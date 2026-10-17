# kalibra-sdk

Report what happens inside your AI app to [Kalibra](https://github.com/LibreGuild/kalibra), link it to eval runs, make tools replayable, and run evals as code.

- **Zero dependencies**, Node ≥ 18, ESM and CommonJS, with types.
- **Off in production unless you opt in.** When off, your functions are handed back untouched.
- **Never in the way.** Nothing waits on the network, there's a bounded memory queue, and errors are swallowed.

```bash
npm i kalibra-sdk
```

## Quick start

```ts
import { kalibra } from 'kalibra-sdk';

kalibra.init({
  enabled: process.env.NODE_ENV !== 'production', // off in production
  url: 'http://127.0.0.1:4317',                    // or KALIBRA_URL
  key: process.env.KALIBRA_KEY,                     // ingest key kik_… (Kalibra → Traces → Connect your app)
  project: 'Support bot',                           // or KALIBRA_PROJECT
});

export const answer = kalibra.trace('answer_question', async (question: string) => {
  const docs = await kalibra.step('retrieve', () => search(question), { kind: 'retrieval', input: question });
  return kalibra.step('llm', () => callModel(question, docs), { kind: 'llm' });
});
```

Every call to `answer` becomes a trace in Kalibra → **Traces**, with its steps. Pick interesting ones and click **Add to dataset** to turn them into test rows.

## Turning it on and off

| How | Effect |
|---|---|
| `init({ enabled: process.env.NODE_ENV !== 'production' })` | the usual pattern: on in dev and staging, off in production |
| `KALIBRA_ENABLED=false` (or `0`, `off`) | **kill switch**: always off, whatever the code says |
| `KALIBRA_ENABLED=true` | on (when a key is set), when the code doesn't say |
| no key (`key` / `KALIBRA_KEY`) | off |
| `sampleRate: 0.1` / `KALIBRA_SAMPLE_RATE=0.1` | keep 10% of traces; eval-run traffic is always kept |

When off:
- `kalibra.trace(name, fn)` returns `fn` itself and `kalibra.tool(name, fn)` returns `fn`;
- `kalibra.step(name, fn)` just calls `fn`;
- nothing is allocated, queued or sent.

Call `init` once at startup, **before** wrapping functions. Functions wrapped before `init` check on each call (a single boolean) instead.

## Linking traces to Kalibra eval runs

During an eval run, Kalibra calls your app with `traceparent`, `x-kalibra-run`, `x-kalibra-result` and `x-kalibra-tools` headers. Read them, and the traces of that request appear on the eval row: agent and RAG checks can then look at the steps (tool calls, retrieved documents).

**Express / Connect:**

```ts
app.use(kalibra.middleware());
app.post('/chat', async (req, res) => res.json({ output: await answer(req.body.message) }));
```

**Next.js route handler** (or anything with a fetch `Request`):

```ts
export async function POST(req: Request) {
  return kalibra.fromRequest(req, async () => {
    const { message } = await req.json();
    return Response.json({ output: await answer(message) });
  });
}
```

**Plain Node `http`, Fastify, Koa…:** `kalibra.fromRequest(req, () => handle(req, res))` takes an `IncomingMessage`, a fetch `Request`, a `Headers` object, or a plain header object.

## Wrapping model calls

```ts
import OpenAI from 'openai';
const openai = new OpenAI();

const chat = kalibra.trace(
  'openai.chat',
  (messages: OpenAI.ChatCompletionMessageParam[]) => openai.chat.completions.create({ model: 'gpt-4.1-mini', messages }),
  { kind: 'llm', output: (r) => r.choices[0]?.message?.content },
);
```

```ts
import Anthropic from '@anthropic-ai/sdk';
const anthropic = new Anthropic();

const reply = await kalibra.step('claude', async (span) => {
  const msg = await anthropic.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 1024, messages: [{ role: 'user', content: question }] });
  span.setAttributes({ model: msg.model, tokens_in: msg.usage.input_tokens, tokens_out: msg.usage.output_tokens });
  return msg.content;
}, { kind: 'llm', input: question });
```

- **Inside a trace**, a traced function becomes a child span; **outside**, it starts its own trace.
- `kalibra.trace.run(name, fn)` runs a block now as a trace.
- **Streaming:** a traced generator (`async function*` or `function*`) stays open while the caller consumes it, so its duration and the steps inside it are right. Its output is the yielded text joined (or the number of items and the first few). Stream objects from other SDKs are returned untouched; record what they produced with `span.setOutput()`.
- Use `kalibra.currentTrace().setMetadata({ user, session })` / `.addTags('beta')` to label the current trace.

## Tools: record, replay, break on purpose

```ts
const searchOrders = kalibra.tool('search_orders', realSearchOrders);
```

| Mode | What the wrapped tool does |
|---|---|
| `live` (default) | calls the real function; sync stays sync |
| `record` | calls it and saves the arguments and result in Kalibra |
| `replay` | returns the saved result for the same arguments, or calls for real if there's none |
| `replay-strict` | returns the saved result, or throws if there's none |
| `fault:timeout` / `fault:error` / `fault:empty` | throws `TimeoutError` / `ToolError`, or returns `null`, without calling |

**Where the mode comes from**, in order:
1. the `x-kalibra-tools` header of the request Kalibra made (pick it in Runs → New run → Advanced → Tools);
2. `KALIBRA_TOOLS`;
3. `live`.

Modes other than `live` return a Promise.

Recordings keep the exact arguments and result (as JSON), not the shortened copies traces keep, and they are not redacted: replay has to return the real values, and Kalibra finds a recording by its arguments. Only `record` mode makes them, so record with data you are fine storing in your Kalibra.

Recordings are looked up by tool name plus **sha256 of the canonical JSON of the arguments**:
- the arguments are the single argument, or the argument list when there are several;
- canonical JSON is `JSON.stringify` without spaces, with object keys sorted (by code unit), `undefined` left out of objects (`null` in arrays), non-finite numbers as `null`, BigInt as a string, and Dates as ISO strings;
- the Python SDK and the Kalibra server compute the same string;
- numbers use their shortest form (`1.0` is `1`), so pass integers or strings when recordings must match across languages.

## Evals as code (vitest, jest, node, CI)

```ts
// support.eval.test.ts
import { evaluate } from 'kalibra-sdk/eval';
import { answer } from '../src/bot';

test('support bot quality', async () => {
  const run = await evaluate({
    dataset: 'Support questions',
    suite: 'Chat checks',
    task: (row) => answer(row.question),   // return the output, or { output, …other fields, metrics }
    concurrency: 4,
  });
  expect(run.passRate).toBeGreaterThan(0.9);
  expect(run.newFailures).toEqual([]);     // compared with the latest run on your base branch
}, 120_000);
```

**How it runs:**
- Kalibra provides the rows and the checks, and your function runs locally. No API needs to be running.
- Each row's `latency_ms` is measured, and errors become failed rows.
- Traces your task produces are attached to their rows.
- The run shows up in Kalibra like any other.

**Connecting:**
- **On your computer:** with the Kalibra app open, nothing to configure (it reads `~/Kalibra/default/.engine.json`).
- **Team server:** set `KALIBRA_URL` and `KALIBRA_TOKEN` (an access token `kal_…` from Account → Access tokens).
- **GitHub Actions:** the git branch, commit and PR are picked up for the baseline comparison.

**Options:**
- `limit`, `tags`: choose rows;
- `timeoutMs`: per row;
- `tools`: e.g. `'replay'`;
- `baseline`: a run id;
- `git`;
- `onResult`.

## Performance

Measured on an M-series laptop (`npx vitest run packages/sdk`):

| Case | Cost |
|---|---|
| Off: 100 000 calls of a wrapped function plus a step | ~3 ms total (the function itself is returned) |
| On: one trace with 2 steps | ~7 µs, including bounded JSON copies of inputs and outputs |
| On but not sampled | ~0.15 µs per trace |
| Sending 10 000 traces | runs in the background, batched (≤ 1000 traces / 5000 spans / ~2 MB per request) |

**Limits that keep it predictable:**
- each value in a trace is at most 32 KB (larger values become a preview);
- at most 256 spans per trace;
- the queue holds at most 10 000 spans (the oldest are dropped when Kalibra is unreachable or slow);
- sending retries twice, then drops;
- personal-data redaction runs on the background sender.

For serverless functions, call `await kalibra.flush()` before returning. Pending traces are also sent automatically when the process is about to exit.

## Privacy

`redact: true` (the default) replaces these with `[redacted]` before anything is sent:
- email addresses;
- phone numbers;
- payment card numbers (Luhn-checked);
- common API keys (`sk-…`, `AKIA…`, `ghp_…`, `xox…`, `kal_…`, `kik_…`).

`redact: false` sends values as they are. Or pass your own `redact: (value) => value`.

Redaction applies to traces. Tool recordings are sent exactly as they are (see [Tools](#tools-record-replay-break-on-purpose)).

## Environment variables

| Variable | Meaning |
|---|---|
| `KALIBRA_ENABLED` | `false` = kill switch; `true` = on when a key is set |
| `KALIBRA_URL` | Kalibra address (default `http://127.0.0.1:4317`) |
| `KALIBRA_KEY` | ingest key `kik_…` (traces and tool recordings only) |
| `KALIBRA_PROJECT` | project id or name (default `default`) |
| `KALIBRA_SAMPLE_RATE` | share of traces kept, 0..1 |
| `KALIBRA_ENVIRONMENT`, `KALIBRA_RELEASE` | labels on every trace |
| `KALIBRA_TOOLS` | default tool mode |
| `KALIBRA_TOKEN` | access token for `evaluate()` on a team server |

## API

| Function | |
|---|---|
| `init(options)` | settings; returns `{ enabled }` |
| `trace(name, fn, { kind, input, output, metadata, tags })` | wraps `fn`; each call is a trace (or a child span) |
| `trace.run(name, fn, options)` | runs `fn(handle)` now as a trace |
| `step(name, fn, { kind, input, attributes, output })` | runs `fn(span)` as a step; kinds `llm`, `tool`, `retrieval`, `agent`, `step` |
| `tool(name, fn)` | wraps a tool (record / replay / fault) |
| `middleware()`, `fromRequest(req, fn?)` | link traces to Kalibra eval rows |
| `currentTrace()`, `currentSpan()` | handles: `setMetadata`, `addTags`, `setInput`, `setOutput`, `setAttributes` |
| `flush()`, `shutdown()` | send queued traces now / and stop |
| `evaluate(options)` (`kalibra-sdk/eval`) | evals as code |

MIT licensed.
