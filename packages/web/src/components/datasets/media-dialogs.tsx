import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from '../../lib/nav';
import { useQueryClient } from '@tanstack/react-query';
import { CircleStop, LoaderCircle } from 'lucide-react';
import { op, useOp } from '../../lib/api';
import { ConnectionPicker } from '../pickers';
import { Button } from '../ui/button';
import { Badge, ErrorBox, Progress, StatusBadge } from '../ui/display';
import { Field, Input, Segmented, Select, Switch, TagInput, Textarea } from '../ui/form';
import { Dialog, HelpTip } from '../ui/overlay';
import { toast, toastError } from '../ui/toast';
import type { ColumnDef, ColumnType, DatasetSchemaResp, RowRecord } from './types';

/*
 * Media for datasets: images and speech from model connections, transcripts from audio,
 * and degraded audio variants for speech-to-text tests. All run as background jobs.
 */

export interface JobRecord {
  id: string;
  kind: string;
  title: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  done: number;
  total: number;
  message: string;
  errors: { item?: string; error: string }[];
  result?: { created?: number; updated?: number; skipped?: number; failed?: number; total?: number };
  error?: string;
  meta?: { datasetId?: string };
  createdAt: string;
  finishedAt?: string;
}

const active = (j?: JobRecord) => !!j && (j.status === 'queued' || j.status === 'running');

export function useJob(jobId: string | null) {
  return useOp<JobRecord>('get_job', { jobId }, { enabled: !!jobId, refetchInterval: (q: any) => (active(q.state.data) || !q.state.data ? 800 : false) } as any);
}

/** Progress, counts and per-item errors of a job, with a cancel button while it runs. */
export function JobPanel({ job }: { job: JobRecord }) {
  const [cancelling, setCancelling] = useState(false);
  const r = job.result ?? {};
  const pct = job.total ? job.done / job.total : active(job) ? 0 : 1;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-raised p-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {active(job) ? <LoaderCircle className="size-4 shrink-0 animate-spin text-accent" /> : <StatusBadge status={job.status === 'completed' ? 'completed' : job.status === 'cancelled' ? 'cancelled' : 'failed'} />}
          <span className="truncate text-[0.84375rem] font-medium">{job.title}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[0.78125rem] tabular-nums text-ink-muted">
            {job.done} / {job.total || '…'}
          </span>
          {active(job) && (
            <Button
              size="sm"
              variant="ghost"
              icon={<CircleStop className="size-3.5" />}
              loading={cancelling}
              onClick={async () => {
                setCancelling(true);
                await op('cancel_job', { jobId: job.id }).catch((e) => {
                  toastError(e, 'Could not stop the job');
                  setCancelling(false);
                });
              }}
            >
              Stop
            </Button>
          )}
        </div>
      </div>
      <Progress value={pct} tone={job.status === 'failed' ? 'bad' : job.status === 'completed' && !r.failed ? 'ok' : 'accent'} />
      {!active(job) && (
        <div className="flex flex-wrap gap-1.5 text-[0.78125rem]">
          {!!r.created && <Badge tone="ok">{r.created} new rows</Badge>}
          {!!r.updated && <Badge tone="ok">{r.updated} rows updated</Badge>}
          {!!r.skipped && <Badge>{r.skipped} skipped</Badge>}
          {!!r.failed && <Badge tone="bad">{r.failed} failed</Badge>}
          {r.total === 0 && <span className="text-ink-muted">Nothing to do — every selected row already has a value.</span>}
        </div>
      )}
      {job.error && <ErrorBox error={new Error(job.error)} />}
      {job.errors.length > 0 && (
        <ul className="max-h-36 overflow-y-auto rounded-md bg-surface px-3 py-2 text-[0.78125rem] text-bad">
          {job.errors.slice(0, 20).map((e, i) => (
            <li key={i} className="truncate">
              {e.item ? <span className="text-ink-faint">{e.item}: </span> : null}
              {e.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Running or recently finished jobs for one dataset, shown above the rows. */
export function DatasetJobsStrip({ datasetId }: { datasetId: string }) {
  const qc = useQueryClient();
  const jobs = useOp<JobRecord[]>('list_jobs', { limit: 30 }, { refetchInterval: (q: any) => ((q.state.data ?? []).some(active) ? 1000 : false) } as any);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const mine = (jobs.data ?? []).filter((j) => j.meta?.datasetId === datasetId && !hidden.has(j.id) && (active(j) || (j.finishedAt && Date.now() - Date.parse(j.finishedAt) < 120_000)));
  const running = mine.some(active);
  useEffect(() => {
    if (!running) qc.invalidateQueries({ queryKey: ['list_rows'] });
  }, [running, qc]);
  if (!mine.length) return null;
  return (
    <div className="mb-4 flex flex-col gap-2">
      {mine.map((j) => (
        <div key={j.id} className="relative">
          <JobPanel job={j} />
          {!active(j) && (
            <button className="absolute right-3 top-3 text-[0.75rem] text-ink-faint hover:text-ink" onClick={() => setHidden(new Set([...hidden, j.id]))}>
              Dismiss
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/* Shared pieces ─────────────────────────────────────────────────────────── */

const NEW = '__new';

/** Pick a column of the right type, or create a new one on start. */
function ColumnChoice({
  label,
  help,
  columns,
  types,
  value,
  onChange,
  newName,
  onNewName,
  newType,
  allowNone,
}: {
  label: string;
  help: ReactNode;
  columns: ColumnDef[];
  types: ColumnType[];
  value: string;
  onChange: (v: string) => void;
  newName: string;
  onNewName: (v: string) => void;
  newType: ColumnType;
  allowNone?: string;
}) {
  const options = [
    ...(allowNone ? [{ value: '__none', label: allowNone }] : []),
    ...columns.filter((c) => types.includes(c.type)).map((c) => ({ value: c.key, label: c.key, hint: c.type })),
    { value: NEW, label: `+ New ${newType} column` },
  ];
  return (
    <Field label={label} help={help}>
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <Select value={value} onChange={onChange} options={options} />
        </div>
        {value === NEW && (
          <div className="min-w-0 flex-1">
            <Input mono value={newName} onChange={(e) => onNewName(e.target.value.replace(/[^A-Za-z0-9_]/g, '_'))} placeholder="column_name" />
          </div>
        )}
      </div>
    </Field>
  );
}

/** Creates the new column (if chosen) and returns the column key to use. Reads the latest schema first. */
async function ensureColumn(ds: DatasetSchemaResp, choice: string, newName: string, type: ColumnType): Promise<string> {
  if (choice !== NEW) return choice;
  const key = newName.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Give the new column a name (letters, digits and _)');
  const cur = await op<DatasetSchemaResp>('get_dataset_schema', { dataset: ds.id, sampleRows: 0 });
  const existing = cur.columns.find((c) => c.key === key);
  if (existing) {
    if (existing.type !== type && !(existing.type === 'file' && type !== 'text')) throw new Error(`Column "${key}" already exists as ${existing.type}`);
    return key;
  }
  await op('update_dataset', { dataset: ds.id, columns: [...cur.columns, { key, type, description: '', required: false }], baseRevision: cur.revision });
  return key;
}

const firstOf = (cols: ColumnDef[], types: ColumnType[]) => cols.find((c) => types.includes(c.type))?.key ?? NEW;

/** Approximate client-side preview of a template for a row ({{col}} and {{row.col}} only). */
function previewTemplate(tpl: string, row: RowRecord) {
  return tpl.replace(/\{\{\s*(?:row\.)?([A-Za-z_][\w]*)[^}]*\}\}/g, (_, k) => {
    const v = row.data[k];
    return v == null ? '' : typeof v === 'object' ? ((v as any).name ?? JSON.stringify(v)) : String(v);
  });
}

function ColumnChips({ columns, onInsert }: { columns: ColumnDef[]; onInsert: (s: string) => void }) {
  if (!columns.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-[0.75rem] text-ink-faint">
      Insert:
      {columns.map((c) => (
        <button key={c.key} type="button" onClick={() => onInsert(`{{${c.key}}}`)} className="rounded border border-line bg-raised px-1.5 font-mono text-ink-muted hover:border-line-strong hover:text-ink">
          {`{{${c.key}}}`}
        </button>
      ))}
    </div>
  );
}

type Scope = 'empty' | 'all' | 'selected';

function ScopeChoice({ value, onChange, selectedCount, emptyLabel = 'Only rows without one' }: { value: Scope; onChange: (s: Scope) => void; selectedCount: number; emptyLabel?: string }) {
  const opts: { value: Scope; label: string }[] = [
    { value: 'empty', label: emptyLabel },
    { value: 'all', label: 'All rows (replace)' },
  ];
  if (selectedCount) opts.push({ value: 'selected', label: `${selectedCount} selected` });
  return (
    <Field label="Which rows" help="Rejected rows are skipped unless you select them. Replacing keeps a version history, so nothing is lost.">
      <Segmented<Scope> value={value} onChange={onChange} options={opts} />
    </Field>
  );
}

/** Loads a sample of rows for previews and estimates. */
function useSampleRows(datasetId: string, open: boolean) {
  return useOp<{ total: number; rows: RowRecord[] }>('list_rows', { dataset: datasetId, limit: 500 }, { enabled: open });
}

function NoConnections() {
  return (
    <div className="rounded-lg border border-line bg-raised p-3.5 text-[0.8125rem] text-ink-muted">
      No model connections yet. <Link to="/connections" className="font-medium text-accent-ink hover:underline">Add a connection</Link> (for example OpenAI with an image or speech model) to use this.
    </div>
  );
}

/** Dialog chrome shared by the media dialogs: form until started, then live job progress. */
function JobDialog({
  open,
  onOpenChange,
  title,
  description,
  startLabel,
  canStart,
  onStart,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: ReactNode;
  startLabel: string;
  canStart: boolean;
  onStart: () => Promise<string>;
  children: ReactNode;
}) {
  const qc = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const job = useJob(jobId);
  const finished = job.data && !active(job.data);

  useEffect(() => {
    if (!finished) return;
    qc.invalidateQueries({ queryKey: ['list_rows'] });
    qc.invalidateQueries({ queryKey: ['get_dataset_schema'] });
    const r = job.data!.result ?? {};
    if (job.data!.status === 'completed') toast.success(`${title}: done`, [r.created && `${r.created} new rows`, r.updated && `${r.updated} rows updated`, r.failed && `${r.failed} failed`].filter(Boolean).join(' · ') || undefined);
  }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = (o: boolean) => {
    if (!o) {
      setJobId(null);
      setError(null);
    }
    onOpenChange(o);
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setJobId(await onStart());
      qc.invalidateQueries({ queryKey: ['get_dataset_schema'] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={title}
      description={description}
      width="lg"
      footer={
        jobId ? (
          <>
            {!finished && <span className="mr-auto self-center text-[0.78125rem] text-ink-faint">You can close this window; the job keeps running and shows above the rows.</span>}
            <Button variant={finished ? 'primary' : 'secondary'} onClick={() => close(false)}>
              {finished ? 'Done' : 'Close'}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => close(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!canStart} onClick={start}>
              {startLabel}
            </Button>
          </>
        )
      }
    >
      {jobId ? job.data ? <JobPanel job={job.data} /> : <div className="text-[0.8125rem] text-ink-muted">Starting…</div> : <div className="flex flex-col gap-5">{children}<ErrorBox error={error} /></div>}
    </Dialog>
  );
}

function useConnectionSpec(id: string | undefined) {
  const conns = useOp<any[]>('list_connections');
  return { list: conns.data, spec: conns.data?.find((c) => c.id === id)?.spec as any };
}

/* Generate images ───────────────────────────────────────────────────────── */

export function GenerateImagesDialog({ open, onOpenChange, ds, selectedIds }: { open: boolean; onOpenChange: (o: boolean) => void; ds: DatasetSchemaResp; selectedIds: string[] }) {
  const [mode, setMode] = useState<'fill' | 'new'>('fill');
  const [connectionId, setConnectionId] = useState<string>();
  const [model, setModel] = useState('');
  const [column, setColumn] = useState(() => firstOf(ds.columns, ['image']));
  const [newColumn, setNewColumn] = useState('image');
  const textCols = ds.columns.filter((c) => c.type === 'text');
  const [template, setTemplate] = useState(() => (textCols[0] ? `A clear, realistic photo of {{${textCols[0].key}}}` : ''));
  const [prompts, setPrompts] = useState('');
  const [promptColumn, setPromptColumn] = useState(() => textCols[0]?.key ?? '__none');
  const [newPromptColumn, setNewPromptColumn] = useState('prompt');
  const [size, setSize] = useState('default');
  const [quality, setQuality] = useState('medium');
  const [maxSize, setMaxSize] = useState('any');
  const [customKb, setCustomKb] = useState('');
  const [scope, setScope] = useState<Scope>(selectedIds.length ? 'selected' : 'empty');
  const { list, spec } = useConnectionSpec(connectionId);
  const sample = useSampleRows(ds.id, open && mode === 'fill');
  const isOpenAI = spec?.provider === 'openai' || spec?.provider === 'azure';

  useEffect(() => {
    if (open) setScope(selectedIds.length ? 'selected' : 'empty');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const promptList = prompts.split('\n').map((p) => p.trim()).filter(Boolean);
  const targetRows = useMemo(() => {
    const rows = (sample.data?.rows ?? []).filter((r) => r.status !== 'rejected');
    if (scope === 'selected') return rows.filter((r) => selectedIds.includes(r.id));
    if (scope === 'empty') return rows.filter((r) => column === NEW || r.data[column] == null || r.data[column] === '');
    return rows;
  }, [sample.data, scope, column, selectedIds]);
  const count = mode === 'new' ? promptList.length : scope === 'selected' ? selectedIds.length : targetRows.length;
  // KB here means 1000 bytes, like Finder and Explorer show file sizes.
  const maxKb = maxSize === 'any' ? undefined : maxSize === 'custom' ? Number(customKb) || undefined : Number(maxSize);
  const customInvalid = maxSize === 'custom' && !(Number(customKb) > 0);
  const modelHint = spec?.imageModel || (/(image|dall-e|imagen)/i.test(spec?.defaultModel ?? '') ? spec.defaultModel : '') || 'gpt-image-2';

  return (
    <JobDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Generate images"
      description="An image model draws one image per row (or per prompt) and stores it in an image column."
      startLabel={count ? `Generate ${count} image${count === 1 ? '' : 's'}` : 'Generate'}
      canStart={!!connectionId && count > 0 && (mode === 'new' || !!template.trim()) && !customInvalid}
      onStart={async () => {
        const col = await ensureColumn(ds, column, newColumn, 'image');
        const common = { dataset: ds.id, column: col, connectionId, model, size: size === 'default' ? '' : size, quality: isOpenAI ? quality : '', ...(maxKb ? { maxKb } : {}) };
        if (mode === 'new') {
          const pc = promptColumn === '__none' ? '' : await ensureColumn(ds, promptColumn, newPromptColumn, 'text');
          return (await op('generate_images', { ...common, mode: 'new_rows', prompts: promptList, promptColumn: pc })).jobId;
        }
        return (await op('generate_images', { ...common, mode: scope === 'all' || scope === 'selected' ? 'overwrite' : 'fill_empty', promptTemplate: template, rowIds: scope === 'selected' ? selectedIds : undefined })).jobId;
      }}
    >
      {list && list.length === 0 && <NoConnections />}
      <Segmented<'fill' | 'new'>
        value={mode}
        onChange={setMode}
        options={[
          { value: 'fill', label: 'Add images to existing rows' },
          { value: 'new', label: 'New rows from prompts' },
        ]}
      />
      <div className="grid grid-cols-2 gap-4">
        <Field label="Connection" help="A provider with an image model, e.g. OpenAI (GPT Image), Google (Imagen / Gemini image), Azure or Bedrock.">
          <ConnectionPicker value={connectionId} onChange={setConnectionId} />
        </Field>
        <Field label="Image model" help="Leave empty to use the connection's image model.">
          <Input mono value={model} onChange={(e) => setModel(e.target.value)} placeholder={modelHint} />
        </Field>
      </div>
      <ColumnChoice label="Store images in" help="An image column of this dataset. Pick “New image column” to add one." columns={ds.columns} types={['image', 'file']} value={column} onChange={setColumn} newName={newColumn} onNewName={setNewColumn} newType="image" />
      {mode === 'fill' ? (
        <>
          <Field label="Prompt" help="Written once and filled in for every row. Use {{column}} to insert that row's values.">
            <Textarea rows={3} value={template} onChange={(e) => setTemplate(e.target.value)} placeholder="A product photo of {{item}} on a kitchen table, natural light" />
          </Field>
          <ColumnChips columns={ds.columns.filter((c) => c.type !== 'image' && c.type !== 'audio' && c.type !== 'file')} onInsert={(s) => setTemplate((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${s}`)} />
          <ScopeChoice value={scope} onChange={setScope} selectedCount={selectedIds.length} emptyLabel="Only rows without an image" />
          {targetRows.length > 0 && template && (
            <Field label="Preview">
              <ul className="flex flex-col gap-1 rounded-lg bg-raised px-3 py-2 text-[0.78125rem] text-ink-muted">
                {targetRows.slice(0, 3).map((r) => (
                  <li key={r.id} className="truncate">
                    <span className="text-ink-faint">#{r.seq}</span> {previewTemplate(template, r)}
                  </li>
                ))}
              </ul>
            </Field>
          )}
        </>
      ) : (
        <>
          <Field label="Prompts" help="One per line. Each prompt becomes a new row with its image. New rows are marked “Needs review”.">
            <Textarea rows={5} value={prompts} onChange={(e) => setPrompts(e.target.value)} placeholder={'A cluttered desk with a laptop and coffee\nA receipt from a grocery store, photographed at an angle\nA street sign in heavy rain'} />
          </Field>
          <ColumnChoice label="Save each prompt in" help="Keeps the prompt next to its image, e.g. as the expected description for a captioning test." columns={ds.columns} types={['text']} value={promptColumn} onChange={setPromptColumn} newName={newPromptColumn} onNewName={setNewPromptColumn} newType="text" allowNone="Don't save the prompt" />
        </>
      )}
      <div className="grid grid-cols-2 gap-4">
        <Field label="Size" help="Square, landscape or portrait. Some providers use their own sizes; Default lets the model choose.">
          <Select
            value={size}
            onChange={setSize}
            options={[
              { value: 'default', label: 'Default' },
              { value: '1024x1024', label: 'Square · 1024×1024' },
              { value: '1536x1024', label: 'Landscape · 1536×1024' },
              { value: '1024x1536', label: 'Portrait · 1024×1536' },
            ]}
          />
        </Field>
        {isOpenAI && (
          <Field label="Quality" help="Higher quality costs more and takes longer. Medium is a good default for test data.">
            <Segmented
              value={quality}
              onChange={setQuality}
              options={[
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
              ]}
            />
          </Field>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Max file size"
          help="Keeps every image at or under this size, e.g. for small test images. Larger images are saved as JPEG and scaled down until they fit; images that already fit are kept as they are. Any = no limit."
        >
          <Select
            value={maxSize}
            onChange={setMaxSize}
            options={[
              { value: 'any', label: 'Any' },
              { value: '50', label: '50 KB' },
              { value: '100', label: '100 KB' },
              { value: '250', label: '250 KB' },
              { value: '500', label: '500 KB' },
              { value: '1000', label: '1 MB' },
              { value: 'custom', label: 'Custom…' },
            ]}
          />
        </Field>
        {maxSize === 'custom' && (
          <Field label="Limit (KB)" help="1 KB = 1000 bytes.">
            <Input type="number" min={1} step={1} value={customKb} onChange={(e) => setCustomKb(e.target.value)} placeholder="e.g. 80" />
          </Field>
        )}
      </div>
      {count > 0 && (
        <div className="text-[0.78125rem] text-ink-faint">
          {count} image{count === 1 ? '' : 's'}
          {isOpenAI ? ` at ${quality} quality` : ''}
          {maxKb ? `, each kept under ${maxKb >= 1000 ? `${maxKb / 1000} MB` : `${maxKb} KB`}` : ''} — each one is a paid call to your provider.
        </div>
      )}
    </JobDialog>
  );
}

/* Generate speech ───────────────────────────────────────────────────────── */

const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

export function GenerateSpeechDialog({ open, onOpenChange, ds, selectedIds }: { open: boolean; onOpenChange: (o: boolean) => void; ds: DatasetSchemaResp; selectedIds: string[] }) {
  const [connectionId, setConnectionId] = useState<string>();
  const [model, setModel] = useState('');
  const [column, setColumn] = useState(() => firstOf(ds.columns, ['audio']));
  const [newColumn, setNewColumn] = useState('audio');
  const textCol = ds.columns.find((c) => c.key === 'reference' || c.key === 'text') ?? ds.columns.find((c) => c.type === 'text');
  const [template, setTemplate] = useState(textCol ? `{{${textCol.key}}}` : '');
  const [voices, setVoices] = useState<string[]>(['alloy', 'coral']);
  const [instructions, setInstructions] = useState('');
  const [speed, setSpeed] = useState('');
  const [scope, setScope] = useState<Scope>(selectedIds.length ? 'selected' : 'empty');
  const { list, spec } = useConnectionSpec(connectionId);
  const sample = useSampleRows(ds.id, open);

  useEffect(() => {
    if (open) setScope(selectedIds.length ? 'selected' : 'empty');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const targetRows = useMemo(() => {
    const rows = (sample.data?.rows ?? []).filter((r) => r.status !== 'rejected');
    if (scope === 'selected') return rows.filter((r) => selectedIds.includes(r.id));
    if (scope === 'empty') return rows.filter((r) => column === NEW || r.data[column] == null || r.data[column] === '');
    return rows;
  }, [sample.data, scope, column, selectedIds]);
  const count = scope === 'selected' ? selectedIds.length : targetRows.length;

  return (
    <JobDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Generate speech"
      description="A text-to-speech model reads each row's text aloud and stores the recording in an audio column — handy for building speech-to-text test sets from transcripts."
      startLabel={count ? `Generate ${count} clip${count === 1 ? '' : 's'}` : 'Generate'}
      canStart={!!connectionId && count > 0 && !!template.trim()}
      onStart={async () => {
        const col = await ensureColumn(ds, column, newColumn, 'audio');
        return (
          await op('generate_speech', {
            dataset: ds.id,
            column: col,
            textTemplate: template,
            voices,
            instructionsTemplate: instructions,
            speed: speed ? Number(speed) : undefined,
            connectionId,
            model,
            mode: scope === 'empty' ? 'fill_empty' : 'overwrite',
            rowIds: scope === 'selected' ? selectedIds : undefined,
          })
        ).jobId;
      }}
    >
      {list && list.length === 0 && <NoConnections />}
      <div className="grid grid-cols-2 gap-4">
        <Field label="Connection" help="A provider with a text-to-speech model, e.g. OpenAI (gpt-4o-mini-tts) or Google.">
          <ConnectionPicker value={connectionId} onChange={setConnectionId} />
        </Field>
        <Field label="Speech model" help="Leave empty to use the connection's speech model.">
          <Input mono value={model} onChange={(e) => setModel(e.target.value)} placeholder={spec?.speechModel || 'gpt-4o-mini-tts'} />
        </Field>
      </div>
      <ColumnChoice label="Store audio in" help="An audio column of this dataset. Pick “New audio column” to add one." columns={ds.columns} types={['audio', 'file']} value={column} onChange={setColumn} newName={newColumn} onNewName={setNewColumn} newType="audio" />
      <Field label="Text to speak" help="Usually the reference transcript, e.g. {{reference}}, so the recording and its expected text always match.">
        <Input mono value={template} onChange={(e) => setTemplate(e.target.value)} placeholder="{{reference}}" />
      </Field>
      <Field
        label="Voices"
        help={
          <>
            Rows rotate through these voices and get a <code>voice:name</code> tag, so you can compare results per voice. OpenAI voices: {OPENAI_VOICES.join(', ')}.
          </>
        }
      >
        <TagInput value={voices} onChange={setVoices} placeholder="Add a voice and press Enter" />
      </Field>
      <div className="grid grid-cols-[1fr_140px] gap-4">
        <Field label="Speaking style" help="Instructions for models that accept them (e.g. gpt-4o-mini-tts): accent, emotion, pace. {{column}} works, e.g. “Speak with a {{accent}} accent”.">
          <Input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. Indian English accent, a little rushed" />
        </Field>
        <Field label="Speed" help="1 is normal. 0.8 is slower, 1.3 faster. Leave empty for the default.">
          <Input type="number" min={0.25} max={4} step={0.05} value={speed} onChange={(e) => setSpeed(e.target.value)} placeholder="1.0" />
        </Field>
      </div>
      <ScopeChoice value={scope} onChange={setScope} selectedCount={selectedIds.length} emptyLabel="Only rows without audio" />
      {targetRows.length > 0 && template && (
        <Field label="Preview">
          <ul className="flex flex-col gap-1 rounded-lg bg-raised px-3 py-2 text-[0.78125rem] text-ink-muted">
            {targetRows.slice(0, 3).map((r, i) => (
              <li key={r.id} className="truncate">
                <span className="text-ink-faint">#{r.seq}</span> {voices.length ? <Badge className="mr-1">{voices[i % voices.length]}</Badge> : null}
                {previewTemplate(template, r)}
              </li>
            ))}
          </ul>
        </Field>
      )}
      <div className="rounded-lg bg-raised px-3 py-2 text-[0.78125rem] text-ink-muted">
        Synthetic speech is cleaner than real recordings. Keep some real audio in the set, and use <b>Make audio variants</b> to add noise or a phone line.
      </div>
    </JobDialog>
  );
}

/* Transcribe ────────────────────────────────────────────────────────────── */

export function TranscribeDialog({ open, onOpenChange, ds, selectedIds }: { open: boolean; onOpenChange: (o: boolean) => void; ds: DatasetSchemaResp; selectedIds: string[] }) {
  const [connectionId, setConnectionId] = useState<string>();
  const [model, setModel] = useState('');
  const [audioColumn, setAudioColumn] = useState(() => ds.columns.find((c) => c.type === 'audio')?.key ?? '');
  const [textColumn, setTextColumn] = useState(() => (ds.columns.some((c) => c.key === 'reference') ? 'reference' : NEW));
  const [newText, setNewText] = useState('transcript');
  const [scope, setScope] = useState<Scope>(selectedIds.length ? 'selected' : 'empty');
  const [review, setReview] = useState(true);
  const { list, spec } = useConnectionSpec(connectionId);
  const audioCols = ds.columns.filter((c) => c.type === 'audio' || c.type === 'file');

  useEffect(() => {
    if (open) setScope(selectedIds.length ? 'selected' : 'empty');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <JobDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Transcribe audio into a column"
      description="A speech-to-text model writes a transcript for each recording. Good for bootstrapping reference transcripts that a person then corrects."
      startLabel="Transcribe"
      canStart={!!connectionId && !!audioColumn && audioCols.length > 0}
      onStart={async () => {
        const col = await ensureColumn(ds, textColumn, newText, 'text');
        return (
          await op('transcribe_rows', {
            dataset: ds.id,
            audioColumn,
            textColumn: col,
            connectionId,
            model,
            mode: scope === 'empty' ? 'fill_empty' : 'overwrite',
            rowIds: scope === 'selected' ? selectedIds : undefined,
            status: review ? 'needs_review' : 'approved',
          })
        ).jobId;
      }}
    >
      {list && list.length === 0 && <NoConnections />}
      {audioCols.length === 0 && <div className="rounded-lg bg-warn-soft px-3 py-2 text-[0.78125rem] text-warn">This dataset has no audio column yet.</div>}
      <div className="grid grid-cols-2 gap-4">
        <Field label="Connection" help="A provider with a transcription model, e.g. OpenAI (gpt-4o-transcribe) or Google.">
          <ConnectionPicker value={connectionId} onChange={setConnectionId} />
        </Field>
        <Field label="Transcription model" help="Leave empty to use the connection's transcription model.">
          <Input mono value={model} onChange={(e) => setModel(e.target.value)} placeholder={spec?.transcriptionModel || 'gpt-4o-transcribe'} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Audio column">
          <Select value={audioColumn} onChange={setAudioColumn} options={audioCols.map((c) => ({ value: c.key, label: c.key }))} />
        </Field>
        <ColumnChoice label="Write text into" help="A text column. Careful: picking your reference column with “All rows” replaces existing references." columns={ds.columns} types={['text']} value={textColumn} onChange={setTextColumn} newName={newText} onNewName={setNewText} newType="text" />
      </div>
      <ScopeChoice value={scope} onChange={setScope} selectedCount={selectedIds.length} emptyLabel="Only rows without text" />
      <Field label="Mark for review" inline help="Transcribed rows get the “Needs review” status so someone checks them before they count as ground truth.">
        <Switch checked={review} onChange={setReview} />
      </Field>
    </JobDialog>
  );
}

/* Audio variants ────────────────────────────────────────────────────────── */

type Effect =
  | { type: 'noise'; snrDb: number; color: 'white' | 'pink' }
  | { type: 'telephone' }
  | { type: 'reverb'; amount: number }
  | { type: 'gain'; db: number }
  | { type: 'clip'; level: number }
  | { type: 'speed'; rate: number }
  | { type: 'lowpass'; hz: number }
  | { type: 'dropouts'; percent: number };

interface Recipe {
  on: boolean;
  name: string;
  effects: Effect[];
  hint: string;
}

const PRESETS: Recipe[] = [
  { on: true, name: 'Noisy café', effects: [{ type: 'noise', snrDb: 10, color: 'pink' }], hint: 'Background chatter-like noise, 10 dB below the voice' },
  { on: true, name: 'Phone line', effects: [{ type: 'telephone' }], hint: '8 kHz narrowband call quality (μ-law)' },
  { on: false, name: 'Phone in a noisy street', effects: [{ type: 'noise', snrDb: 12, color: 'white' }, { type: 'telephone' }], hint: 'Noise first, then the phone line' },
  { on: false, name: 'Echoey room', effects: [{ type: 'reverb', amount: 0.6 }], hint: 'Speaker far from the mic in a hard room' },
  { on: false, name: 'Quiet speaker', effects: [{ type: 'gain', db: -18 }], hint: '18 dB quieter' },
  { on: false, name: 'Fast speech', effects: [{ type: 'speed', rate: 1.2 }], hint: '20% faster (pitch rises too)' },
  { on: false, name: 'Clipped mic', effects: [{ type: 'clip', level: 0.35 }], hint: 'Too loud for the microphone' },
  { on: false, name: 'Muffled', effects: [{ type: 'lowpass', hz: 1500 }], hint: 'Through a mask or a wall' },
  { on: false, name: 'Dropouts', effects: [{ type: 'dropouts', percent: 5 }], hint: '5% of 20 ms frames lost, like a bad connection' },
];

const PARAMS: Record<string, { key: string; label: string; step: number; help: ReactNode }[]> = {
  noise: [{ key: 'snrDb', label: 'SNR dB', step: 1, help: 'Signal-to-noise ratio: how much louder the voice is than the noise. 20 is mild, 10 is noticeable, 0 is as loud as the voice.' }],
  reverb: [{ key: 'amount', label: 'Amount', step: 0.1, help: '0 is dry, 1 is a large echoey hall.' }],
  gain: [{ key: 'db', label: 'dB', step: 1, help: 'Negative makes it quieter. −6 dB is about half the loudness.' }],
  clip: [{ key: 'level', label: 'Level', step: 0.05, help: 'Fraction of the peak where the signal flattens. Lower = more distortion.' }],
  speed: [{ key: 'rate', label: 'Rate', step: 0.05, help: '1.2 = 20% faster. Pitch changes with speed.' }],
  lowpass: [{ key: 'hz', label: 'Hz', step: 100, help: 'Frequencies above this are cut, making speech muffled.' }],
  dropouts: [{ key: 'percent', label: '%', step: 1, help: 'Share of 20 ms frames replaced with silence.' }],
};

export function AudioVariantsDialog({ open, onOpenChange, ds, selectedIds }: { open: boolean; onOpenChange: (o: boolean) => void; ds: DatasetSchemaResp; selectedIds: string[] }) {
  const audioCols = ds.columns.filter((c) => c.type === 'audio' || c.type === 'file');
  const [source, setSource] = useState(() => audioCols[0]?.key ?? '');
  const [recipes, setRecipes] = useState<Recipe[]>(() => PRESETS.map((p) => ({ ...p, effects: p.effects.map((e) => ({ ...e })) })));
  const [scope, setScope] = useState<'all' | 'selected'>(selectedIds.length ? 'selected' : 'all');
  const [includeAugmented, setIncludeAugmented] = useState(false);
  const sample = useSampleRows(ds.id, open);

  useEffect(() => {
    if (open) setScope(selectedIds.length ? 'selected' : 'all');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = recipes.filter((r) => r.on);
  const sourceCount =
    scope === 'selected'
      ? selectedIds.length
      : (sample.data?.rows ?? []).filter((r) => r.status !== 'rejected' && r.data[source] && (includeAugmented || !r.tags.some((t) => t.startsWith('aug:')))).length;
  const total = sourceCount * chosen.length;

  const setEffect = (ri: number, ei: number, key: string, v: number) =>
    setRecipes((rs) => rs.map((r, i) => (i !== ri ? r : { ...r, effects: r.effects.map((e, j) => (j !== ei ? e : ({ ...e, [key]: v } as Effect))) })));

  return (
    <JobDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Make audio variants"
      description="Creates harder copies of your recordings: noise, phone lines, echo and more. Each variant is a new row with the same expected text and an aug:… tag, so you can compare accuracy on clean vs. degraded audio."
      startLabel={total ? `Create ${total} variant${total === 1 ? '' : 's'}` : 'Create variants'}
      canStart={!!source && total > 0}
      onStart={async () =>
        (
          await op('augment_audio', {
            dataset: ds.id,
            sourceColumn: source,
            recipes: chosen.map((r) => ({ name: r.name, effects: r.effects })),
            rowIds: scope === 'selected' ? selectedIds : undefined,
            includeAugmented,
          })
        ).jobId
      }
    >
      {audioCols.length === 0 && <div className="rounded-lg bg-warn-soft px-3 py-2 text-[0.78125rem] text-warn">This dataset has no audio column yet.</div>}
      <div className="grid grid-cols-2 gap-4">
        <Field label="Audio column" help="The recordings to transform. Other columns are copied to the new rows unchanged.">
          <Select value={source} onChange={setSource} options={audioCols.map((c) => ({ value: c.key, label: c.key }))} />
        </Field>
        <Field label="Which rows" help="Rows that are already variants are left out unless you include them below.">
          <Segmented<'all' | 'selected'>
            value={scope}
            onChange={setScope}
            options={[{ value: 'all', label: 'All recordings' }, ...(selectedIds.length ? [{ value: 'selected' as const, label: `${selectedIds.length} selected` }] : [])]}
          />
        </Field>
      </div>
      <Field label="Variants" help="Tick the conditions to simulate. Each ticked variant makes one new row per recording. Effects are deterministic, so re-running skips variants that already exist.">
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {recipes.map((r, ri) => (
            <li key={ri} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <input type="checkbox" className="size-4 accent-[var(--k-accent)]" checked={r.on} onChange={(e) => setRecipes((rs) => rs.map((x, i) => (i === ri ? { ...x, on: e.target.checked } : x)))} aria-label={`Use ${r.name}`} />
              <div className="min-w-0 flex-1">
                <div className="text-[0.84375rem] font-medium">{r.name}</div>
                <div className="text-[0.75rem] text-ink-faint">{r.hint}</div>
              </div>
              <div className="flex items-center gap-2">
                {r.effects.flatMap((e, ei) =>
                  (PARAMS[e.type] ?? []).map((p) => (
                    <label key={`${ei}-${p.key}`} className="flex items-center gap-1 text-[0.75rem] text-ink-muted">
                      {p.label}
                      <HelpTip>{p.help}</HelpTip>
                      <input
                        type="number"
                        step={p.step}
                        value={(e as any)[p.key]}
                        disabled={!r.on}
                        onChange={(ev) => setEffect(ri, ei, p.key, Number(ev.target.value))}
                        className="h-7 w-16 rounded-md border border-line-strong bg-surface px-1.5 text-[0.78125rem] tabular-nums focus:border-accent focus:outline-none disabled:opacity-50"
                      />
                    </label>
                  )),
                )}
              </div>
            </li>
          ))}
        </ul>
      </Field>
      <Field label="Also transform rows that are already variants" inline help="Off by default, so variants are not stacked on variants.">
        <Switch checked={includeAugmented} onChange={setIncludeAugmented} />
      </Field>
      {total > 0 && (
        <div className="text-[0.78125rem] text-ink-faint">
          {sourceCount} recording{sourceCount === 1 ? '' : 's'} × {chosen.length} variant{chosen.length === 1 ? '' : 's'} = {total} new rows. Processing happens on this machine; no model calls.
        </div>
      )}
    </JobDialog>
  );
}
