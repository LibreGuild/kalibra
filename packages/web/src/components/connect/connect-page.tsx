import { useEffect, useState } from 'react';
import { ArrowUpRight, Waves } from 'lucide-react';
import { Page } from '../layout/shell';
import { Button, buttonClass } from '../ui/button';
import { Card, CodeBlock, ErrorBox, SectionTitle, TabPanel, Tabs } from '../ui/display';
import { Field, Input } from '../ui/form';
import { toast } from '../ui/toast';
import { useMeta, useOp, useOpMutation, useProjectId } from '../../lib/api';
import { Link } from '../../lib/nav';
import { useProject } from '../../lib/session';
import { isMissingOp } from '../traces/types';
import { IngestKeys } from './ingest-keys';
import { jsSnippet, otelSnippet, proxySnippet, pythonSnippet, type SnippetContext } from './snippets';
import { sdkDocsPath } from '../../sdk-docs/links';
import { withBase } from '../../lib/base';

/*
 * Connect your app: one key and one snippet, and the app's real calls start showing up under
 * Traces. Four ways in (JS SDK, Python SDK, OpenTelemetry, OpenAI proxy); every snippet keeps
 * tracing off in production unless the app turns it on.
 */

export function ConnectPage() {
  const project = useProjectId();
  const info = useProject();
  const meta = useMeta();
  const [key, setKey] = useState<string>();
  const [tab, setTab] = useState('js');
  const base = (meta.data?.publicUrl || location.origin).replace(/\/$/, '');
  const ctx: SnippetContext = { base, project, key };
  const js = jsSnippet(ctx);
  const py = pythonSnippet(ctx);
  const proxy = proxySnippet(ctx);

  return (
    <Page
      title="Connect your app"
      description="Send your app's real calls to Kalibra: each model call, tool call and retrieval shows up under Traces, and eval runs can see the steps inside every row. Nothing changes in production unless you turn it on."
      actions={
        <Link to="/traces" className={buttonClass('secondary')}>
          <Waves className="size-4" />
          Open Traces
        </Link>
      }
    >
      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <SectionTitle help="An ingest key lets an app send traces and tool recordings to this project only. It cannot read datasets, runs or anything else.">1. Create a key</SectionTitle>
            <IngestKeys project={project} canEdit={!info || info.canEdit} onKeyChange={setKey} />
          </Card>

          <Card>
            <SectionTitle help="Pick how your app talks to Kalibra. The SDKs add the most detail (steps, tool replay, links to eval rows); OpenTelemetry and the proxy need no new library.">2. Add it to your app</SectionTitle>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { value: 'js', label: 'JavaScript / TypeScript' },
                { value: 'python', label: 'Python' },
                { value: 'otel', label: 'OpenTelemetry' },
                { value: 'proxy', label: 'OpenAI proxy' },
              ]}
            >
              <TabPanel value="js" className="flex flex-col gap-3 pt-3">
                <Snippet label="Install" code={js.install} />
                <Snippet label="Environment (.env, development only)" code={js.env} />
                <Snippet label="In your app" code={js.code} />
                <SdkDocsLink href={sdkDocsPath('js')}>JavaScript SDK docs: steps, tools, evaluate(), every option</SdkDocsLink>
              </TabPanel>
              <TabPanel value="python" className="flex flex-col gap-3 pt-3">
                <Snippet label="Install" code={py.install} />
                <Snippet label="Environment (development only)" code={py.env} />
                <Snippet label="In your app" code={py.code} />
                <SdkDocsLink href={sdkDocsPath('python')}>Python SDK docs: steps, tools, evaluate(), every option</SdkDocsLink>
              </TabPanel>
              <TabPanel value="otel" className="flex flex-col gap-3 pt-3">
                <p className="text-[0.8125rem] text-ink-muted">
                  Frameworks that already emit OpenTelemetry traces (with the <code className="font-mono">gen_ai.*</code> conventions) need no code changes: point the exporter here. Kalibra reads JSON, so keep the protocol line.
                </p>
                <Snippet label="Environment variables" code={otelSnippet(ctx)} />
              </TabPanel>
              <TabPanel value="proxy" className="flex flex-col gap-3 pt-3">
                <p className="text-[0.8125rem] text-ink-muted">
                  Calls to OpenAI go through Kalibra, which forwards them unchanged (streaming included) and records each one. Your OpenAI key still goes to OpenAI; Kalibra only reads its own key from <code className="font-mono">x-kalibra-key</code>.
                </p>
                <Snippet label="Environment (development only)" code={proxy.env} />
                <Snippet label="JavaScript / TypeScript" code={proxy.js} />
                <Snippet label="Python" code={proxy.python} />
              </TabPanel>
            </Tabs>
          </Card>

          <TraceSettings isOwner={!info || info.isOwner} />
        </div>

        <Card className="h-fit">
          <SectionTitle>What you get</SectionTitle>
          <ul className="flex flex-col gap-3 text-[0.8125rem] text-ink-muted">
            <li>
              <b className="text-ink">Real test data.</b> Pick interesting or broken calls under Traces and add them to a dataset in one click.
            </li>
            <li>
              <b className="text-ink">Steps in every eval row.</b> Runs send a few headers with each request; the SDK links the trace to the row, so agent and RAG checks can see tool calls and retrieved documents.
            </li>
            <li>
              <b className="text-ink">Safe tool replay.</b> Wrap tools with the SDK, record them once, then replay them in runs (New run → Advanced → Tools).
            </li>
            <li>
              <b className="text-ink">Off in production.</b> Every snippet checks the environment, and <code className="font-mono">KALIBRA_ENABLED=false</code> always switches it off.
            </li>
          </ul>
          <div className="mt-4 flex flex-col items-start gap-1.5">
            <Link to="/docs/traces" className="text-[0.8125rem] font-medium text-accent-ink hover:underline">
              Read the guide →
            </Link>
            <SdkDocsLink href={sdkDocsPath(tab === 'python' ? 'python' : 'js')}>SDK docs</SdkDocsLink>
          </div>
        </Card>
      </div>
    </Page>
  );
}

/** The public SDK docs, in a new tab. */
function SdkDocsLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={withBase(href)} target="_blank" rel="noopener noreferrer" className="inline-flex w-fit items-center gap-1 text-[0.8125rem] font-medium text-accent-ink hover:underline">
      {children}
      <ArrowUpRight className="size-3.5" />
    </a>
  );
}

function Snippet({ label, code }: { label: string; code: string }) {
  return (
    <div>
      <div className="mb-1 text-[0.75rem] font-medium text-ink-muted">{label}</div>
      <CodeBlock value={code} maxHeight={420} />
    </div>
  );
}

interface TraceSettingsShape {
  retentionDays: number;
  proxyOpenaiUpstream: string;
  /** What is stored now. */
  traces?: number;
  spans?: number;
  toolRecordings?: number;
}

const DEFAULT_UPSTREAM = 'https://api.openai.com';

/** https anywhere, plain http only on this machine (what the engine accepts). */
function validUpstream(raw: string) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

/** How long traces are kept, and where the OpenAI proxy forwards to (owners only). */
function TraceSettings({ isOwner }: { isOwner: boolean }) {
  const settings = useOp<TraceSettingsShape>('get_trace_settings');
  const save = useOpMutation('set_trace_settings', { invalidate: ['get_trace_settings'], onSuccess: () => toast.success('Trace settings saved') });
  const [days, setDays] = useState('');
  const [upstream, setUpstream] = useState('');
  const current = settings.data;
  useEffect(() => {
    if (!current) return;
    setDays(String(current.retentionDays));
    setUpstream(current.proxyOpenaiUpstream === DEFAULT_UPSTREAM ? '' : current.proxyOpenaiUpstream);
  }, [current]);

  if (isMissingOp(settings.error)) return null;
  const n = Number(days);
  const target = upstream.trim().replace(/\/+$/, '') || DEFAULT_UPSTREAM;
  const daysOk = Number.isInteger(n) && n >= 1 && n <= 3650;
  const upstreamOk = validUpstream(target);
  const dirty = !!current && (current.retentionDays !== n || current.proxyOpenaiUpstream !== target);

  return (
    <Card>
      <SectionTitle help={`Settings of traces in this project${isOwner ? '' : '. Only project owners can change them'}.`}>Trace settings</SectionTitle>
      <ErrorBox error={settings.error} />
      {current && (
        <p className="mb-3 text-[0.8125rem] text-ink-muted">
          Stored now: {count(current.traces ?? 0, 'trace')}, {count(current.spans ?? 0, 'step')}, {count(current.toolRecordings ?? 0, 'tool recording')}.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Keep traces for (days)" help="Older traces are removed automatically. Traces that belong to eval runs stay as long as their run." error={days && !daysOk ? 'Between 1 and 3650 days' : undefined}>
          <Input type="number" min={1} max={3650} value={days} disabled={!isOwner} onChange={(e) => setDays(e.target.value)} />
        </Field>
        <Field
          label="OpenAI proxy forwards to"
          help="Leave empty for https://api.openai.com. Use another OpenAI-compatible endpoint (Azure OpenAI, a gateway, a local model server) if you have one. Plain http works only for this machine."
          error={upstream.trim() && !upstreamOk ? 'Use https (http only for localhost)' : undefined}
        >
          <Input mono value={upstream} disabled={!isOwner} placeholder={DEFAULT_UPSTREAM} onChange={(e) => setUpstream(e.target.value)} />
        </Field>
      </div>
      {isOwner && (
        <div className="mt-3 flex justify-end">
          <Button variant="primary" size="sm" disabled={!dirty || !daysOk || !upstreamOk} loading={save.isPending} onClick={() => save.mutate({ retentionDays: n, proxyOpenaiUpstream: target })}>
            Save
          </Button>
        </div>
      )}
      <ErrorBox error={save.error} />
    </Card>
  );
}

const count = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
