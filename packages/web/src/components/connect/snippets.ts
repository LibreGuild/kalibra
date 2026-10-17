import { BASE } from '../../lib/base';

/*
 * Copy-paste snippets for sending traces to Kalibra (docs/design/sdk-and-traces.md §2 and §5).
 * Every snippet only switches tracing on outside production, so dropping it into an app is safe.
 */

export interface SnippetContext {
  /** Where the app reaches Kalibra (origin), e.g. http://127.0.0.1:4317 or https://kalibra.example.com */
  base: string;
  /** Project id (the SDK also accepts the name). */
  project: string;
  /** A key just created on this page; otherwise a placeholder the user replaces. */
  key?: string;
}

const KEY_PLACEHOLDER = 'kik_…';

/** Kalibra's API lives under /kalibra on that origin (the SDKs add it themselves). */
export const projectApi = (c: SnippetContext) => `${c.base.replace(/\/$/, '')}${BASE}/api/projects/${encodeURIComponent(c.project)}`;

export function jsSnippet(c: SnippetContext) {
  return {
    install: 'npm i kalibra-sdk',
    env: `KALIBRA_KEY=${c.key ?? KEY_PLACEHOLDER}`,
    code: `import { kalibra } from 'kalibra-sdk';

kalibra.init({
  // Development only: in production nothing is recorded (KALIBRA_ENABLED=false also turns it off).
  enabled: process.env.NODE_ENV !== 'production',
  url: '${c.base}',
  key: process.env.KALIBRA_KEY,
  project: '${c.project}',
});

// One trace per call, with the steps inside it.
export const answer = kalibra.trace('answer_question', async (question: string) => {
  const docs = await kalibra.step('retrieve', () => search(question), { kind: 'retrieval' });
  return kalibra.step('llm', () => callModel(question, docs), { kind: 'llm' });
});

// Tools can be recorded once and replayed during evals.
export const searchOrders = kalibra.tool('search_orders', realSearchOrders);

// Express / Connect: links traces to Kalibra eval runs and picks the tool mode a run asks for.
app.use(kalibra.middleware());`,
  };
}

export function pythonSnippet(c: SnippetContext) {
  return {
    install: 'pip install kalibra-sdk',
    env: `KALIBRA_KEY=${c.key ?? KEY_PLACEHOLDER}`,
    code: `import os
import kalibra

kalibra.init(
    # Development only: in production nothing is recorded (KALIBRA_ENABLED=false also turns it off).
    enabled=os.getenv("ENV") != "production",
    url="${c.base}",
    key=os.environ.get("KALIBRA_KEY"),
    project="${c.project}",
)

@kalibra.trace("answer_question")
def answer(question):
    with kalibra.step("retrieve", kind="retrieval") as s:
        docs = search(question)
        s.output = docs
    return call_model(question, docs)

# Tools can be recorded once and replayed during evals.
search_orders = kalibra.tool("search_orders")(real_search_orders)`,
  };
}

export function otelSnippet(c: SnippetContext) {
  return `# Set these in your development environment only.
# Works with LangChain, LlamaIndex, the Vercel AI SDK, OpenAI Agents SDK and any OpenTelemetry setup.
OTEL_EXPORTER_OTLP_ENDPOINT=${projectApi(c)}/otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20${c.key ?? KEY_PLACEHOLDER}`;
}

export function proxySnippet(c: SnippetContext) {
  const baseURL = `${projectApi(c)}/proxy/openai/v1`;
  return {
    js: `import OpenAI from 'openai';

// Development only: requests go through Kalibra, which records them and forwards them to OpenAI.
// Your OpenAI key is passed through unchanged; Kalibra's key goes in x-kalibra-key.
const dev = process.env.NODE_ENV !== 'production';
export const openai = new OpenAI({
  ...(dev && {
    baseURL: '${baseURL}',
    defaultHeaders: { 'x-kalibra-key': process.env.KALIBRA_KEY },
  }),
});`,
    python: `import os
from openai import OpenAI

# Development only: requests go through Kalibra, which records them and forwards them to OpenAI.
dev = os.getenv("ENV") != "production"
client = OpenAI(**({
    "base_url": "${baseURL}",
    "default_headers": {"x-kalibra-key": os.environ.get("KALIBRA_KEY", "")},
} if dev else {}))`,
    env: `KALIBRA_KEY=${c.key ?? KEY_PLACEHOLDER}`,
  };
}
