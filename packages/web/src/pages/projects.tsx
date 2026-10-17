import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { FolderOpen, FolderPlus, Trash2, UserPlus, Users } from 'lucide-react';
import { Page } from '../components/layout/shell';
import { Button } from '../components/ui/button';
import { Badge, Card, CopyButton, EmptyState, ErrorBox, Loading, SectionTitle } from '../components/ui/display';
import { Field, Input, Select, Textarea } from '../components/ui/form';
import { Dialog, Tip } from '../components/ui/overlay';
import { SimpleTable } from '../components/ui/table';
import { toast, toastError } from '../components/ui/toast';
import { ShareCard } from '../components/sharing/share-card';
import { hubOp, rememberProject, setCurrentProject, useHubMutation, useHubOp, useOp, DEFAULT_PROJECT } from '../lib/api';
import { Link } from '../lib/nav';
import { bytes, timeAgo } from '../lib/format';
import { useProject, useSession } from '../lib/session';
import { ROLE_HELP, ROLE_LABEL, ROLE_TONE, type ProjectRole } from '../lib/roles';

/*
 * Projects: separate spaces with their own datasets, targets, suites, runs, connections and
 * secrets. On a team server each project has members with a role (viewer, editor, owner).
 */


const ROLE_OPTIONS = (['viewer', 'editor', 'owner'] as const).map((r) => ({ value: r, label: ROLE_LABEL[r], hint: ROLE_HELP[r] }));

export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useHubMutation('create_project', {
    invalidate: ['list_projects'],
    onSuccess: (p: any) => {
      onOpenChange(false);
      setName('');
      setDescription('');
      rememberProject(p.id);
      navigate(`/p/${encodeURIComponent(p.id)}`);
    },
  });
  useEffect(() => {
    if (!open) create.reset();
  }, [open]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && !create.isPending) create.mutate({ name: name.trim(), description: description.trim() });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New project"
      description="A separate space with its own datasets, targets, suites, runs, connections and secrets."
      width="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={submit}>
            Create project
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          <Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Support chatbot" />
        </Field>
        <Field label="Description" hint="Optional: what this project evaluates.">
          <Textarea rows={2} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <ErrorBox error={create.error} />
      </form>
    </Dialog>
  );
}

export function ProjectsPage() {
  const { isServer, isAdmin } = useSession();
  const deleted = useHubOp<any[]>('list_deleted_projects', {}, { enabled: isAdmin });
  const navigate = useNavigate();
  const projects = useHubOp<any[]>('list_projects');
  const me = useHubOp<any>('get_me');
  const [creating, setCreating] = useState(false);
  const open = (id: string) => {
    rememberProject(id);
    navigate(`/p/${encodeURIComponent(id)}`);
  };

  return (
    <Page
      title="Projects"
      description={
        isServer
          ? 'Each project has its own data, connections and secrets, and its own members. You see the projects you are a member of.'
          : 'Keep separate evaluations apart: each project has its own datasets, targets, suites, runs, connections and secrets.'
      }
      actions={
        me.data?.canCreateProjects && (
          <Button variant="primary" icon={<FolderPlus className="size-4" />} onClick={() => setCreating(true)}>
            New project
          </Button>
        )
      }
    >
      {projects.isLoading ? (
        <Loading />
      ) : projects.error ? (
        <ErrorBox error={projects.error} />
      ) : !projects.data?.length ? (
        <EmptyState
          icon={<FolderOpen className="size-6" />}
          title="No projects yet"
          action={
            me.data?.canCreateProjects ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                Create a project
              </Button>
            ) : undefined
          }
        >
          {me.data?.canCreateProjects ? 'Create one to start.' : 'Ask a project owner to add you, or an administrator to create one for you.'}
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {projects.data.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => open(p.id)}
              className="group flex min-h-28 flex-col rounded-xl border border-line bg-surface p-4 text-left shadow-sm transition-colors hover:border-line-strong hover:bg-hover"
            >
              <div className="flex items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-[0.9375rem] font-bold text-accent-ink">{p.name.slice(0, 1).toUpperCase()}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[0.9375rem] font-semibold">{p.name}</div>
                  <div className="line-clamp-2 text-[0.8125rem] text-ink-muted">{p.description || (p.id === DEFAULT_PROJECT ? 'The project your existing data lives in.' : 'No description')}</div>
                </div>
              </div>
              <div className="mt-auto flex items-center gap-2 pt-3 text-[0.75rem] text-ink-faint">
                {isServer && <Badge tone={ROLE_TONE[p.role]}>{ROLE_LABEL[p.role]}</Badge>}
                {isServer && p.members !== undefined && (
                  <span className="inline-flex items-center gap-1">
                    <Users className="size-3" /> {p.members}
                  </span>
                )}
                <span className="ml-auto">created {timeAgo(p.createdAt)}</span>
              </div>
            </button>
          ))}
        </div>
      )}
      {(deleted.data?.length ?? 0) > 0 && (
        <div className="mt-6 text-[0.8125rem] text-ink-muted">
          <Link to="/admin/trash" className="text-accent-ink underline">
            {deleted.data!.length} deleted project{deleted.data!.length === 1 ? '' : 's'}
          </Link>{' '}
          can be restored.
        </div>
      )}
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </Page>
  );
}

// ── Project settings ─────────────────────────────────────────────────────────

export function ProjectSettingsPage() {
  const project = useProject();
  const { isServer } = useSession();
  if (!project) return <Loading />;
  return (
    <Page title="Project settings" description={`Settings of “${project.name}”.`}>
      <div className="flex max-w-3xl flex-col gap-6">
        <GeneralCard />
        {isServer && <MembersCard />}
        <StorageCard />
        <ShareCard />
        {project.isOwner && project.id !== DEFAULT_PROJECT && <DangerZone />}
      </div>
    </Page>
  );
}

function GeneralCard() {
  const project = useProject()!;
  const qc = useQueryClient();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  useEffect(() => {
    setName(project.name);
    setDescription(project.description);
  }, [project.id, project.name, project.description]);
  const save = useHubMutation('update_project', {
    invalidate: ['list_projects'],
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hub:get_project'] });
      toast.success('Project saved');
    },
  });
  const dirty = name.trim() !== project.name || description.trim() !== project.description;
  return (
    <Card>
      <SectionTitle help="Only owners can rename a project. The id stays the same, so links keep working.">General</SectionTitle>
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input value={name} maxLength={80} disabled={!project.isOwner} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <Textarea rows={2} value={description} maxLength={500} disabled={!project.isOwner} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Project id" help="Use it with the CLI and coding agents: --project <id> or KALIBRA_PROJECT.">
          <div className="flex items-center justify-between gap-3 rounded-lg bg-raised px-3 py-1.5">
            <code className="truncate font-mono text-[0.78125rem]">{project.id}</code>
            <CopyButton text={project.id} />
          </div>
        </Field>
        {project.isOwner && (
          <div className="flex items-center justify-end gap-2">
            <ErrorBox error={save.error} />
            <Button variant="primary" disabled={!dirty || !name.trim()} loading={save.isPending} onClick={() => save.mutate({ project: project.id, name: name.trim(), description: description.trim() })}>
              Save
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function MembersCard() {
  const project = useProject()!;
  const { user } = useSession();
  const members = useHubOp<any[]>('list_members', { project: project.id });
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['hub:list_members'] });
    qc.invalidateQueries({ queryKey: ['hub:list_projects'] });
    qc.invalidateQueries({ queryKey: ['hub:get_project'] });
  };
  const change = async (m: any, role: ProjectRole) => {
    try {
      await hubOp('set_member', { project: project.id, [m.type]: m.id, role });
      refresh();
    } catch (e) {
      toastError(e, 'Could not change the role');
    }
  };
  const remove = async (m: any) => {
    try {
      await hubOp('remove_member', { project: project.id, [m.type]: m.id });
      refresh();
      toast.success(`${m.name} removed`);
    } catch (e) {
      toastError(e, 'Could not remove');
    }
  };

  return (
    <Card>
      <SectionTitle
        help={
          <>
            <b>Viewer</b>: {ROLE_HELP.viewer}
            <br />
            <b>Editor</b>: {ROLE_HELP.editor}
            <br />
            <b>Owner</b>: {ROLE_HELP.owner}
            <br />
            Administrators can open every project. Adding a group gives all its members that role.
          </>
        }
        action={
          project.isOwner && (
            <Button size="sm" icon={<UserPlus className="size-3.5" />} onClick={() => setAdding(true)}>
              Add people
            </Button>
          )
        }
      >
        Members
      </SectionTitle>
      {members.isLoading ? (
        <Loading />
      ) : members.error ? (
        <ErrorBox error={members.error} />
      ) : (
        <SimpleTable
          rows={members.data ?? []}
          rowKey={(m) => `${m.type}:${m.id}`}
          empty="No members yet. Administrators can still open this project."
          columns={[
            {
              key: 'name',
              header: 'Name',
              render: (m) => (
                <div className="flex min-w-0 items-center gap-2">
                  {m.type === 'group' ? <Users className="size-3.5 shrink-0 text-ink-faint" /> : <span className="grid size-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[0.625rem] font-bold text-accent-ink">{m.name.slice(0, 1).toUpperCase()}</span>}
                  <span className="truncate">{m.name}</span>
                  {m.type === 'group' && <Badge>group</Badge>}
                  {m.type === 'user' && m.id === user?.id && <Badge tone="accent">you</Badge>}
                </div>
              ),
            },
            { key: 'username', header: 'Username', width: '160px', render: (m) => <span className="text-ink-muted">{m.username ?? '—'}</span> },
            {
              key: 'role',
              header: 'Role',
              width: '150px',
              render: (m) =>
                project.isOwner ? (
                  <Select size="sm" value={m.role} onChange={(v) => v !== m.role && change(m, v as ProjectRole)} options={ROLE_OPTIONS} aria-label={`Role of ${m.name}`} />
                ) : (
                  <Badge tone={ROLE_TONE[m.role]}>{ROLE_LABEL[m.role]}</Badge>
                ),
            },
            {
              key: 'actions',
              header: '',
              width: '48px',
              render: (m) =>
                project.isOwner && (
                  <Tip content={`Remove ${m.name}`}>
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove ${m.name}`} onClick={() => remove(m)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </Tip>
                ),
            },
          ]}
        />
      )}
      <AddMemberDialog open={adding} onOpenChange={setAdding} existing={members.data ?? []} onAdded={refresh} />
    </Card>
  );
}

function AddMemberDialog({ open, onOpenChange, existing, onAdded }: { open: boolean; onOpenChange: (o: boolean) => void; existing: any[]; onAdded: () => void }) {
  const project = useProject()!;
  const people = useHubOp<{ users: any[]; groups: any[] }>('list_people', {}, { enabled: open });
  const [who, setWho] = useState('');
  const [role, setRole] = useState<ProjectRole>('editor');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setWho('');
      setError(null);
    }
  }, [open]);
  const taken = new Set(existing.map((m) => `${m.type}:${m.id}`));
  const options = [
    ...(people.data?.users ?? []).filter((u) => !taken.has(`user:${u.id}`)).map((u) => ({ value: `user:${u.id}`, label: u.name, hint: u.username })),
    ...(people.data?.groups ?? []).filter((g) => !taken.has(`group:${g.id}`)).map((g) => ({ value: `group:${g.id}`, label: `${g.name} (group)`, hint: `${g.members} member${g.members === 1 ? '' : 's'}` })),
  ];
  const add = async () => {
    const [type, id] = who.split(':');
    if (!type || !id || busy) return;
    setBusy(true);
    setError(null);
    try {
      await hubOp('set_member', { project: project.id, [type]: id, role });
      onAdded();
      onOpenChange(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add people"
      description="Give a person or a group access to this project."
      width="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!who} loading={busy} onClick={add}>
            Add
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Person or group" hint={people.isLoading ? 'Loading…' : options.length ? undefined : 'Everyone is already a member. An administrator can create more accounts.'}>
          <Select value={who} onChange={setWho} options={options} placeholder="Choose…" />
        </Field>
        <Field label="Role" hint={ROLE_HELP[role]}>
          <Select value={role} onChange={(v) => setRole(v as ProjectRole)} options={ROLE_OPTIONS} />
        </Field>
        <ErrorBox error={error ?? people.error} />
      </div>
    </Dialog>
  );
}

function StorageCard() {
  const ws = useOp<any>('get_workspace');
  return (
    <Card>
      <SectionTitle help="What this project holds. Each project keeps its database (kalibra.db) and files (blobs/) in its own folder.">Contents</SectionTitle>
      {ws.isLoading ? (
        <Loading />
      ) : ws.error ? (
        <ErrorBox error={ws.error} />
      ) : (
        <div className="flex flex-col gap-4">
          {ws.data?.dir && (
            <div className="flex items-center justify-between gap-3 rounded-lg bg-raised px-3 py-2">
              <code className="truncate font-mono text-[0.78125rem]">{ws.data.dir}</code>
              <CopyButton text={ws.data.dir} />
            </div>
          )}
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-[0.84375rem] sm:grid-cols-3">
            {[
              ['Datasets', ws.data?.datasets],
              ['Rows', ws.data?.rows],
              ['Targets', ws.data?.targets],
              ['Suites', ws.data?.suites],
              ['Connections', ws.data?.connections],
              ['Runs', ws.data?.runs],
              ['Database', bytes(ws.data?.storage?.databaseBytes)],
              ['Files', `${ws.data?.storage?.blobCount ?? 0} · ${bytes(ws.data?.storage?.blobBytes)}`],
            ].map(([k, v]) => (
              <div key={k as string} className="flex justify-between gap-3 border-b border-line/70 py-1.5">
                <dt className="text-ink-muted">{k}</dt>
                <dd className="font-medium tabular-nums">{v as any}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </Card>
  );
}

function DangerZone() {
  const project = useProject()!;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const del = useHubMutation('delete_project', {
    invalidate: ['list_projects'],
    onSuccess: () => {
      setOpen(false);
      rememberProject(DEFAULT_PROJECT);
      setCurrentProject(DEFAULT_PROJECT);
      qc.removeQueries({ queryKey: ['hub:get_project'] });
      toast.success(`“${project.name}” moved to the trash`, 'An administrator can restore it.');
      navigate('/projects');
    },
  });
  return (
    <Card className="border-bad/30">
      <SectionTitle>Delete project</SectionTitle>
      <div className="flex items-center justify-between gap-4">
        <p className="text-[0.8125rem] text-ink-muted">Moves the project to the trash. Nobody can open it until an administrator restores it; its files stay on disk.</p>
        <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => (setTyped(''), setOpen(true))}>
          Delete
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete “${project.name}”?`}
        width="sm"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="danger" disabled={typed.trim() !== project.name} loading={del.isPending} onClick={() => del.mutate({ project: project.id })}>
              Delete project
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-[0.84375rem]">
          <p className="text-ink-muted">Everyone loses access to its datasets, targets, suites, runs, connections and secrets until it is restored.</p>
          <Field label={`Type the project name to confirm: ${project.name}`}>
            <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
          </Field>
          <ErrorBox error={del.error} />
        </div>
      </Dialog>
    </Card>
  );
}
