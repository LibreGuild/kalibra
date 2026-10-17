# Kalibra SDK for Python

Send what happens inside your AI app to [Kalibra](https://github.com/LibreGuild/kalibra): each request as a **trace**, its **steps** (retrieval, model calls, tools), **tool record/replay** for safe evals, and **evals from your own tests**.

```bash
pip install kalibra-sdk     # Python 3.9+, no dependencies
```

```python
import os
import kalibra

kalibra.init(enabled=os.getenv("ENV") != "production")   # key, URL and project come from KALIBRA_* env vars

@kalibra.trace("answer_question")
def answer(question: str) -> str:
    with kalibra.step("retrieve", kind="retrieval") as s:
        docs = search(question)
        s.output = [{"id": d.id, "text": d.text} for d in docs]
    return call_model(question, docs)

@kalibra.step(kind="llm")
def call_model(question, docs): ...
```

Traces appear in Kalibra under **Traces**, where any of them can become a dataset row in one click. Create the key under **Traces → Connect your app**.

## Off in production (or anywhere)

The SDK is meant for development and staging. Turning it off makes it disappear: decorators return your function unchanged, context managers are a shared no-op, and no thread or connection is ever started.

| How | Effect |
|---|---|
| `kalibra.init(enabled=os.getenv("ENV") != "production")` | Off in production, on elsewhere |
| `KALIBRA_ENABLED=false` (or `0`, `no`, `off`) | **Kill switch**: off whatever the code says |
| No `KALIBRA_KEY` | Off |
| `kalibra.init(sample_rate=0.1)` | On for 10 % of traces (rows of Kalibra eval runs are always kept) |

Call `init()` early in your entry point. Decorators applied before `init()` still follow it, at the cost of one flag check per call.

## Traces and steps

```python
@kalibra.trace("chat_turn")             # sync, async, generators and async generators
async def chat_turn(message): ...

with kalibra.trace("nightly_job") as t:  # or as a block
    t.input = params
    t.metadata["customer"] = "acme"       # also kalibra.current_trace().metadata / .tags
    t.tags.append("batch")
    ...
    t.output = summary

with kalibra.step("rerank", kind="step") as s:   # kind: llm | tool | retrieval | agent | step
    s.input = candidates
    s.output = ranked
    s.set(model="rerank-v3", top_k=5)
```

- **Inputs and outputs:** a decorated function's arguments become the input (the value itself for one argument, else a dict by parameter name), and its return value the output. Use `capture=False` to skip them.
- **Generators:** streamed text is joined into one output (handy for LLM streams), otherwise a count and the first few items. Between chunks your code is not inside the trace.
- **Nesting:** a `trace` inside another trace becomes a child step. A `step` outside any trace records nothing.
- **Errors:** an exception is recorded on the trace or step and re-raised unchanged.
- **Threads:** steps follow `contextvars`, which asyncio tasks inherit. A thread you start yourself needs `contextvars.copy_context().run(fn)` to stay in the trace.

## Model calls

```python
from openai import OpenAI
client = OpenAI()

@kalibra.step(kind="llm")            # messages in, text out: recorded as they are
def ask(messages):
    res = client.chat.completions.create(model="gpt-4o-mini", messages=messages)
    return res.choices[0].message.content

# Or record exactly what you want, with token counts:
with kalibra.step("llm", kind="llm") as s:
    s.input = messages
    res = client.chat.completions.create(model="gpt-4o-mini", messages=messages)
    s.output = res.choices[0].message.content
    s.set(model=res.model, tokens_in=res.usage.prompt_tokens, tokens_out=res.usage.completion_tokens)
```

```python
import anthropic
claude = anthropic.Anthropic()

with kalibra.step("claude", kind="llm") as s:
    s.input = messages
    msg = claude.messages.create(model="claude-sonnet-5-5", max_tokens=1024, messages=messages)
    s.output = "".join(b.text for b in msg.content if b.type == "text")
    s.set(model=msg.model, tokens_in=msg.usage.input_tokens, tokens_out=msg.usage.output_tokens)
```

No code at all: point an OpenAI client at Kalibra's proxy, `base_url=f"{KALIBRA_URL}/api/projects/<project>/proxy/openai/v1"`, with header `x-kalibra-key`, or export OpenTelemetry traces to Kalibra. See **Connect your app** in Kalibra.

## RAG: sources

Kalibra's retrieval, groundedness and citation checks read the output of `retrieval` steps. Give each document an `id` and its `text`:

```python
with kalibra.step("retrieve", kind="retrieval") as s:
    s.output = [{"id": d.id, "text": d.page_content, "score": d.score} for d in docs]
```

## Linking requests to Kalibra eval runs

When Kalibra runs a dataset through your API, each request carries `traceparent`, `x-kalibra-run`, `x-kalibra-result` and `x-kalibra-tools`. Read them, and the trace of that request lands on the right result row (its **Steps** tab). Tools then follow the run's record/replay mode. Linked traces are always kept, whatever the sample rate.

```python
# FastAPI / Starlette (any ASGI app)
app.add_middleware(kalibra.KalibraASGIMiddleware)

# Flask (any WSGI app)
app.wsgi_app = kalibra.KalibraWSGIMiddleware(app.wsgi_app)

# Django: settings.py
MIDDLEWARE = ["kalibra.middleware.KalibraDjangoMiddleware", *MIDDLEWARE]

# Anything else: wrap the handler
with kalibra.from_headers(request.headers):
    return handle(request)
```

## Tools: record, replay, fault

```python
@kalibra.tool("search_orders")
def search_orders(order_id: str): ...

refund = kalibra.tool("refund_order")(payments.refund)
```

| Mode | What happens |
|---|---|
| `live` (default) | The real call, recorded as a `tool` step |
| `record` | The real call; arguments and result are saved in Kalibra (in the background) |
| `replay` | The saved result for the same arguments; a real call when there is none |
| `replay-strict` | The saved result, or `kalibra.ReplayMissing` |
| `fault:timeout` / `fault:error` / `fault:empty` | `TimeoutError` / `RuntimeError` / `None`, without calling |

The mode comes from the request's `x-kalibra-tools` header (set by the run's **Tools** setting in Kalibra), else `KALIBRA_TOOLS`, else `live`. Replay makes evals fast, free and repeatable, and they never send real emails or refunds.

**Tool arguments hash.** Recordings are found by tool name and the SHA-256 of the arguments' canonical JSON. That's byte-for-byte what the JS SDK computes, so recordings are shared between Node and Python services.
- **Arguments as one value:** a single argument is the value itself, keyword arguments alone are one object, anything else is a list (with keyword arguments as a trailing object). `search({"q": "x"})`, `search(q="x")` and JS `search({ q: "x" })` all give `{"q":"x"}`.
- **Canonical JSON:**
  - no spaces;
  - object keys sorted by UTF-16 code units;
  - non-ASCII characters as they are;
  - numbers as JavaScript writes them (`1.0` → `1`, `1e-07` → `1e-7`, integers past 2⁵³ as their double);
  - `NaN`/`Infinity` → `null`;
  - lone surrogates as `\udxxx`.
- Use `kalibra.args_hash(value)` and `kalibra.canonical_json(value)` to check.

## Evals from your tests

```python
from kalibra.eval import evaluate

def test_support_bot():
    result = evaluate(
        dataset="Support questions",
        suite="Chat checks",
        task=lambda row: answer(row["question"]),   # or {"output": ..., "sources": [...], "metrics": {"tokens": 120}}
        concurrency=4,
    )
    result.expect(min_pass_rate=0.9, no_new_failures=True)
```

- **How it runs:** Kalibra hands out the dataset rows, `task` runs here for each row (timed, exceptions recorded as row errors), and Kalibra scores the outputs with the suite and compares with the baseline run. The run appears in Kalibra with its git branch and commit.
- **Async:** async tasks work too; inside a running event loop, use `await evaluate_async(...)`.
- **Where Kalibra is:** `url=` / `token=`, else `KALIBRA_URL` / `KALIBRA_TOKEN` (a personal access token `kal_…` from **Account**), else the Kalibra app running on this computer.
- **Result:** `run_id`, `pass_rate`, `passed`, `failed`, `new_failures`, `fixed`, `baseline`, `url`, `summary`.

## Configuration

| `init()` argument | Environment | Default |
|---|---|---|
| `enabled` | `KALIBRA_ENABLED` (kill switch) | on when a key is set |
| `url` | `KALIBRA_URL` | `http://127.0.0.1:4317` |
| `key` | `KALIBRA_KEY` | none (an ingest key `kik_…`) |
| `project` | `KALIBRA_PROJECT` | `default` (id or name) |
| `sample_rate` | `KALIBRA_SAMPLE_RATE` | `1` |
| `environment`, `release` | `KALIBRA_ENVIRONMENT`, `KALIBRA_RELEASE` | none (added to each trace's metadata) |
| `redact` | | `True`: emails, phone and card numbers, API keys → `[redacted]`. Or a function applied to every string, or `False` |
| `flush_interval`, `timeout` | | `1.0` s, `5.0` s |

`kalibra.flush()` sends what is queued (call it before a serverless function returns). `kalibra.shutdown()` also stops the sender. Both run at exit on their own.

## Performance

Nothing in your call path waits on the network.

- **Finishing a trace:** a finished trace is copied into JSON-safe data and put on a queue. The copy is capped at 32 KB per field, so its cost is bounded however big your objects are.
- **Background thread:** a single daemon thread wakes every second, or once 200 steps are waiting. It redacts, serializes and sends in batches; a failed batch is retried twice, then dropped.
- **Limits:**
  - the queue holds at most 10 000 steps, and the oldest are dropped when it's full;
  - a trace keeps at most 256 steps;
  - the SDK never raises into your code, and logs one warning per kind of problem.
- **Processes:** forked workers (gunicorn, multiprocessing) start their own sender.

Measured on an Apple M-series laptop (Python 3.12, `tests/test_perf.py`):

| | Cost |
|---|---|
| Disabled, decorated function | the plain function (identical object) |
| Disabled, `with kalibra.step(...)` | ~0.1 µs per block |
| Sampled out | ~1 µs per call |
| Enabled, a trace with 2 steps | ~50 µs in the call path; sending happens in the background |

## What is sent

`POST {url}/api/projects/{project}/ingest/traces` with `Authorization: Bearer <key>`:

```json
{"traces": [{
  "id": "4bf92f3577b34da6a3ce929d0e0e4736", "name": "answer_question",
  "startedAt": "2026-10-17T09:00:00.000Z", "durationMs": 812.4, "status": "ok",
  "input": "How do I block my card?", "output": "Open the app…",
  "metadata": {"environment": "dev", "release": "1.4.2"}, "tags": ["smoke"],
  "runId": "run_…", "resultId": "res_…",
  "spans": [{"id": "00f067aa0ba902b7", "name": "retrieve", "kind": "retrieval",
             "startedAt": "…", "durationMs": 31.2, "output": [{"id": "kb-17", "text": "…"}],
             "attributes": {"top_k": 3}, "parentId": "…"}]
}]}
```

- Fields that would be empty are left out.
- `error` (text) and `status: "error"` mark failures.
- `runId` and `resultId` appear only when the request came from a Kalibra eval run.

**Tool recordings:**
- `POST {url}/api/projects/{project}/ingest/tools` with body `{"tool", "args", "argsHash", "output" | "error"}`;
- replay reads `GET …/ingest/tools?tool=<name>&argsHash=<sha256>`, which answers `{"found", "output", "error"}`.

## Development

```bash
cd sdks/python
python3 -m unittest discover -s tests -v    # standard library only; pytest works too
```

The code map is in `src/kalibra/__init__.py`. The design shared with the JS SDK and the server is in [`docs/design/sdk-and-traces.md`](../../docs/design/sdk-and-traces.md).

MIT licensed.
