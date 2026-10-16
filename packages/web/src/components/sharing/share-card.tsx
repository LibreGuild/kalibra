import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { FolderDown, FolderUp, PackageOpen, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge, Card, ErrorBox, SectionTitle } from '../ui/display';
import { Field, Input, Segmented, Switch } from '../ui/form';
import { HelpTip } from '../ui/overlay';
import { toast } from '../ui/toast';
import { op, useOp } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { exportAndDownloadBundle } from './download';

/*
 * Settings card for sharing without a server: a bundle file to send to a teammate, or a folder
 * your team keeps in Git. Secret values never leave this machine.
 */

type Kind = 'datasets' | 'targets' | 'suites' | 'connections' | 'runs';
const KIND_LABEL: Record<Kind, string> = { datasets: 'Datasets', targets: 'Targets', suites: 'Suites', connections: 'Connections', runs: 'Runs (with results)' };

function Picker({ kind, items, picked, toggle }: { kind: Kind; items: { id: string; name: string }[]; picked: Set<string>; toggle: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="mb-1.5 text-[0.75rem] font-semibold uppercase tracking-wide text-ink-faint">{KIND_LABEL[kind]}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((i) => (
          <button
            key={i.id}
            type="button"
            onClick={() => toggle(i.id)}
            className={clsx('max-w-[16rem] truncate rounded-full border px-2.5 py-1 text-[0.78125rem] transition-colors', picked.has(i.id) ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line-strong text-ink-muted hover:text-ink')}
          >
            {i.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function BundleSection() {
  const [mode, setMode] = useState<'everything' | 'choose'>('everything');
  const [withRuns, setWithRuns] = useState(false);
  const [withMedia, setWithMedia] = useState(true);
  const [picked, setPicked] = useState<Record<Kind, Set<string>>>({ datasets: new Set(), targets: new Set(), suites: new Set(), connections: new Set(), runs: new Set() });
  const [busy, setBusy] = useState(false);
  const lists = {
    datasets: useOp<any[]>('list_datasets', {}, { enabled: mode === 'choose' }),
    targets: useOp<any[]>('list_targets', {}, { enabled: mode === 'choose' }),
    suites: useOp<any[]>('list_suites', {}, { enabled: mode === 'choose' }),
    connections: useOp<any[]>('list_connections', {}, { enabled: mode === 'choose' }),
    runs: useOp<{ runs: any[] }>('list_runs', { limit: 12 }, { enabled: mode === 'choose' }),
  };
  const toggle = (kind: Kind) => (id: string) =>
    setPicked((p) => {
      const next = new Set(p[kind]);
      next.has(id) ? next.delete(id) : next.add(id);
      return { ...p, [kind]: next };
    });
  const count = Object.values(picked).reduce((n, s) => n + s.size, 0);

  const exportNow = async () => {
    setBusy(true);
    const input =
      mode === 'everything'
        ? { everything: true, includeRuns: withRuns, includeMedia: withMedia, name: 'kalibra-workspace' }
        : { ...Object.fromEntries(Object.entries(picked).map(([k, s]) => [k, [...s]])), includeMedia: withMedia };
    await exportAndDownloadBundle(input);
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-1.5 text-[0.875rem] font-semibold">
        <PackageOpen className="size-4 text-ink-muted" /> Send a bundle
        <HelpTip>One .kalibra file with datasets (and their audio/images), targets, suites and, if you like, runs. A teammate opens Datasets → Import to load it. API keys and other secret values are never included — they'll be told which secret names to set.</HelpTip>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'everything', label: 'Everything' },
            { value: 'choose', label: 'Choose…' },
          ]}
        />
        {mode === 'everything' && (
          <label className="flex items-center gap-2 text-[0.8125rem] text-ink-muted">
            <Switch checked={withRuns} onChange={setWithRuns} label="Include runs" /> Include runs
          </label>
        )}
        <label className="flex items-center gap-2 text-[0.8125rem] text-ink-muted">
          <Switch checked={withMedia} onChange={setWithMedia} label="Include audio and images" /> Include audio & images
        </label>
      </div>
      {mode === 'choose' && (
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-raised/50 p-3.5">
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <Picker key={k} kind={k} items={(k === 'runs' ? lists.runs.data?.runs.map((r) => ({ id: r.id, name: `#${r.number} ${r.name}` })) : (lists[k].data as any[])?.map((d) => ({ id: d.id, name: d.name }))) ?? []} picked={picked[k]} toggle={toggle(k)} />
          ))}
          <div className="text-[0.75rem] text-ink-faint">Runs bring their dataset, target and suite along automatically.</div>
        </div>
      )}
      <div>
        <Button variant="primary" loading={busy} disabled={mode === 'choose' && !count} onClick={exportNow}>
          Export bundle
        </Button>
      </div>
    </div>
  );
}

interface FolderReport {
  dryRun: boolean;
  summary: { added: number; changed: number; unchanged: number; removed: number };
  definitions: { kind: string; name: string; change: string }[];
  datasets: { name: string; change: string; schemaChanged: boolean; rows: { added: number; changed: number; removed: number; invalid: number } }[];
  warnings: string[];
}

function FolderSection() {
  const settings = useOp<any>('get_sharing_settings');
  const [dir, setDir] = useState('');
  const [rows, setRows] = useState(true);
  const [media, setMedia] = useState(false);
  const [prune, setPrune] = useState(false);
  const [busy, setBusy] = useState<'export' | 'check' | 'apply' | null>(null);
  const [preview, setPreview] = useState<FolderReport | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (settings.data && !dir) {
      setDir(settings.data.folder ?? '');
      if (typeof settings.data.includeRows === 'boolean') setRows(settings.data.includeRows);
      if (typeof settings.data.includeMedia === 'boolean') setMedia(settings.data.includeMedia);
    }
  }, [settings.data]);

  // The preview is a dry run with the same prune setting, so it lists exactly what Apply will add, change or delete.
  const run = async (kind: 'export' | 'check' | 'apply', pruneNow = prune) => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'export') {
        const r = await op('export_to_folder', { dir, includeRows: rows, includeMedia: media });
        setPreview(null);
        toast.success('Exported to folder', r.written ? `${r.written} files written, ${r.removed} removed, ${r.unchanged} unchanged. Commit them to Git.` : 'Nothing changed since the last export.');
      } else {
        const r = await op<FolderReport>('import_from_folder', { dir, dryRun: kind === 'check', prune: pruneNow });
        if (kind === 'check') setPreview(r);
        else {
          setPreview(null);
          toast.success('Folder imported', `${r.summary.added} added, ${r.summary.changed} changed${r.summary.removed ? `, ${r.summary.removed} removed` : ''}.`);
        }
      }
      settings.refetch();
    } catch (e) {
      setError(e);
      if (kind === 'check') setPreview(null);
    } finally {
      setBusy(null);
    }
  };

  const changes = preview ? [...preview.definitions.filter((d) => d.change !== 'unchanged'), ...preview.datasets.filter((d) => d.change !== 'unchanged')] : [];

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-1.5 text-[0.875rem] font-semibold">
        <RefreshCw className="size-4 text-ink-muted" /> Sync with a folder (Git)
        <HelpTip>Export writes small, stable text files your team commits to Git. After a git pull, “Check for changes” shows what differs and “Apply” brings it in as new versions. Secret values are never written. Works in the desktop app and CLI (a local folder path).</HelpTip>
      </div>
      <Field label="Folder" hint={settings.data?.lastExportAt || settings.data?.lastImportAt ? `Last export ${timeAgo(settings.data?.lastExportAt)} · last import ${timeAgo(settings.data?.lastImportAt)}` : 'An absolute path, e.g. /Users/me/projects/support-bot/evals'}>
        <Input
          mono
          value={dir}
          onChange={(e) => {
            setDir(e.target.value);
            setPreview(null);
          }}
          placeholder="/path/to/your/repo/evals"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 text-[0.8125rem] text-ink-muted">
          <Switch checked={rows} onChange={setRows} label="Include dataset rows" /> Include dataset rows
        </label>
        <label className="flex items-center gap-2 text-[0.8125rem] text-ink-muted">
          <Switch checked={media} onChange={setMedia} label="Include audio and images" /> Include audio & images
          <HelpTip>Media files can be large; many teams keep them out of Git and share them with a bundle instead.</HelpTip>
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button icon={<FolderUp className="size-4" />} disabled={!dir.trim()} loading={busy === 'export'} onClick={() => run('export')}>
          Export to folder
        </Button>
        <Button icon={<FolderDown className="size-4" />} disabled={!dir.trim()} loading={busy === 'check'} onClick={() => run('check')}>
          Check for changes
        </Button>
      </div>
      <ErrorBox error={error} />
      {preview && (
        <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-raised/50 p-3.5">
          <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
            <span className="font-medium">In the folder:</span>
            <Badge tone="ok">{preview.summary.added} new</Badge>
            <Badge tone="info">{preview.summary.changed} changed</Badge>
            <Badge>{preview.summary.unchanged} unchanged</Badge>
            {preview.summary.removed > 0 && <Badge tone="bad">{preview.summary.removed} removed</Badge>}
          </div>
          {changes.length > 0 && (
            <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto text-[0.8125rem]">
              {changes.map((c: any) => (
                <li key={`${c.kind ?? 'dataset'}:${c.name}`} className="flex items-center gap-2">
                  <Badge tone={c.change === 'added' ? 'ok' : c.change === 'removed' ? 'bad' : 'info'}>{c.change}</Badge>
                  <span className="text-ink-faint">{c.kind ?? 'dataset'}</span>
                  <span className="truncate">{c.name}</span>
                  {c.rows && (c.rows.added || c.rows.changed || c.rows.removed) ? (
                    <span className="text-ink-faint">
                      · rows +{c.rows.added} ~{c.rows.changed}
                      {c.rows.removed ? ` −${c.rows.removed}` : ''}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {preview.warnings.map((w) => (
            <div key={w} className="text-[0.75rem] text-warn">
              {w}
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-[0.8125rem] text-ink-muted">
              <Switch
                checked={prune}
                onChange={(v) => {
                  setPrune(v);
                  run('check', v);
                }}
                label="Also delete what is not in the folder"
              />{' '}
              Also delete what is not in the folder
            </label>
            <Button variant="primary" disabled={!changes.length || busy !== null} loading={busy === 'apply'} onClick={() => run('apply')}>
              Apply changes
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ShareCard() {
  return (
    <Card>
      <SectionTitle help="Share without a server: send a bundle, or keep a folder in Git that everyone syncs.">Share with your team</SectionTitle>
      <div className="flex flex-col gap-6">
        <BundleSection />
        <div className="h-px bg-line" />
        <FolderSection />
      </div>
    </Card>
  );
}
