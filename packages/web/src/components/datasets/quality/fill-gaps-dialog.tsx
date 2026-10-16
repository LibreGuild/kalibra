import { useMemo, useState } from 'react';
import { Button } from '../../ui/button';
import { ErrorBox } from '../../ui/display';
import { Field, Input, Select } from '../../ui/form';
import { Dialog } from '../../ui/overlay';
import { ConnectionPicker } from '../../pickers';
import { op } from '../../../lib/api';
import { JobPanel, useJob } from '../media-dialogs';
import type { ColumnQuality } from './types';

/** Asks a model for rows that cover under-represented values of a column. */
export function FillGapsDialog({
  open,
  onOpenChange,
  datasetId,
  columns,
  initialColumn,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  datasetId: string;
  columns: ColumnQuality[];
  initialColumn?: string;
}) {
  const candidates = columns.filter((c) => c.categorical && c.topValues?.length && !['audio', 'image', 'file'].includes(c.type));
  const [column, setColumn] = useState(initialColumn ?? candidates[0]?.key ?? '');
  const col = candidates.find((c) => c.key === column);
  const maxCount = Math.max(1, ...(col?.topValues?.map((v) => v.count) ?? [1]));
  const [target, setTarget] = useState<number | ''>('');
  const [connectionId, setConnectionId] = useState('');
  const [model, setModel] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const job = useJob(jobId);
  const effectiveTarget = target === '' ? maxCount : target;

  const plan = useMemo(
    () => (col?.topValues ?? []).map((v) => ({ value: v.value, have: v.count, add: Math.min(50, Math.max(0, effectiveTarget - v.count)) })).filter((p) => p.add > 0),
    [col, effectiveTarget],
  );
  const totalAdd = plan.reduce((n, p) => n + p.add, 0);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await op('fill_gaps', { dataset: datasetId, column, targetPerValue: effectiveTarget, connectionId, model });
      if (!r.jobId) {
        setError(new Error(r.result?.message ?? 'Nothing to fill'));
        return;
      }
      setJobId(r.jobId);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    onOpenChange(false);
    setJobId(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title="Fill gaps"
      description="A model writes rows for the values that have too few. New rows wait in the review queue."
      footer={
        jobId ? (
          <Button onClick={close}>Close</Button>
        ) : (
          <>
            <span className="mr-auto self-center text-[0.78125rem] text-ink-muted">{totalAdd ? `About ${totalAdd} new row${totalAdd === 1 ? '' : 's'}` : 'Already balanced'}</span>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!connectionId || !totalAdd} onClick={start}>
              Generate
            </Button>
          </>
        )
      }
    >
      {jobId ? (
        job.data ? <JobPanel job={job.data} /> : <div className="text-[0.8125rem] text-ink-muted">Starting…</div>
      ) : (
        <div className="flex flex-col gap-4">
          {!candidates.length ? (
            <div className="text-[0.8125rem] text-ink-muted">No column with a small set of values (like category, accent or language) to balance yet.</div>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Column">
                  <Select value={column} onChange={setColumn} options={candidates.map((c) => ({ value: c.key, label: c.key, hint: `${c.topValues!.length} values` }))} />
                </Field>
                <Field label="Rows wanted per value" help="Defaults to the count of the most common value, so everything ends up even. At most 50 are added per value in one go.">
                  <Input type="number" min={1} max={500} value={target === '' ? '' : target} placeholder={String(maxCount)} onChange={(e) => setTarget(e.target.value === '' ? '' : Math.max(1, Number(e.target.value)))} />
                </Field>
              </div>
              <div className="rounded-lg border border-line bg-raised/60 p-3">
                <div className="mb-2 text-[0.75rem] font-semibold uppercase tracking-wide text-ink-faint">Plan</div>
                {plan.length ? (
                  <ul className="flex flex-col gap-1 text-[0.8125rem]">
                    {plan.map((p) => (
                      <li key={p.value} className="flex justify-between gap-3">
                        <span className="truncate">{p.value}</span>
                        <span className="tabular-nums text-ink-muted">
                          {p.have} → <span className="text-ink">{p.have + p.add}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-[0.8125rem] text-ink-muted">Every value already has at least {effectiveTarget} rows.</div>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Field label="Connection">
                  <ConnectionPicker value={connectionId} onChange={setConnectionId} />
                </Field>
                <Field label="Model" help="Leave empty to use the connection's default text model.">
                  <Input mono value={model} onChange={(e) => setModel(e.target.value)} placeholder="default" />
                </Field>
              </div>
            </>
          )}
          <ErrorBox error={error} />
        </div>
      )}
    </Dialog>
  );
}
