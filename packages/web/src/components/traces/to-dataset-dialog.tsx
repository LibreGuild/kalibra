import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/button';
import { ErrorBox } from '../ui/display';
import { Field, Input, Select } from '../ui/form';
import { Dialog } from '../ui/overlay';
import { toast } from '../ui/toast';
import { DatasetPicker } from '../pickers';
import { op, useOp } from '../../lib/api';
import { preview } from '../../lib/format';
import { candidatePaths, pathValue, type Trace } from './types';

/*
 * Turns real calls into test cases: each selected trace becomes one dataset row. Every column is
 * filled from a path in the trace ("input", "input.question", "output.answer", "metadata.user").
 * Rows land as "needs review", so a person approves them before they count in runs.
 */

const CUSTOM = '__custom__';
const NONE = '__none__';

interface Column {
  key: string;
  type?: string;
  description?: string;
}

/** A sensible first guess for a column: a field with the same name, else input/output by meaning. */
function guess(col: string, paths: string[], sample: Trace | undefined): string {
  const exact = paths.find((p) => p.split('.').pop()?.toLowerCase() === col.toLowerCase());
  if (exact) return exact;
  const lc = col.toLowerCase();
  if (/^(input|question|prompt|query|message|text|utterance)$/.test(lc) && typeof sample?.input === 'string') return 'input';
  if (/^(output|answer|expected|expected_answer|response|reply|reference)$/.test(lc) && typeof sample?.output === 'string') return 'output';
  return NONE;
}

export function AddToDatasetDialog({ open, onOpenChange, traceIds, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; traceIds: string[]; onDone?: () => void }) {
  const qc = useQueryClient();
  const [dataset, setDataset] = useState<string>();
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // The first selected trace shows which fields exist and previews the first new row.
  const sample = useOp<Trace>('get_trace', { id: traceIds[0] }, { enabled: open && traceIds.length > 0 });
  const schema = useOp<{ columns: Column[] }>('get_dataset_schema', { dataset, sampleRows: 0 }, { enabled: open && !!dataset });
  const columns = schema.data?.columns ?? [];
  const paths = useMemo(() => candidatePaths(sample.data), [sample.data]);

  // New dataset (or new sample): start from guesses, keeping choices the user already made.
  useEffect(() => {
    if (!columns.length) return;
    setMapping((cur) => Object.fromEntries(columns.map((c) => [c.key, cur[c.key] ?? guess(c.key, paths, sample.data)])));
  }, [schema.data, paths]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) {
      setError(null);
      setBusy(false);
    }
  }, [open]);

  // Built from the current dataset's columns, so a mapping left over from the previous dataset (while
  // the new one's columns load) is never sent.
  const resolved = Object.fromEntries(
    columns
      .map((c) => [c.key, mapping[c.key]] as const)
      .map(([col, choice]) => [col, choice === CUSTOM ? (custom[col] ?? '').trim() : choice] as const)
      .filter(([, path]) => path && path !== NONE),
  );
  const ready = !!dataset && Object.keys(resolved).length > 0 && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await op<any>('traces_to_dataset', { traceIds, dataset, mapping: resolved, status: 'needs_review' });
      const added = res?.added?.length ?? 0;
      const skipped = (res?.rejected?.length ?? 0) + (res?.missing?.length ?? 0);
      qc.invalidateQueries({ queryKey: ['list_rows'] });
      qc.invalidateQueries({ queryKey: ['list_datasets'] });
      toast.success(`${added} row${added === 1 ? '' : 's'} added for review`, skipped ? `${skipped} could not be added (deleted, or not matching the dataset's columns).` : 'Approve them in the dataset before they count in runs.');
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const options = [{ value: NONE, label: <span className="text-ink-faint">Leave empty</span> }, ...paths.map((p) => ({ value: p, label: <span className="font-mono">{p}</span> })), { value: CUSTOM, label: 'Another path…' }];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Add ${traceIds.length} trace${traceIds.length === 1 ? '' : 's'} to a dataset`}
      description="Each trace becomes one row. Pick where every column comes from; the new rows wait for review."
      width="lg"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={submit}>
            Add {traceIds.length} row{traceIds.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Dataset" help="Rows are added to this dataset. Its columns are listed below.">
          <DatasetPicker value={dataset} onChange={setDataset} />
        </Field>
        {dataset && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] gap-3 text-[0.71875rem] font-semibold uppercase tracking-wide text-ink-faint">
              <span>Column</span>
              <span>Filled from</span>
              <span>First row</span>
            </div>
            {schema.isLoading && <div className="text-[0.8125rem] text-ink-muted">Loading columns…</div>}
            {columns.map((c) => {
              const choice = mapping[c.key] ?? NONE;
              const path = choice === CUSTOM ? custom[c.key] ?? '' : choice;
              const value = path && path !== NONE ? pathValue(sample.data, path) : undefined;
              return (
                <div key={c.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] items-start gap-3">
                  <div className="min-w-0 pt-1.5">
                    <div className="truncate font-mono text-[0.8125rem]">{c.key}</div>
                    {c.type && <div className="text-[0.71875rem] text-ink-faint">{c.type}</div>}
                  </div>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Select value={choice} onChange={(v) => setMapping({ ...mapping, [c.key]: v })} options={options} aria-label={`Source for ${c.key}`} />
                    {choice === CUSTOM && <Input mono value={custom[c.key] ?? ''} placeholder="e.g. input.messages.0.content" onChange={(e) => setCustom({ ...custom, [c.key]: e.target.value })} aria-label={`Path for ${c.key}`} />}
                  </div>
                  <div className="min-w-0 truncate pt-1.5 text-[0.78125rem] text-ink-muted">{value === undefined ? <span className="text-ink-faint">—</span> : preview(value, 80)}</div>
                </div>
              );
            })}
          </div>
        )}
        <ErrorBox error={error ?? schema.error} />
      </div>
    </Dialog>
  );
}
