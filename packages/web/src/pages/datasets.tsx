import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { AudioLines, Bot, Captions, Check, Database, Download, Ellipsis, FileSpreadsheet, Image as ImageIcon, Plus, Save, Search, ShieldAlert, Sparkles, Trash2, Undo2, Upload, Waves, X } from 'lucide-react';
import { ApiError, fileUrl, op, useOp } from '../lib/api';
import { actorLabel, dateTime, timeAgo } from '../lib/format';
import { BackLink, Page } from '../components/layout/shell';
import { Button } from '../components/ui/button';
import { Badge, EmptyState, ErrorBox, Loading, StatusBadge, TabPanel, Tabs } from '../components/ui/display';
import { Field, Input, Segmented, Select, Textarea } from '../components/ui/form';
import { CellValue } from '../components/ui/media';
import { HelpTip, Menu, MenuItem, MenuSeparator, useConfirm } from '../components/ui/overlay';
import { DataTable, SimpleTable, type Column } from '../components/ui/table';
import { toast, toastError } from '../components/ui/toast';
import { ColumnsEditor, columnErrors } from '../components/datasets/columns-editor';
import { GenerateDialog, ImportDialog, NewDatasetDialog, SaveVersionDialog, UploadFilesDialog } from '../components/datasets/dialogs';
import { SafetyPackDialog } from '../components/datasets/safety-dialog';
import { RowSheet } from '../components/datasets/row-sheet';
import { AudioVariantsDialog, DatasetJobsStrip, GenerateImagesDialog, GenerateSpeechDialog, TranscribeDialog } from '../components/datasets/media-dialogs';
import type { ColumnDef, DatasetSchemaResp, RowRecord, RowStatus } from '../components/datasets/types';

/* Datasets list ──────────────────────────────────────────────────────────── */

export function DatasetsPage() {
  const navigate = useNavigate();
  const q = useOp<any[]>('list_datasets');
  const [creating, setCreating] = useState(false);
  const [safety, setSafety] = useState(false);

  const columns: Column<any>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 'minmax(260px, 3fr)',
      render: (d) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{d.name}</div>
          {d.description && <div className="truncate text-[0.78125rem] text-ink-muted">{d.description}</div>}
        </div>
      ),
    },
    { key: 'rows', header: 'Rows', width: '90px', align: 'right', render: (d) => <span className="tabular-nums">{d.rowCount}</span> },
    {
      key: 'review',
      header: 'Review',
      help: 'Rows added by agents, models or imports that are waiting for a person to approve or reject them.',
      width: '130px',
      render: (d) => (d.reviewCount > 0 ? <Badge tone="warn">{d.reviewCount} to review</Badge> : <span className="text-ink-faint">—</span>),
    },
    { key: 'cols', header: 'Columns', width: '90px', align: 'right', render: (d) => <span className="tabular-nums">{d.schema?.columns?.length ?? 0}</span> },
    {
      key: 'version',
      header: 'Version',
      help: 'The latest saved, frozen version. Runs save a version automatically.',
      width: '90px',
      render: (d) => (d.latestVersion ? <span className="tabular-nums">v{d.latestVersion}</span> : <span className="text-ink-faint">—</span>),
    },
    { key: 'updated', header: 'Updated', width: '130px', render: (d) => <span className="text-ink-muted">{timeAgo(d.updatedAt)}</span> },
  ];

  return (
    <Page
      title="Datasets"
      description="Test cases for your AI app: inputs, expected answers, recordings and images. Every column can be sent to your app and compared against."
      actions={
        <>
          <Button icon={<ShieldAlert className="size-4" />} onClick={() => setSafety(true)}>
            Safety pack
          </Button>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            New dataset
          </Button>
        </>
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : !q.data?.length ? (
        <EmptyState
          icon={<Database />}
          title="No datasets yet"
          action={
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              Create your first dataset
            </Button>
          }
        >
          A dataset is a table of test cases. Fill it by hand, import a CSV, upload recordings, generate rows with a model, or let your coding agent write them.
        </EmptyState>
      ) : (
        <SimpleTable rows={q.data} columns={columns} rowKey={(d) => d.id} onRowClick={(d) => navigate(`/datasets/${d.id}`)} />
      )}
      <NewDatasetDialog open={creating} onOpenChange={setCreating} />
      <SafetyPackDialog open={safety} onOpenChange={setSafety} />
    </Page>
  );
}

/* Dataset detail ─────────────────────────────────────────────────────────── */

type Dlg = null | 'upload' | 'import' | 'generate' | 'version' | 'images' | 'speech' | 'variants' | 'transcribe';

export function DatasetDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const schema = useOp<DatasetSchemaResp>('get_dataset_schema', { dataset: id, sampleRows: 0 });
  const [tab, setTab] = useState('rows');
  const [dialog, setDialog] = useState<Dlg>(null);
  const [sheetRow, setSheetRow] = useState<RowRecord | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const confirm = useConfirm();

  const exportAs = async (format: 'csv' | 'jsonl') => {
    try {
      const res = await op('export_dataset', { dataset: id, format });
      const a = document.createElement('a');
      a.href = fileUrl(res.hash, true);
      a.download = res.name ?? `dataset.${format}`;
      a.click();
      toast.success(`Exported ${res.rows} rows`);
    } catch (e) {
      toastError(e, 'Export failed');
    }
  };

  const remove = async () => {
    if (!(await confirm.ask(`Delete “${schema.data?.name}”?`, 'The dataset moves to the trash. Runs that used it keep their results.'))) return;
    try {
      await op('delete_dataset', { dataset: id });
      qc.invalidateQueries({ queryKey: ['list_datasets'] });
      navigate('/datasets');
    } catch (e) {
      toastError(e, 'Could not delete the dataset');
    }
  };

  if (schema.isLoading) return <Loading />;
  if (schema.error || !schema.data)
    return (
      <Page title="Dataset" back={<BackLink to="/datasets">Datasets</BackLink>}>
        <ErrorBox error={schema.error ?? new Error('Dataset not found')} />
      </Page>
    );
  const ds = schema.data;

  return (
    <Page
      width="wide"
      back={<BackLink to="/datasets">Datasets</BackLink>}
      title={ds.name}
      description={ds.description || undefined}
      badge={<Badge>{ds.stats.total} rows</Badge>}
      actions={
        <>
          <Menu
            align="start"
            trigger={
              <Button variant="primary" icon={<Plus className="size-4" />}>
                Add rows
              </Button>
            }
          >
            <MenuItem icon={<Plus />} hint="Fill in one row in a form" onSelect={() => (setSheetRow(null), setSheetOpen(true))}>
              Add a row
            </MenuItem>
            <MenuItem icon={<Upload />} hint="One row per file, plus an optional labels CSV" onSelect={() => setDialog('upload')}>
              Upload audio or image files
            </MenuItem>
            <MenuItem icon={<FileSpreadsheet />} hint="CSV, JSONL or JSON" onSelect={() => setDialog('import')}>
              Import a file
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Sparkles />} hint="Uses one of your model connections" onSelect={() => setDialog('generate')}>
              Generate with a model
            </MenuItem>
            <MenuItem icon={<ImageIcon />} hint="GPT Image, Imagen… one image per row or prompt" onSelect={() => setDialog('images')}>
              Generate images
            </MenuItem>
            <MenuItem icon={<AudioLines />} hint="Read text aloud with a text-to-speech model" onSelect={() => setDialog('speech')}>
              Generate speech (TTS)
            </MenuItem>
            <MenuItem icon={<Waves />} hint="Noise, phone line, echo, fast speech…" onSelect={() => setDialog('variants')}>
              Make audio variants
            </MenuItem>
            <MenuItem icon={<Captions />} hint="Fill a text column from the audio" onSelect={() => setDialog('transcribe')}>
              Transcribe audio into a column
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Bot />} hint="Claude Code, Codex, Cursor… through MCP" onSelect={() => navigate('/agents')}>
              Fill with a coding agent
            </MenuItem>
          </Menu>
          <Menu align="start" trigger={<Button icon={<Download className="size-4" />}>Export</Button>}>
            <MenuItem hint="Opens in spreadsheets; files export as names" onSelect={() => exportAs('csv')}>
              CSV
            </MenuItem>
            <MenuItem hint="One JSON object per line, with row ids" onSelect={() => exportAs('jsonl')}>
              JSONL
            </MenuItem>
          </Menu>
          <Button icon={<Save className="size-4" />} onClick={() => setDialog('version')}>
            Save version
          </Button>
          <Menu
            trigger={
              <Button size="icon" aria-label="More actions">
                <Ellipsis className="size-4" />
              </Button>
            }
          >
            <MenuItem icon={<Trash2 />} danger onSelect={remove}>
              Delete dataset
            </MenuItem>
          </Menu>
        </>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'rows', label: 'Rows', count: ds.stats.total },
          { value: 'columns', label: 'Columns & instructions', count: ds.columns.length },
          { value: 'versions', label: 'Versions' },
        ]}
      >
        <TabPanel value="rows" className="pt-4">
          <DatasetJobsStrip datasetId={ds.id} />
          <RowsTab ds={ds} onOpenRow={(r) => (setSheetRow(r), setSheetOpen(true))} onAddRow={() => (setSheetRow(null), setSheetOpen(true))} onUpload={() => setDialog('upload')} onSelectionChange={setSelectedIds} />
        </TabPanel>
        <TabPanel value="columns" className="pt-5">
          <ColumnsTab ds={ds} onSaved={() => schema.refetch()} />
        </TabPanel>
        <TabPanel value="versions" className="pt-5">
          <VersionsTab datasetId={ds.id} />
        </TabPanel>
      </Tabs>

      <RowSheet open={sheetOpen} onOpenChange={setSheetOpen} datasetId={ds.id} columns={ds.columns} row={sheetRow} />
      <UploadFilesDialog open={dialog === 'upload'} onOpenChange={(o) => setDialog(o ? 'upload' : null)} datasetId={ds.id} columns={ds.columns} />
      <ImportDialog open={dialog === 'import'} onOpenChange={(o) => setDialog(o ? 'import' : null)} datasetId={ds.id} />
      <GenerateDialog open={dialog === 'generate'} onOpenChange={(o) => setDialog(o ? 'generate' : null)} datasetId={ds.id} />
      <SaveVersionDialog open={dialog === 'version'} onOpenChange={(o) => setDialog(o ? 'version' : null)} datasetId={ds.id} />
      {dialog === 'images' && <GenerateImagesDialog open onOpenChange={(o) => setDialog(o ? 'images' : null)} ds={ds} selectedIds={selectedIds} />}
      {dialog === 'speech' && <GenerateSpeechDialog open onOpenChange={(o) => setDialog(o ? 'speech' : null)} ds={ds} selectedIds={selectedIds} />}
      {dialog === 'variants' && <AudioVariantsDialog open onOpenChange={(o) => setDialog(o ? 'variants' : null)} ds={ds} selectedIds={selectedIds} />}
      {dialog === 'transcribe' && <TranscribeDialog open onOpenChange={(o) => setDialog(o ? 'transcribe' : null)} ds={ds} selectedIds={selectedIds} />}
      {confirm.element}
    </Page>
  );
}

/* Rows tab ───────────────────────────────────────────────────────────────── */

const PAGE = 200;
type Filter = 'all' | RowStatus;

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const COL_WIDTH: Record<string, string> = {
  text: 'minmax(220px, 2fr)',
  number: 'minmax(90px, 0.6fr)',
  boolean: 'minmax(80px, 0.5fr)',
  list: 'minmax(160px, 1fr)',
  json: 'minmax(180px, 1.2fr)',
  messages: 'minmax(130px, 0.8fr)',
  audio: 'minmax(200px, 1.2fr)',
  image: 'minmax(80px, 0.5fr)',
  file: 'minmax(160px, 1fr)',
};

function RowsTab({
  ds,
  onOpenRow,
  onAddRow,
  onUpload,
  onSelectionChange,
}: {
  ds: DatasetSchemaResp;
  onOpenRow: (r: RowRecord) => void;
  onAddRow: () => void;
  onUpload: () => void;
  onSelectionChange?: (ids: string[]) => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [filter, setFilter] = useState<Filter>('all');
  const [searchText, setSearchText] = useState('');
  const search = useDebounced(searchText.trim());
  const [tag, setTag] = useState('__all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const input = { dataset: ds.id, status: filter === 'all' ? undefined : [filter], tag: tag === '__all' ? undefined : tag, search: search || undefined };
  const rowsQ = useInfiniteQuery({
    queryKey: ['list_rows', input],
    queryFn: ({ pageParam }) => op<{ total: number; rows: RowRecord[] }>('list_rows', { ...input, offset: pageParam, limit: PAGE }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.rows.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  const rows = useMemo(() => rowsQ.data?.pages.flatMap((p) => p.rows) ?? [], [rowsQ.data]);
  const total = rowsQ.data?.pages[0]?.total ?? 0;

  useEffect(() => setSelected(new Set()), [filter, tag, search]);
  useEffect(() => onSelectionChange?.([...selected]), [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = ds.stats.byStatus;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['list_rows'] });
    qc.invalidateQueries({ queryKey: ['get_dataset_schema'] });
    qc.invalidateQueries({ queryKey: ['list_datasets'] });
  };

  const bulk = async (status: RowStatus) => {
    setBusy(true);
    try {
      const res = await op('set_rows_status', { dataset: ds.id, rowIds: [...selected], status });
      toast.success(`${res.updated} row${res.updated === 1 ? '' : 's'} updated`);
      setSelected(new Set());
      refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const bulkDelete = async () => {
    const n = selected.size;
    if (!(await confirm.ask(`Delete ${n} row${n === 1 ? '' : 's'}?`, 'Rows move to the trash. Saved versions and past runs keep them.'))) return;
    setBusy(true);
    try {
      await op('delete_rows', { dataset: ds.id, rowIds: [...selected] });
      toast.success(`${n} row${n === 1 ? '' : 's'} deleted`);
      setSelected(new Set());
      refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<RowRecord>[] = [
    { key: 'seq', header: '#', width: '64px', render: (r) => <span className="tabular-nums text-ink-faint">{r.seq}</span> },
    ...ds.columns.map(
      (c): Column<RowRecord> => ({
        key: `c_${c.key}`,
        header: <span className="normal-case font-mono tracking-normal">{c.key}</span>,
        help: c.description || undefined,
        width: COL_WIDTH[c.type] ?? 'minmax(160px, 1fr)',
        render: (r) => <CellValue value={r.data[c.key]} type={c.type} />,
      }),
    ),
    {
      key: 'tags',
      header: 'Tags',
      width: 'minmax(120px, 0.8fr)',
      render: (r) =>
        r.tags.length ? (
          <span className="flex flex-wrap gap-1">
            {r.tags.slice(0, 3).map((t) => (
              <span key={t} className="rounded bg-raised px-1.5 text-[0.75rem] text-ink-muted">
                {t}
              </span>
            ))}
            {r.tags.length > 3 && <span className="text-[0.75rem] text-ink-faint">+{r.tags.length - 3}</span>}
          </span>
        ) : (
          <span className="text-ink-faint">—</span>
        ),
    },
    { key: 'status', header: 'Status', width: '136px', render: (r) => <StatusBadge status={r.status} /> },
  ];

  if (ds.columns.length === 0 && ds.stats.total === 0) {
    return (
      <EmptyState icon={<Database />} title="Add columns first">
        This dataset has no columns. Open <b>Columns & instructions</b> to define what each test case holds.
      </EmptyState>
    );
  }

  const noRowsAtAll = ds.stats.total === 0;

  return (
    <div className="flex flex-col gap-3">
      {selected.size > 0 ? (
        <div className="sticky top-0 z-20 flex h-11 items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft px-3">
          <span className="text-[0.84375rem] font-medium">{selected.size} selected</span>
          <div className="ml-2 flex items-center gap-1.5">
            <Button size="sm" icon={<Check className="size-3.5" />} loading={busy} onClick={() => bulk('approved')}>
              Approve
            </Button>
            <Button size="sm" icon={<X className="size-3.5" />} disabled={busy} onClick={() => bulk('rejected')}>
              Reject
            </Button>
            <Button size="sm" icon={<Undo2 className="size-3.5" />} disabled={busy} onClick={() => bulk('needs_review')}>
              Mark for review
            </Button>
            <Button size="sm" variant="ghost" className="text-bad" icon={<Trash2 className="size-3.5" />} disabled={busy} onClick={bulkDelete}>
              Delete
            </Button>
          </div>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All', count: ds.stats.total },
              { value: 'needs_review', label: 'Needs review', count: counts.needs_review ?? 0 },
              { value: 'approved', label: 'Approved', count: counts.approved ?? 0 },
              { value: 'rejected', label: 'Rejected', count: counts.rejected ?? 0 },
            ]}
          />
          <HelpTip>Approved rows are used in runs. Rows from agents, models and some imports start as “Needs review” so a person can check them first.</HelpTip>
          <div className="relative ml-auto w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
            <Input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Search values or row id" className="pl-8" />
          </div>
          {ds.stats.tags.length > 0 && (
            <div className="w-44">
              <Select
                value={tag}
                onChange={setTag}
                options={[{ value: '__all', label: 'All tags' }, ...ds.stats.tags.map((t) => ({ value: t.tag, label: t.tag, hint: `${t.count} rows` }))]}
              />
            </div>
          )}
        </div>
      )}

      {rowsQ.error ? (
        <ErrorBox error={rowsQ.error} />
      ) : noRowsAtAll ? (
        <EmptyState
          icon={<Database />}
          title="No rows yet"
          action={
            <div className="flex gap-2">
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={onAddRow}>
                Add a row
              </Button>
              {ds.columns.some((c) => ['audio', 'image', 'file'].includes(c.type)) && (
                <Button icon={<Upload className="size-4" />} onClick={onUpload}>
                  Upload files
                </Button>
              )}
            </div>
          }
        >
          Use <b>Add rows</b> above to add rows by hand, upload recordings, import a file, generate them with a model, or have your coding agent fill them through MCP.
        </EmptyState>
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(r) => r.id}
          onRowClick={onOpenRow}
          rowHeight={46}
          selected={selected}
          onToggleSelect={(k) => {
            const next = new Set(selected);
            if (next.has(k)) next.delete(k);
            else next.add(k);
            setSelected(next);
          }}
          onToggleAll={() => setSelected(rows.length && rows.every((r) => selected.has(r.id)) ? new Set() : new Set(rows.map((r) => r.id)))}
          empty={rowsQ.isLoading ? 'Loading rows…' : 'No rows match these filters.'}
          footer={
            <div className="flex items-center justify-between">
              <span>
                Showing {rows.length} of {total} row{total === 1 ? '' : 's'}
              </span>
              {rowsQ.hasNextPage && (
                <Button size="sm" variant="ghost" loading={rowsQ.isFetchingNextPage} onClick={() => rowsQ.fetchNextPage()}>
                  Load {Math.min(PAGE, total - rows.length)} more
                </Button>
              )}
            </div>
          }
        />
      )}
      {confirm.element}
    </div>
  );
}

/* Columns & instructions tab ─────────────────────────────────────────────── */

function ColumnsTab({ ds, onSaved }: { ds: DatasetSchemaResp; onSaved: () => void }) {
  const qc = useQueryClient();
  const [columns, setColumns] = useState<ColumnDef[]>(ds.columns);
  const [instructions, setInstructions] = useState(ds.instructions);
  const [name, setName] = useState(ds.name);
  const [description, setDescription] = useState(ds.description);
  const [saving, setSaving] = useState(false);
  const [baseRevision, setBaseRevision] = useState(ds.revision);

  // Pick up changes made elsewhere when nothing is being edited here.
  const dirty =
    JSON.stringify(columns) !== JSON.stringify(ds.columns) || instructions !== ds.instructions || name !== ds.name || description !== ds.description;
  useEffect(() => {
    if (!dirty) {
      setColumns(ds.columns);
      setInstructions(ds.instructions);
      setName(ds.name);
      setDescription(ds.description);
      setBaseRevision(ds.revision);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds.revision]);

  const invalid = Object.keys(columnErrors(columns)).length > 0;

  async function save() {
    setSaving(true);
    try {
      const cleaned = columns.map((c) => ({ ...c, enum: c.enum?.length ? c.enum : undefined }));
      const res = await op('update_dataset', { dataset: ds.id, name: name.trim() || ds.name, description, columns: cleaned, instructions, baseRevision });
      setBaseRevision(res.revision);
      toast.success('Dataset saved');
      for (const k of ['get_dataset_schema', 'list_datasets', 'list_rows']) qc.invalidateQueries({ queryKey: [k] });
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict') {
        toast.info('Changed elsewhere — reloaded', 'Someone (or an agent) changed this dataset. Your edits were replaced with the latest version; re-apply them.');
        const fresh = await op<DatasetSchemaResp>('get_dataset_schema', { dataset: ds.id, sampleRows: 0 });
        setColumns(fresh.columns);
        setInstructions(fresh.instructions);
        setName(fresh.name);
        setDescription(fresh.description);
        setBaseRevision(fresh.revision);
        onSaved();
      } else toastError(e, 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex max-w-[1000px] flex-col gap-6">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this dataset covers" />
        </Field>
      </div>

      <Field
        label="Columns"
        help="Each column is a value per test case. Use them in targets and checks as {{column_name}}. Changing a column's type does not convert existing values."
      >
        <ColumnsEditor value={columns} onChange={setColumns} />
      </Field>

      <Field
        label="Instructions for writing rows"
        help="Guidance used by model generators and by coding agents when they add rows: tone, coverage, how many edge cases, languages, rules to follow."
        hint="Example: “Retail-banking customer questions. About 30% should be requests the assistant must refuse. Use amounts in INR and Indian names.”"
      >
        <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={5} placeholder="How new rows should be written" />
      </Field>

      <div className="flex items-center gap-3 border-t border-line pt-4">
        <Button variant="primary" loading={saving} disabled={!dirty || invalid} onClick={save}>
          Save changes
        </Button>
        {dirty && (
          <Button
            variant="ghost"
            onClick={() => {
              setColumns(ds.columns);
              setInstructions(ds.instructions);
              setName(ds.name);
              setDescription(ds.description);
            }}
          >
            Discard
          </Button>
        )}
        <span className="text-[0.78125rem] text-ink-faint">{dirty ? 'Unsaved changes' : `Revision ${baseRevision}`}</span>
      </div>
    </div>
  );
}

/* Versions tab ───────────────────────────────────────────────────────────── */

function VersionsTab({ datasetId }: { datasetId: string }) {
  const q = useOp<any[]>('list_dataset_versions', { dataset: datasetId });
  const columns: Column<any>[] = [
    { key: 'number', header: 'Version', width: '100px', render: (v) => <span className="font-medium tabular-nums">v{v.number}</span> },
    { key: 'note', header: 'Note', width: 'minmax(240px, 3fr)', render: (v) => (v.note ? <span className="truncate">{v.note}</span> : <span className="text-ink-faint">—</span>) },
    { key: 'rows', header: 'Rows', width: '90px', align: 'right', render: (v) => <span className="tabular-nums">{v.rowCount}</span> },
    { key: 'by', header: 'Saved by', width: '140px', render: (v) => <span className="text-ink-muted">{actorLabel(v.createdBy)}</span> },
    { key: 'at', header: 'Saved', width: '170px', render: (v) => <span className="text-ink-muted">{dateTime(v.createdAt)}</span> },
  ];
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-2xl text-[0.8125rem] text-ink-muted">
        A version freezes the rows exactly as they were, so run results stay comparable even after you edit the dataset. Every run saves one automatically when the rows have changed.
      </p>
      <SimpleTable rows={q.data ?? []} columns={columns} rowKey={(v) => v.id} empty="No versions yet. Use “Save version” or start a run." />
    </div>
  );
}
