# The engine (`packages/core`)

## Operations

```ts
defineOp({
  name: 'add_dataset_rows',            // snake_case, becomes the MCP tool name
  title: 'Add rows',
  description: '…',                    // shown in the API, CLI help and to agents
  category: 'datasets',
  input: z.object({ … }),              // zod → validated input → JSON Schema for MCP
  readOnly?, destructive?,             // become MCP readOnlyHint / destructiveHint
  quiet?,                              // not shown in the activity feed
  mcp?: false,                         // hidden from agents (secret handling only)
  handler: ({ engine, actor }, input) => …,
});
```

- Ops live in `src/ops/*.ts` and are registered in `src/ops/index.ts`.
- `engine.call(name, input, actor)` validates, runs, logs non-read-only calls to `activity`, and emits an event.

## Actors, activity, events

- **Actor** = `{ kind: 'user' | 'agent' | 'cli' | 'system', id, client?, model? }`. The MCP bridge sends `x-kalibra-actor`.
- Agent-added rows default to `needs_review` and record provenance (client, model).
- **Events** (`events.ts`): `dataset.changed`, `rows.changed`, `def.changed`, `run.updated`, `result.updated`, `job.updated`, `activity`. Streamed to the UI over SSE.

## Jobs

`engine.jobs.start(kind, title, async (job) => { job.progress(done, total); job.itemError(…) })`. Used for image/speech generation, transcription, audio variants and the safety pack. In memory; ops are idempotent ("fill empty rows") so an interrupted job can be re-run.

## Runner

```
start_run ─► dataset version snapshot ─► pending results (row × repetition)
          ─► N workers ─► executeTarget ─► retries (Retry-After, backoff+jitter)
                       ─► evaluateChecks (layers, gates) ─► saveResult ─► event
          ─► live summary every ~2 s ─► final summary
```

- Crash or cancel leaves rows `pending`; `resume_run` continues. Runs left `running` become `interrupted` on startup.
- **Imported runs** skip the target and score outputs from a file.

## Checks and gates

- Layers 0–5: Transport, Structure, Fields, Content, Reference metrics, Judgment.
- A failing **gate** skips every check in later layers for that row.
- `applyWhen` (JS expression) makes a check conditional.
- Row pass: all checks pass, or weighted score ≥ threshold.

## Summaries

- Pass rate with a **Wilson 95% interval**.
- **Corpus WER/CER** = Σ errors ÷ Σ reference units (checks report `details.errors` / `details.refUnits`).
- Percentiles (p50/p95/p99) for every numeric metric.
- `compare_runs`: row matching + exact **McNemar** p-value. `run_breakdown`: per tag/column groups. `judge_agreement`: kappa, TPR/TNR, corrected pass rate.

## Templates

`{{ path | filter }}` in URLs, headers, bodies and check configs.

- Paths: row columns, `vars.*`, `secret.*`, `output`, `outputs.*`, `response.*`, `metrics.*`, `$uuid`, `$timestamp`.
- Filters: `json`, `raw`, `base64`, `dataurl`, `text`, `urlencode`, `upper`, `lower`, `trim`, `default(x)`, `join(sep)`, `first`, `last`, `length`.
- In JSON bodies, `{{x}}` inside quotes is escaped automatically; `{{x | json}}` inserts raw JSON.

## Scripts (escape hatches)

`runScript(code, args)` runs user JS in a `vm` context with `fetch`, `Buffer`, `crypto`, `require`. **Trust model:** scripts run with the user's permissions (like npm scripts). A hosted server mode must swap in a real sandbox.

## Providers

- Built on the Vercel AI SDK behind `createLlmClient`: `text`, `json`, `image`, `speech`, `transcribe`.
- Connections reference **credential sources**: secret names, AWS profiles/SSO, gcloud ADC, service-account files, `az` CLI tokens.
- Structured output schemas are made **strict** (all keys required, optional → nullable) so OpenAI's strict mode accepts them.
- `inferModelKind(model)` routes connection tests to the right API (text / image / speech / transcription).
