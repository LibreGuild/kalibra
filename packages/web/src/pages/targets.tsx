import { useCallback, useEffect, useRef, useState } from 'react';
import { useBeforeUnload, useBlocker, useNavigate, useParams } from 'react-router';
import clsx from 'clsx';
import { Bot, Code2, Crosshair, Globe, History, Plus, Radio, Save, Trash2 } from 'lucide-react';
import { ApiError, op, useOp, useOpMutation } from '../lib/api';
import { actorLabel, dateTime, timeAgo } from '../lib/format';
import { BackLink, Page } from '../components/layout/shell';
import { Button } from '../components/ui/button';
import { Badge, EmptyState, ErrorBox, Loading } from '../components/ui/display';
import { Field, Input, KeyValueEditor } from '../components/ui/form';
import { Dialog, Popover, Tip, useConfirm } from '../components/ui/overlay';
import { SimpleTable } from '../components/ui/table';
import { toast, toastError } from '../components/ui/toast';
import { Section, TemplateHelp } from '../components/targets/common';
import { HttpForm } from '../components/targets/http-form';
import { WsForm } from '../components/targets/ws-form';
import { ModelForm, ScriptForm } from '../components/targets/other-forms';
import { TryPanel } from '../components/targets/try-panel';
import {
  defaultConfig,
  defaultVariables,
  endpointOf,
  KIND_LABEL,
  KIND_TONE,
  type TargetConfig,
  type TargetKind,
  type TargetRecord,
  type TargetSpec,
} from '../components/targets/model';

/* List ─────────────────────────────────────────────────────────────────── */

export function TargetsPage() {
  const targets = useOp<TargetRecord[]>('list_targets');
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  return (
    <Page
      title="Targets"
      description="The AI application under test. A target describes how to call it for each dataset row and which parts of the response to keep."
      actions={
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          New target
        </Button>
      }
    >
      {targets.isLoading ? (
        <Loading />
      ) : targets.error ? (
        <ErrorBox error={targets.error} />
      ) : (targets.data ?? []).length === 0 ? (
        <EmptyState
          icon={<Crosshair />}
          title="No targets yet"
          action={
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New target
            </Button>
          }
        >
          A target is your app as Kalibra sees it: an HTTP endpoint, a WebSocket service, a model with a prompt, or a script that calls anything you like.
        </EmptyState>
      ) : (
        <SimpleTable
          rows={targets.data!}
          rowKey={(t) => t.id}
          onRowClick={(t) => navigate(`/targets/${t.id}`)}
          columns={[
            {
              key: 'name',
              header: 'Name',
              width: 'minmax(260px, 2fr)',
              render: (t) => (
                <div className="min-w-0">
                  <div className="truncate font-medium">{t.name}</div>
                  {t.description && <div className="truncate text-[12.5px] text-ink-muted">{t.description}</div>}
                </div>
              ),
            },
            {
              key: 'kind',
              header: 'Kind',
              width: '140px',
              render: (t) => <Badge tone={KIND_TONE[t.spec.config.kind]}>{KIND_LABEL[t.spec.config.kind]}</Badge>,
            },
            {
              key: 'endpoint',
              header: 'Calls',
              width: 'minmax(220px, 1.6fr)',
              render: (t) => <span className="block truncate font-mono text-[12.5px] text-ink-muted">{endpointOf(t.spec)}</span>,
            },
            { key: 'version', header: 'Version', width: '90px', render: (t) => <span className="tabular-nums text-ink-muted">v{t.version}</span> },
            {
              key: 'updated',
              header: 'Updated',
              width: '150px',
              render: (t) => (
                <Tip content={`${dateTime(t.updatedAt)} by ${actorLabel(t.updatedBy)}`}>
                  <span className="text-ink-muted">{timeAgo(t.updatedAt)}</span>
                </Tip>
              ),
            },
          ]}
        />
      )}
      <NewTargetDialog open={creating} onOpenChange={setCreating} onCreated={(t) => navigate(`/targets/${t.id}`)} />
    </Page>
  );
}

const KINDS: { kind: TargetKind; icon: typeof Globe; title: string; text: string }[] = [
  { kind: 'http', icon: Globe, title: 'HTTP API', text: 'REST/JSON, multipart uploads, SSE streaming' },
  { kind: 'websocket', icon: Radio, title: 'WebSocket', text: 'Streaming audio (speech-to-text), realtime chat' },
  { kind: 'model', icon: Bot, title: 'Model + prompt', text: 'Test a prompt directly against a model connection' },
  { kind: 'script', icon: Code2, title: 'Custom script', text: 'Write JS that calls your app any way you like' },
];

function NewTargetDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (t: TargetRecord) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TargetKind>('http');
  const create = useOpMutation<any, TargetRecord>('create_target', {
    invalidate: ['list_targets'],
    onSuccess: (t) => {
      onOpenChange(false);
      setName('');
      onCreated(t);
    },
  });
  const submit = () =>
    create.mutate(
      { name: name.trim(), spec: { variables: defaultVariables(kind), config: defaultConfig(kind) } },
      { onError: (e) => toastError(e, 'Could not create the target') },
    );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New target"
      description="Pick how Kalibra should call your app. You can fine-tune everything afterwards."
      width="lg"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={submit}>
            Create target
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Name">
          <Input autoFocus value={name} placeholder="Support bot (staging)" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && submit()} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          {KINDS.map(({ kind: k, icon: Icon, title, text }) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={clsx(
                'flex items-start gap-3 rounded-xl border p-4 text-left transition-colors',
                kind === k ? 'border-accent bg-accent-soft/50 ring-2 ring-accent/20' : 'border-line hover:border-line-strong hover:bg-hover',
              )}
            >
              <div className={clsx('grid size-8 shrink-0 place-items-center rounded-lg', kind === k ? 'bg-accent text-on-accent' : 'bg-raised text-ink-muted')}>
                <Icon className="size-4" />
              </div>
              <div className="min-w-0">
                <div className="text-[13.5px] font-semibold">{title}</div>
                <div className="text-[12.5px] text-ink-muted">{text}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

/* Editor ───────────────────────────────────────────────────────────────── */

interface Draft {
  name: string;
  description: string;
  spec: TargetSpec;
}

const snapshot = (t: TargetRecord): Draft => ({ name: t.name, description: t.description ?? '', spec: t.spec });
const same = (a: Draft | null, b: Draft | null) => JSON.stringify(a) === JSON.stringify(b);

export function TargetEditorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const target = useOp<TargetRecord>('get_target', { id });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [base, setBase] = useState<{ version: number; draft: Draft } | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const confirm = useConfirm();
  const leaving = useRef(false);

  // Load the server copy; adopt newer versions automatically unless there are local edits.
  useEffect(() => {
    const t = target.data;
    if (!t) return;
    if (!base || !draft) {
      setBase({ version: t.version, draft: snapshot(t) });
      setDraft(snapshot(t));
    } else if (t.version !== base.version) {
      if (same(draft, base.draft)) {
        setBase({ version: t.version, draft: snapshot(t) });
        setDraft(snapshot(t));
      } else setConflict(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.data]);

  const dirty = !!draft && !!base && !same(draft, base.draft);

  const reload = async () => {
    const t = await target.refetch();
    if (t.data) {
      setBase({ version: t.data.version, draft: snapshot(t.data) });
      setDraft(snapshot(t.data));
      setConflict(false);
    }
  };

  const save = useCallback(async () => {
    if (!draft || !base || saving) return;
    setSaving(true);
    try {
      const t = await op<TargetRecord>('update_target', { id, name: draft.name.trim(), description: draft.description, spec: draft.spec, baseVersion: base.version });
      setBase({ version: t.version, draft: snapshot(t) });
      setDraft(snapshot(t));
      setConflict(false);
      target.refetch();
      toast.success(t.version === base.version ? 'Nothing changed' : `Saved as version ${t.version}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict') {
        setConflict(true);
        toast.error('Someone else changed this target', 'Reload to see their version, then re-apply your edits.');
      } else toastError(e, 'Could not save');
    } finally {
      setSaving(false);
    }
  }, [draft, base, id, saving, target]);

  // ⌘S / Ctrl+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, save]);

  const blocker = useBlocker(({ currentLocation, nextLocation }) => !leaving.current && dirty && currentLocation.pathname !== nextLocation.pathname);
  useBeforeUnload(
    useCallback(
      (e: BeforeUnloadEvent) => {
        if (dirty) e.preventDefault();
      },
      [dirty],
    ),
  );

  if (target.isLoading) return <Loading />;
  if (target.error || !target.data) {
    return (
      <Page title="Target" back={<BackLink to="/targets">Targets</BackLink>}>
        <ErrorBox error={target.error ?? 'Target not found'} />
      </Page>
    );
  }
  if (!draft) return <Loading />;

  const config = draft.spec.config;
  const setConfig = (c: TargetConfig) => setDraft({ ...draft, spec: { ...draft.spec, config: c } });

  const remove = async () => {
    if (!(await confirm.ask(`Delete “${draft.name}”?`, 'The target moves to the trash. Past runs keep the exact version they used.'))) return;
    try {
      await op('delete_target', { id });
      leaving.current = true; // nothing left to protect
      toast.success('Target deleted');
      navigate('/targets');
    } catch (e) {
      toastError(e, 'Could not delete');
    }
  };

  return (
    <Page
      width="wide"
      back={<BackLink to="/targets">Targets</BackLink>}
      title={draft.name || 'Untitled target'}
      badge={
        <div className="flex items-center gap-1.5">
          <Badge tone={KIND_TONE[config.kind]}>{KIND_LABEL[config.kind]}</Badge>
          <Badge>v{base?.version}</Badge>
          {dirty && (
            <Badge tone="warn" dot>
              Unsaved changes
            </Badge>
          )}
        </div>
      }
      actions={
        <>
          <TemplateHelp />
          <VersionsPopover
            id={id}
            current={base?.version ?? 0}
            onRestore={(spec, version) => {
              setDraft({ ...draft, spec });
              toast.info(`Loaded version ${version}`, 'Save to make it the current version.');
            }}
          />
          <Tip content="Delete target">
            <Button variant="ghost" size="icon" aria-label="Delete target" onClick={remove}>
              <Trash2 className="size-4" />
            </Button>
          </Tip>
          <Tip content="Save (⌘S)">
            <Button variant="primary" icon={<Save className="size-4" />} loading={saving} disabled={!dirty} onClick={save}>
              Save
            </Button>
          </Tip>
        </>
      }
    >
      {conflict && (
        <div className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 text-[13px] text-warn">
          <span>This target was changed elsewhere (in another window, the CLI or by a coding agent). Reload to see the latest version; your unsaved edits will be replaced.</span>
          <Button size="sm" onClick={reload}>
            Reload
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(340px,2fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Section title="Details">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name">
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label="Description" help="Optional note for your team, e.g. which environment or build this points at.">
                <Input value={draft.description} placeholder="Optional" onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </Field>
            </div>
          </Section>

          <Section
            title="Variables"
            help="Values available as {{vars.name}}, e.g. base_url. Change them here to point the same target at local, staging or production."
            collapsible
            defaultOpen
            summary={`${draft.spec.variables.length} variable(s)`}
          >
            <KeyValueEditor
              value={draft.spec.variables}
              onChange={(variables) => setDraft({ ...draft, spec: { ...draft.spec, variables } })}
              keyPlaceholder="base_url"
              valuePlaceholder="http://localhost:3000"
              addLabel="Add variable"
            />
          </Section>

          {config.kind === 'http' && <HttpForm value={config} onChange={setConfig} />}
          {config.kind === 'websocket' && <WsForm value={config} onChange={setConfig} />}
          {config.kind === 'model' && <ModelForm value={config} onChange={setConfig} />}
          {config.kind === 'script' && <ScriptForm value={config} onChange={setConfig} />}
        </div>

        <div className="min-w-0 lg:sticky lg:top-6 lg:max-h-[calc(100vh-48px)] lg:self-start lg:overflow-y-auto">
          <TryPanel spec={draft.spec} targetId={id} />
        </div>
      </div>

      <Dialog
        open={blocker.state === 'blocked'}
        onOpenChange={(o) => !o && blocker.reset?.()}
        title="Discard unsaved changes?"
        width="sm"
        footer={
          <>
            <Button onClick={() => blocker.reset?.()}>Keep editing</Button>
            <Button variant="danger" onClick={() => blocker.proceed?.()}>
              Discard
            </Button>
          </>
        }
      >
        <div className="text-[13.5px] text-ink-muted">You changed this target but did not save. Leaving now loses those changes.</div>
      </Dialog>
      {confirm.element}
    </Page>
  );
}

function VersionsPopover({ id, current, onRestore }: { id: string; current: number; onRestore: (spec: TargetSpec, version: number) => void }) {
  const versions = useOp<{ version: number; name: string; createdAt: string; actor: any }[]>('list_target_versions', { id });
  return (
    <Popover
      align="end"
      className="w-80"
      trigger={
        <Button variant="ghost" icon={<History className="size-4" />}>
          Versions
        </Button>
      }
    >
      <div className="mb-2 text-[13px] font-semibold">Version history</div>
      <div className="mb-2 text-[12px] text-ink-faint">Every save is kept. Runs record the exact version they used.</div>
      <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
        {(versions.data ?? []).map((v) => (
          <div key={v.version} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">
                v{v.version}
                {v.version === current && <span className="ml-1.5 text-[12px] font-normal text-ink-faint">current</span>}
              </div>
              <div className="truncate text-[12px] text-ink-faint">
                {dateTime(v.createdAt)} · {actorLabel(v.actor)}
              </div>
            </div>
            {v.version !== current && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  try {
                    const t = await op<TargetRecord>('get_target', { id, version: v.version });
                    onRestore(t.spec, v.version);
                  } catch (e) {
                    toastError(e, 'Could not load that version');
                  }
                }}
              >
                Load
              </Button>
            )}
          </div>
        ))}
        {versions.isLoading && <div className="px-2 py-1 text-[12.5px] text-ink-faint">Loading…</div>}
      </div>
    </Popover>
  );
}
