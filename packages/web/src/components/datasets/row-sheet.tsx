import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { ApiError, op, uploadFile } from '../../lib/api';
import { actorLabel, dateTime } from '../../lib/format';
import { Button } from '../ui/button';
import { useCanEdit } from '../../lib/session';
import { CodeEditor } from '../ui/code';
import { ErrorBox } from '../ui/display';
import { Field, Input, Select, Switch, TagInput, Textarea } from '../ui/form';
import { CellValue, isFileValue } from '../ui/media';
import { Sheet } from '../ui/overlay';
import { toast, toastError } from '../ui/toast';
import { COLUMN_TYPES } from './columns-editor';
import { isFileType, type AddRowsResult, type ColumnDef, type RowRecord, type RowStatus } from './types';

export const STATUS_OPTIONS: { value: RowStatus; label: string; hint: string }[] = [
  { value: 'approved', label: 'Approved', hint: 'Used in runs' },
  { value: 'needs_review', label: 'Needs review', hint: 'Waiting for a person to check it' },
  { value: 'draft', label: 'Draft', hint: 'Work in progress' },
  { value: 'rejected', label: 'Rejected', hint: 'Kept, but excluded from runs by default' },
];

/** Editor state keeps JSON-ish values as text so half-typed JSON doesn't get lost. */
type Draft = Record<string, unknown>;

function toDraft(cols: ColumnDef[], data: Record<string, unknown>): Draft {
  const d: Draft = { ...data };
  for (const c of cols) {
    const v = data[c.key];
    if (c.type === 'json' || c.type === 'messages') d[c.key] = v === undefined || v === null ? '' : JSON.stringify(v, null, 2);
    else if (c.type === 'number') d[c.key] = v === undefined || v === null ? '' : String(v);
    else if (c.type === 'list') d[c.key] = Array.isArray(v) ? v.map(String) : [];
  }
  return d;
}

function fromDraft(cols: ColumnDef[], draft: Draft): { data: Record<string, unknown>; error?: string } {
  const data: Record<string, unknown> = { ...draft };
  for (const c of cols) {
    const v = draft[c.key];
    if (c.type === 'json' || c.type === 'messages') {
      if (typeof v !== 'string' || v.trim() === '') data[c.key] = undefined;
      else {
        try {
          data[c.key] = JSON.parse(v);
        } catch {
          return { data, error: `"${c.key}" is not valid JSON` };
        }
      }
    } else if (c.type === 'number') {
      data[c.key] = v === '' || v === undefined ? undefined : Number(v);
    } else if (c.type === 'list') {
      data[c.key] = Array.isArray(v) && v.length ? v : undefined;
    } else if (c.type === 'text' && v === '') data[c.key] = undefined;
  }
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  return { data };
}

function FileInput({ column, value, onChange }: { column: ColumnDef; value: unknown; onChange: (v: unknown) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const accept = column.type === 'audio' ? 'audio/*' : column.type === 'image' ? 'image/*' : undefined;
  return (
    <div className="flex flex-col gap-2">
      {isFileValue(value) ? <CellValue value={value} type={column.type} full /> : <span className="text-[0.8125rem] text-ink-faint">No file yet</span>}
      <div>
        <Button size="sm" icon={<Upload className="size-3.5" />} loading={busy} onClick={() => ref.current?.click()}>
          {isFileValue(value) ? 'Replace file' : 'Upload file'}
        </Button>
        <input
          ref={ref}
          type="file"
          accept={accept}
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setBusy(true);
            try {
              const up = await uploadFile(f);
              onChange({ blob: up.hash, name: up.name ?? f.name, mime: up.mime, size: up.size });
            } catch (err) {
              toastError(err, 'Upload failed');
            } finally {
              setBusy(false);
            }
          }}
        />
      </div>
    </div>
  );
}

function ColumnInput({ column, value, onChange }: { column: ColumnDef; value: unknown; onChange: (v: unknown) => void }) {
  switch (column.type) {
    case 'number':
      return <Input type="number" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
    case 'boolean':
      return (
        <div className="flex items-center gap-2 text-[0.8125rem] text-ink-muted">
          <Switch checked={value === true} onChange={onChange} label={column.key} />
          {value === true ? 'true' : 'false'}
        </div>
      );
    case 'list':
      return <TagInput value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} placeholder="Type a value and press Enter" />;
    case 'json':
    case 'messages':
      return (
        <CodeEditor
          language="json"
          value={typeof value === 'string' ? value : ''}
          onChange={onChange}
          minHeight={90}
          maxHeight={300}
          placeholder={column.type === 'messages' ? '[{ "role": "user", "content": "Hello" }]' : '{ }'}
        />
      );
    case 'audio':
    case 'image':
    case 'file':
      return <FileInput column={column} value={value} onChange={onChange} />;
    default:
      if (column.enum?.length) {
        return <Select value={typeof value === 'string' ? value : undefined} onChange={onChange} options={column.enum.map((v) => ({ value: v, label: v }))} />;
      }
      return <Textarea value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} rows={String(value ?? '').length > 160 ? 6 : 3} />;
  }
}

function Provenance({ row }: { row: RowRecord }) {
  const p = row.provenance ?? {};
  const source: Record<string, string> = { manual: 'Added by hand', agent: 'Added by a coding agent', generated: 'Generated by a model', import: 'Imported from a file' };
  const items: [string, string | undefined][] = [
    ['Source', source[p.source] ?? p.source],
    ['Added by', p.actor ? actorLabel(p.actor) : undefined],
    ['Agent', p.client],
    ['Model', p.model],
    ['File', p.file],
    ['Added', dateTime(row.createdAt)],
    ['Last edited', dateTime(row.updatedAt)],
    ['Revision', String(row.rev)],
  ];
  return (
    <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.78125rem]">
      {items
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-faint">{k}</dt>
            <dd className="truncate text-ink-muted">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Side panel to view, edit or add one row. `row = null` means "new row". */
export function RowSheet({
  open,
  onOpenChange,
  datasetId,
  columns,
  row,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  datasetId: string;
  columns: ColumnDef[];
  row: RowRecord | null;
}) {
  const canEdit = useCanEdit();
  const qc = useQueryClient();
  const [current, setCurrent] = useState<RowRecord | null>(row);
  const [draft, setDraft] = useState<Draft>({});
  const [tags, setTags] = useState<string[]>([]);
  const [status, setStatus] = useState<RowStatus>('approved');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = (r: RowRecord | null) => {
    setCurrent(r);
    setDraft(toDraft(columns, r?.data ?? {}));
    setTags(r?.tags ?? []);
    setStatus(r?.status ?? 'approved');
    setError(null);
  };

  useEffect(() => {
    if (open) load(row);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, row]);

  const extraKeys = Object.keys(current?.data ?? {}).filter((k) => !columns.some((c) => c.key === k));

  async function save() {
    const { data, error: parseError } = fromDraft(columns, draft);
    if (parseError) return setError(parseError);
    setSaving(true);
    setError(null);
    try {
      if (current) {
        // update_row merges into the stored values, so a cleared column must be sent as null to clear it.
        for (const c of columns) if (!(c.key in data) && current.data[c.key] != null) data[c.key] = null;
        await op('update_row', { rowId: current.id, data, tags, status, baseRev: current.rev });
        toast.success('Row saved');
      } else {
        const res = await op<AddRowsResult>('add_dataset_rows', { dataset: datasetId, rows: [{ data, tags, status }] });
        if (res.rejected.length) {
          setError(res.rejected[0].errors.join('; '));
          return;
        }
        toast.success('Row added');
      }
      qc.invalidateQueries({ queryKey: ['list_rows'] });
      qc.invalidateQueries({ queryKey: ['get_dataset_schema'] });
      onOpenChange(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict' && current) {
        toast.info('Changed elsewhere — reloaded', 'Someone (or an agent) edited this row while you were editing. Re-apply your change.');
        const fresh = await op<{ rows: RowRecord[] }>('list_rows', { dataset: datasetId, search: current.id, limit: 1 }).catch(() => null);
        if (fresh?.rows[0]) load(fresh.rows[0]);
        qc.invalidateQueries({ queryKey: ['list_rows'] });
      } else setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={current ? `Row #${current.seq}` : 'New row'}
      subtitle={current ? current.id : 'Fill in the columns, then add the row'}
      width={640}
      actions={
        canEdit && (
          <Button variant="primary" size="sm" loading={saving} onClick={save}>
            {current ? 'Save' : 'Add row'}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-5 px-5 py-4">
        {columns.length === 0 && <div className="text-[0.8125rem] text-ink-muted">This dataset has no columns yet. Add some in “Columns & instructions”.</div>}
        {columns.map((c) => (
          <Field
            key={c.key}
            label={
              <span className="flex items-center gap-2">
                <span className="font-mono text-[0.78125rem]">{c.key}</span>
                <span className="text-[0.71875rem] font-normal text-ink-faint">{COLUMN_TYPES.find((t) => t.value === c.type)?.label}</span>
                {c.required && <span className="text-[0.71875rem] font-normal text-accent-ink">required</span>}
              </span>
            }
            help={c.description || undefined}
          >
            <ColumnInput column={c} value={draft[c.key]} onChange={(v) => setDraft((d) => ({ ...d, [c.key]: v }))} />
          </Field>
        ))}

        {extraKeys.length > 0 && (
          <Field label="Other values" help="Values in this row that don't match any column. They are kept as they are and can still be used in templates.">
            <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-raised p-2.5 text-[0.8125rem]">
              {extraKeys.map((k) => (
                <div key={k} className="grid grid-cols-[140px_minmax(0,1fr)] gap-2">
                  <span className="font-mono text-[0.75rem] text-ink-muted">{k}</span>
                  <CellValue value={current!.data[k]} />
                </div>
              ))}
            </div>
          </Field>
        )}

        <div className="grid grid-cols-2 gap-4">
          <Field label="Tags" help="Labels for slicing results later, like 'noisy', 'accent-in' or 'edge-case'. Runs can be limited to tags.">
            <TagInput value={tags} onChange={setTags} />
          </Field>
          <Field label="Status" help="Only rows you include are used in runs. Rows added by agents or models start as 'Needs review'.">
            <Select value={status} onChange={(v) => setStatus(v as RowStatus)} options={STATUS_OPTIONS} />
          </Field>
        </div>

        {error && <ErrorBox error={{ message: error }} />}

        {current && (
          <div className="border-t border-line pt-4">
            <div className="mb-2 text-[0.78125rem] font-semibold text-ink-muted">Where this row came from</div>
            <Provenance row={current} />
          </div>
        )}
      </div>
    </Sheet>
  );
}

export { isFileType };
