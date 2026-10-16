import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CircleAlert, CircleCheck, FileSpreadsheet, LoaderCircle, Upload, X } from 'lucide-react';
import { op, uploadFile, useOp } from '../../lib/api';
import { bytes } from '../../lib/format';
import { Button } from '../ui/button';
import { ErrorBox } from '../ui/display';
import { Field, Input, Select, Switch, TagInput, Textarea } from '../ui/form';
import { Dialog, HelpTip } from '../ui/overlay';
import { ConnectionPicker } from '../pickers';
import { toast, toastError } from '../ui/toast';
import { ColumnsEditor, columnErrors, TEMPLATES } from './columns-editor';
import { baseName, parseCsv } from './csv';
import { STATUS_OPTIONS } from './row-sheet';
import { isFileType, type AddRowsResult, type ColumnDef, type RowStatus } from './types';

const SKIP = '__skip';
const NEW = '__new:';

function useRefreshRows() {
  const qc = useQueryClient();
  return () => {
    for (const k of ['list_rows', 'get_dataset_schema', 'list_datasets']) qc.invalidateQueries({ queryKey: [k] });
  };
}

/** Outcome of an add/import: counts, first rejection reasons, warnings, unmatched files. */
export function ResultSummary({ result, extra }: { result: AddRowsResult; extra?: ReactNode }) {
  const added = Array.isArray(result.added) ? result.added.length : result.added;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3 text-[0.8125rem]">
      <div className="flex items-center gap-2 font-medium">
        <CircleCheck className="size-4 text-ok" /> {added} row{added === 1 ? '' : 's'} added
        {result.rejected.length > 0 && <span className="text-bad">· {result.rejected.length} rejected</span>}
      </div>
      {result.rejected.slice(0, 5).map((r, i) => (
        <div key={i} className="flex items-start gap-2 text-ink-muted">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-bad" />
          <span>
            Row {r.index + 1}: {r.errors.join('; ')}
          </span>
        </div>
      ))}
      {result.rejected.length > 5 && <div className="text-ink-faint">…and {result.rejected.length - 5} more</div>}
      {(result.warnings ?? []).slice(0, 3).map((w, i) => (
        <div key={`w${i}`} className="text-warn">
          Row {w.index + 1}: {w.message}
        </div>
      ))}
      {!!result.unmatchedFiles?.length && (
        <div className="text-warn">
          {result.unmatchedFiles.length} file name{result.unmatchedFiles.length === 1 ? '' : 's'} in the CSV had no uploaded file: {result.unmatchedFiles.slice(0, 5).join(', ')}
          {result.unmatchedFiles.length > 5 && '…'}
        </div>
      )}
      {extra}
    </div>
  );
}

function DropZone({ accept, multiple, onFiles, children }: { accept?: string; multiple?: boolean; onFiles: (f: File[]) => void; children: ReactNode }) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => ref.current?.click()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && ref.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = [...e.dataTransfer.files];
        if (files.length) onFiles(multiple ? files : files.slice(0, 1));
      }}
      className={clsx(
        'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-7 text-center text-[0.8125rem] text-ink-muted transition-colors',
        over ? 'border-accent bg-accent-soft/50' : 'border-line-strong bg-raised hover:border-ink-faint',
      )}
    >
      <Upload className="size-5 text-ink-faint" />
      {children}
      <input
        ref={ref}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </div>
  );
}

/* New dataset ─────────────────────────────────────────────────────────────── */

export function NewDatasetDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState('qa');
  const [columns, setColumns] = useState<ColumnDef[]>(TEMPLATES[0].columns);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const invalid = Object.keys(columnErrors(columns)).length > 0;

  const pick = (id: string) => {
    setTemplate(id);
    setColumns(TEMPLATES.find((t) => t.id === id)!.columns.map((c) => ({ ...c })));
  };

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const ds = await op('create_dataset', { name: name.trim(), description, columns });
      qc.invalidateQueries({ queryKey: ['list_datasets'] });
      onOpenChange(false);
      setName('');
      setDescription('');
      pick('qa');
      navigate(`/datasets/${ds.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New dataset"
      description="A dataset is a table of test cases. Each column becomes a {{placeholder}} you can send to your app and compare against."
      width="lg"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || invalid} onClick={create}>
            Create dataset
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Support questions" />
          </Field>
          <Field label="Description" help="Optional. What these test cases cover.">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this dataset covers" />
          </Field>
        </div>
        <Field label="Start from" help="A template only pre-fills the columns. You can change everything below and later.">
          <div className="grid grid-cols-4 gap-2">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => pick(t.id)}
                className={clsx(
                  'rounded-lg border px-3 py-2.5 text-left transition-colors',
                  template === t.id ? 'border-accent bg-accent-soft/50' : 'border-line bg-surface hover:bg-hover',
                )}
              >
                <div className="text-[0.8125rem] font-medium">{t.label}</div>
                <div className="mt-0.5 text-[0.75rem] leading-snug text-ink-muted">{t.hint}</div>
              </button>
            ))}
          </div>
        </Field>
        <Field label="Columns">
          <ColumnsEditor value={columns} onChange={setColumns} />
        </Field>
        <ErrorBox error={error} />
      </div>
    </Dialog>
  );
}

/* Upload audio / image files ─────────────────────────────────────────────── */

type UploadState = { file: File; status: 'pending' | 'uploading' | 'done' | 'error'; hash?: string; mime?: string; size?: number; error?: string };

export function UploadFilesDialog({ open, onOpenChange, datasetId, columns }: { open: boolean; onOpenChange: (o: boolean) => void; datasetId: string; columns: ColumnDef[] }) {
  const refresh = useRefreshRows();
  const fileColumns = columns.filter((c) => isFileType(c.type));
  const [items, setItems] = useState<UploadState[]>([]);
  const [picked, setPicked] = useState<string | undefined>();
  // The dialog stays mounted, so fall back to the first file column if the picked one is gone or was never set.
  const column = fileColumns.some((c) => c.key === picked) ? picked : fileColumns[0]?.key;
  const [csv, setCsv] = useState<{ file: File; headers: string[]; rows: Record<string, string>[] } | null>(null);
  const [nameCol, setNameCol] = useState<string | undefined>();
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<RowStatus>('approved');
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AddRowsResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const accept = columns.find((c) => c.key === column)?.type === 'image' ? 'image/*' : columns.find((c) => c.key === column)?.type === 'audio' ? 'audio/*' : undefined;

  const reset = () => {
    setItems([]);
    setCsv(null);
    setNameCol(undefined);
    setMapping({});
    setResult(null);
    setError(null);
  };

  const addFiles = (files: File[]) => {
    setResult(null);
    setItems((cur) => {
      const names = new Set(cur.map((c) => c.file.name));
      return [...cur, ...files.filter((f) => !names.has(f.name)).map((file) => ({ file, status: 'pending' as const }))];
    });
  };

  const pickCsv = async (f: File) => {
    const parsed = parseCsv(await f.text());
    setCsv({ file: f, ...parsed });
    const guess = parsed.headers.find((h) => /file|audio|path|name|image/i.test(h)) ?? parsed.headers[0];
    setNameCol(guess);
    const m: Record<string, string> = {};
    for (const h of parsed.headers) {
      if (h === guess) continue;
      const same = columns.find((c) => c.key === h && !isFileType(c.type));
      const transcript = /text|transcript|reference|label|sentence/i.test(h) ? columns.find((c) => c.type === 'text') : undefined;
      m[h] = same?.key ?? transcript?.key ?? SKIP;
    }
    setMapping(m);
  };

  const referenced = useMemo(() => new Set(csv && nameCol ? csv.rows.map((r) => baseName(r[nameCol] ?? '')) : []), [csv, nameCol]);
  const notInCsv = csv ? items.filter((i) => !referenced.has(i.file.name)).length : 0;

  async function start() {
    if (!column) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const states = [...items];
    const update = (i: number, patch: Partial<UploadState>) => {
      states[i] = { ...states[i], ...patch };
      setItems([...states]);
    };
    let next = 0;
    const worker = async () => {
      while (next < states.length) {
        const i = next++;
        if (states[i].status === 'done') continue;
        update(i, { status: 'uploading' });
        try {
          const up = await uploadFile(states[i].file);
          update(i, { status: 'done', hash: up.hash, mime: up.mime, size: up.size });
        } catch (e) {
          update(i, { status: 'error', error: (e as Error).message });
        }
      }
    };
    try {
      await Promise.all([worker(), worker(), worker()]);
      const done = states.filter((s) => s.status === 'done');
      if (!done.length) throw new Error('No files were uploaded');

      if (csv && nameCol) {
        const up = await uploadFile(csv.file);
        const map: Record<string, string> = { [nameCol]: column };
        for (const [src, dst] of Object.entries(mapping)) {
          if (dst === SKIP) map[src] = '';
          else map[src] = dst.startsWith(NEW) ? dst.slice(NEW.length) : dst;
        }
        const res = await op<AddRowsResult>('import_rows', {
          dataset: datasetId,
          blob: up.hash,
          format: 'csv',
          mapping: map,
          createColumns: true,
          files: Object.fromEntries(done.map((d) => [d.file.name, d.hash!])),
          status,
          tags,
        });
        setResult(res);
      } else {
        const rows = done.map((d) => ({ data: { [column]: { blob: d.hash, name: d.file.name, mime: d.mime, size: d.size } }, tags, status }));
        const agg: AddRowsResult = { added: [], rejected: [], warnings: [] };
        for (let i = 0; i < rows.length; i += 200) {
          const res = await op<AddRowsResult>('add_dataset_rows', { dataset: datasetId, rows: rows.slice(i, i + 200) });
          (agg.added as string[]).push(...(res.added as string[]));
          agg.rejected.push(...res.rejected.map((r) => ({ ...r, index: r.index + i })));
          agg.warnings!.push(...(res.warnings ?? []).map((w) => ({ ...w, index: w.index + i })));
        }
        setResult(agg);
      }
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const csvTargets = [
    { value: SKIP, label: 'Skip this column' },
    ...columns.filter((c) => !isFileType(c.type)).map((c) => ({ value: c.key, label: c.key, hint: c.description || c.type })),
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Upload audio or image files"
      description="Each file becomes one row. Add a CSV to fill other columns, such as the correct transcript for each recording."
      width="lg"
      footer={
        result ? (
          <Button variant="primary" onClick={() => (reset(), onOpenChange(false))}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={() => (reset(), onOpenChange(false))}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!items.length || !column} onClick={start}>
              Upload {items.length || ''} file{items.length === 1 ? '' : 's'}
            </Button>
          </>
        )
      }
    >
      {fileColumns.length === 0 ? (
        <div className="rounded-lg border border-line bg-raised p-4 text-[0.84375rem] text-ink-muted">
          This dataset has no audio, image or file column yet. Add one in <b>Columns & instructions</b> (type “Audio file” or “Image file”), then come back.
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Put files in column" help="The dataset column that receives the uploaded files.">
              <Select value={column} onChange={setPicked} options={fileColumns.map((c) => ({ value: c.key, label: c.key, hint: c.type }))} />
            </Field>
            <Field label="Status for new rows" help="Rows you include in runs. Choose 'Needs review' if someone should check them first.">
              <Select value={status} onChange={(v) => setStatus(v as RowStatus)} options={STATUS_OPTIONS} />
            </Field>
          </div>

          <DropZone accept={accept} multiple onFiles={addFiles}>
            <span className="font-medium text-ink">Drop files here or click to choose</span>
            <span className="text-[0.75rem]">You can select many files at once.</span>
          </DropZone>

          {items.length > 0 && (
            <div className="max-h-48 overflow-y-auto rounded-lg border border-line">
              {items.map((it, i) => (
                <div key={it.file.name} className="flex items-center gap-2 border-b border-line/70 px-3 py-1.5 text-[0.8125rem] last:border-b-0">
                  {it.status === 'uploading' ? (
                    <LoaderCircle className="size-3.5 animate-spin text-ink-faint" />
                  ) : it.status === 'done' ? (
                    <CircleCheck className="size-3.5 text-ok" />
                  ) : it.status === 'error' ? (
                    <CircleAlert className="size-3.5 text-bad" />
                  ) : (
                    <span className="size-3.5 rounded-full border border-line-strong" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{it.file.name}</span>
                  {csv && nameCol && !referenced.has(it.file.name) && <span className="text-[0.75rem] text-warn">not in CSV</span>}
                  {it.error && <span className="truncate text-[0.75rem] text-bad">{it.error}</span>}
                  <span className="text-[0.75rem] tabular-nums text-ink-faint">{bytes(it.file.size)}</span>
                  {!busy && it.status !== 'done' && (
                    <button type="button" className="text-ink-faint hover:text-ink" aria-label="Remove" onClick={() => setItems(items.filter((_, j) => j !== i))}>
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="rounded-lg border border-line p-3.5">
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-[0.8125rem] font-medium">
                <FileSpreadsheet className="size-4 text-ink-muted" /> Labels CSV (optional)
                <HelpTip>A CSV with one line per file: a column with the file name, plus columns like the correct transcript. Values are matched to files by name.</HelpTip>
              </div>
              {csv ? (
                <Button size="sm" variant="ghost" onClick={() => setCsv(null)}>
                  Remove
                </Button>
              ) : (
                <label className="inline-flex h-7 cursor-pointer items-center rounded-md border border-line-strong px-2.5 text-[0.8125rem] font-medium hover:bg-hover">
                  Choose CSV
                  <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && pickCsv(e.target.files[0])} />
                </label>
              )}
            </div>
            {!csv && <div className="text-[0.78125rem] text-ink-faint">Example: <span className="font-mono">file,transcript</span> then <span className="font-mono">clip01.wav,turn left at the light</span></div>}
            {csv && (
              <div className="flex flex-col gap-3">
                <div className="text-[0.78125rem] text-ink-muted">
                  {csv.file.name} · {csv.rows.length} lines
                  {notInCsv > 0 && <span className="text-warn"> · {notInCsv} uploaded file{notInCsv === 1 ? ' is' : 's are'} not listed and will be skipped</span>}
                </div>
                <Field label="Column with the file name" inline>
                  <div className="w-64">
                    <Select value={nameCol} onChange={setNameCol} options={csv.headers.map((h) => ({ value: h, label: h }))} />
                  </div>
                </Field>
                {csv.headers
                  .filter((h) => h !== nameCol)
                  .map((h) => (
                    <Field
                      key={h}
                      inline
                      label={
                        <span>
                          <span className="font-mono text-[0.78125rem]">{h}</span> <span className="font-normal text-ink-faint">→</span>
                        </span>
                      }
                    >
                      <div className="w-64">
                        <Select
                          value={mapping[h] ?? SKIP}
                          onChange={(v) => setMapping({ ...mapping, [h]: v })}
                          options={[...csvTargets, { value: `${NEW}${h}`, label: `New column “${h}”` }]}
                        />
                      </div>
                    </Field>
                  ))}
              </div>
            )}
          </div>

          <Field label="Tags for new rows" help="Optional labels such as 'real-recordings' or 'telephony', so you can slice results later.">
            <TagInput value={tags} onChange={setTags} />
          </Field>

          <ErrorBox error={error} />
          {result && <ResultSummary result={result} />}
        </div>
      )}
    </Dialog>
  );
}

/* Import a CSV / JSONL / JSON file ───────────────────────────────────────── */

export function ImportDialog({ open, onOpenChange, datasetId }: { open: boolean; onOpenChange: (o: boolean) => void; datasetId: string }) {
  const refresh = useRefreshRows();
  const [file, setFile] = useState<File | null>(null);
  const [createColumns, setCreateColumns] = useState(true);
  const [status, setStatus] = useState<RowStatus>('approved');
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AddRowsResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  const close = (o: boolean) => {
    if (!o) {
      setFile(null);
      setResult(null);
      setError(null);
    }
    onOpenChange(o);
  };

  async function run() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const up = await uploadFile(file);
      const res = await op<AddRowsResult>('import_rows', { dataset: datasetId, blob: up.hash, createColumns, status, tags });
      setResult(res);
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Import rows from a file"
      description="CSV, JSONL or JSON. Column names in the file are matched to dataset columns by name."
      footer={
        result ? (
          <Button variant="primary" onClick={() => close(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={() => close(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!file} onClick={run}>
              Import
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-5">
        {file ? (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-raised px-3 py-2.5 text-[0.8125rem]">
            <FileSpreadsheet className="size-4 text-ink-muted" />
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
            <span className="text-ink-faint">{bytes(file.size)}</span>
            {!result && (
              <button type="button" className="text-ink-faint hover:text-ink" aria-label="Remove file" onClick={() => setFile(null)}>
                <X className="size-3.5" />
              </button>
            )}
          </div>
        ) : (
          <DropZone accept=".csv,.tsv,.jsonl,.ndjson,.json,text/csv,application/json" onFiles={(f) => setFile(f[0])}>
            <span className="font-medium text-ink">Drop a file here or click to choose</span>
            <span className="text-[0.75rem]">OpenAI Evals JSONL ({'{"item": {…}}'} per line) works too.</span>
          </DropZone>
        )}
        <Field
          inline
          label="Create missing columns"
          help="When the file has columns this dataset doesn't, add them automatically (types are guessed). Turn off to reject such files instead."
        >
          <Switch checked={createColumns} onChange={setCreateColumns} label="Create missing columns" />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Status for new rows" help="Choose 'Needs review' if someone should check the imported rows first.">
            <Select value={status} onChange={(v) => setStatus(v as RowStatus)} options={STATUS_OPTIONS} />
          </Field>
          <Field label="Tags" help="Optional labels added to every imported row.">
            <TagInput value={tags} onChange={setTags} />
          </Field>
        </div>
        <ErrorBox error={error} />
        {result && <ResultSummary result={result} />}
      </div>
    </Dialog>
  );
}

/* Generate with a model ──────────────────────────────────────────────────── */

export function GenerateDialog({ open, onOpenChange, datasetId }: { open: boolean; onOpenChange: (o: boolean) => void; datasetId: string }) {
  const refresh = useRefreshRows();
  const connections = useOp<any[]>('list_connections', {}, { enabled: open });
  const [connectionId, setConnectionId] = useState<string | undefined>();
  const [model, setModel] = useState('');
  const [count, setCount] = useState('10');
  const [instructions, setInstructions] = useState('');
  const [temperature, setTemperature] = useState('1');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ added: number; rejected: AddRowsResult['rejected'] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const conn = connections.data?.find((c) => c.id === connectionId);
  const none = connections.isSuccess && connections.data.length === 0;

  const close = (o: boolean) => {
    if (!o) {
      setResult(null);
      setError(null);
    }
    onOpenChange(o);
  };

  async function run() {
    if (!connectionId) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await op('generate_rows', {
        dataset: datasetId,
        connectionId,
        model,
        count: Math.max(1, Math.min(500, Number(count) || 10)),
        instructions,
        temperature: Math.max(0, Math.min(2, temperature.trim() && Number.isFinite(Number(temperature)) ? Number(temperature) : 1)),
      });
      setResult(res);
      refresh();
      toast.success(`${res.added} rows generated`, 'They are marked “Needs review”.');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Generate rows with a model"
      description="A model writes new rows that follow your columns and instructions. New rows are marked “Needs review”. File columns are left empty."
      footer={
        result ? (
          <Button variant="primary" onClick={() => close(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={() => close(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!connectionId || none} onClick={run}>
              {busy ? 'Generating…' : 'Generate'}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-5">
        {none && (
          <div className="rounded-lg border border-line bg-raised p-3.5 text-[0.8125rem] text-ink-muted">
            No model connections yet. <Link to="/connections" className="font-medium text-accent-ink hover:underline">Add a connection</Link>, or let your coding agent fill this
            dataset for free through MCP — see <Link to="/agents" className="font-medium text-accent-ink hover:underline">Coding agents</Link>.
          </div>
        )}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Connection" help="The model provider account that writes the rows.">
            <ConnectionPicker value={connectionId} onChange={setConnectionId} />
          </Field>
          <Field label="Model" help="Leave empty to use the connection's default model.">
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={conn?.spec?.defaultModel || 'Default model'} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="How many rows" help="Up to 500. Rows are written in batches of 10, and duplicates are dropped.">
            <Input type="number" min={1} max={500} value={count} onChange={(e) => setCount(e.target.value)} />
          </Field>
          <Field label="Temperature" help="Higher values (around 1) give more varied rows; lower values give more predictable ones.">
            <Input type="number" min={0} max={2} step={0.1} value={temperature} onChange={(e) => setTemperature(e.target.value)} />
          </Field>
        </div>
        <Field label="Extra instructions" help="Added to the dataset's own instructions for this batch only. For example: 'focus on refund questions in Hindi-English'.">
          <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} placeholder="Optional guidance for this batch" />
        </Field>
        {busy && (
          <div className="flex items-center gap-2 text-[0.8125rem] text-ink-muted">
            <LoaderCircle className="size-4 animate-spin" /> Writing rows… this can take a minute for larger batches.
          </div>
        )}
        <ErrorBox error={error} />
        {result && <ResultSummary result={{ added: result.added, rejected: result.rejected as any }} />}
      </div>
    </Dialog>
  );
}

/* Save version ───────────────────────────────────────────────────────────── */

export function SaveVersionDialog({ open, onOpenChange, datasetId }: { open: boolean; onOpenChange: (o: boolean) => void; datasetId: string }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const v = await op('create_dataset_version', { dataset: datasetId, note });
      qc.invalidateQueries({ queryKey: ['list_dataset_versions'] });
      qc.invalidateQueries({ queryKey: ['list_datasets'] });
      if (v.reused) toast.info(`Unchanged since version ${v.number}`, 'No new version was needed.');
      else toast.success(`Saved version ${v.number}`, `${v.rowCount} rows frozen.`);
      setNote('');
      onOpenChange(false);
    } catch (e) {
      toastError(e, 'Could not save the version');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Save a version"
      description="Freezes the current rows so results stay comparable. Runs also save a version automatically."
      width="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save version
          </Button>
        </>
      }
    >
      <Field label="Note" help="Optional. What changed, e.g. 'added 40 noisy recordings'.">
        <Input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed in this version" onKeyDown={(e) => e.key === 'Enter' && !busy && save()} />
      </Field>
    </Dialog>
  );
}
