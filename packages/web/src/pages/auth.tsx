import { useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { GitBranch, KeyRound, LogIn, ShieldCheck } from 'lucide-react';
import { Button } from '../components/ui/button';
import { ErrorBox } from '../components/ui/display';
import { Field, Input } from '../components/ui/form';
import { authCall, forgetProject, hubOp, useAuthStatus, type AuthStatus } from '../lib/api';
import { safeNext, useSession } from '../lib/session';
import { withBase } from '../lib/base';

/*
 * Signing in to a team server: the first-administrator setup, the sign-in page (password and/or
 * sign-in providers), and the forced "choose your own password" step for new accounts.
 * Never shown in local mode (`npx kalibra`), which has no sign-in.
 */

const MIN_PASSWORD = 10;

function AuthFrame({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="grid size-8 place-items-center rounded-lg bg-accent text-[1rem] font-bold text-on-accent">K</div>
          <span className="text-[1.25rem] font-bold tracking-tight">Kalibra</span>
        </div>
        <div className="rounded-xl border border-line bg-surface p-6 shadow-card">
          <h1 className="text-[1.125rem] font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-[0.8125rem] text-ink-muted">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
        {footer && <div className="mt-4 text-center text-[0.78125rem] text-ink-faint">{footer}</div>}
      </div>
    </div>
  );
}

/** After signing in, re-read the sign-in state; the gate then takes you to `next`. */
function useSignedIn() {
  const qc = useQueryClient();
  return async () => {
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth-status' });
    await qc.invalidateQueries({ queryKey: ['auth-status'] });
  };
}

const PROVIDER_ICON: Record<string, ReactNode> = { github: <GitBranch className="size-4" />, oidc: <KeyRound className="size-4" />, proxy: <ShieldCheck className="size-4" /> };

export function LoginPage() {
  const status = useAuthStatus();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const data = status.data as AuthStatus | undefined;
  // A failed provider sign-in is reported once by the server (never through the URL, which anyone could craft).
  const [error, setError] = useState<unknown>(data?.error || null);
  const [busy, setBusy] = useState(false);
  const signedIn = useSignedIn();
  // A login gateway (kind "proxy") signs people in before they reach this page; it has no button.
  const providers = (data?.providers ?? []).filter((p) => p.kind !== 'proxy');
  const gateway = (data?.providers ?? []).find((p) => p.kind === 'proxy');
  // With password sign-in turned off, administrators can still use theirs (e.g. when a provider is down).
  const [adminForm, setAdminForm] = useState(false);
  const passwordLogin = data?.passwordLogin !== false || adminForm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await authCall('login', { username: username.trim(), password });
      await signedIn();
    } catch (err) {
      setError(err);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Sign in" subtitle="Sign in to your team's Kalibra." footer="Forgot your password? Ask an administrator to reset it.">
      <div className="flex flex-col gap-4">
        {providers.length > 0 && (
          <div className="flex flex-col gap-2">
            {providers.map((p) => (
              <a
                key={p.id}
                href={withBase(`/api/auth/sso/${encodeURIComponent(p.id)}/start?next=${encodeURIComponent(next)}`)}
                className="flex h-10 items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface text-[0.875rem] font-medium hover:bg-hover"
              >
                {PROVIDER_ICON[p.kind] ?? <LogIn className="size-4" />}
                Continue with {p.name}
              </a>
            ))}
          </div>
        )}
        {providers.length > 0 && passwordLogin && (
          <div className="flex items-center gap-3 text-[0.75rem] text-ink-faint">
            <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
          </div>
        )}
        {passwordLogin && (
          <form onSubmit={submit} className="flex flex-col gap-3.5">
            <Field label="Username">
              <Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
            <Field label="Password">
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" loading={busy} disabled={!username.trim() || !password} className="mt-1 w-full justify-center">
              Sign in
            </Button>
          </form>
        )}
        {!passwordLogin && providers.length === 0 && (
          <div className="text-[0.8125rem] text-ink-muted">
            {gateway ? `Sign in through ${gateway.name}, then reload this page.` : 'No sign-in method is set up. Ask the person who runs this server.'}
          </div>
        )}
        <ErrorBox error={error} />
        {data?.passwordLogin === false && !adminForm && (
          <button type="button" className="self-center text-[0.75rem] text-ink-faint hover:text-ink" onClick={() => setAdminForm(true)}>
            Administrator sign-in
          </button>
        )}
      </div>
    </AuthFrame>
  );
}

/** First start of a team server: create the first administrator with the code printed in the server log. */
export function SetupPage() {
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get('code') ?? '');
  const [form, setForm] = useState({ username: 'admin', name: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const signedIn = useSignedIn();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const mismatch = form.confirm.length > 0 && form.confirm !== form.password;
  const short = form.password.length > 0 && form.password.length < MIN_PASSWORD;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || mismatch || short) return;
    setBusy(true);
    setError(null);
    try {
      await authCall('setup', { code: code.trim(), username: form.username.trim(), password: form.password, name: form.name.trim(), email: form.email.trim() });
      await signedIn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      title="Set up this server"
      subtitle="Create the first administrator. They can then add people, groups and sign-in providers."
      footer="The setup code is printed in the server's log when it starts. It works once."
    >
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        {!params.get('code') && (
          <Field label="Setup code" help="Printed by the server at start-up, in the link /setup?code=…">
            <Input mono value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        )}
        <Field label="Username">
          <Input autoComplete="username" value={form.username} onChange={set('username')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Display name">
            <Input autoComplete="name" value={form.name} onChange={set('name')} placeholder="optional" />
          </Field>
          <Field label="Email">
            <Input type="email" autoComplete="email" value={form.email} onChange={set('email')} placeholder="optional" />
          </Field>
        </div>
        <Field label="Password" hint={`At least ${MIN_PASSWORD} characters. A short sentence works well.`} error={short ? `Use at least ${MIN_PASSWORD} characters` : undefined}>
          <Input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />
        </Field>
        <Field label="Repeat password" error={mismatch ? 'The passwords differ' : undefined}>
          <Input type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} />
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!code.trim() || !form.username.trim() || !form.password || mismatch || short || !form.confirm} className="mt-1 w-full justify-center">
          Create administrator
        </Button>
        <ErrorBox error={error} />
      </form>
    </AuthFrame>
  );
}

/** New accounts (and reset passwords) choose their own password before anything else. */
export function ChangePasswordPage() {
  const { user } = useSession();
  const qc = useQueryClient();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
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
      await qc.invalidateQueries({ queryKey: ['auth-status'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Choose your password" subtitle={`Hi ${user?.name ?? ''}. You signed in with a starting password; pick one only you know.`}>
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <Field label="Starting password">
          <Input type="password" autoComplete="current-password" autoFocus value={form.current} onChange={set('current')} />
        </Field>
        <Field label="New password" hint={`At least ${MIN_PASSWORD} characters, not containing your username.`} error={short ? `Use at least ${MIN_PASSWORD} characters` : undefined}>
          <Input type="password" autoComplete="new-password" value={form.next} onChange={set('next')} />
        </Field>
        <Field label="Repeat new password" error={mismatch ? 'The passwords differ' : undefined}>
          <Input type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} />
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!form.current || !form.next || !form.confirm || mismatch || short} className="mt-1 w-full justify-center">
          Save and continue
        </Button>
        <ErrorBox error={error} />
        <button
          type="button"
          className="text-[0.78125rem] text-ink-faint hover:text-ink"
          onClick={async () => {
            await authCall('logout').catch(() => {});
            forgetProject();
            window.location.assign(withBase('/login'));
          }}
        >
          Sign out instead
        </button>
      </form>
    </AuthFrame>
  );
}
