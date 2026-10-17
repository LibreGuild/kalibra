# Design: SDKs, traces, code runs, agent/RAG checks, tool replay

The contract every part of this feature builds against: core, server, the JS and Python SDKs, the web UI and the CLI. Change it here first when something has to change.

Kalibra keeps working exactly as before. Everything here is optional:

```
             ┌──────────── today: targets call the app from outside ────────────┐
Kalibra ─────┤                                                                  ├──► your app
             └── new: the app reports what happened inside (SDK / OTel / proxy) ┘
```

## 1. Data (per project, in the project's kalibra.db; migration 5)

```sql
traces (
  id TEXT PRIMARY KEY,              -- 32 hex chars (W3C trace id) or SDK-generated
  name TEXT NOT NULL,               -- e.g. "answer_question"
  source TEXT NOT NULL,             -- 'sdk' | 'otel' | 'proxy'
  status TEXT NOT NULL,             -- 'ok' | 'error'
  started_at TEXT NOT NULL, duration_ms REAL,
  input TEXT, output TEXT,          -- JSON (SDK truncates large values; see §5)
  error TEXT,
  metadata TEXT NOT NULL DEFAULT '{}', -- {environment, release, user, session, ...} free-form
  tags TEXT NOT NULL DEFAULT '[]',
  run_id TEXT, result_id TEXT,      -- set when the trace belongs to an eval run row (see §4)
  created_at TEXT NOT NULL
);
CREATE INDEX traces_started ON traces(started_at);
CREATE INDEX traces_result ON traces(result_id) WHERE result_id IS NOT NULL;
CREATE INDEX traces_name ON traces(name, started_at);

spans (
  id TEXT NOT NULL, trace_id TEXT NOT NULL, parent_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,               -- 'llm' | 'tool' | 'retrieval' | 'agent' | 'step'
  started_at TEXT NOT NULL, duration_ms REAL,
  input TEXT, output TEXT, error TEXT,
  attributes TEXT NOT NULL DEFAULT '{}', -- model, tokens_in/out, cost, tool args, documents …
  PRIMARY KEY (trace_id, id)
);

tool_recordings (
  tool TEXT NOT NULL, args_hash TEXT NOT NULL,  -- sha256 of canonical JSON args
  args TEXT NOT NULL, output TEXT, error TEXT,
  recorded_at TEXT NOT NULL, run_id TEXT,
  PRIMARY KEY (tool, args_hash)
);
```

Retention: traces older than `trace_retention_days` (project setting, default 30) are pruned on start. Traces belonging to runs are kept with their run.

**Hub (hub.db, migration 2):**
```sql
ingest_keys (id, project_id, name, prefix, token_hash UNIQUE, created_at, created_by, last_used_at, revoked_at)
```
- An ingest key (`kik_…`) may only send traces and read or write tool recordings of its one project. It can't read anything else.
- Keys are created and revoked by project editors, through hub ops `list_ingest_keys`, `create_ingest_key` and `revoke_ingest_key`. These work in local mode too, because the SDK runs in another process.

## 2. HTTP endpoints (server)

All under `/api/projects/:project/…`. Auth: an ingest key (`Authorization: Bearer kik_…`) or the normal session/token/local token with the editor role.

| Method & path | Body / query | Notes |
|---|---|---|
| `POST /ingest/traces` | `{ traces: TraceIn[] }` | ≤ 2 MB per request, ≤ 1000 traces, ≤ 5000 spans. Answers `202 { accepted }` right away; writes are batched. |
| `POST /otlp/v1/traces` | OTLP/HTTP **JSON** (`ExportTraceServiceRequest`) | Maps `gen_ai.*` semantic conventions to span kinds and attributes; `traceparent` / resource attributes `kalibra.result_id` / `kalibra.run_id` join to runs. Protobuf answers `415` with a hint to set `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`. |
| `ANY /proxy/openai/*` | passed through to `upstream` (default `https://api.openai.com`, project setting `proxy.openaiUpstream`) | Kalibra key in `x-kalibra-key`; the client's `Authorization` goes to OpenAI unchanged. Records one trace with an `llm` span (model, messages, output, tokens, latency). Streaming responses are passed through as they arrive and recorded when they finish. |
| `GET /ingest/tools?tool=&argsHash=` | | `200 {found, output, error}` |
| `POST /ingest/tools` | `{ tool, args, argsHash, output?, error? }` | record (upsert) |

```ts
interface TraceIn {
  id?: string; name: string; startedAt: string; durationMs?: number;
  input?: unknown; output?: unknown; error?: string; status?: 'ok' | 'error';
  metadata?: Record<string, unknown>; tags?: string[];
  runId?: string; resultId?: string;              // from the incoming Kalibra headers (§4)
  spans?: SpanIn[];
}
interface SpanIn { id: string; parentId?: string; name: string; kind: 'llm'|'tool'|'retrieval'|'agent'|'step';
  startedAt: string; durationMs?: number; input?: unknown; output?: unknown; error?: string; attributes?: Record<string, unknown> }
```

## 3. Ops (registry → UI, CLI, MCP)

| Op | Access | Purpose |
|---|---|---|
| `list_traces` | viewer | filters: name, status, source, since/until, search, runId, metadata key=value; paged |
| `get_trace` | viewer | trace + spans tree |
| `delete_traces` | editor | by ids or filter |
| `traces_to_dataset` | editor | `{traceIds, dataset, mapping: {column: 'input' \| 'output' \| 'input.path' \| …}, status: 'needs_review'}` |
| `get_trace_settings` / `set_trace_settings` | viewer / owner | retention days, proxy upstream |
| `list_tool_recordings` / `delete_tool_recordings` | viewer / editor | |
| `start_code_run` | editor | `{dataset, suite, name?, git?:{branch,commit,pr,baseBranch}, limit?, tags?}` → `{runId, rows:[{id,data}]}` (kind `code`) |
| `submit_code_results` | editor | `{runId, results:[{rowId, outputs, metrics?, error?, traceId?}]}` (batches; idempotent per rowId) |
| `finish_code_run` | editor | `{runId, baselineRunId?}` → `{run, summary, baseline?:{runId,passRate}, newFailures:[{rowId,reason}], fixed:[rowId]}` |
| `compare_to_baseline` | viewer | same report for any finished run; default baseline = latest completed run on `git.baseBranch` (or `main`) with the same dataset + suite + target |

## 4. Joining traces to eval rows

- **Outgoing:** for HTTP and WebSocket targets, the runner adds these headers when the target's `traces.send` is on (default on):
  - `traceparent: 00-<traceId>-<spanId>-01`
  - `x-kalibra-run: <runId>`
  - `x-kalibra-result: <resultId>`
  - `x-kalibra-tools: <mode>` (§6)
- **SDK side:** `kalibra.fromRequest(req)` or `middleware()` reads those headers, and the trace carries `runId` / `resultId`.
- **Runner:** after the call, if `traces.wait` > 0 (default 1500 ms when the run has `collectTraces`), it waits for a trace with that `result_id`, then attaches it. The result's `steps` holds the spans.
- **Check scope** gets:
  - `steps` (spans, in order);
  - `sources`: retrieval span outputs normalized to `[{id, text, score?}]`, or from `outputs.sources`;
  - `tool_calls`: tool spans normalized to `[{name, args, output, error}]`, or from `outputs.tool_calls`.

  API-only apps can return `sources` / `tool_calls` fields and map them with extractors; no SDK needed.
- **Script and model targets** can also produce `steps` themselves: they return `{ output, steps }`.

## 5. SDKs

**JS:** `packages/sdk`, npm `kalibra-sdk`. Zero dependencies, Node ≥ 18; ESM + CJS + types.
**Python:** `sdks/python`, PyPI `kalibra-sdk`. Stdlib only, Python ≥ 3.9.

```ts
import { kalibra } from 'kalibra-sdk';

kalibra.init({
  // Off in production unless you opt in. KALIBRA_ENABLED=false always wins (kill switch).
  enabled: process.env.NODE_ENV !== 'production',
  url: 'http://127.0.0.1:4317',      // or KALIBRA_URL
  key: process.env.KALIBRA_KEY,      // ingest key kik_… (KALIBRA_KEY)
  project: 'Support bot',            // or KALIBRA_PROJECT (id or name)
  sampleRate: 1,                     // 0..1 traces kept (KALIBRA_SAMPLE_RATE)
  redact: true,                      // emails, phones, cards, API keys → [redacted]; or (value) => value
  environment: 'dev', release: '1.4.2',
});

export const answer = kalibra.trace('answer_question', async (question: string) => {
  const docs = await kalibra.step('retrieve', () => search(question), { kind: 'retrieval' });
  return kalibra.step('llm', () => llm(question, docs), { kind: 'llm' });
});

const searchOrders = kalibra.tool('search_orders', realSearchOrders); // live / record / replay / fault (§6)
app.use(kalibra.middleware());          // Express/Connect: links traces to Kalibra eval rows via headers
await kalibra.flush();                  // e.g. before a serverless function returns
```

```python
import kalibra
kalibra.init(enabled=os.getenv("ENV") != "production", url=..., key=..., project="Support bot")

@kalibra.trace("answer_question")
def answer(question):
    with kalibra.step("retrieve", kind="retrieval") as s:
        docs = search(question); s.output = docs
    return llm(question, docs)

search_orders = kalibra.tool("search_orders")(real_search_orders)
```

**Rules (both SDKs):**
- **Disabled** means a pass-through: `trace(fn)` returns `fn` itself and `step` just calls the function, with nothing allocated and no network use. Disabled when `enabled: false`, `KALIBRA_ENABLED=false`/`0`, or there is no key.
- **Never in the way:**
  - nothing in the call path waits on the network;
  - spans go into an in-memory queue (≤ 10 000 spans; the oldest are dropped when full);
  - a background flush runs every 1 s or every 200 spans (unref'd timer / daemon thread) and retries twice with backoff, then drops;
  - SDK errors are swallowed and reported once to stderr.
- **Sampling** is decided once per trace, at its start; unsampled traces cost a single random number.
- **Size limits:** values are serialized safely (cycles, BigInt, Buffers) and truncated to 32 KB per field, plus 256 spans per trace.
- **Redaction** runs on the background flush, not in the call path.
- **Context:** Node uses AsyncLocalStorage, Python `contextvars`; nested `trace` inside `trace` becomes a child span.
- **Eval helper:**
  - JS: `import { evaluate } from 'kalibra-sdk/eval'`.
  - Python: `from kalibra.eval import evaluate`.
  - Signature: `evaluate({ dataset, suite, task: (row) => output | {output, …}, name?, concurrency?, limit?, baseline? })` → `{ runId, passRate, passed, failed, newFailures, url }`.
  - It calls `start_code_run` → runs `task` locally per row (timing `latency_ms`, catching errors) → `submit_code_results` in batches → `finish_code_run`.
  - It works with a normal access token (`KALIBRA_TOKEN`) or the local app.

## 6. Tool record / replay

- **Mode**, per call, from the first of:
  1. the `x-kalibra-tools` header of the current request (via middleware/`fromRequest`);
  2. the `KALIBRA_TOOLS` env var;
  3. `live`.
- **Modes:**
  - `live`: call the real function.
  - `record`: call it and POST the args and output.
  - `replay`: GET the recording by `(tool, sha256(canonical JSON args))`; if missing, call for real (`replay-or-live`, default) or throw (`replay-strict`).
  - `fault:timeout` / `fault:error` / `fault:empty`: simulate a failure without calling.
- **Run settings** add `tools: 'live' | 'record' | 'replay' | 'replay-strict' | 'fault:…'`, sent as the header. In the UI: Runs → New run → Advanced → "Tools".

## 7. New checks (`checks/agents.ts`, `checks/rag.ts`)

| type | config | passes when |
|---|---|---|
| `retrieval_recall` | `expected: '{{expected_sources}}'` (ids), `k?`, `min: 1` | ≥ `min` fraction of expected ids are among the first k retrieved `sources` |
| `grounded` | connection, model | an LLM judge finds every claim in the answer supported by `sources` (score = supported / claims) |
| `citations` | `pattern: '\\[(\\w[\\w-]*)\\]'` or `field` | every cited id exists in `sources` |
| `tool_called` | `name`, `args?` (partial match, templates), `min: 1`, `max?` | calls of `name` matching args are within [min, max] |
| `tool_not_called` | `names: []` | none of these tools was called |
| `tool_order` | `sequence: []` | the calls contain this sequence in order (not necessarily adjacent) |
| `step_limits` | `maxSteps?`, `maxLlmCalls?`, `maxToolCalls?` | counts within limits |

All of them skip, with a clear reason, when there is nothing to check (no sources, no steps).

## 8. CLI and CI

- `kalibra run … --baseline auto|<runId> --report markdown --git-branch … --git-commit …`: auto-detects `GITHUB_*` env.
- `kalibra eval-report <runId> --format markdown`: prints the comparison.
- Composite action `action/action.yml` (`uses: LibreGuild/kalibra/action@vX`):
  - inputs: `server`, `token`, `project`, `dataset`, `target`, `suite`, `min-pass`, `comment: true`;
  - runs the CLI and posts or updates one PR comment (marker `<!-- kalibra-eval -->`) using `GITHUB_TOKEN`.

## 9. UI

- **Traces** (sidebar, project): list (name, status, duration, source, time, environment), filters, and a detail sheet with the span tree, each span's input/output/attributes, "Add to dataset", and a link to its run row.
- **Connect your app** (from Traces' empty state and Coding agents): ingest keys and copy-paste snippets for JS, Python, OpenTelemetry env vars, and the OpenAI proxy base URL. Settings for retention and proxy upstream.
- **Run result sheet:** a "Steps" tab when `steps` exist.
- **Run dialog:** Advanced → "Tools" mode, and "Collect traces from my app" with a wait time.
- **Checks catalogue:** a new "Agents & RAG" category.
