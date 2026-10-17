import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { GitBranch, KeyRound, Lock, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge, Card, CopyButton, ErrorBox, Loading, SectionTitle } from '../ui/display';
import { Field, Input, Segmented, Select, Switch, TagInput } from '../ui/form';
import { Dialog, Tip, useConfirm } from '../ui/overlay';
import { SimpleTable } from '../ui/table';
import { toast, toastError } from '../ui/toast';
import { hubOp, useHubOp } from '../../lib/api';
import { BASE } from '../../lib/base';

/*
 * Administration → Sign-in: providers people can sign in with besides (or instead of) passwords.
 *   OIDC     – Google, Microsoft Entra, Okta, Keycloak, GitLab, Dex, most company SSO
 *   GitHub   – github.com or a GitHub Enterprise server (e.g. https://github.example.com)
 *   Gateway  – a login proxy in front of Kalibra (Google IAP, Cloudflare Access, oauth2-proxy)
 * Providers set in the server's configuration file are shown read-only.
 */

type Kind = 'oidc' | 'github' | 'proxy';

interface Provider {
  id: string;
  name: string;
  kind: Kind;
  enabled: boolean;
  source?: 'app' | 'config';
  callbackUrl?: string;
  hasClientSecret?: boolean;
  issuer: string;
  clientId: string;
  scopes: string;
  groupsClaim: string;
  githubUrl: string;
  allowedOrgs: string[];
  emailHeader: string;
  nameHeader: string;
  groupsHeader: string;
  jwtHeader: string;
  jwksUrl: string;
  jwtIssuer: string;
  jwtAudience: string;
  trustedProxies: string[];
  allowedDomains: string[];
  allowedGroups: string[];
  autoCreate: boolean;
  adminGroups: string[];
  syncGroups: boolean;
}

const BLANK: Provider = {
  id: '',
  name: '',
  kind: 'oidc',
  enabled: true,
  issuer: '',
  clientId: '',
  scopes: 'openid email profile',
  groupsClaim: '',
  githubUrl: 'https://github.com',
  allowedOrgs: [],
  emailHeader: '',
  nameHeader: '',
  groupsHeader: '',
  jwtHeader: '',
  jwksUrl: '',
  jwtIssuer: '',
  jwtAudience: '',
  trustedProxies: [],
  allowedDomains: [],
  allowedGroups: [],
  autoCreate: false,
  adminGroups: [],
  syncGroups: false,
};

const KIND_LABEL: Record<Kind, string> = { oidc: 'OpenID Connect', github: 'GitHub', proxy: 'Login gateway' };
const KIND_ICON: Record<Kind, ReactNode> = { oidc: <KeyRound className="size-3.5" />, github: <GitBranch className="size-3.5" />, proxy: <ShieldCheck className="size-3.5" /> };

/** Common OIDC providers: pick one to fill the name and issuer. */
const PRESETS: { id: string; name: string; issuer: string; note: string }[] = [
  { id: 'google', name: 'Google', issuer: 'https://accounts.google.com', note: 'Google Cloud console → APIs & Services → Credentials → OAuth client (Web application).' },
  { id: 'microsoft', name: 'Microsoft', issuer: 'https://login.microsoftonline.com/<tenant-id>/v2.0', note: 'Entra admin center → App registrations. Replace <tenant-id> with your directory id.' },
  { id: 'okta', name: 'Okta', issuer: 'https://<your-org>.okta.com', note: 'Okta admin → Applications → Create App Integration (OIDC, Web).' },
  { id: 'keycloak', name: 'Keycloak', issuer: 'https://<keycloak-host>/realms/<realm>', note: 'Keycloak → Clients → Create client (OpenID Connect, client authentication on).' },
  { id: 'gitlab', name: 'GitLab', issuer: 'https://gitlab.com', note: 'GitLab → Preferences → Applications (scopes: openid, email, profile). Self-hosted: your GitLab address.' },
  { id: 'other', name: 'Company SSO', issuer: '', note: 'Any OpenID Connect provider: ask for its issuer URL, a client id and a client secret.' },
];

const absolute = (url?: string) => (url?.startsWith('/') ? `${location.origin}${url}` : (url ?? ''));
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export function SignInSection() {
  const list = useHubOp<{ providers: Provider[]; callbackBase: string }>('list_auth_providers');
  const settings = useHubOp<any>('get_server_settings');
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Provider | 'new' | null>(null);

  const remove = async (p: Provider) => {
    if (!(await confirm.ask(`Delete “${p.name}”?`, 'People who signed in with it keep their accounts, but can no longer sign in this way.'))) return;
    try {
      await hubOp('delete_auth_provider', { id: p.id });
      qc.invalidateQueries({ queryKey: ['hub:list_auth_providers'] });
      qc.invalidateQueries({ queryKey: ['auth-status'] });
    } catch (e) {
      toastError(e, 'Could not delete');
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <SectionTitle
          help="Let people sign in with an account they already have. New people can be invited (an administrator adds them by email first) or created automatically when their email domain or group is allowed."
          action={
            <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing('new')}>
              Add provider
            </Button>
          }
        >
          Sign-in providers
        </SectionTitle>
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox error={list.error} />
        ) : (
          <SimpleTable
            rows={list.data?.providers ?? []}
            rowKey={(p) => p.id}
            empty="None yet: people sign in with a username and password. Add Google, GitHub, your company SSO or a login gateway."
            columns={[
              {
                key: 'name',
                header: 'Provider',
                render: (p) => (
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="text-ink-muted">{KIND_ICON[p.kind]}</span>
                    <span className="truncate font-medium">{p.name}</span>
                    {!p.enabled && <Badge>off</Badge>}
                    {p.source === 'config' && (
                      <Tip content="Set in the server's configuration; change it there.">
                        <span>
                          <Badge tone="info">
                            <Lock className="size-3" /> config
                          </Badge>
                        </span>
                      </Tip>
                    )}
                  </div>
                ),
              },
              { key: 'kind', header: 'Kind', width: '140px', render: (p) => <span className="text-ink-muted">{KIND_LABEL[p.kind]}</span> },
              {
                key: 'who',
                header: 'Who can sign in',
                render: (p) => <span className="truncate text-ink-muted">{whoCanSignIn(p)}</span>,
              },
              {
                key: 'actions',
                header: '',
                width: '80px',
                render: (p) =>
                  p.source === 'config' ? (
                    <Tip content="View">
                      <Button variant="ghost" size="icon-sm" aria-label={`View ${p.name}`} onClick={() => setEditing(p)}>
                        <Pencil className="size-3.5" />
                      </Button>
                    </Tip>
                  ) : (
                    <div className="flex justify-end gap-0.5">
                      <Tip content="Edit">
                        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}>
                          <Pencil className="size-3.5" />
                        </Button>
                      </Tip>
                      <Tip content="Delete">
                        <Button variant="ghost" size="icon-sm" aria-label={`Delete ${p.name}`} onClick={() => remove(p)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </Tip>
                    </div>
                  ),
              },
            ]}
          />
        )}
        {settings.data && settings.data.passwordLogin === false && (
          <p className="mt-3 text-[0.78125rem] text-ink-faint">Password sign-in is off (Settings tab); administrators can still use theirs from a small link on the sign-in page.</p>
        )}
      </Card>
      <ProviderDialog provider={editing} callbackBase={list.data?.callbackBase ?? ''} onClose={() => setEditing(null)} />
      {confirm.element}
    </div>
  );
}

function whoCanSignIn(p: Provider) {
  const parts: string[] = [];
  if (p.allowedDomains.length) parts.push(`@${p.allowedDomains.join(', @')}`);
  if (p.allowedGroups.length) parts.push(`groups ${p.allowedGroups.join(', ')}`);
  if (p.kind === 'github' && p.allowedOrgs.length) parts.push(`orgs ${p.allowedOrgs.join(', ')}`);
  const scope = parts.length ? parts.join(' · ') : 'anyone with an account there';
  return p.autoCreate ? `${scope} (accounts created on first sign-in)` : `invited people only · ${scope}`;
}

function ProviderDialog({ provider, callbackBase, onClose }: { provider: Provider | 'new' | null; callbackBase: string; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = provider === 'new';
  const readOnly = !isNew && provider?.source === 'config';
  const [p, setP] = useState<Provider>(BLANK);
  const [secret, setSecret] = useState('');
  const [preset, setPreset] = useState('google');
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!provider) return;
    setError(null);
    setSecret('');
    setAdvanced(false);
    if (provider === 'new') {
      const g = PRESETS[0];
      setPreset(g.id);
      setP({ ...BLANK, name: g.name, issuer: g.issuer });
    } else setP({ ...BLANK, ...provider });
  }, [provider]);

  if (!provider) return null;
  const set = <K extends keyof Provider>(k: K, v: Provider[K]) => setP((cur) => ({ ...cur, [k]: v }));
  const text = (k: keyof Provider) => (e: { target: { value: string } }) => set(k, e.target.value as any);
  const id = isNew ? slug(p.name) : p.id;
  const callback = isNew ? `${callbackBase || location.origin}${BASE}/api/auth/sso/${id || '<id>'}/callback` : absolute((provider as Provider).callbackUrl);
  const pickPreset = (pid: string) => {
    const pr = PRESETS.find((x) => x.id === pid)!;
    setPreset(pid);
    setP((cur) => ({ ...cur, name: pr.name, issuer: pr.issuer }));
  };

  const save = async () => {
    if (busy || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const { source, callbackUrl, hasClientSecret, id: _, ...fields } = p;
      await hubOp('save_auth_provider', { ...fields, ...(isNew ? {} : { id: p.id }), ...(secret ? { clientSecret: secret } : {}) });
      qc.invalidateQueries({ queryKey: ['hub:list_auth_providers'] });
      qc.invalidateQueries({ queryKey: ['auth-status'] });
      toast.success(isNew ? `${p.name} added` : `${p.name} saved`, p.enabled && p.kind !== 'proxy' ? 'Its button now shows on the sign-in page.' : undefined);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const presetNote = PRESETS.find((x) => x.id === preset)?.note;

  return (
    <Dialog
      open={!!provider}
      onOpenChange={(o) => !o && onClose()}
      title={readOnly ? p.name : isNew ? 'Add a sign-in provider' : `Edit ${p.name}`}
      description={readOnly ? 'Set in the server configuration; change it there.' : undefined}
      width="lg"
      footer={
        readOnly ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            {/* Next to the buttons, so it is visible however far the form is scrolled. */}
            {!!error && (
              <div className="mr-auto min-w-0 flex-1">
                <ErrorBox error={error} />
              </div>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!p.name.trim()} onClick={save}>
              {isNew ? 'Add provider' : 'Save'}
            </Button>
          </>
        )
      }
    >
      <fieldset disabled={readOnly} className="flex flex-col gap-5">
        {isNew && (
          <Field label="Kind">
            <Segmented
              value={p.kind}
              onChange={(k) => {
                set('kind', k);
                if (k === 'github') setP((cur) => ({ ...cur, kind: k, name: 'GitHub' }));
                if (k === 'proxy') setP((cur) => ({ ...cur, kind: k, name: 'Company gateway' }));
                if (k === 'oidc') pickPreset(preset);
              }}
              options={[
                { value: 'oidc', label: 'OpenID Connect' },
                { value: 'github', label: 'GitHub' },
                { value: 'proxy', label: 'Login gateway' },
              ]}
            />
          </Field>
        )}
        {isNew && p.kind === 'oidc' && (
          <Field label="Provider" hint={presetNote}>
            <Select value={preset} onChange={pickPreset} options={PRESETS.map((x) => ({ value: x.id, label: x.name === 'Company SSO' ? 'Other (company SSO, Dex, Authentik…)' : x.name }))} />
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <Field label="Button label" help="Shown as “Continue with …” on the sign-in page." hint={isNew && id ? `Id: ${id}` : undefined}>
            <Input value={p.name} maxLength={60} onChange={text('name')} />
          </Field>
          <Field label="On" help="Off hides the button and stops sign-ins through it.">
            <div className="flex h-8.5 items-center">
              <Switch checked={p.enabled} onChange={(v) => set('enabled', v)} label="Provider on" />
            </div>
          </Field>
        </div>

        {p.kind !== 'proxy' && (
          <Field label="Callback URL" help="Register this address with the provider (it may be called redirect URI or authorized redirect URL).">
            <div className="flex items-center justify-between gap-3 rounded-lg bg-raised px-3 py-1.5">
              <code className="truncate font-mono text-[0.78125rem]">{callback}</code>
              <CopyButton text={callback} />
            </div>
          </Field>
        )}

        {p.kind === 'oidc' && (
          <>
            <Field label="Issuer URL" help="The provider's address; Kalibra reads its settings from <issuer>/.well-known/openid-configuration.">
              <Input mono value={p.issuer} onChange={text('issuer')} placeholder="https://accounts.google.com" />
            </Field>
            <ClientFields p={p} secret={secret} setSecret={setSecret} set={set} />
          </>
        )}

        {p.kind === 'github' && (
          <>
            <Field
              label="GitHub address"
              help="https://github.com, or your GitHub Enterprise server (e.g. https://github.example.com). Kalibra must be able to reach it from where it runs: for an Enterprise server inside your company network, run Kalibra inside that network too."
            >
              <Input mono value={p.githubUrl} onChange={text('githubUrl')} />
            </Field>
            <ClientFields p={p} secret={secret} setSecret={setSecret} set={set} hint="GitHub → Settings → Developer settings → OAuth Apps → New OAuth App." />
            <Field label="Only members of these organisations" help="Leave empty to allow anyone with an account on that GitHub (subject to the rules below).">
              <TagInput value={p.allowedOrgs} onChange={(v) => set('allowedOrgs', v)} placeholder="my-org, press Enter" />
            </Field>
          </>
        )}

        {p.kind === 'proxy' && (
          <>
            <p className="rounded-lg bg-raised p-3 text-[0.8125rem] text-ink-muted">
              A gateway (Google Cloud IAP, Cloudflare Access, oauth2-proxy, your company's reverse proxy) signs people in before requests reach Kalibra and passes who they are in a header. Kalibra trusts it only from the proxy addresses you list, or when the header is a JWT it can verify.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Email header" help="Header with the signed-in user's email.">
                <Input mono value={p.emailHeader} onChange={text('emailHeader')} placeholder="X-Forwarded-Email" />
              </Field>
              <Field label="Name header" help="Optional header with the display name.">
                <Input mono value={p.nameHeader} onChange={text('nameHeader')} placeholder="X-Forwarded-User" />
              </Field>
              <Field label="Groups header" help="Optional header with comma-separated groups.">
                <Input mono value={p.groupsHeader} onChange={text('groupsHeader')} placeholder="X-Forwarded-Groups" />
              </Field>
            </div>
            <Field label="Trusted proxy addresses" help="IP addresses or CIDR ranges allowed to set these headers, e.g. 10.0.0.0/8. Required unless you verify a JWT below.">
              <TagInput value={p.trustedProxies} onChange={(v) => set('trustedProxies', v)} placeholder="10.0.0.5, press Enter" />
            </Field>
            <details className="rounded-lg border border-line p-3" open={!!p.jwtHeader}>
              <summary className="cursor-pointer text-[0.8125rem] font-medium">Verify a signed JWT instead (IAP, Cloudflare Access)</summary>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label="JWT header" help="e.g. X-Goog-IAP-JWT-Assertion (Google IAP) or Cf-Access-Jwt-Assertion (Cloudflare Access).">
                  <Input mono value={p.jwtHeader} onChange={text('jwtHeader')} />
                </Field>
                <Field label="Keys URL (JWKS)" help="Where the gateway publishes its signing keys, e.g. https://www.gstatic.com/iap/verify/public_key-jwk.">
                  <Input mono value={p.jwksUrl} onChange={text('jwksUrl')} />
                </Field>
                <Field label="Issuer" help="Expected iss claim, e.g. https://cloud.google.com/iap.">
                  <Input mono value={p.jwtIssuer} onChange={text('jwtIssuer')} />
                </Field>
                <Field label="Audience" help="Expected aud claim (IAP: /projects/<number>/global/backendServices/<id>; Cloudflare: the application AUD tag).">
                  <Input mono value={p.jwtAudience} onChange={text('jwtAudience')} />
                </Field>
              </div>
            </details>
          </>
        )}

        <div className="flex flex-col gap-4 rounded-lg border border-line p-4">
          <div className="text-[0.8125rem] font-semibold">Who can sign in</div>
          <Field
            label="Create accounts on first sign-in"
            inline
            help="Off (invite only): an administrator creates the user first with the same email, and their first sign-in links to it. On: anyone allowed by the rules below gets a new account with the User role."
          >
            <Switch checked={p.autoCreate} onChange={(v) => set('autoCreate', v)} label="Create accounts on first sign-in" />
          </Field>
          <Field label="Only these email domains" help="e.g. example.com. Leave empty for any domain.">
            <TagInput value={p.allowedDomains} onChange={(v) => set('allowedDomains', v)} placeholder="example.com, press Enter" />
          </Field>
          {p.kind !== 'github' && (
            <Field label="Only members of these groups" help="Groups the provider reports (OIDC groups claim or the gateway's groups header). Leave empty for no group rule.">
              <TagInput value={p.allowedGroups} onChange={(v) => set('allowedGroups', v)} placeholder="eval-team, press Enter" />
            </Field>
          )}
          <button type="button" className="self-start text-[0.78125rem] text-accent-ink" onClick={() => setAdvanced((a) => !a)}>
            {advanced ? 'Hide group options' : 'Group options…'}
          </button>
          {advanced && (
            <>
              <Field
                label="Mirror groups"
                inline
                help={p.kind === 'github' ? 'Create a Kalibra group for each GitHub team (org/team) and keep its members up to date at sign-in, so teams can be added to projects.' : 'Create a Kalibra group for each provider group and keep its members up to date at sign-in, so they can be added to projects.'}
              >
                <Switch checked={p.syncGroups} onChange={(v) => set('syncGroups', v)} label="Mirror groups" />
              </Field>
              <Field label="Administrator groups" help={p.kind === 'github' ? 'Members of these teams (org/team) become administrators when they sign in.' : 'Members of these provider groups become administrators when they sign in.'}>
                <TagInput value={p.adminGroups} onChange={(v) => set('adminGroups', v)} placeholder="platform-admins, press Enter" />
              </Field>
              {p.kind === 'oidc' && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Groups claim" help="Token claim that lists the user's groups, e.g. groups. Needed for group rules.">
                    <Input mono value={p.groupsClaim} onChange={text('groupsClaim')} placeholder="groups" />
                  </Field>
                  <Field label="Scopes" help="What to ask the provider for. Add the scope that includes groups if yours needs one.">
                    <Input mono value={p.scopes} onChange={text('scopes')} />
                  </Field>
                </div>
              )}
            </>
          )}
        </div>
      </fieldset>
    </Dialog>
  );
}

function ClientFields({ p, secret, setSecret, set, hint }: { p: Provider; secret: string; setSecret: (v: string) => void; set: <K extends keyof Provider>(k: K, v: Provider[K]) => void; hint?: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Client id" hint={hint}>
        <Input mono value={p.clientId} onChange={(e) => set('clientId', e.target.value)} />
      </Field>
      <Field label="Client secret" help="Stored in the server's secret store and never shown again. Leave empty to keep the current one." hint={p.hasClientSecret ? 'A secret is stored. Type a new one to replace it.' : undefined}>
        <Input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={p.hasClientSecret ? '••••••••' : ''} />
      </Field>
    </div>
  );
}
