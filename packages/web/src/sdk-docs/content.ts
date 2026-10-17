import type { Code, Section, Text } from './types';

/*
 * The SDK docs: packages/sdk (npm `kalibra-sdk`) and sdks/python (PyPI `kalibra-sdk`, import
 * `kalibra`). Every name and default here is checked against the SDK sources; when the SDKs
 * change, change this file too (test/sdk-docs.test.ts checks its shape).
 *
 * Style: each section opens with one line on when you need it, then code, then a compact
 * reference. Short beats complete-but-boring.
 */

/** A code sample indented with the source: the shared indentation is removed. Raw, so `\n` stays as typed. */
function src(strings: TemplateStringsArray): string {
  const raw = strings.raw.join('').replace(/\\`/g, '`').replace(/\\\$\{/g, '${');
  const lines = raw.replace(/^\n/, '').replace(/\n\s*$/, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return lines.map((l) => l.slice(indent)).join('\n');
}

const both = (s: string): Code => ({ js: s, python: s });
const t = (js: string, python: string): Text => ({ js, python });

export const GROUPS = ['Get started', 'Record', 'Connect to runs', 'Evals as code', 'Without the SDK', 'Operate', 'Reference'];

export const SECTIONS: Section[] = [
  // ── Get started ─────────────────────────────────────────────────────────────
  {
    id: 'overview',
    group: 'Get started',
    title: 'What the SDK does',
    when: 'Start here: what the SDK adds to your app, and what it costs.',
    blocks: [
      {
        type: 'text',
        text: 'During an eval run, Kalibra calls your app from the outside. The SDK shows the **inside**: the documents a request retrieved, the prompt it sent, every tool it called.',
      },
      {
        type: 'cards',
        items: [
          { title: 'Traces', text: 'Every real call to your app, with its steps. Turn interesting ones into test rows in one click.' },
          { title: 'Steps in eval rows', text: 'Runs link each row to its trace, so agent and RAG checks can read tool calls and retrieved documents.' },
          { title: 'Tool replay', text: 'Record tools once, replay them in runs: fast, free, and no real email or refund is ever sent.' },
          { title: 'Evals in your tests', text: t('`evaluate()` runs a Kalibra dataset through your own function inside vitest or jest, and compares with main.', '`evaluate()` runs a Kalibra dataset through your own function inside pytest, and compares with main.') },
        ],
      },
      {
        type: 'table',
        head: ['', ''],
        rows: [
          ['Package', t('`kalibra-sdk` on npm', '`kalibra-sdk` on PyPI, imported as `kalibra`')],
          ['Runs on', t('Node.js 18+, ESM and CommonJS, with TypeScript types', 'Python 3.9+, sync and asyncio')],
          ['Dependencies', 'None'],
          ['In production', 'Off unless you turn it on. When off, your functions are handed back untouched.'],
          ['On the hot path', t('About 8 µs per trace with two steps. Sending happens in the background.', 'About 50 µs per trace with two steps. Sending happens on a background thread.')],
        ],
      },
    ],
  },
  {
    id: 'install',
    group: 'Get started',
    title: 'Install and first trace',
    when: 'Five minutes from nothing to your first trace in Kalibra.',
    blocks: [
      {
        type: 'steps',
        items: [
          'In Kalibra, open **Traces → Connect your app** and create an ingest key (`kik_…`). It can only send traces and tool recordings to that one project.',
          'Install the SDK and put the key in your **development** environment.',
          'Call `init` once at startup, wrap the function that handles a request, and use your app.',
        ],
      },
      { type: 'code', label: 'Install', syntax: 'bash', code: { js: 'npm i kalibra-sdk', python: 'pip install kalibra-sdk' } },
      {
        type: 'code',
        label: '.env (development only)',
        syntax: 'bash',
        code: both(src`
          KALIBRA_KEY=kik_…            # from Traces → Connect your app
          KALIBRA_PROJECT=Support bot  # project id or name (default: default)
          KALIBRA_URL=http://127.0.0.1:4317
        `),
      },
      {
        type: 'code',
        label: 'Your app',
        code: {
          js: src`
            import { kalibra } from 'kalibra-sdk';

            // Key, project and URL come from the KALIBRA_* variables.
            kalibra.init({ enabled: process.env.NODE_ENV !== 'production' });

            export const answer = kalibra.trace('answer_question', async (question: string) => {
              const docs = await kalibra.step('retrieve', () => search(question), { kind: 'retrieval', input: question });
              return kalibra.step('llm', () => callModel(question, docs), { kind: 'llm' });
            });
          `,
          python: src`
            import os
            import kalibra

            # Key, project and URL come from the KALIBRA_* variables.
            kalibra.init(enabled=os.getenv("ENV") != "production")

            @kalibra.trace("answer_question")
            def answer(question: str) -> str:
                with kalibra.step("retrieve", kind="retrieval") as s:
                    docs = search(question)
                    s.output = [{"id": d.id, "text": d.text} for d in docs]
                return call_model(question, docs)

            @kalibra.step(kind="llm")
            def call_model(question, docs): ...
          `,
        },
      },
      {
        type: 'callout',
        tone: 'tip',
        title: 'What you get',
        text: 'Open **Traces** in Kalibra: each call is a trace with its steps on a timeline. Select good or broken ones and click **Add to dataset** to turn them into test rows.',
      },
    ],
  },
  {
    id: 'on-off',
    group: 'Get started',
    title: 'Off in production',
    when: 'The SDK is for development and staging. Here is how it stays out of production.',
    blocks: [
      {
        type: 'code',
        code: {
          js: "kalibra.init({ enabled: process.env.NODE_ENV !== 'production' });",
          python: 'kalibra.init(enabled=os.getenv("ENV") != "production")',
        },
      },
      {
        type: 'table',
        head: ['When', 'The SDK is'],
        rows: [
          [t('`enabled: false`', '`enabled=False`'), 'Off.'],
          ['`KALIBRA_ENABLED=false` (or `0`, `no`, `off`)', '**Off, whatever the code says.** A kill switch for any environment.'],
          ['`KALIBRA_ENABLED=true` (or `1`, `yes`, `on`)', t('On when a key is set and the code passes no `enabled`.', 'On when a key is set and the code passes no `enabled=`.')],
          ['`KALIBRA_ENABLED` set to anything else', t('Off, unless the code passes `enabled: true`. A typo never switches tracing on.', 'Off, unless the code passes `enabled=True`. A typo never switches tracing on.')],
          ['No key (`key` or `KALIBRA_KEY`)', 'Off. You get one warning if you asked for it to be on.'],
          [t('`sampleRate: 0.1`', '`sample_rate=0.1`'), 'On for 10% of traces. Traces of Kalibra eval runs are always kept.'],
        ],
      },
      {
        type: 'list',
        items: [
          t('**Off costs nothing:** `trace(name, fn)` and `tool(name, fn)` return `fn` itself, and `step(name, fn)` just calls `fn`. 100 000 calls of a wrapped function plus a step take about 3 ms in total.', '**Off costs nothing:** decorators return your function itself, and `with kalibra.trace()` / `kalibra.step()` is one shared no-op object (about 0.1 µs per block).'),
          t('**Nothing runs in the background:** no timer, no queue, no network.', '**Nothing runs in the background:** no thread, no queue, no network.'),
          'The SDK never throws into your code, on or off.',
        ],
      },
      {
        type: 'callout',
        tone: 'tip',
        title: 'Call init early',
        text: t(
          'Call `kalibra.init()` once at startup, **before** wrapping functions: then "off" really returns your functions untouched. Functions wrapped earlier still work; they check one boolean per call. Without `init()`, the SDK reads the `KALIBRA_*` variables.',
          'Call `kalibra.init()` early in your entry point. Decorators applied before it still follow it, at the cost of one flag check per call. Without `init()`, the first use configures the SDK from the `KALIBRA_*` variables.',
        ),
      },
    ],
  },
  {
    id: 'config',
    group: 'Get started',
    title: 'Configuration',
    when: 'Every setting, in code or as an environment variable. Code wins over the environment, except the kill switch.',
    blocks: [
      {
        type: 'code',
        code: {
          js: src`
            kalibra.init({
              enabled: process.env.NODE_ENV !== 'production',
              url: 'https://kalibra.example.com',
              key: process.env.KALIBRA_KEY,
              project: 'Support bot',
              sampleRate: 0.25,
              environment: 'staging',
              release: '1.4.2',
              redact: true,
              flushIntervalMs: 1000,
              warnings: true,
            }); // → { enabled: boolean }
          `,
          python: src`
            kalibra.init(
                enabled=os.getenv("ENV") != "production",
                url="https://kalibra.example.com",
                key=os.environ.get("KALIBRA_KEY"),
                project="Support bot",
                sample_rate=0.25,
                environment="staging",
                release="1.4.2",
                redact=True,
                flush_interval=1.0,
                timeout=5.0,
            )  # → True when it is now sending
          `,
        },
      },
      {
        type: 'table',
        head: ['Option', 'Environment', 'Default', 'What it does'],
        rows: [
          ['`enabled`', '`KALIBRA_ENABLED`', 'on with a key', 'On or off. `KALIBRA_ENABLED=false` always wins.'],
          ['`url`', '`KALIBRA_URL`', '`http://127.0.0.1:4317`', 'Where Kalibra runs: its origin. The SDK adds `/kalibra/api/…`; an address ending in `/kalibra` works too.'],
          ['`key`', '`KALIBRA_KEY`', 'none', 'Ingest key `kik_…`. No key means off.'],
          ['`project`', '`KALIBRA_PROJECT`', '`default`', 'Project id or name.'],
          [t('`sampleRate`', '`sample_rate`'), '`KALIBRA_SAMPLE_RATE`', '`1`', 'Share of traces to keep, 0 to 1. Eval-run traces are always kept.'],
          ['`environment`', '`KALIBRA_ENVIRONMENT`', 'none', 'Label on every trace, like `dev` or `staging`.'],
          ['`release`', '`KALIBRA_RELEASE`', 'none', 'Your app version on every trace.'],
          ['`redact`', '', t('`true`', '`True`'), 'Remove personal data before sending. See [Privacy](#privacy).'],
          [t('`flushIntervalMs`', '`flush_interval`'), '', t('`1000` ms', '`1.0` s'), 'How often queued traces are sent (sooner when 200 steps are waiting).'],
          { only: 'js', cells: ['`warnings`', '', '`true`', 'Print sending problems to stderr, once per kind.'] },
          { only: 'python', cells: ['`timeout`', '', '`5.0` s', 'Timeout of each request to Kalibra. Warnings go to the `kalibra` logger, once per kind.'] },
        ],
      },
      {
        type: 'table',
        head: ['Also read from the environment', ''],
        rows: [
          ['`KALIBRA_TOOLS`', 'Default [tool mode](#tools) when a request doesn\'t set one: `live`, `record`, `replay`, …'],
          ['`KALIBRA_TOKEN`', 'Access token `kal_…` for `evaluate()` against a team server (Account → Access tokens).'],
          ['`KALIBRA_DIR`', 'Where `evaluate()` finds the Kalibra app running on this computer (default `~/Kalibra/default`).'],
        ],
      },
    ],
  },

  // ── Record ──────────────────────────────────────────────────────────────────
  {
    id: 'traces',
    group: 'Record',
    title: 'Traces',
    when: 'One trace per interaction with your app: a request, a chat turn, a job.',
    blocks: [
      {
        type: 'code',
        code: {
          js: src`
            // Wrap a function: every call is one trace.
            export const answer = kalibra.trace('answer_question', async (question: string, user: User) => {
              kalibra.currentTrace().setMetadata({ user: user.id });
              kalibra.currentTrace().addTags('beta');
              return reply(question);
            }, {
              input: (question) => question,   // what to record (default: the argument, or the argument list)
              output: (text) => text,          // default: the return value; false records nothing
              metadata: { feature: 'support' },
              tags: ['chat'],
            });

            // Or run a block now as a trace.
            await kalibra.trace.run('nightly_job', async (t) => {
              t.setInput(params);
              t.setOutput(await runJob(params));
            });
          `,
          python: src`
            @kalibra.trace("answer_question")      # a bare @kalibra.trace uses the function name
            def answer(question: str, user: User) -> str:
                kalibra.current_trace().metadata["user"] = user.id
                kalibra.current_trace().tags.append("beta")
                return reply(question)

            @kalibra.trace("embed_batch", capture=False)   # don't record arguments or return value
            def embed_batch(texts): ...

            with kalibra.trace("nightly_job") as t:  # or a block
                t.input = params
                t.output = run_job(params)
          `,
        },
      },
      {
        type: 'table',
        head: ['', ''],
        rows: [
          ['Input', t('The single argument, or the argument list. Change it with `input: (...args) => …` or `false`.', 'The single argument itself, else a dict by parameter name. `capture=False` skips it.')],
          ['Output', t('The return value (awaited). Change it with `output: (result) => …`, `false`, or `handle.setOutput()`.', 'The return value. Set `t.output` in a block.')],
          ['Labels', t('`metadata` and `tags` options, or `currentTrace().setMetadata()` / `.addTags()` from anywhere inside.', '`current_trace().metadata` (a dict) and `.tags` (a list) from anywhere inside.')],
          ['Nesting', t('Called inside another trace, a traced function becomes a child step (its `kind` option, default `step`).', 'Inside another trace, a trace becomes a child step.')],
          ['Errors', 'Recorded on the trace (status `error`) and thrown again, unchanged.'],
        ],
      },
    ],
  },
  {
    id: 'steps',
    group: 'Record',
    title: 'Steps',
    when: 'The parts of a trace: retrieval, model calls, tools. Checks read these.',
    blocks: [
      {
        type: 'code',
        code: {
          js: src`
            const docs = await kalibra.step('retrieve', () => search(query), { kind: 'retrieval', input: query });

            const text = await kalibra.step('llm', async (span) => {
              const res = await callModel(prompt);
              span.setAttributes({ model: res.model, tokens_in: res.usage.in, tokens_out: res.usage.out });
              return res.text;
            }, { kind: 'llm', input: prompt });

            const ranked = kalibra.step('rerank', (span) => {
              const out = rerank(docs);
              span.setOutput(out.map((d) => d.id)); // record something other than the return value
              return out;
            });
          `,
          python: src`
            with kalibra.step("retrieve", kind="retrieval") as s:
                s.input = query
                docs = search(query)
                s.output = [{"id": d.id, "text": d.text} for d in docs]

            with kalibra.step("llm", kind="llm") as s:
                s.input = prompt
                res = call_model(prompt)
                s.output = res.text
                s.set(model=res.model, tokens_in=res.usage.input, tokens_out=res.usage.output)

            @kalibra.step(kind="tool")      # as a decorator: arguments in, return value out
            def lookup_order(order_id: str): ...
          `,
        },
      },
      {
        type: 'table',
        head: ['Kind', 'Use it for', 'Kalibra uses it to'],
        rows: [
          ['`llm`', 'Model calls', 'Show model and tokens; `step_limits` counts LLM calls.'],
          ['`retrieval`', 'Search, vector lookups', 'Give RAG checks the retrieved documents (its output). See [RAG](#rag).'],
          ['`tool`', 'Functions your agent calls', 'Feed `tool_called`, `tool_not_called` and `tool_order`. [`tool()`](#tools) records these for you.'],
          ['`agent`', 'A sub-agent or planning loop', 'Group the steps under it.'],
          ['`step`', 'Anything else (default)', 'Show it on the timeline.'],
        ],
      },
      {
        type: 'callout',
        tone: 'warn',
        title: t('A step outside a trace starts one', 'A step outside a trace records nothing'),
        text: t(
          'Called with no trace open, `step()` becomes its own trace. Wrap your entry point with `trace()` to keep steps together.',
          'With no trace open, `kalibra.step()` is a no-op. Put `@kalibra.trace` on the entry point (or use the middleware) so steps have a trace to join.',
        ),
      },
      {
        type: 'list',
        items: [
          t('The callback gets a handle: `setInput()`, `setOutput()`, `setAttributes()`. `kalibra.currentSpan()` returns the innermost one from anywhere.', 'A step has `input`, `output`, `error` and `attributes`; `s.set(key=value)` adds attributes.'),
          'A trace keeps at most 256 steps; more are counted and dropped.',
        ],
      },
    ],
  },
  {
    id: 'models',
    group: 'Record',
    title: 'Model calls',
    when: 'Record prompts, answers, model names and token counts from OpenAI, Anthropic or anything else.',
    blocks: [
      {
        type: 'code',
        label: 'OpenAI',
        code: {
          js: src`
            import OpenAI from 'openai';
            const openai = new OpenAI();

            const chat = kalibra.trace(
              'openai.chat',
              (messages: OpenAI.ChatCompletionMessageParam[]) => openai.chat.completions.create({ model: 'gpt-4.1-mini', messages }),
              { kind: 'llm', output: (r) => r.choices[0]?.message?.content },
            );
          `,
          python: src`
            from openai import OpenAI
            client = OpenAI()

            with kalibra.step("llm", kind="llm") as s:
                s.input = messages
                res = client.chat.completions.create(model="gpt-4.1-mini", messages=messages)
                s.output = res.choices[0].message.content
                s.set(model=res.model, tokens_in=res.usage.prompt_tokens, tokens_out=res.usage.completion_tokens)
          `,
        },
      },
      {
        type: 'code',
        label: 'Anthropic',
        code: {
          js: src`
            import Anthropic from '@anthropic-ai/sdk';
            const anthropic = new Anthropic();

            const reply = await kalibra.step('claude', async (span) => {
              const msg = await anthropic.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 1024, messages: [{ role: 'user', content: question }] });
              span.setAttributes({ model: msg.model, tokens_in: msg.usage.input_tokens, tokens_out: msg.usage.output_tokens });
              return msg.content;
            }, { kind: 'llm', input: question });
          `,
          python: src`
            import anthropic
            claude = anthropic.Anthropic()

            with kalibra.step("claude", kind="llm") as s:
                s.input = messages
                msg = claude.messages.create(model="claude-sonnet-5-5", max_tokens=1024, messages=messages)
                s.output = "".join(b.text for b in msg.content if b.type == "text")
                s.set(model=msg.model, tokens_in=msg.usage.input_tokens, tokens_out=msg.usage.output_tokens)
          `,
        },
      },
      {
        type: 'callout',
        tone: 'tip',
        title: 'No code changes?',
        text: 'Point your OpenAI client at Kalibra\'s proxy, or export OpenTelemetry. See [Without the SDK](#no-sdk).',
      },
    ],
  },
  {
    id: 'rag',
    group: 'Record',
    title: 'RAG: retrieved documents',
    when: 'Give retrieved documents an `id` and their `text`, and the RAG checks can grade answers against them.',
    blocks: [
      {
        type: 'code',
        code: {
          js: src`
            const docs = await kalibra.step('retrieve', async (span) => {
              const hits = await store.search(question, { k: 5 });
              span.setOutput(hits.map((h) => ({ id: h.id, text: h.content, score: h.score })));
              return hits;
            }, { kind: 'retrieval', input: question });
          `,
          python: src`
            with kalibra.step("retrieve", kind="retrieval") as s:
                s.input = question
                docs = store.similarity_search_with_score(question, k=5)
                s.output = [{"id": d.metadata["id"], "text": d.page_content, "score": score} for d, score in docs]
          `,
        },
      },
      {
        type: 'table',
        head: ['Check', 'Passes when'],
        rows: [
          ['`retrieval_recall`', 'The expected document ids (e.g. a column `expected_sources`) are among the first k retrieved.'],
          ['`grounded`', 'An LLM judge finds every claim of the answer supported by the retrieved text.'],
          ['`citations`', 'Every id the answer cites, like `[kb-17]`, is among the retrieved documents.'],
        ],
      },
      {
        type: 'list',
        items: [
          'Common shapes work as they are: `{ id, text, score }`, LangChain documents (`page_content`, `metadata`), plain strings (numbered 1, 2, …).',
          t('Without a trace, return `sources` (and `tool_calls`) from your API, or from an [`evaluate()`](#evaluate) task: `{ output, sources }`.', 'Without a trace, return `sources` (and `tool_calls`) from your API, or from an [`evaluate()`](#evaluate) task: `{"output": …, "sources": […]}`.'),
          'Rows whose app sent neither are skipped by these checks, with a hint, rather than failed.',
        ],
      },
    ],
  },
  {
    id: 'async',
    group: 'Record',
    title: 'Async, streaming and errors',
    when: 'How traces follow async code, streamed answers and exceptions.',
    blocks: [
      {
        type: 'code',
        code: {
          js: src`
            // A traced generator stays open while the caller reads it.
            export const stream = kalibra.trace('answer_stream', async function* (question: string) {
              for await (const chunk of model.stream(question)) yield chunk.text;
            }); // output: the yielded text, joined

            // A stream object from another SDK comes back untouched: record what it produced yourself.
            await kalibra.step('llm', async (span) => {
              const s = await openai.chat.completions.create({ model, messages, stream: true });
              let text = '';
              for await (const c of s) text += c.choices[0]?.delta?.content ?? '';
              span.setOutput(text);
              return text;
            }, { kind: 'llm' });
          `,
          python: src`
            @kalibra.trace("answer_stream")       # generators and async generators too
            async def answer_stream(question):
                async for chunk in model.stream(question):
                    yield chunk.text               # output: the yielded text, joined

            # A thread you start yourself needs the context to stay in the trace:
            ctx = contextvars.copy_context()
            threading.Thread(target=ctx.run, args=(work, item)).start()
          `,
        },
      },
      {
        type: 'table',
        head: ['', ''],
        rows: [
          ['Async', t('Context follows `await`, promises and timers (AsyncLocalStorage), across concurrent requests.', 'Context follows `contextvars`, which asyncio tasks inherit. Threads need `copy_context().run()`.')],
          ['Generators', t('`function*` and `async function*` stay open until consumed. Output: the yielded text joined, or the item count and the first items. Stopping early is not an error.', 'Generators stay open until consumed. Output: the yielded text joined, or the item count and first items. Between chunks your code is outside the trace.')],
          ['Errors', 'Recorded on the step or trace, then raised again unchanged. Your error handling sees exactly what it did before.'],
        ],
      },
      {
        type: 'only',
        lang: 'js',
        blocks: [
          {
            type: 'callout',
            tone: 'note',
            text: 'With tracing on, an async function\'s result comes back as a plain Promise. If you rely on extra methods of a returned thenable (like OpenAI\'s `.withResponse()`), call them inside the step instead.',
          },
        ],
      },
    ],
  },

  // ── Connect to runs ─────────────────────────────────────────────────────────
  {
    id: 'link-runs',
    group: 'Connect to runs',
    title: 'Link requests to eval runs',
    when: 'When Kalibra runs a dataset through your API, attach each request\'s trace to its row.',
    blocks: [
      {
        type: 'text',
        text: 'Every request of an eval run carries four headers. Read them, and the trace lands on the right result row (its **Steps** tab), tools follow the run\'s record/replay mode, and agent and RAG checks can see inside. Turn on **Collect traces from my app** in Runs → New run → Advanced.',
      },
      {
        type: 'code',
        code: {
          js: src`
            // Express / Connect
            app.use(kalibra.middleware());

            // Next.js route handler, or anything with a fetch Request
            export async function POST(req: Request) {
              return kalibra.fromRequest(req, async () => Response.json({ output: await answer((await req.json()).message) }));
            }

            // Hono
            app.use((c, next) => kalibra.fromRequest(c.req.raw, next));

            // Fastify, Koa, plain http: wrap the handler
            fastify.post('/chat', (req) => kalibra.fromRequest(req.headers, () => handle(req)));
          `,
          python: src`
            # FastAPI / Starlette (any ASGI app)
            app.add_middleware(kalibra.KalibraASGIMiddleware)

            # Flask (any WSGI app)
            app.wsgi_app = kalibra.KalibraWSGIMiddleware(app.wsgi_app)

            # Django: settings.py
            MIDDLEWARE = ["kalibra.middleware.KalibraDjangoMiddleware", *MIDDLEWARE]

            # Anything else
            with kalibra.from_headers(request.headers):
                return handle(request)
          `,
        },
      },
      {
        type: 'table',
        head: ['Header', 'Carries'],
        rows: [
          ['`traceparent`', 'W3C trace context: the trace id Kalibra expects.'],
          ['`x-kalibra-run`', 'The eval run id.'],
          ['`x-kalibra-result`', 'The row (result) id.'],
          ['`x-kalibra-tools`', 'The run\'s tool mode: `live`, `record`, `replay`, … See [Tools](#tools).'],
        ],
      },
      {
        type: 'list',
        items: [
          'Linked traces are always kept, whatever the sample rate.',
          'A `traceparent` alone (ordinary distributed tracing) is ignored: your traces keep their own ids.',
          t('`fromRequest(src, fn)` takes a Node `IncomingMessage`, a fetch `Request`, a `Headers` object or a plain header object. Without `fn` it links the rest of the current async flow.', 'The middlewares only read the four headers, and call your app directly when the SDK is off.'),
        ],
      },
    ],
  },
  {
    id: 'tools',
    group: 'Connect to runs',
    title: 'Tools: record, replay, faults',
    when: 'Make evals of an agent fast, free and safe: record real tool results once, replay them in every run.',
    blocks: [
      {
        type: 'code',
        code: {
          js: src`
            export const searchOrders = kalibra.tool('search_orders', realSearchOrders);
            export const refund = kalibra.tool('refund_order', (orderId: string) => payments.refund(orderId));
          `,
          python: src`
            @kalibra.tool("search_orders")
            def search_orders(order_id: str): ...

            refund = kalibra.tool("refund_order")(payments.refund)
          `,
        },
      },
      {
        type: 'table',
        head: ['Mode', 'The wrapped tool'],
        rows: [
          ['`live` (default)', t('Calls the real function. Sync stays sync.', 'Calls the real function.')],
          ['`record`', 'Calls it and saves the arguments and result in Kalibra, in the background.'],
          ['`replay`', 'Returns the saved result for the same arguments; calls for real when there is none.'],
          ['`replay-strict`', t('Returns the saved result, or throws an error named `ReplayError`.', 'Returns the saved result, or raises `kalibra.ReplayMissing`.')],
          ['`fault:timeout`', t('Throws an error named `TimeoutError`, without calling.', 'Raises `TimeoutError`, without calling.')],
          ['`fault:error`', t('Throws an error named `ToolError`, without calling.', 'Raises `RuntimeError`, without calling.')],
          ['`fault:empty`', t('Returns `null`, without calling.', 'Returns `None`, without calling.')],
        ],
      },
      {
        type: 'steps',
        items: [
          'Wrap your tools, and [link requests](#link-runs) so each one knows the run\'s mode.',
          'Run once with Runs → New run → Advanced → **Tools: Record**.',
          'From then on, use **Replay**: no real tool runs, results are identical every time.',
          'Try **fault** modes to see how your agent copes when a tool times out, fails or finds nothing.',
        ],
      },
      {
        type: 'list',
        items: [
          'The mode comes from the request\'s `x-kalibra-tools` header, else `KALIBRA_TOOLS`, else `live`.',
          t('Each call is recorded as a `tool` step. Modes other than `live` return a Promise.', 'Inside a trace, each call is recorded as a `tool` step. Async tools stay async.'),
          'A recording that holds an error replays that error.',
        ],
      },
      {
        type: 'callout',
        tone: 'warn',
        title: 'Recordings are exact',
        text: 'Replay must return the real values, so recordings keep the exact arguments and results. They are **not redacted** (traces are). Record with test data you are happy to store in Kalibra.',
      },
    ],
  },
  {
    id: 'args-hash',
    group: 'Connect to runs',
    title: 'How recordings are matched',
    when: 'When a replay misses, or a Node service and a Python service share recordings.',
    blocks: [
      {
        type: 'text',
        text: 'A recording is found by the tool name plus the **SHA-256 of the canonical JSON of its arguments**. The JS SDK, the Python SDK and the server compute the same string, byte for byte.',
      },
      {
        type: 'code',
        code: {
          js: src`
            import { argsHash, canonicalJson } from 'kalibra-sdk';

            canonicalJson({ b: 1, a: [1.0, 'x'] }); // '{"a":[1,"x"],"b":1}'
            argsHash({ q: 'refund' });              // sha256 hex of '{"q":"refund"}'
          `,
          python: src`
            kalibra.canonical_json({"b": 1, "a": [1.0, "x"]})  # '{"a":[1,"x"],"b":1}'
            kalibra.args_hash({"q": "refund"})                  # sha256 hex of '{"q":"refund"}'
          `,
        },
      },
      {
        type: 'table',
        head: ['Rule', ''],
        rows: [
          ['Arguments', t('One argument is the value itself; several are a list.', 'One argument is the value itself; keyword arguments alone are one object; anything else is a list, with keyword arguments as a trailing object. `search(q="x")` matches JS `search({ q: "x" })`.')],
          ['Objects', 'Keys sorted by UTF-16 code units, no spaces.'],
          ['Numbers', 'JavaScript\'s shortest form: `1.0` is `1`, `1e-07` is `1e-7`. `NaN` and `Infinity` are `null`.'],
          ['Other', t('`undefined` is left out of objects (`null` in arrays), BigInt is a string, Dates are ISO strings.', 'Non-ASCII characters stay as they are; lone surrogates are written `\\udxxx`.')],
        ],
      },
      { type: 'callout', tone: 'tip', text: 'Sharing recordings across languages? Pass integers or strings, not floats that might print differently.' },
    ],
  },

  // ── Evals as code ───────────────────────────────────────────────────────────
  {
    id: 'evaluate',
    group: 'Evals as code',
    title: 'evaluate(): evals in your tests',
    when: t('Run a Kalibra dataset through your own function in vitest or jest, no API needed.', 'Run a Kalibra dataset through your own function in pytest, no API needed.'),
    blocks: [
      {
        type: 'code',
        code: {
          js: src`
            // support.eval.test.ts
            import { evaluate } from 'kalibra-sdk/eval';
            import { answer } from '../src/bot';

            test('support bot quality', async () => {
              const run = await evaluate({
                dataset: 'Support questions',
                suite: 'Chat checks',
                task: (row) => answer(row.question),   // the output, or { output, …fields, metrics }
                concurrency: 4,
              });
              expect(run.passRate).toBeGreaterThan(0.9);
              expect(run.newFailures).toEqual([]);     // compared with the latest run on your base branch
            }, 120_000);
          `,
          python: src`
            # test_quality.py
            from kalibra.eval import evaluate

            def test_support_bot():
                result = evaluate(
                    dataset="Support questions",
                    suite="Chat checks",
                    task=lambda row: answer(row["question"]),   # the output, or {"output": …, "metrics": {…}}
                    concurrency=4,
                )
                result.expect(min_pass_rate=0.9, no_new_failures=True)
          `,
        },
      },
      {
        type: 'steps',
        items: [
          'Kalibra hands out the dataset rows.',
          'Your task runs here, once per row: timed (`latency_ms`), with exceptions recorded as row errors.',
          'Results go back in batches, with the traces your task produced linked to their rows.',
          'Kalibra scores them with the suite and compares with the baseline. The run shows up in Kalibra with its branch and commit.',
        ],
      },
      {
        type: 'table',
        head: ['Option', 'Default', ''],
        rows: [
          ['`dataset`, `suite`', 'required', 'Ids or names.'],
          ['`task`', 'required', t('`(row, raw) => output`: `row` is the row\'s values; `raw` is `{ id, data }`. May be async.', '`task(row)` gets the row\'s values (a dict). Async tasks work too.')],
          ['`name`', '"Code run (<branch>)"', 'Run name.'],
          ['`project`', '`KALIBRA_PROJECT` or `default`', ''],
          ['`url`, `token`', '`KALIBRA_URL`, `KALIBRA_TOKEN`', 'Else the Kalibra app on this computer.'],
          ['`concurrency`', '`4`', 'Rows at a time.'],
          ['`limit`, `tags`', 'all rows', 'Only the first N rows / rows with any of these tags.'],
          ['`baseline`', 'latest run on the base branch', 'A run id to compare with.'],
          ['`git`', 'from CI', t('`{ branch, commit, pr, baseBranch }`; read from `GITHUB_*` variables.', '`{"branch", "commit", "pr", "baseBranch"}`; read from CI variables, else `git`.')],
          { only: 'js', cells: ['`timeoutMs`', 'none', 'Fail a row whose task takes longer.'] },
          { only: 'js', cells: ['`tools`', '`live`', 'Tool mode for your code during the run, e.g. `\'replay\'`.'] },
          { only: 'js', cells: ['`onResult`', '', 'Called after each row with `{ outputs, error, latencyMs }`.'] },
          { only: 'python', cells: ['`batch_size`', '`50`', 'Results per request.'] },
          { only: 'python', cells: ['`timeout`', '`60.0` s', 'Timeout of each request to Kalibra.'] },
        ],
      },
      {
        type: 'table',
        head: ['Result', ''],
        rows: [
          [t('`runId`, `url`', '`run_id`, `url`'), 'The run, and a link to open it in Kalibra.'],
          [t('`passRate`, `passed`, `failed`', '`pass_rate`, `passed`, `failed`, `errors`'), 'Share of rows that passed every check (0 to 1, or none when nothing was scored), and counts.'],
          [t('`newFailures`', '`new_failures`'), 'Rows that passed in the baseline and fail now: `{ rowId, reason }`.'],
          ['`fixed`', 'Row ids that failed in the baseline and pass now.'],
          ['`baseline`', '`{ runId, passRate, number, name }` of the run compared with, if any.'],
          ['`summary`, `run`', 'Everything else Kalibra knows about the run.'],
          { only: 'python', cells: ['`.expect(min_pass_rate=, no_new_failures=)`', 'Fails the test with a readable message listing the new failures.'] },
        ],
      },
      {
        type: 'callout',
        tone: 'tip',
        title: 'Where Kalibra is',
        text: 'On your computer with Kalibra open, nothing to set up. For a team server, set `KALIBRA_URL` and `KALIBRA_TOKEN` (Account → Access tokens).',
      },
      {
        type: 'only',
        lang: 'python',
        blocks: [{ type: 'text', text: 'Inside a running event loop (pytest-asyncio, notebooks), use `await evaluate_async(...)` with the same arguments.' }],
      },
    ],
  },
  {
    id: 'ci',
    group: 'Evals as code',
    title: 'CI and pull requests',
    when: 'Fail the build when quality drops, and comment the result on the pull request.',
    blocks: [
      {
        type: 'code',
        label: '.github/workflows/evals.yml',
        syntax: 'yaml',
        code: {
          js: src`
            on: pull_request
            jobs:
              evals:
                runs-on: ubuntu-latest
                steps:
                  - uses: actions/checkout@v5
                  - uses: actions/setup-node@v5
                    with: { node-version: 22 }
                  - run: npm ci
                  - run: npx vitest run evals/
                    env:
                      KALIBRA_URL: https://kalibra.example.com
                      KALIBRA_TOKEN: \${{ secrets.KALIBRA_TOKEN }}
                      KALIBRA_PROJECT: Support bot
          `,
          python: src`
            on: pull_request
            jobs:
              evals:
                runs-on: ubuntu-latest
                steps:
                  - uses: actions/checkout@v5
                  - uses: actions/setup-python@v6
                    with: { python-version: "3.12" }
                  - run: pip install -e . kalibra-sdk pytest
                  - run: pytest tests/evals
                    env:
                      KALIBRA_URL: https://kalibra.example.com
                      KALIBRA_TOKEN: \${{ secrets.KALIBRA_TOKEN }}
                      KALIBRA_PROJECT: Support bot
          `,
        },
      },
      {
        type: 'list',
        items: [
          'On GitHub Actions the branch, commit and pull request are picked up on their own. A pull request compares with the latest run on its base branch, so keep main\'s runs coming (run the same evals on pushes to main).',
          'A first run has no baseline yet, so it never counts as having new failures.',
        ],
      },
      {
        type: 'code',
        label: 'Comment the result on the pull request',
        syntax: 'bash',
        code: both(src`
          # Save the run id from your test (e.g. to .kalibra-run), then:
          npx kalibra@next eval-report "$(cat .kalibra-run)" --format markdown > report.md
          gh pr comment "$PR_NUMBER" --body-file report.md
        `),
      },
      {
        type: 'callout',
        tone: 'note',
        title: 'Testing a deployed API instead?',
        text: 'The `LibreGuild/kalibra/action` GitHub Action runs a dataset against a target on your team server, fails below `min-pass`, and keeps one comment on the pull request up to date.',
      },
    ],
  },

  // ── Without the SDK ─────────────────────────────────────────────────────────
  {
    id: 'no-sdk',
    group: 'Without the SDK',
    title: 'OpenTelemetry and the OpenAI proxy',
    when: 'Traces without adding a library: your framework already speaks OpenTelemetry, or you call OpenAI.',
    blocks: [
      {
        type: 'code',
        label: 'OpenTelemetry (LangChain, LlamaIndex, Vercel AI SDK, OpenAI Agents SDK…)',
        syntax: 'bash',
        code: both(src`
          OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4317/kalibra/api/projects/<project>/otlp
          OTEL_EXPORTER_OTLP_PROTOCOL=http/json
          OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20kik_…
        `),
      },
      {
        type: 'code',
        label: 'OpenAI proxy',
        code: {
          js: src`
            import OpenAI from 'openai';

            const dev = process.env.NODE_ENV !== 'production';
            export const openai = new OpenAI({
              ...(dev && {
                baseURL: 'http://127.0.0.1:4317/kalibra/api/projects/<project>/proxy/openai/v1',
                defaultHeaders: { 'x-kalibra-key': process.env.KALIBRA_KEY },
              }),
            });
          `,
          python: src`
            from openai import OpenAI

            dev = os.getenv("ENV") != "production"
            client = OpenAI(**({
                "base_url": "http://127.0.0.1:4317/kalibra/api/projects/<project>/proxy/openai/v1",
                "default_headers": {"x-kalibra-key": os.environ.get("KALIBRA_KEY", "")},
            } if dev else {}))
          `,
        },
      },
      {
        type: 'list',
        items: [
          '**OpenTelemetry:** Kalibra reads OTLP as JSON (keep the protocol line) and understands the `gen_ai.*` conventions.',
          '**Proxy:** each call is forwarded unchanged, streaming included, and recorded as a trace. Your OpenAI key still goes to OpenAI; Kalibra reads only its own key, from `x-kalibra-key`. A project owner can point it at another OpenAI-compatible server (Traces → Connect your app).',
          'Neither gives you tool replay or links to eval rows: use the SDK for those.',
        ],
      },
    ],
  },

  // ── Operate ─────────────────────────────────────────────────────────────────
  {
    id: 'privacy',
    group: 'Operate',
    title: 'Redaction and privacy',
    when: 'What leaves your process, and how to keep personal data out.',
    blocks: [
      {
        type: 'code',
        code: {
          js: src`
            kalibra.init({ redact: true });   // default: built-in redaction
            kalibra.init({ redact: false });  // send values as they are
            kalibra.init({ redact: (value) => scrub(value) }); // your own: gets each trace value, returns what to send
          `,
          python: src`
            kalibra.init(redact=True)                     # default: built-in redaction
            kalibra.init(redact=False)                    # send values as they are
            kalibra.init(redact=lambda s: scrub(s))       # your own: applied to every string
          `,
        },
      },
      {
        type: 'list',
        items: [
          '**Built in**, replaced with `[redacted]`: email addresses, phone numbers, payment card numbers (Luhn-checked), and common API keys (`sk-…`, `AKIA…`, `ghp_…`, `xox…`, `kal_…`, `kik_…`).',
          'Redaction runs on the background sender, never in your call path.',
          'Each value is capped at 32 KB before it is queued, so huge inputs never travel whole.',
          '**Tool recordings are not redacted** ([why](#tools)). Record with test data.',
          'An ingest key can only send traces and tool recordings to one project. It can\'t read anything. Keep it in an environment variable and revoke it in Kalibra if it leaks.',
        ],
      },
    ],
  },
  {
    id: 'performance',
    group: 'Operate',
    title: 'Performance and limits',
    when: 'What the SDK costs, and the limits that keep it predictable.',
    blocks: [
      {
        type: 'table',
        head: ['Case', 'Cost'],
        rows: [
          { only: 'js', cells: ['Off: 100 000 calls of a wrapped function plus a step', 'about 3 ms in total (your function is returned as it is)'] },
          { only: 'js', cells: ['On: a trace with two steps', 'about 8 µs in the call path'] },
          { only: 'js', cells: ['On, not sampled', 'about 0.15 µs per trace'] },
          { only: 'python', cells: ['Off: a decorated function', 'the plain function, the same object'] },
          { only: 'python', cells: ['Off: a `with kalibra.step()` block', 'about 0.1 µs'] },
          { only: 'python', cells: ['On, not sampled', 'about 1 µs per call'] },
          { only: 'python', cells: ['On: a trace with two steps', 'about 50 µs in the call path'] },
          ['Sending', t('In the background on an unref\'d timer, batched (up to 1000 traces, 5000 steps, about 2 MB per request).', 'On one daemon thread, batched (up to 1000 traces, 5000 steps, about 2 MB per request). Forked workers start their own.')],
        ],
      },
      {
        type: 'table',
        head: ['Limit', ''],
        rows: [
          ['Value size', t('32 KB per value; larger ones become a preview.', '32 KB per field; longer strings are cut with a "…[truncated N chars]" note.')],
          ['Steps', '256 per trace.'],
          ['Queue', '10 000 steps. When Kalibra is down or slow, the oldest are dropped; your app never waits.'],
          ['Retries', 'Two, then the batch is dropped. A wrong key or project is not retried.'],
          ['Errors', t('Never thrown into your code; one warning per kind of problem.', 'Never raised into your code; one warning per kind of problem.')],
        ],
      },
      { type: 'text', text: t('Measured on an Apple M-series laptop: `npx vitest run packages/sdk`.', 'Measured on an Apple M-series laptop with Python 3.12: `tests/test_perf.py`.') },
    ],
  },
  {
    id: 'flush',
    group: 'Operate',
    title: 'Flush, shutdown and serverless',
    when: 'Short-lived processes: make sure the last traces are sent.',
    blocks: [
      {
        type: 'code',
        code: {
          js: src`
            // Serverless: send before the function returns.
            export const handler = async (event) => {
              const result = await answer(event.question);
              await kalibra.flush(); // never rejects
              return result;
            };

            // Before process.exit() or in a signal handler:
            process.on('SIGTERM', async () => {
              await kalibra.shutdown(); // flush, then stop
              process.exit(0);
            });
          `,
          python: src`
            # Serverless: send before the function returns.
            def handler(event, context):
                result = answer(event["question"])
                kalibra.flush(timeout=2.0)   # → True when everything was sent
                return result

            kalibra.shutdown()   # flush, then stop the background thread
          `,
        },
      },
      {
        type: 'list',
        items: [
          t('Pending traces are also sent when Node is about to exit normally (`beforeExit`). That doesn\'t fire on `process.exit()` or signals, so flush there yourself.', 'Pending traces are also flushed at interpreter exit (with a 2 s limit, so an unreachable Kalibra never hangs your exit).'),
          t('`flush()` also waits for tool recordings still being saved.', '`flush()` also waits for tool recordings still being saved.'),
          'Calling `init()` again applies new settings; what was queued still goes out with the old ones.',
        ],
      },
    ],
  },
  {
    id: 'troubleshooting',
    group: 'Operate',
    title: 'Troubleshooting',
    when: 'Something is missing or odd. Most answers are here.',
    blocks: [
      {
        type: 'qa',
        items: [
          {
            q: 'Nothing shows up under Traces.',
            a: t(
              'Check `kalibra.init(...)` returned `{ enabled: true }`: a key is set, `enabled` is not false, `KALIBRA_ENABLED` isn\'t off. Then check `KALIBRA_URL` and `KALIBRA_PROJECT`. Sending problems print one warning to stderr (unless `warnings: false`). Short scripts: `await kalibra.flush()` before exiting.',
              'Check `kalibra.init(...)` returned `True`: a key is set, `enabled` is not False, `KALIBRA_ENABLED` isn\'t off. Then check `KALIBRA_URL` and `KALIBRA_PROJECT`. Sending problems are logged once to the `kalibra` logger. Steps need a trace around them.',
            ),
          },
          {
            q: 'Eval rows have no Steps tab.',
            a: 'Turn on **Collect traces from my app** for the run (New run → Advanced), and make sure your server [reads the run headers](#link-runs): middleware, or `fromRequest` / `from_headers`. The trace must come from the same request.',
          },
          {
            q: 'Replay called the real tool.',
            a: 'No recording matched these exact arguments (`replay` then falls back to live). Record first, check the arguments are deterministic (no timestamps or random ids), and use `replay-strict` to make misses fail loudly. See [matching](#args-hash).',
          },
          {
            q: 'evaluate() can\'t reach Kalibra.',
            a: 'Open the Kalibra app on this computer, or set `KALIBRA_URL` and `KALIBRA_TOKEN` (a personal access token `kal_…`) for a team server. In CI, store the token as a secret.',
          },
          {
            q: 'Values show [redacted].',
            a: t('Built-in redaction matched them (emails, phones, cards, keys). Pass `redact: false` or your own function for that environment.', 'Built-in redaction matched them (emails, phones, cards, keys). Pass `redact=False` or your own function for that environment.'),
          },
          {
            q: 'Some traces are missing under load.',
            a: 'The queue holds 10 000 steps; when Kalibra is slow or down, the oldest are dropped so your app never waits. Lower the sample rate for load tests.',
          },
        ],
      },
    ],
  },

  // ── Reference ───────────────────────────────────────────────────────────────
  {
    id: 'api',
    group: 'Reference',
    title: 'API reference',
    when: t('Everything `kalibra-sdk` exports, on one screen.', 'Everything `kalibra` exports, on one screen.'),
    blocks: [
      {
        type: 'table',
        head: ['Name', 'What it does'],
        rows: [
          { only: 'js', cells: ['`init(options)`', 'Settings ([Configuration](#config)). Returns `{ enabled }`.'] },
          { only: 'js', cells: ['`trace(name, fn, options?)`', 'Wraps `fn`: each call is a trace, or a child step inside one. Options: `kind`, `input`, `output`, `metadata`, `tags`.'] },
          { only: 'js', cells: ['`trace.run(name, fn, options?)`', 'Runs `fn(handle)` now as a trace.'] },
          { only: 'js', cells: ['`step(name, fn, options?)`', 'Runs `fn(span)` as a step. Options: `kind`, `input`, `attributes`, `output`.'] },
          { only: 'js', cells: ['`tool(name, fn)`', 'Wraps a tool for record / replay / faults.'] },
          { only: 'js', cells: ['`middleware()`', 'Express / Connect middleware linking requests to eval rows.'] },
          { only: 'js', cells: ['`fromRequest(src, fn?)`', 'Links `fn` (or the rest of the async flow) to the eval row in `src`\'s headers.'] },
          { only: 'js', cells: ['`currentTrace()`, `currentSpan()`', 'Handles: `setInput`, `setOutput`, `setAttributes`; traces also `setMetadata`, `addTags`, `runId`, `resultId`.'] },
          { only: 'js', cells: ['`flush()`, `shutdown()`', 'Send what is queued now; and stop.'] },
          { only: 'js', cells: ['`isEnabled()`, `getConfig()`', 'Is it on; the active settings.'] },
          { only: 'js', cells: ['`toolMode()`', 'The tool mode of the current call.'] },
          { only: 'js', cells: ['`canonicalJson(v)`, `argsHash(v)`', 'How recordings are matched.'] },
          { only: 'js', cells: ['`redactString(s)`, `redactValue(v)`', 'The built-in redaction, to reuse in your own `redact`.'] },
          { only: 'js', cells: ['`evaluate(options)`', 'Evals as code; also from `kalibra-sdk/eval`. Throws `KalibraEvalError`.'] },
          { only: 'js', cells: ['`kalibra`', 'All of the above as one object (also the default export); `kalibra.version`.'] },
          { only: 'python', cells: ['`init(...)`', 'Settings ([Configuration](#config)). Returns whether it is sending.'] },
          { only: 'python', cells: ['`trace(name=None, *, capture=True)`', 'Decorator or `with` block: a trace, or a child step inside one.'] },
          { only: 'python', cells: ['`step(name=None, *, kind="step", capture=True)`', 'Decorator or `with` block: a step of the current trace.'] },
          { only: 'python', cells: ['`tool(name=None)`', 'Decorator for record / replay / faults.'] },
          { only: 'python', cells: ['`current_trace()`', 'The trace being recorded (`metadata`, `tags`, `input`, `output`), or a no-op stand-in.'] },
          { only: 'python', cells: ['`from_headers(headers)`', '`with` block linking what runs inside to the eval row of a request.'] },
          { only: 'python', cells: ['`KalibraASGIMiddleware`, `KalibraWSGIMiddleware`, `KalibraDjangoMiddleware`', 'The same for whole apps.'] },
          { only: 'python', cells: ['`flush(timeout=5.0)`, `shutdown(timeout=5.0)`', 'Send what is queued now (→ True when done); and stop. Both run at exit.'] },
          { only: 'python', cells: ['`is_enabled()`, `tool_mode()`', 'Is it on; the tool mode of the current call.'] },
          { only: 'python', cells: ['`canonical_json(v)`, `args_hash(v)`', 'How recordings are matched.'] },
          { only: 'python', cells: ['`redact_text(s)`', 'The built-in redaction, to reuse in your own `redact`.'] },
          { only: 'python', cells: ['`ReplayMissing`', 'Raised by `replay-strict` when there is no recording.'] },
          { only: 'python', cells: ['`kalibra.eval.evaluate(...)`, `evaluate_async(...)`', 'Evals as code. Raises `KalibraError` when Kalibra can\'t be reached.'] },
        ],
      },
      {
        type: 'text',
        text: t(
          'Source and changelog: [packages/sdk](https://github.com/LibreGuild/kalibra/tree/main/packages/sdk) on GitHub. MIT licensed.',
          'Source and changelog: [sdks/python](https://github.com/LibreGuild/kalibra/tree/main/sdks/python) on GitHub. MIT licensed.',
        ),
      },
    ],
  },
];

/** What each SDK is for, in two sentences (the "SDK docs" picker in the app). */
export const SDK_BRIEF: Record<'js' | 'python', { name: string; install: string; text: string }> = {
  js: {
    name: 'JavaScript / TypeScript',
    install: 'npm i kalibra-sdk',
    text: 'For Node.js apps: Express, Next.js, Hono, Fastify, workers. Traces and steps, links to eval runs, tool record/replay, and evaluate() in vitest or jest.',
  },
  python: {
    name: 'Python',
    install: 'pip install kalibra-sdk',
    text: 'For Python apps: FastAPI, Flask, Django, scripts and notebooks. Traces and steps, links to eval runs, tool record/replay, and evaluate() in pytest.',
  },
};
