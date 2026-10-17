import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, Monitor, Plus, Trash2 } from 'lucide-react';
import { Page } from '../components/layout/shell';
import { Button } from '../components/ui/button';
import { Badge, Card, CodeBlock, CopyButton, EmptyState, ErrorBox, Loading, SectionTitle } from '../components/ui/display';
import { Field, Input, Select } from '../components/ui/form';
import { Dialog, Tip, useConfirm } from '../components/ui/overlay';
import { SimpleTable } from '../components/ui/table';
import { toast, toastError } from '../components/ui/toast';
import { hubOp, lastProject, useHubMutation, useHubOp, useMeta } from '../lib/api';
import { dateTime, timeAgo } from '../lib/format';
import { Link } from '../lib/nav';
import { useSession } from '../lib/session';

/*
 * Your account on a team server: profile, password, access tokens for coding agents and the CLI,
 * the browsers you are signed in on, and the sign-in providers linked to you.
 */

const MIN_PASSWORD = 10;

export function AccountPage() {
  const { isServer } = useSession();
  if (!isServer) {
    return (
      <Page title="Your account">
        <EmptyState icon={<KeyRound className="size-6" />} title="No account needed here">
          This Kalibra runs on your computer for you alone, so there is no sign-in. Accounts exist on team servers (<code className="font-mono">kalibra server</code>).
        </EmptyState>
      </Page>
    );
  }
  return (
    <Page title="Your account" description="Your profile, password, and the tokens and browsers that can act as you.">
      <div className="flex max-w-3xl flex-col gap-6">
        <ProfileCard />
        <PasswordCard />
        <TokensCard />
        <SessionsCard />
        <IdentitiesCard />
      </div>
    </Page>
  );
}

function ProfileCard() {
  const qc = useQueryClient();
  const me = useHubOp<any>('get_me');
  const [name, setName] = useState('');
  useEffect(() => {
    if (me.data) setName(me.data.user.name);
  }, [me.data]);
  const save = useHubMutation('update_me', {
    invalidate: ['get_me'],
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['auth-status'] });
      toast.success('Profile saved');
    },
  });
  if (me.isLoading) return <Card><Loading /></Card>;
  const user = me.data?.user;
  const dirty = !!user && name.trim() !== user.name;
  return (
    <Card>
      <SectionTitle help="Your name appears in history next to what you change.">Profile</SectionTitle>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Display name">
            <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email" help="Links sign-ins through Google, GitHub or company SSO to your account, so only administrators change it.">
            <Input type="email" value={user?.email ?? ''} readOnly disabled placeholder="none" />
          </Field>
        </div>
        <div className="flex items-center justify-between gap-3 text-[0.8125rem] text-ink-muted">
          <span>
            Username <code className="font-mono text-ink">{user?.username}</code> · {me.data?.isAdmin ? 'Administrator' : 'User'}
            {(me.data?.groups ?? []).length > 0 && <> · groups: {me.data.groups.map((g: any) => g.name).join(', ')}</>}
          </span>
          <Button variant="primary" disabled={!dirty || !name.trim()} loading={save.isPending} onClick={() => save.mutate({ name: name.trim() })}>
            Save
          </Button>
        </div>
        <ErrorBox error={save.error} />
      </div>
    </Card>
  );
}

function PasswordCard() {
  const me = useHubOp<any>('get_me');
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (me.data && !me.data.user.hasPassword) return null;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const mismatch = form.confirm.length > 0 && form.confirm !== form.next;
  const short = form.next.length > 0 && form.next.length < MIN_PASSWORD;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || mismatch || short) return;
    setBusy(true);
    setError(null);
    try {
      await hubOp('change_password', { current: form.current, next: form.next });
      setForm({ current: '', next: '', confirm: '' });
      toast.success('Password changed', 'Your other browsers were signed out.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <SectionTitle help="Changing it signs you out everywhere else.">Password</SectionTitle>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Current password">
            <Input type="password" autoComplete="current-password" value={form.current} onChange={set('current')} />
          </Field>
          <Field label="New password" error={short ? `At least ${MIN_PASSWORD} characters` : undefined}>
            <Input type="password" autoComplete="new-password" value={form.next} onChange={set('next')} />
          </Field>
          <Field label="Repeat new password" error={mismatch ? 'The passwords differ' : undefined}>
            <Input type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} />
          </Field>
        </div>
        <div className="flex items-center justify-end gap-3">
          <ErrorBox error={error} />
          <Button type="submit" variant="primary" loading={busy} disabled={!form.current || !form.next || !form.confirm || mismatch || short}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** The MCP command for this server, for a coding agent that uses `token`. */
export function serverMcpCommand(server: string, project: string) {
  return `claude mcp add kalibra -e KALIBRA_TOKEN=<your token> -- npx -y kalibra mcp --server ${server} --project ${JSON.stringify(project)}`;
}

function TokensCard() {
  const tokens = useHubOp<any[]>('list_tokens');
  const meta = useMeta();
  const projects = useHubOp<any[]>('list_projects');
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const server = meta.data?.publicUrl || location.origin;
  const project = (projects.data ?? []).find((p) => p.id === lastProject()) ?? projects.data?.[0];

  const revoke = async (t: any) => {
    if (!(await confirm.ask(`Revoke “${t.name}”?`, 'Agents and scripts using it stop working at once.', 'Revoke'))) return;
    try {
      await hubOp('revoke_token', { id: t.id });
      qc.invalidateQueries({ queryKey: ['hub:list_tokens'] });
    } catch (e) {
      toastError(e, 'Could not revoke');
    }
  };

  return (
    <Card>
      <SectionTitle
        help="Coding agents (MCP), the CLI and scripts use a token to act as you on this server. A token can work in your projects but cannot manage accounts or read secret values. Create one per agent or machine, so you can revoke them separately."
        action={
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
            New token
          </Button>
        }
      >
        Access tokens
      </SectionTitle>
      {tokens.isLoading ? (
        <Loading />
      ) : tokens.error ? (
        <ErrorBox error={tokens.error} />
      ) : (
        <SimpleTable
          rows={tokens.data ?? []}
          rowKey={(t) => t.id}
          empty="No tokens yet. Create one to connect a coding agent or the CLI."
          columns={[
            { key: 'name', header: 'Name', render: (t) => <span className="font-medium">{t.name}</span> },
            { key: 'prefix', header: 'Token', width: '130px', render: (t) => <code className="font-mono text-[0.75rem] text-ink-muted">{t.prefix}…</code> },
            { key: 'used', header: 'Last used', width: '120px', render: (t) => <span className="text-ink-muted">{t.lastUsedAt ? timeAgo(t.lastUsedAt) : 'never'}</span> },
            { key: 'expires', header: 'Expires', width: '120px', render: (t) => <span className="text-ink-muted">{t.expiresAt ? dateTime(t.expiresAt) : 'never'}</span> },
            {
              key: 'actions',
              header: '',
              width: '48px',
              render: (t) => (
                <Tip content="Revoke">
                  <Button variant="ghost" size="icon-sm" aria-label={`Revoke ${t.name}`} onClick={() => revoke(t)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </Tip>
              ),
            },
          ]}
        />
      )}
      <div className="mt-4 rounded-lg bg-raised p-3 text-[0.8125rem] text-ink-muted">
        <div className="mb-1.5 font-medium text-ink">Connect a coding agent</div>
        Create a token, then add Kalibra to your agent (Claude Code shown; see <Link to="/agents" className="text-accent-ink underline">Coding agents</Link> for others):
        <CodeBlock className="mt-2" value={serverMcpCommand(server, project?.name ?? 'My project')} />
      </div>
      <NewTokenDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(t) => {
          setCreated(t);
          qc.invalidateQueries({ queryKey: ['hub:list_tokens'] });
        }}
      />
      <Dialog
        open={!!created}
        onOpenChange={(o) => !o && setCreated(null)}
        title="Copy your token now"
        description="It is shown only once. Store it like a password; if you lose it, revoke it and create another."
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            I copied it
          </Button>
        }
      >
        {created && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-raised px-3 py-2">
              <code className="break-all font-mono text-[0.78125rem]">{created.token}</code>
              <CopyButton text={created.token} />
            </div>
            <div className="text-[0.8125rem] text-ink-muted">Then connect your agent:</div>
            <CodeBlock value={serverMcpCommand(server, project?.name ?? 'My project').replace('<your token>', created.token)} />
          </div>
        )}
      </Dialog>
      {confirm.element}
    </Card>
  );
}

function NewTokenDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (t: { name: string; token: string }) => void }) {
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const create = useHubMutation('create_token', {
    onSuccess: (t: any) => {
      onOpenChange(false);
      setName('');
      onCreated(t);
    },
  });
  useEffect(() => {
    if (!open) create.reset();
  }, [open]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && !create.isPending) create.mutate({ name: name.trim(), ...(days !== 'never' ? { expiresInDays: Number(days) } : {}) });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New access token"
      width="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={submit}>
            Create token
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name" hint="Where it will be used, so you know which one to revoke later.">
          <Input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude Code on my laptop" />
        </Field>
        <Field label="Expires">
          <Select
            value={days}
            onChange={setDays}
            options={[
              { value: '7', label: 'In 7 days' },
              { value: '30', label: 'In 30 days' },
              { value: '90', label: 'In 90 days' },
              { value: '365', label: 'In a year' },
              { value: 'never', label: 'Never' },
            ]}
          />
        </Field>
        <ErrorBox error={create.error} />
      </form>
    </Dialog>
  );
}

function SessionsCard() {
  const sessions = useHubOp<any[]>('list_sessions');
  const qc = useQueryClient();
  const revoke = async (id: string) => {
    try {
      await hubOp('revoke_session', { id });
      qc.invalidateQueries({ queryKey: ['hub:list_sessions'] });
    } catch (e) {
      toastError(e, 'Could not sign out that browser');
    }
  };
  return (
    <Card>
      <SectionTitle help="Browsers where you are signed in. Sign out any you do not recognise, then change your password.">Signed-in browsers</SectionTitle>
      {sessions.isLoading ? (
        <Loading />
      ) : sessions.error ? (
        <ErrorBox error={sessions.error} />
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {(sessions.data ?? []).map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <Monitor className="size-4 shrink-0 text-ink-faint" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[0.8125rem]">{browserName(s.userAgent)}</div>
                <div className="text-[0.75rem] text-ink-faint">
                  {s.ip || 'unknown address'} · active {timeAgo(s.lastSeenAt)} · until {dateTime(s.expiresAt)}
                </div>
              </div>
              {s.current ? (
                <Badge tone="accent">this browser</Badge>
              ) : (
                <Button size="sm" variant="ghost" icon={<LogOut className="size-3.5" />} onClick={() => revoke(s.id)}>
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function IdentitiesCard() {
  const me = useHubOp<any>('get_me');
  const ids: any[] = me.data?.identities ?? [];
  if (!ids.length) return null;
  return (
    <Card>
      <SectionTitle help="Sign-in providers linked to your account. You can sign in with any of them.">Sign-in methods</SectionTitle>
      <ul className="flex flex-col gap-2 text-[0.8125rem]">
        {ids.map((i) => (
          <li key={i.provider} className="flex items-center justify-between gap-3">
            <span>
              <b>{i.providerName ?? i.provider}</b> <span className="text-ink-muted">{i.email}</span>
            </span>
            <span className="text-ink-faint">{i.lastLoginAt ? `last used ${timeAgo(i.lastLoginAt)}` : ''}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** "Chrome on macOS" from a user agent, good enough to recognise a browser. */
function browserName(ua: string) {
  if (!ua) return 'Unknown browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|node|undici/i.test(ua) ? 'Script' : 'Browser';
  const os = /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
