# Targets and checks

## Target kinds

A target is how Kalibra calls your app for one row. All kinds share **Variables** (`{{vars.x}}`) and can use `{{secret.name}}`.

**HTTP API** (`kind: http`)
- Method, URL, query, headers; auth: bearer, API key (header/query), basic.
- Body: JSON (auto-escaped placeholders), text, form, multipart (file parts from audio/image columns), raw binary.
- Streaming: SSE or NDJSON with a JSONPath for the text and an optional stop expression; measures TTFB and TTFT.
- Outputs: extractors by JSONPath, whole text, header, status, regex or JS expression. `output` is the main field.
- Scripts: `beforeRequest` (sign, reshape) and `afterResponse` (extract anything). Import from a cURL command.

**WebSocket** (`kind: websocket`)
- URL, headers, query, subprotocols, auth; messages on open (JSON / text / base64 binary) with delays; wait for an acknowledgement.
- Audio streaming: source column, encoding (PCM16, float32, μ-law, A-law, or the raw file), sample rate, channels, frame size, binary frames or a text template (`{{chunk_base64}}`, `{{seq}}`, `{{is_last}}`), real-time or fast pacing, trailing silence.
- Incoming: JSON or text, ignore rule, text path, `isFinal` expression, done when (final after audio / close / expression / idle), how finals join.
- Metrics: connect, first partial, final latency, RTF, partial and final counts.
- Scripts: `onMessage` per message, or `session` to drive the socket yourself.

**Model + prompt** (`kind: model`)
- Tasks: text (system + prompt template), image (prompt, size, quality), speech (text, voice), transcription (audio column).

**Custom script** (`kind: script`)
- JavaScript with `row`, `vars`, `fetch`, `WebSocket`, `readFile`, `llm`, `log`; return `{ output, … }` or a string.

**Any kind, multi-turn** (run setting **Conversation**)
- Scripted turns from a list column, or a simulated user (persona + goal, played by a model connection), up to 30 turns, optional stop phrase.
- Each turn can use `{{message}}`, `{{history}}`, `{{turn}}`, `{{conversation_id}}`, `{{session_id}}`. Extract a `session_id` output if your app returns one; model targets replay the history as chat messages.

**Per-run overrides** (comparisons, `settings.overrides`)
- Swap variables, the model / connection / temperature of a model target, or any config field for one run, without editing the target.

## Check catalog

Every check can be a **gate**, has a **weight** and an optional **applyWhen** expression. The UI's **Add a check** dialog shows the most used ten first (`status`, `latency`, `json_schema`, `contains`, `equals`, `similarity`, `wer`, `semantic_similarity`, `llm_judge`, `refusal`).

**Layer 0 · Transport**
- `status`: HTTP status is in a list such as `200` or `2xx`.
- `latency`: a metric (latency, TTFB, TTFT, connect, first partial, final latency) is under a limit.
- `no_error`: the call produced no transport error.

**Layer 1 · Structure**
- `is_json`: the value parses as JSON.
- `json_schema`: the value matches a JSON Schema (ajv + formats).

**Layer 2 · Fields**
- `jsonpath`: a JSONPath exists / equals / contains / matches / compares / has length / has type.

**Layer 3 · Content**
- `equals`: exact match with trim, case and whitespace options.
- `contains`: any / all / none of a list of phrases.
- `regex`: matches (or must not match) a pattern.
- `numeric`: number within a tolerance or range.
- `similarity`: fuzzy (Levenshtein) similarity above a threshold.
- `transcript_contains`: phrases anywhere in a conversation (app, user or both; all / any / none).
- `turn_count`: the conversation took between N and M user turns.

**Layer 4 · Reference metrics**
- `wer`: WER / CER / MER / WIL with normalizers (none, basic, English, custom rules) and an alignment diff. Feeds corpus WER.
- `keyword_recall`: names, numbers and other keywords transcribed correctly.
- `bleu`, `rouge_l`, `chrf`, `token_f1`: reference-based text overlap.
- `semantic_similarity`: cosine of text embeddings against a reference; local model (free, offline) or a connection's embedding model.
- `semantic_wer`: an LLM lists only transcription errors that change the meaning; score = meaning errors ÷ reference words.

**Layer 5 · Judgment**
- `llm_judge`: rubric-based pass/fail with critique first, repetitions (majority vote), and image/audio attachments.
- `refusal`: refused when it should, answered when it should (catches over-refusal); detection by phrases, a response field, or an LLM. An empty reply fails as "no output", not as unsafe compliance.
- `pii_leak`: emails, phones, cards (Luhn), SSN, IBAN, Aadhaar, PAN, API keys, canary strings; allow-list for public values.
- `goal_met`: did the conversation reach the user's goal? The simulated user's verdict, or an LLM judge reading the transcript.
- `script`: your JavaScript returns `true/false` or `{ pass, score, value, reason }`.
- `expression`: a one-line JS condition.

**Agents & RAG** (category `agents`; `checks/agents.ts`, `checks/rag.ts`)

They read tool calls, steps and retrieved documents from traces joined to the row (`tool_calls`, `steps`, `sources`), or from fields your app returns (`outputs.tool_calls`, `outputs.steps`, `outputs.sources`). With neither, they skip and explain how to provide them.

- `tool_called` (layer 2): a tool was called between min and max times. Optionally only calls whose arguments match: partial deep match, `{{column}}` templates allowed.
- `tool_not_called` (2): none of the listed tools was called.
- `tool_order` (2): the calls contain a sequence in order; other calls may come in between.
- `step_limits` (2): at most N steps, model calls or tool calls.
- `citations` (3): every cited id (a regex such as `[doc-17]`, or a field) was actually retrieved.
- `retrieval_recall` (4): the expected document ids (a list or comma-separated column) are among the first k retrieved.
- `grounded` (5): an LLM judge splits the answer into claims and checks each against the retrieved documents. The score is the share supported.

Source: `packages/core/src/checks/*.ts`. Every field has a help text that becomes a UI tooltip.
