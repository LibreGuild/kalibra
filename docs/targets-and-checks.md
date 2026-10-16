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

## Check catalog

Every check can be a **gate**, has a **weight** and an optional **applyWhen** expression.

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

**Layer 4 · Reference metrics**
- `wer`: WER / CER / MER / WIL with normalizers (none, basic, English, custom rules) and an alignment diff. Feeds corpus WER.
- `keyword_recall`: names, numbers and other keywords transcribed correctly.
- `bleu`, `rouge_l`, `chrf`, `token_f1`: reference-based text overlap.

**Layer 5 · Judgment**
- `llm_judge`: rubric-based pass/fail with critique first, repetitions (majority vote), and image/audio attachments.
- `refusal`: refused when it should, answered when it should (catches over-refusal); detection by phrases, a response field, or an LLM.
- `pii_leak`: emails, phones, cards (Luhn), SSN, IBAN, Aadhaar, PAN, API keys, canary strings; allow-list for public values.
- `script`: your JavaScript returns `true/false` or `{ pass, score, value, reason }`.
- `expression`: a one-line JS condition.

Source: `packages/core/src/checks/*.ts`. Every field has a help text that becomes a UI tooltip.
