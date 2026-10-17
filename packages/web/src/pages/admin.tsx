import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, KeyRound, Pencil, Plus, Search, Trash2, UserPlus, Users } from 'lucide-react';
import clsx from 'clsx';
import { Page } from '../components/layout/shell';
import { Button } from '../components/ui/button';
import { Badge, Card, CopyButton, EmptyState, ErrorBox, Loading, SectionTitle, Tabs } from '../components/ui/display';
import { Field, Input, Segmented, Select, Switch, Textarea } from '../components/ui/form';
import { Dialog, Tip, useConfirm } from '../components/ui/overlay';
import { SimpleTable } from '../components/ui/table';
import { toast, toastError } from '../components/ui/toast';
import { SignInSection } from '../components/admin/sign-in';
import { hubOp, useHubMutation, useHubOp } from '../lib/api';
import { dateTime, timeAgo } from '../lib/format';
import { useSession } from '../lib/session';

/*
 * Administration of a team server: accounts, groups, sign-in providers, server settings, the
 * security log, and deleted projects. On the desktop only the trash applies.
 */

const SECTIONS = [
  { value: 'users', label: 'Users' },
  { value: 'groups', label: 'Groups' },
  { value: 'sign-in', label: 'Sign-in' },
  { value: 'settings', label: 'Settings' },
  { value: 'security', label: 'Security log' },
  { value: 'trash', label: 'Trash' },
];

export function AdminPage() {
  const { section = 'users' } = useParams();
  const navigate = useNavigate();
  const { isServer, isAdmin } = useSession();

  if (!isAdmin) {
    return (
      <Page title="Administration">
        <EmptyState title="For administrators">Ask an administrator of this server if you need something changed.</EmptyState>
      </Page>
    );
  }
  if (!isServer) {
    return (
      <Page title="Deleted projects" description="Projects you deleted on this computer. Restore one to open it again.">
        <TrashSection />
      </Page>
    );
  }
  return (
    <Page title="Administration" description="Accounts, groups, how people sign in, and server-wide settings." width="wide">
      <Tabs value={section} onChange={(v) => navigate(`/admin/${v}`)} tabs={SECTIONS} />
      <div className="mt-5">
        {section === 'users' && <UsersSection />}
        {section === 'groups' && <GroupsSection />}
        {section === 'sign-in' && <SignInSection />}
        {section === 'settings' && <SettingsSection />}
        {section === 'security' && <SecuritySection />}
        {section === 'trash' && <TrashSection />}
        {!SECTIONS.some((s) => s.value === section) && <EmptyState title="Unknown section" />}
      </div>
    </Page>
  );
}

/** A starting password for a new or reset account, shown once to the administrator. */
function temporaryPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function OneTimeSecret({ label, value, note }: { label: string; value: string; note: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[0.8125rem] font-medium">{label}</div>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-raised px-3 py-2">
        <code className="break-all font-mono text-[0.84375rem]">{value}</code>
        <CopyButton text={value} />
      </div>
      <div className="text-[0.78125rem] text-ink-muted">{note}</div>
    </div>
  );
}

// ── Users ────────────────────────────────────────────────────────────────────

function UsersSection() {
  const users = useHubOp<any[]>('list_users');
  const { user: me } = useSession();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [resetting, setResetting] = useState<any>(null);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (users.data ?? []).filter((u) => !q || [u.username, u.name, u.email].some((v: string) => v?.toLowerCase().includes(q)));
  }, [users.data, search]);

  return (
    <Card>
      <SectionTitle
        help="Disable an account to block it at once (it is signed out everywhere and its tokens stop working); its history stays. A server always keeps at least one active administrator."
        action={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
              <Input className="h-8 w-56 pl-8" placeholder="Search people…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search people" />
            </div>
            <Button size="sm" variant="primary" icon={<UserPlus className="size-3.5" />} onClick={() => setCreating(true)}>
              New user
            </Button>
          </div>
        }
      >
        Users ({users.data?.length ?? 0})
      </SectionTitle>
      {users.isLoading ? (
        <Loading />
      ) : users.error ? (
        <ErrorBox error={users.error} />
      ) : (
        <SimpleTable
          rows={shown}
          rowKey={(u) => u.id}
          empty="Nobody matches."
          columns={[
            {
              key: 'name',
              header: 'Name',
              render: (u) => (
                <div className={clsx('min-w-0', u.disabled && 'opacity-60')}>
                  <div className="flex items-center gap-1.5 truncate font-medium">
                    {u.name}
                    {u.id === me?.id && <Badge tone="accent">you</Badge>}
                  </div>
                  <div className="truncate text-[0.75rem] text-ink-faint">
                    {u.username}
                    {u.email ? ` · ${u.email}` : ''}
                  </div>
                </div>
              ),
            },
            {
              key: 'role',
              header: 'Role',
              width: '150px',
              render: (u) => (
                <div className="flex flex-wrap gap-1">
                  {u.role === 'admin' ? <Badge tone="accent">Administrator</Badge> : <Badge>User</Badge>}
                  {u.disabled && <Badge tone="bad">Disabled</Badge>}
                  {u.mustChangePassword && !u.disabled && (
                    <Tip content="Signed in with a starting password; must choose their own next time.">
                      <span>
                        <Badge tone="warn">New password due</Badge>
                      </span>
                    </Tip>
                  )}
                </div>
              ),
            },
            {
              key: 'groups',
              header: 'Groups',
              width: 'minmax(120px, 1fr)',
              render: (u) => <span className="truncate text-ink-muted">{(u.groups ?? []).map((g: any) => g.name).join(', ') || '—'}</span>,
            },
            { key: 'projects', header: 'Projects', width: '80px', align: 'right', render: (u) => <span className="tabular-nums text-ink-muted">{u.projects ?? 0}</span> },
            {
              key: 'signin',
              header: 'Signs in with',
              width: '130px',
              render: (u) => <span className="truncate text-ink-muted">{[u.hasPassword ? 'password' : null, ...(u.identities ?? [])].filter(Boolean).join(', ') || '—'}</span>,
            },
            { key: 'last', header: 'Last sign-in', width: '110px', render: (u) => <span className="text-ink-muted">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'never'}</span> },
            {
              key: 'actions',
              header: '',
              width: '80px',
              render: (u) => (
                <div className="flex justify-end gap-0.5">
                  <Tip content="Edit">
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit ${u.name}`} onClick={() => setEditing(u)}>
                      <Pencil className="size-3.5" />
                    </Button>
                  </Tip>
                  <Tip content="Reset password">
                    <Button variant="ghost" size="icon-sm" aria-label={`Reset password of ${u.name}`} onClick={() => setResetting(u)}>
                      <KeyRound className="size-3.5" />
                    </Button>
                  </Tip>
                </div>
              ),
            },
          ]}
        />
      )}
      <CreateUserDialog open={creating} onOpenChange={setCreating} />
      <EditUserDialog user={editing} onClose={() => setEditing(null)} />
      <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />
    </Card>
  );
}

function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const empty = { username: '', name: '', email: '', role: 'user', password: '', method: 'temporary' as 'temporary' | 'set' | 'none' };
  const [form, setForm] = useState(empty);
  const [created, setCreated] = useState<{ username: string; password?: string } | null>(null);
  const create = useHubMutation('create_user', { invalidate: ['list_users', 'list_people'] });
  // Reset on open and on close, so a starting password does not stay in memory after the dialog.
  useEffect(() => {
    setForm(empty);
    setCreated(null);
    create.reset();
  }, [open]);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (create.isPending || !form.username.trim()) return;
    const password = form.method === 'temporary' ? temporaryPassword() : form.method === 'set' ? form.password : undefined;
    try {
      await create.mutateAsync({
        username: form.username.trim(),
        name: form.name.trim(),
        email: form.email.trim(),
        role: form.role,
        ...(password ? { password, mustChangePassword: form.method === 'temporary' } : {}),
      });
      setCreated({ username: form.username.trim(), password: form.method === 'temporary' ? password : undefined });
    } catch {
      /* shown below */
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={created ? 'User created' : 'New user'}
      width="md"
      footer={
        created ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" loading={create.isPending} disabled={!form.username.trim() || (form.method === 'set' && form.password.length < 10)} onClick={() => submit()}>
              Create user
            </Button>
          </>
        )
      }
    >
      {created ? (
        created.password ? (
          <OneTimeSecret
            label={`Starting password for ${created.username}`}
            value={created.password}
            note="Send it to them privately. It is shown only now; they choose their own password when they first sign in."
          />
        ) : (
          <div className="text-[0.84375rem] text-ink-muted">{created.username} can sign in now. Add them to projects from each project’s settings.</div>
        )
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Username" hint="Letters, digits, dot, dash, underscore or @.">
              <Input autoFocus value={form.username} maxLength={64} onChange={set('username')} />
            </Field>
            <Field label="Display name">
              <Input value={form.name} maxLength={100} onChange={set('name')} placeholder="optional" />
            </Field>
          </div>
          <Field label="Email" help="Used to link a sign-in provider account (Google, GitHub, company SSO) to this user when they first sign in that way.">
            <Input type="email" value={form.email} maxLength={200} onChange={set('email')} placeholder="optional" />
          </Field>
          <Field label="Server role" help="Administrators manage accounts, groups and settings, and can open every project. Everyone else only sees the projects they are members of.">
            <Segmented
              value={form.role}
              onChange={(v) => setForm((f) => ({ ...f, role: v }))}
              options={[
                { value: 'user', label: 'User' },
                { value: 'admin', label: 'Administrator' },
              ]}
            />
          </Field>
          <Field label="Password">
            <Segmented
              value={form.method}
              onChange={(v) => setForm((f) => ({ ...f, method: v }))}
              options={[
                { value: 'temporary', label: 'Generate a starting one' },
                { value: 'set', label: 'Type one' },
                { value: 'none', label: 'None (provider sign-in only)' },
              ]}
            />
          </Field>
          {form.method === 'set' && (
            <Field label="Password" hint="At least 10 characters. They keep it; no change is forced.">
              <Input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />
            </Field>
          )}
          <ErrorBox error={create.error} />
        </form>
      )}
    </Dialog>
  );
}

function EditUserDialog({ user, onClose }: { user: any; onClose: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', role: 'user', disabled: false });
  const { user: me } = useSession();
  const qc = useQueryClient();
  const update = useHubMutation('update_user', {
    invalidate: ['list_users', 'list_people', 'get_me'],
    onSuccess: () => {
      // Editing yourself (name, role) changes what the sidebar and pages show.
      qc.invalidateQueries({ queryKey: ['auth-status'] });
      toast.success('User saved');
      onClose();
    },
  });
  useEffect(() => {
    if (user) {
      setForm({ name: user.name, email: user.email, role: user.role, disabled: user.disabled });
      update.reset();
    }
  }, [user]);
  if (!user) return null;
  const self = user.id === me?.id;
  return (
    <Dialog
      open={!!user}
      onOpenChange={(o) => !o && onClose()}
      title={`Edit ${user.name}`}
      width="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={!form.name.trim()}
            onClick={() => update.mutate({ id: user.id, name: form.name.trim(), email: form.email.trim(), role: form.role, disabled: form.disabled })}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Display name">
          <Input value={form.name} maxLength={100} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>
        <Field label="Email">
          <Input type="email" value={form.email} maxLength={200} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
        </Field>
        <Field label="Server role">
          <Segmented
            value={form.role}
            onChange={(v) => setForm((f) => ({ ...f, role: v }))}
            options={[
              { value: 'user', label: 'User' },
              { value: 'admin', label: 'Administrator' },
            ]}
          />
        </Field>
        <Field label="Account disabled" inline help={self ? 'You cannot disable your own account.' : 'Signs them out everywhere and stops their tokens. Their history stays; you can enable them again.'}>
          <Switch checked={form.disabled} disabled={self} onChange={(v) => setForm((f) => ({ ...f, disabled: v }))} label="Account disabled" />
        </Field>
        <ErrorBox error={update.error} />
      </div>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: any; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [revokeTokens, setRevokeTokens] = useState(true);
  const [done, setDone] = useState<string | null>(null);
  const reset = useHubMutation('reset_user_password', { invalidate: ['list_users'] });
  useEffect(() => {
    // A fresh password on open; forget it (and the request carrying it) on close.
    setPassword(user ? temporaryPassword() : '');
    setRevokeTokens(true);
    setDone(null);
    reset.reset();
  }, [user]);
  if (!user) return null;
  return (
    <Dialog
      open={!!user}
      onOpenChange={(o) => !o && onClose()}
      title={`Reset the password of ${user.name}`}
      description="They are signed out everywhere and choose their own password at next sign-in."
      width="sm"
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="danger"
              loading={reset.isPending}
              onClick={async () => {
                try {
                  await reset.mutateAsync({ id: user.id, password, mustChangePassword: true, revokeTokens });
                  setDone(password);
                } catch {
                  /* shown below */
                }
              }}
            >
              Reset password
            </Button>
          </>
        )
      }
    >
      {done ? (
        <OneTimeSecret label="New starting password" value={done} note="Send it to them privately. It is shown only now." />
      ) : (
        <div className="flex flex-col gap-3 text-[0.84375rem] text-ink-muted">
          A new random starting password will be set. You will see it once, to send to {user.name}.
          <Field label="Also stop their access tokens" inline help="Agents and scripts using their tokens stop working; they create new ones after signing in. Leave on if the account may be compromised.">
            <Switch checked={revokeTokens} onChange={setRevokeTokens} label="Also stop their access tokens" />
          </Field>
          <ErrorBox error={reset.error} />
        </div>
      )}
    </Dialog>
  );
}

// ── Groups ───────────────────────────────────────────────────────────────────

function GroupsSection() {
  const groups = useHubOp<any[]>('list_groups');
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const remove = async (g: any) => {
    if (!(await confirm.ask(`Delete the group “${g.name}”?`, 'Projects it was added to lose it as a member. Its people keep their own memberships.'))) return;
    try {
      await hubOp('delete_group', { id: g.id });
      qc.invalidateQueries({ queryKey: ['hub:list_groups'] });
      qc.invalidateQueries({ queryKey: ['hub:list_users'] });
    } catch (e) {
      toastError(e, 'Could not delete the group');
    }
  };
  return (
    <Card>
      <SectionTitle
        help="Add a group to a project to give all its people the same role there. Groups from a sign-in provider (synced) update their members at each sign-in."
        action={
          <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing('new')}>
            New group
          </Button>
        }
      >
        Groups
      </SectionTitle>
      {groups.isLoading ? (
        <Loading />
      ) : groups.error ? (
        <ErrorBox error={groups.error} />
      ) : (
        <SimpleTable
          rows={groups.data ?? []}
          rowKey={(g) => g.id}
          empty="No groups yet. Create one for each team, e.g. “Speech team”."
          columns={[
            {
              key: 'name',
              header: 'Group',
              render: (g) => (
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 truncate font-medium">
                    <Users className="size-3.5 text-ink-faint" /> {g.name}
                    {g.source !== 'local' && <Badge tone="info">from {g.source}</Badge>}
                  </div>
                  {g.description && <div className="truncate text-[0.75rem] text-ink-faint">{g.description}</div>}
                </div>
              ),
            },
            { key: 'members', header: 'People', render: (g) => <span className="truncate text-ink-muted">{(g.users ?? []).map((u: any) => u.name).join(', ') || 'nobody yet'}</span> },
            {
              key: 'actions',
              header: '',
              width: '80px',
              render: (g) => (
                <div className="flex justify-end gap-0.5">
                  <Tip content="Edit">
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit ${g.name}`} onClick={() => setEditing(g)}>
                      <Pencil className="size-3.5" />
                    </Button>
                  </Tip>
                  <Tip content="Delete">
                    <Button variant="ghost" size="icon-sm" aria-label={`Delete ${g.name}`} onClick={() => remove(g)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </Tip>
                </div>
              ),
            },
          ]}
        />
      )}
      <GroupDialog group={editing} onClose={() => setEditing(null)} />
      {confirm.element}
    </Card>
  );
}

function GroupDialog({ group, onClose }: { group: any | 'new' | null; onClose: () => void }) {
  const isNew = group === 'new';
  const people = useHubOp<{ users: any[] }>('list_people', {}, { enabled: !!group });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [members, setMembers] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const synced = !isNew && group && group.source !== 'local';
  const save = useHubMutation(isNew ? 'create_group' : 'update_group', {
    invalidate: ['list_groups', 'list_users', 'list_people'],
    onSuccess: () => {
      toast.success(isNew ? 'Group created' : 'Group saved');
      onClose();
    },
  });
  useEffect(() => {
    if (!group) return;
    save.reset();
    setFilter('');
    if (isNew) {
      setName('');
      setDescription('');
      setMembers(new Set());
    } else {
      setName(group.name);
      setDescription(group.description ?? '');
      setMembers(new Set((group.users ?? []).map((u: any) => u.id)));
    }
  }, [group]);
  if (!group) return null;
  const toggle = (id: string) =>
    setMembers((m) => {
      const next = new Set(m);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const users = (people.data?.users ?? []).filter((u) => !filter.trim() || `${u.name} ${u.username}`.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <Dialog
      open={!!group}
      onOpenChange={(o) => !o && onClose()}
      title={isNew ? 'New group' : `Edit ${group.name}`}
      width="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!name.trim()}
            onClick={() =>
              save.mutate(
                isNew
                  ? { name: name.trim(), description: description.trim(), users: [...members] }
                  : { id: group.id, name: name.trim(), description: description.trim(), ...(synced ? {} : { users: [...members] }) },
              )
            }
          >
            {isNew ? 'Create group' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Speech team" />
        </Field>
        <Field label="Description">
          <Textarea rows={2} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} placeholder="optional" />
        </Field>
        <Field label={`People (${members.size})`} hint={synced ? `Members come from ${group.source} when people sign in, so they can't be edited here.` : undefined}>
          {synced ? (
            <div className="text-[0.8125rem] text-ink-muted">{(group.users ?? []).map((u: any) => u.name).join(', ') || 'nobody yet'}</div>
          ) : (
            <div className="rounded-lg border border-line">
              <div className="border-b border-line p-2">
                <Input className="h-7" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter people" />
              </div>
              <ul className="max-h-56 overflow-y-auto p-1">
                {users.map((u) => (
                  <li key={u.id}>
                    <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[0.84375rem] hover:bg-hover">
                      <input type="checkbox" checked={members.has(u.id)} onChange={() => toggle(u.id)} className="accent-[var(--k-accent)]" />
                      <span className="truncate">{u.name}</span>
                      <span className="truncate text-[0.75rem] text-ink-faint">{u.username}</span>
                    </label>
                  </li>
                ))}
                {!users.length && <li className="px-2 py-1.5 text-[0.8125rem] text-ink-faint">{people.isLoading ? 'Loading…' : 'Nobody matches.'}</li>}
              </ul>
            </div>
          )}
        </Field>
        <ErrorBox error={save.error} />
      </div>
    </Dialog>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────

function SettingsSection() {
  const settings = useHubOp<any>('get_server_settings');
  const qc = useQueryClient();
  const [draft, setDraft] = useState<any>(null);
  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);
  const save = useHubMutation('update_server_settings', {
    invalidate: ['get_server_settings', 'get_me'],
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['auth-status'] });
      toast.success('Settings saved');
    },
  });
  if (settings.isLoading || !draft) return <Card>{settings.error ? <ErrorBox error={settings.error} /> : <Loading />}</Card>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.data);
  return (
    <Card className="max-w-3xl">
      <SectionTitle>Server settings</SectionTitle>
      <div className="flex flex-col gap-5">
        <Field label="Everyone can create projects" inline help="Off: only administrators create projects (and then add members).">
          <Switch checked={!!draft.allowProjectCreation} onChange={(v) => setDraft({ ...draft, allowProjectCreation: v })} label="Everyone can create projects" />
        </Field>
        {'passwordLogin' in draft && (
          <Field label="Password sign-in" inline help="Off: people sign in only through a sign-in provider. Administrators can still use their password (a small link on the sign-in page), in case a provider is down.">
            <Switch checked={!!draft.passwordLogin} onChange={(v) => setDraft({ ...draft, passwordLogin: v })} label="Password sign-in" />
          </Field>
        )}
        <Field
          label="Who may add or change code"
          help="Script targets, request/response hooks, JavaScript expressions and script checks run on this server with its permissions. Anyone who can write code here can read the server's files and secrets."
        >
          <Segmented
            value={draft.codePolicy}
            onChange={(v) => setDraft({ ...draft, codePolicy: v })}
            options={[
              { value: 'everyone', label: 'Every editor' },
              { value: 'admins', label: 'Administrators only' },
            ]}
          />
          {draft.codePolicy === 'everyone' ? (
            <div className="mt-1.5 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-[0.78125rem] text-warn">
              Every editor can run code on this server. Choose this only when you trust all editors as you would trust them with the server itself. Editors can still run code an administrator wrote either way.
            </div>
          ) : (
            <div className="mt-1.5 text-[0.78125rem] text-ink-faint">Editors can still use and run targets and checks an administrator scripted, and change their other fields.</div>
          )}
        </Field>
        <Field label="Sign-ins last" inline help="After this many days people sign in again.">
          <Select
            value={String(draft.sessionDays)}
            onChange={(v) => setDraft({ ...draft, sessionDays: Number(v) })}
            options={[1, 7, 14, 30, 90].map((d) => ({ value: String(d), label: `${d} day${d === 1 ? '' : 's'}` }))}
            className="w-36"
          />
        </Field>
        <div className="flex items-center justify-end gap-2">
          <ErrorBox error={save.error} />
          <Button disabled={!dirty} onClick={() => setDraft(settings.data)}>
            Discard
          </Button>
          <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(draft)}>
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ── Security log ─────────────────────────────────────────────────────────────

const ACTIONS = [
  { value: '', label: 'Everything' },
  { value: 'login', label: 'Sign-ins' },
  { value: 'user', label: 'Accounts' },
  { value: 'password', label: 'Passwords' },
  { value: 'member', label: 'Project members' },
  { value: 'project', label: 'Projects' },
  { value: 'group', label: 'Groups' },
  { value: 'token', label: 'Access tokens' },
  { value: 'provider', label: 'Sign-in providers' },
  { value: 'settings', label: 'Settings' },
];

function SecuritySection() {
  const [action, setAction] = useState('');
  const log = useHubOp<any[]>('list_audit', { limit: 300, ...(action ? { action } : {}) });
  const who = (a: any) => a?.name ?? (a?.kind === 'anonymous' ? (a.id ? `“${a.id}”` : 'someone') : (a?.id ?? '—'));
  return (
    <Card>
      <SectionTitle
        help="Sign-ins (and failed ones), and changes to accounts, members, groups, tokens and settings. Newest first."
        action={
          <div className="w-48">
            <Select size="sm" value={action || '__all'} onChange={(v) => setAction(v === '__all' ? '' : v)} options={ACTIONS.map((a) => ({ value: a.value || '__all', label: a.label }))} aria-label="Filter" />
          </div>
        }
      >
        Security log
      </SectionTitle>
      {log.isLoading ? (
        <Loading />
      ) : log.error ? (
        <ErrorBox error={log.error} />
      ) : (
        <SimpleTable
          rows={log.data ?? []}
          rowKey={(a) => String(a.id)}
          empty="Nothing recorded yet."
          columns={[
            { key: 'at', header: 'When', width: '150px', render: (a) => <span className="text-ink-muted">{dateTime(a.at)}</span> },
            {
              key: 'action',
              header: 'What',
              width: '170px',
              render: (a) => <Badge tone={/failed|rate_limited|refused/.test(a.action) ? 'bad' : /deleted|removed|revoked|reset/.test(a.action) ? 'warn' : 'neutral'}>{a.action}</Badge>,
            },
            { key: 'who', header: 'Who', width: '160px', render: (a) => <span className="truncate">{who(a.actor)}</span> },
            { key: 'subject', header: 'Subject', render: (a) => <span className="block min-w-0 truncate">{a.subject || '—'}</span> },
            {
              key: 'details',
              header: 'Details',
              render: (a) => {
                const d = Object.entries(a.details ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
                return (
                  <span className="block min-w-0 truncate text-[0.78125rem] text-ink-muted" title={d.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')}>
                    {d.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') || '—'}
                  </span>
                );
              },
            },
            { key: 'ip', header: 'Address', width: '120px', render: (a) => <span className="truncate font-mono text-[0.75rem] text-ink-faint">{a.ip || '—'}</span> },
          ]}
        />
      )}
    </Card>
  );
}

// ── Trash ────────────────────────────────────────────────────────────────────

function TrashSection() {
  const deleted = useHubOp<any[]>('list_deleted_projects');
  const restore = useHubMutation('restore_project', {
    invalidate: ['list_deleted_projects', 'list_projects'],
    onSuccess: (p: any) => toast.success(`“${p.name}” restored`),
    // A name taken in the meantime is the usual reason; the message says so.
  });
  return (
    <Card>
      <SectionTitle help="Deleting a project moves it here; its files stay on disk. Restore brings it back with its members.">Deleted projects</SectionTitle>
      {deleted.isLoading ? (
        <Loading />
      ) : deleted.error ? (
        <ErrorBox error={deleted.error} />
      ) : (
        <SimpleTable
          rows={deleted.data ?? []}
          rowKey={(p) => p.id}
          empty="The trash is empty."
          columns={[
            { key: 'name', header: 'Project', render: (p) => <span className="font-medium">{p.name}</span> },
            { key: 'deleted', header: 'Deleted', width: '160px', render: (p) => <span className="text-ink-muted">{dateTime(p.deletedAt)}</span> },
            {
              key: 'actions',
              header: '',
              width: '120px',
              render: (p) => (
                <Button size="sm" icon={<ArchiveRestore className="size-3.5" />} loading={restore.isPending && restore.variables?.id === p.id} onClick={() => restore.mutate({ id: p.id })}>
                  Restore
                </Button>
              ),
            },
          ]}
        />
      )}
      <ErrorBox error={restore.error} />
    </Card>
  );
}
