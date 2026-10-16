import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, MoreHorizontal, Pencil, Plug, Plus, Trash2, Zap } from 'lucide-react';
import { Page } from '../components/layout/shell';
import { Button } from '../components/ui/button';
import { Badge, Card, EmptyState, ErrorBox, Loading, SectionTitle } from '../components/ui/display';
import { Field, Input, KeyValueEditor, Select, Switch, type KV } from '../components/ui/form';
import { Dialog, HelpTip, Menu, MenuItem, MenuSeparator, Tip, useConfirm } from '../components/ui/overlay';
import { AudioPlayer } from '../components/ui/media';
import { toast, toastError } from '../components/ui/toast';
import { fileUrl, op, useOp, useOpMutation } from '../lib/api';
import { timeAgo } from '../lib/format';

interface ConnSpec {
  provider: string;
  baseUrl: string;
  apiKeySecret: string;
  headers: KV[];
  defaultModel: string;
  imageModel: string;
  speechModel: string;
  transcriptionModel: string;
  embeddingModel: string;
  models: string[];
  options: Record<string, any>;
}

const EMPTY: ConnSpec = { provider: 'openai', baseUrl: '', apiKeySecret: '', headers: [], defaultModel: '', imageModel: '', speechModel: '', transcriptionModel: '', embeddingModel: '', models: [], options: {} };

interface ProviderInfo {
  id: string;
  label: string;
  hint: string;
  defaultModel: string;
  media: string[];
}

type Kind = 'text' | 'image' | 'speech' | 'transcription' | 'embedding';
const KIND_FIELD: Record<Kind, keyof ConnSpec> = { text: 'defaultModel', image: 'imageModel', speech: 'speechModel', transcription: 'transcriptionModel', embedding: 'embeddingModel' };
/** Mirrors the engine's inferModelKind: guesses what a model id is for. */
function guessKind(model: string): Kind {
  const m = model.toLowerCase();
  if (/(^|[-_/])(gpt-image|dall-e|imagen|flux|stable-diffusion|sdxl|nova-canvas|titan-image)|image-(generation|preview)|-image$/.test(m)) return 'image';
  if (/transcri|whisper|(^|[-_])stt([-_]|$)|speech-to-text|chirp/.test(m)) return 'transcription';
  if (/(^|[-_])tts([-_]|$)|text-to-speech|-tts-|speech/.test(m)) return 'speech';
  return 'text';
}

const KIND_LABEL: Record<Kind, string> = { text: 'Text', image: 'Image', speech: 'Speech', transcription: 'Transcription', embedding: 'Embedding' };

/** One line describing a test result: reply text, or a small image / audio preview. */
function TestResult({ r }: { r: any }) {
  if (!r) return null;
  if (r.error) return <div className="text-[0.78125rem] text-bad">{r.error}</div>;
  return (
    <div className="flex items-center gap-3 text-[0.78125rem] text-ink-muted">
      <Badge tone="ok" dot>Works</Badge>
      <span>{r.latencyMs} ms</span>
      {r.file && r.kind === 'image' && <img src={fileUrl(r.file.hash)} alt="Test image" className="size-10 rounded border border-line object-cover" />}
      {r.file && r.kind === 'speech' && <div className="w-48"><AudioPlayer file={{ blob: r.file.hash, name: 'test.wav', mime: r.file.mime }} compact /></div>}
      {r.reply && <span className="truncate">“{r.reply}”</span>}
      {r.similarity !== undefined && (
        <span className="truncate">
          {r.dims} dimensions · similar sentences score {r.similarity}
        </span>
      )}
    </div>
  );
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'connection';

/** Where each provider gets its credentials. */
function needsApiKey(s: ConnSpec) {
  const o = s.options;
  switch (s.provider) {
    case 'azure':
      return o.authMode !== 'az_cli';
    case 'bedrock':
      return o.authMode === 'api_key';
    case 'vertex':
      return o.authMode === 'express';
    case 'openai_compatible':
      return 'optional';
    default:
      return true;
  }
}

function describe(s: ConnSpec) {
  const o = s.options ?? {};
  switch (s.provider) {
    case 'azure':
      return o.resourceName || s.baseUrl || 'Azure';
    case 'bedrock':
      return `${o.region || 'us-east-1'} · ${o.authMode === 'api_key' ? 'API key' : o.authMode === 'access_keys' ? 'access keys' : o.profile ? `profile ${o.profile}` : 'AWS default credentials'}`;
    case 'vertex':
      return `${o.project || 'default project'} · ${o.location || 'us-central1'}`;
    default:
      return s.baseUrl || 'default endpoint';
  }
}

export function ConnectionsPage() {
  const list = useOp<any[]>('list_connections');
  const providers = useOp<ProviderInfo[]>('list_providers');
  const secrets = useOp<string[]>('list_secrets');
  const [editing, setEditing] = useState<any | null>(null);
  const [secretOpen, setSecretOpen] = useState(false);
  const confirm = useConfirm();
  const del = useOpMutation('delete_connection', { invalidate: ['list_connections'] });
  const delSecret = useOpMutation('delete_secret', { invalidate: ['list_secrets'] });
  const label = (id: string) => providers.data?.find((p) => p.id === id)?.label ?? id;

  const test = async (c: any) => {
    try {
      const r = await op('test_connection', { id: c.id });
      const what = r.kind === 'image' ? 'drew a test image' : r.kind === 'speech' ? 'spoke a test sentence' : `replied "${r.reply}"`;
      toast.success(`${c.name} works`, `${r.model} ${what} in ${r.latencyMs} ms`);
    } catch (e) {
      toastError(e, `${c.name} failed`);
    }
  };

  return (
    <Page
      title="Connections"
      description="Model providers Kalibra uses for LLM judges, model targets and data generation. Your app under test is configured under Targets, not here."
      actions={
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ name: '', spec: EMPTY })}>
          Add connection
        </Button>
      }
    >
      {confirm.element}
      <div className="flex flex-col gap-6">
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox error={list.error} />
        ) : (list.data ?? []).length === 0 ? (
          <EmptyState
            icon={<Plug />}
            title="No connections yet"
            action={
              <Button variant="primary" onClick={() => setEditing({ name: '', spec: EMPTY })}>
                Add connection
              </Button>
            }
          >
            Add OpenAI, Anthropic, Gemini, Azure, AWS Bedrock, Google Vertex AI, or any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, OpenRouter, xAI, Groq, a LiteLLM proxy…). You can also skip this and let your coding agent generate data through MCP.
          </EmptyState>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {list.data!.map((c) => (
              <Card key={c.id} className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[0.9375rem] font-semibold">{c.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone="accent">{label(c.spec.provider)}</Badge>
                      {(['text', 'image', 'speech', 'transcription', 'embedding'] as Kind[]).map((k) =>
                        c.spec[KIND_FIELD[k]] ? (
                          <Tip key={k} content={`${KIND_LABEL[k]} model`}>
                            <span>
                              <Badge>{k === 'text' ? '' : `${KIND_LABEL[k]}: `}{c.spec[KIND_FIELD[k]]}</Badge>
                            </span>
                          </Tip>
                        ) : null,
                      )}
                    </div>
                  </div>
                  <Menu trigger={<Button variant="ghost" size="icon-sm" aria-label="More"><MoreHorizontal className="size-4" /></Button>}>
                    <MenuItem icon={<Pencil />} onSelect={() => setEditing(c)}>Edit</MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      icon={<Trash2 />}
                      danger
                      onSelect={async () => {
                        if (await confirm.ask(`Delete "${c.name}"?`, 'Checks and targets that use it will stop working until you pick another connection.')) del.mutate({ id: c.id }, { onError: (e) => toastError(e) });
                      }}
                    >
                      Delete
                    </MenuItem>
                  </Menu>
                </div>
                <div className="truncate font-mono text-[0.75rem] text-ink-muted">{describe(c.spec)}</div>
                <div className="mt-auto flex items-center justify-between border-t border-line pt-3">
                  <span className="text-[0.75rem] text-ink-faint">Updated {timeAgo(c.updatedAt)}</span>
                  <Button size="sm" icon={<Zap className="size-3.5" />} onClick={() => test(c)}>
                    Test
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}

        <Card>
          <SectionTitle
            help="Secrets are stored outside the workspace, encrypted with your OS keychain in the desktop app. Use them anywhere in targets as {{secret.name}} — the value never appears in definitions, exports or MCP."
            action={
              <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setSecretOpen(true)}>
                Add secret
              </Button>
            }
          >
            Secrets
          </SectionTitle>
          {(secrets.data ?? []).length === 0 ? (
            <div className="text-[0.8125rem] text-ink-muted">No secrets stored. API keys you enter for connections are saved here automatically.</div>
          ) : (
            <ul className="divide-y divide-line">
              {secrets.data!.map((s) => (
                <li key={s} className="flex items-center justify-between py-2">
                  <span className="flex items-center gap-2 font-mono text-[0.78125rem]">
                    <KeyRound className="size-3.5 text-ink-faint" />
                    {`{{secret.${s}}}`}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${s}`}
                    onClick={async () => {
                      if (await confirm.ask(`Delete secret "${s}"?`, 'Anything that references it will fail until it is set again.')) delSecret.mutate({ name: s }, { onError: (e) => toastError(e, 'Could not delete the secret') });
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {editing && <ConnectionDialog initial={editing} providers={providers.data ?? []} onClose={() => setEditing(null)} />}
      {secretOpen && <SecretDialog onClose={() => setSecretOpen(false)} />}
    </Page>
  );
}

function ConnectionDialog({ initial, providers, onClose }: { initial: any; providers: ProviderInfo[]; onClose: () => void }) {
  const [name, setName] = useState<string>(initial.name ?? '');
  const [spec, setSpec] = useState<ConnSpec>(() => {
    const s: ConnSpec = { ...EMPTY, ...initial.spec, options: { ...(initial.spec?.options ?? {}) } };
    // Older connections kept an image/speech model in the text slot; move it where it belongs.
    const kind = guessKind(s.defaultModel);
    if (kind !== 'text' && !s[KIND_FIELD[kind]]) return { ...s, [KIND_FIELD[kind]]: s.defaultModel, defaultModel: '' };
    return s;
  });
  const [apiKey, setApiKey] = useState('');
  const [extraSecrets, setExtraSecrets] = useState<Record<string, string>>({});
  const [models, setModels] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'models' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const qc = useQueryClient();
  const isNew = !initial.id;
  const o = spec.options;
  const set = (patch: Partial<ConnSpec>) => setSpec((s) => ({ ...s, ...patch }));
  const setOpt = (k: string, v: unknown) => setSpec((s) => ({ ...s, options: { ...s.options, [k]: v } }));
  const keyMode = needsApiKey(spec);

  /** Store typed secret values and return the spec that references them. */
  const persistSecrets = async () => {
    const base = slug(name || spec.provider);
    let next = { ...spec, options: { ...spec.options } };
    if (apiKey) {
      const secretName = spec.apiKeySecret || `${base}_api_key`;
      await op('set_secret', { name: secretName, value: apiKey });
      next.apiKeySecret = secretName;
    }
    for (const [field, value] of Object.entries(extraSecrets)) {
      if (!value) continue;
      const secretName = next.options[field] || `${base}_${field.replace(/Secret$/, '').replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`;
      await op('set_secret', { name: secretName, value });
      next.options[field] = secretName;
    }
    // Secrets don't emit change events; refresh the list on the page behind the dialog.
    if (apiKey || Object.values(extraSecrets).some(Boolean)) qc.invalidateQueries({ queryKey: ['list_secrets'] });
    return next;
  };

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      const finalSpec = await persistSecrets();
      if (isNew) await op('create_connection', { name, spec: finalSpec });
      else await op('update_connection', { id: initial.id, name, spec: finalSpec, baseVersion: initial.version });
      qc.invalidateQueries({ queryKey: ['list_connections'] });
      toast.success(isNew ? 'Connection added' : 'Connection saved');
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const [results, setResults] = useState<Partial<Record<Kind, any>>>({});
  const [testing, setTesting] = useState<Kind | null>(null);
  const testKind = async (kind: Kind) => {
    setTesting(kind);
    setResults((r) => ({ ...r, [kind]: undefined }));
    try {
      const finalSpec = await persistSecrets();
      setSpec(finalSpec);
      setApiKey('');
      const r =
        kind === 'embedding'
          ? await op('test_embeddings', { spec: finalSpec, model: finalSpec.embeddingModel || undefined })
          : await op('test_connection', { spec: finalSpec, kind, model: finalSpec[KIND_FIELD[kind]] });
      setResults((x) => ({ ...x, [kind]: r }));
    } catch (e: any) {
      setResults((x) => ({ ...x, [kind]: { error: e?.message ?? String(e) } }));
    } finally {
      setTesting(null);
    }
  };
  const media = providers.find((p) => p.id === spec.provider)?.media ?? [];
  // Every provider except Anthropic offers embedding models (used for meaning-based checks and duplicates).
  const kinds = (['text', ...media, ...(spec.provider === 'anthropic' ? [] : ['embedding'])] as Kind[]);

  const loadModels = async () => {
    setBusy('models');
    try {
      const finalSpec = await persistSecrets();
      setSpec(finalSpec);
      setApiKey('');
      setModels(await op('list_models', { spec: finalSpec }));
    } catch (e) {
      toastError(e, 'Could not list models');
    } finally {
      setBusy(null);
    }
  };

  const secretField = (field: string, label: string, help: string) => (
    <Field label={label} help={help}>
      <Input
        type="password"
        autoComplete="off"
        placeholder={o[field] ? `Stored as {{secret.${o[field]}}} — type to replace` : 'Paste value'}
        value={extraSecrets[field] ?? ''}
        onChange={(e) => setExtraSecrets((s) => ({ ...s, [field]: e.target.value }))}
      />
    </Field>
  );

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title={isNew ? 'Add connection' : `Edit ${initial.name}`}
      description="Credentials are referenced, not copied: keys go to the secret store, and cloud logins (AWS profiles, gcloud, az) are read when needed."
      width="lg"
      footer={
        <>
          <div className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy === 'save'} disabled={!name.trim()}>
            {isNew ? 'Add connection' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" help="A label you will recognise when picking a judge or generator model.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. OpenAI (team key)" autoFocus />
          </Field>
          <Field label="Provider">
            <Select
              value={spec.provider}
              onChange={(v) => set({ provider: v, options: {} })}
              options={providers.map((p) => ({ value: p.id, label: p.label, hint: p.hint }))}
            />
          </Field>
        </div>

        {spec.provider === 'openai_compatible' && (
          <Field label="Base URL" help="The API root that has /chat/completions, e.g. http://localhost:11434/v1 for Ollama, https://openrouter.ai/api/v1, https://api.x.ai/v1, or your LiteLLM proxy.">
            <Input mono value={spec.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="http://localhost:11434/v1" />
          </Field>
        )}
        {['openai', 'anthropic', 'google'].includes(spec.provider) && (
          <Field label="Base URL (optional)" help="Leave empty for the provider's default. Set it to route through a proxy or gateway.">
            <Input mono value={spec.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="Default" />
          </Field>
        )}
        {spec.provider === 'openai' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Organization (optional)">
              <Input mono value={o.organization ?? ''} onChange={(e) => setOpt('organization', e.target.value)} />
            </Field>
            <Field label="Project (optional)">
              <Input mono value={o.project ?? ''} onChange={(e) => setOpt('project', e.target.value)} />
            </Field>
          </div>
        )}

        {spec.provider === 'azure' && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Resource name" help="The part before .openai.azure.com. Or leave empty and give the full base URL below.">
                <Input mono value={o.resourceName ?? ''} onChange={(e) => setOpt('resourceName', e.target.value)} placeholder="my-resource" />
              </Field>
              <Field label="Base URL (optional)" help="Use for Foundry or custom domains, e.g. https://my-resource.services.ai.azure.com/openai/v1">
                <Input mono value={spec.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Sign in with" help="API key, or your Azure CLI login (run `az login` first). Entra ID tokens are fetched and refreshed automatically.">
                <Select value={o.authMode ?? 'api_key'} onChange={(v) => setOpt('authMode', v)} options={[{ value: 'api_key', label: 'API key' }, { value: 'az_cli', label: 'Azure CLI login (Entra ID)' }]} />
              </Field>
              <Field label="API version (optional)" help="Only for older deployment-based endpoints. The v1 API does not need it.">
                <Input mono value={o.apiVersion ?? ''} onChange={(e) => setOpt('apiVersion', e.target.value)} placeholder="v1" />
              </Field>
            </div>
            <Field label="Use deployment-based URLs" inline help="Turn on for older resources that use /openai/deployments/{name}/… URLs. In Azure, the model name is your deployment name.">
              <Switch checked={!!o.useDeploymentBasedUrls} onChange={(v) => setOpt('useDeploymentBasedUrls', v)} />
            </Field>
          </>
        )}

        {spec.provider === 'bedrock' && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Region">
                <Input mono value={o.region ?? ''} onChange={(e) => setOpt('region', e.target.value)} placeholder="us-east-1" />
              </Field>
              <Field label="Credentials" help="AWS default chain reads env vars, ~/.aws profiles (including SSO — run `aws sso login`) and credential_process. Bedrock API keys and access keys are stored as secrets.">
                <Select
                  value={o.authMode ?? 'chain'}
                  onChange={(v) => setOpt('authMode', v)}
                  options={[
                    { value: 'chain', label: 'AWS profile / SSO / default chain' },
                    { value: 'api_key', label: 'Bedrock API key' },
                    { value: 'access_keys', label: 'Access key + secret' },
                  ]}
                />
              </Field>
            </div>
            {(o.authMode ?? 'chain') === 'chain' && (
              <Field label="Profile (optional)" help="A profile name from ~/.aws/config. Empty = default chain.">
                <Input mono value={o.profile ?? ''} onChange={(e) => setOpt('profile', e.target.value)} placeholder="default" />
              </Field>
            )}
            {o.authMode === 'access_keys' && (
              <div className="grid gap-4 sm:grid-cols-3">
                {secretField('accessKeyIdSecret', 'Access key ID', 'Stored in the secret store.')}
                {secretField('secretAccessKeySecret', 'Secret access key', 'Stored in the secret store.')}
                {secretField('sessionTokenSecret', 'Session token (optional)', 'For temporary credentials.')}
              </div>
            )}
          </>
        )}

        {spec.provider === 'vertex' && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Project ID">
                <Input mono value={o.project ?? ''} onChange={(e) => setOpt('project', e.target.value)} placeholder="my-gcp-project" />
              </Field>
              <Field label="Location" help="A region such as us-central1, or global where supported.">
                <Input mono value={o.location ?? ''} onChange={(e) => setOpt('location', e.target.value)} placeholder="us-central1" />
              </Field>
            </div>
            <Field label="Credentials" help="Application Default Credentials come from `gcloud auth application-default login` or GOOGLE_APPLICATION_CREDENTIALS. Express mode uses an API key (Gemini models only).">
              <Select
                value={o.authMode ?? 'adc'}
                onChange={(v) => setOpt('authMode', v)}
                options={[
                  { value: 'adc', label: 'Application Default Credentials (gcloud)' },
                  { value: 'service_account', label: 'Service account key file' },
                  { value: 'express', label: 'Express mode API key' },
                ]}
              />
            </Field>
            {o.authMode === 'service_account' && (
              <Field label="Key file path" help="Absolute path to the service-account JSON on this machine. The file is read when needed, not copied.">
                <Input mono value={o.keyFile ?? ''} onChange={(e) => setOpt('keyFile', e.target.value)} placeholder="/Users/me/keys/sa.json" />
              </Field>
            )}
          </>
        )}

        {keyMode && (
          <Field
            label={keyMode === 'optional' ? 'API key (optional)' : 'API key'}
            help="Saved to the secret store, never into the connection itself."
            hint={spec.apiKeySecret ? `Stored as {{secret.${spec.apiKeySecret}}}. Type a new key to replace it.` : undefined}
          >
            <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={spec.apiKeySecret ? '••••••••' : 'Paste key'} />
          </Field>
        )}

        <div className="flex flex-col gap-3 rounded-lg border border-line bg-raised/50 p-3.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 text-[0.8125rem] font-semibold">
              Models
              <HelpTip>One connection can serve several kinds of models from the same account. Fill in the ones you use; leave the rest empty. Each Test makes one small real call.</HelpTip>
            </div>
            {['openai', 'anthropic', 'openai_compatible', 'google'].includes(spec.provider) && (
              <Button size="sm" variant="ghost" onClick={loadModels} loading={busy === 'models'}>
                {models ? `${models.length} models listed` : 'List available models'}
              </Button>
            )}
          </div>
          {kinds.map((kind) => {
            const field = KIND_FIELD[kind];
            const help =
              kind === 'text'
                ? spec.provider === 'azure' ? 'Your chat deployment name. Used for LLM judges and text generation.' : 'Used for LLM judges, model targets and generating rows.'
                : kind === 'image'
                  ? 'Used to generate image datasets and by image model targets, e.g. gpt-image-2, imagen-4.0-generate-001.'
                  : kind === 'speech'
                    ? 'Text-to-speech, used to turn transcripts into audio test data, e.g. gpt-4o-mini-tts.'
                    : kind === 'embedding'
                      ? 'Optional. Turns text into vectors for meaning-based checks and duplicate search, e.g. text-embedding-3-small, or nomic-embed-text in Ollama. Without it Kalibra can use a free local model. Test works with the provider default when empty.'
                      : 'Speech-to-text, used to draft reference transcripts or as a baseline target, e.g. gpt-4o-transcribe.';
            return (
              <div key={kind} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <Field label={`${KIND_LABEL[kind]} model`} help={help}>
                  <Input mono list={`models-${kind}`} value={(spec as any)[field] ?? ''} onChange={(e) => set({ [field]: e.target.value } as any)} placeholder={kind === 'text' ? 'model id' : 'optional'} />
                </Field>
                <Button onClick={() => testKind(kind)} loading={testing === kind} disabled={kind !== 'embedding' && !(spec as any)[field]} icon={<Zap className="size-3.5" />}>
                  Test
                </Button>
                {results[kind] && (
                  <div className="sm:col-span-2">
                    <TestResult r={results[kind]} />
                  </div>
                )}
                <datalist id={`models-${kind}`}>
                  {(models ?? []).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
            );
          })}
        </div>

        <details className="group">
          <summary className="cursor-pointer text-[0.8125rem] font-medium text-ink-muted hover:text-ink">Extra headers</summary>
          <div className="mt-2">
            <KeyValueEditor value={spec.headers} onChange={(h) => set({ headers: h })} keyPlaceholder="Header" valuePlaceholder="Value" addLabel="Add header" />
          </div>
        </details>

        <ErrorBox error={error} />
      </div>
    </Dialog>
  );
}

function SecretDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const m = useOpMutation('set_secret', {
    invalidate: ['list_secrets'],
    onSuccess: () => {
      toast.success('Secret saved', `Use it as {{secret.${name}}}`);
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title="Add secret"
      description="For tokens your app under test needs, e.g. an Authorization header."
      width="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} disabled={!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !value} onClick={() => m.mutate({ name, value }, { onError: (e) => toastError(e) })}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" hint={name ? `Reference: {{secret.${name}}}` : 'Letters, digits and _'}>
          <Input mono value={name} onChange={(e) => setName(e.target.value)} placeholder="my_app_token" autoFocus />
        </Field>
        <Field label="Value">
          <Input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
