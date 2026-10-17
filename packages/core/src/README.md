# core/src: code map

Read top to bottom. Each folder's files start with a comment explaining what they own.

## The spine

| File | Owns |
|---|---|
| `engine.ts` | `Engine`: one project's state (SQLite db, blobs, secrets, registry, runner, jobs, LLM and embedding clients). `Engine.call(op, input, actor, {role, caps})` is how every operation runs. |
| `registry.ts` | `defineOp`, `Registry`, actors, project roles (`viewer < editor < owner`), `opAccess`, `Capabilities` |
| `policy.ts` | host policies checked where data is written: who may add code, folder sync roots; the current call context (`AsyncLocalStorage`) |
| `db.ts` | SQLite wrapper (`node:sqlite`), statement cache, transactions, **project migrations** |
| `specs.ts` | zod schemas of everything users configure: columns, targets, suites, connections, run settings |
| `storage.ts` | content-addressed blob store (files, audio, images), secret stores |
| `jobs.ts` | background jobs (generation, transcription, clustering…) with progress and cancel |
| `events.ts` | live change events (the UI subscribes over SSE) |
| `template.ts` / `script.ts` | `{{placeholders}}` with filters; user JavaScript (expressions, hooks, script targets) |
| `util.ts` | ids, `KalibraError` (codes map to HTTP statuses), JSON helpers |
| `index.ts` | the public exports used by server and cli |

## Folders

| Folder | Owns |
|---|---|
| `hub/` | Above projects: `hub.ts` (one Engine per project, the single place access is decided), `accounts.ts` (users, sessions, tokens, lockout), `projects.ts` (projects, members, groups), `ops.ts` (hub operations), `providers.ts` + `sso.ts` (sign-in providers), `passwords.ts`, `schema.ts` (hub migrations) |
| `ops/` | Every project operation, grouped by area: `datasets`, `defs` (targets, suites, connections, secrets), `runs`, `groups` (comparisons), `conversations`, `media` (images, speech, transcription, audio variants), `labels` (calibration), `insights` (breakdowns, trends), `themes`, `quality`, `playground`, `safety`, `sharing`, `workspace`. Register new ones in `ops/index.ts`. |
| `repo/` | SQL access per table group: `datasets` (rows, versions), `defs` (versioned targets/suites/connections), `runs` (runs, results, groups), `labels` |
| `runner/` | Running a dataset through a target: `runner.ts` (concurrency, retries, resume), `evaluate.ts` (layered checks), `summary.ts`, `conversation.ts` (multi-turn), `overrides.ts` (per-run changes), `preflight.ts` (setup warnings) |
| `targets/` | Calling the app under test: `http.ts`, `websocket.ts` (incl. audio streaming), `model.ts`, `script.ts`, `curl.ts` (cURL import); shared extractors in `common.ts` |
| `checks/` | Check types by category: `transport` (status, latency), `structure` (JSON schema, fields), `content`, `reference` (WER, BLEU, similarity), `semantic` (embeddings), `judgment` (LLM judge, scripts), `safety`, `conversation`, `agents`, `rag`; registry in `index.ts` |
| `providers/` | Model connections via the AI SDK (OpenAI, Anthropic, Google, Vertex, Azure, Bedrock, OpenAI-compatible) and embeddings (local model or a connection) |
| `metrics/` | WER/CER alignment, text normalizers, BLEU/ROUGE (confidence intervals live in `runner/summary.ts`) |
| `audio/` | WAV decoding and encoding, resampling and wire formats for streaming (PCM16, G.711…), augmentation (noise, phone line, reverb…) |
| `media/` | image utilities (`image-size.ts`: keep generated images under a file-size limit) |
| `insights/` | failure themes (free grouping + AI clustering) and their storage |
| `quality/` | dataset quality: column profiles, coverage, duplicates |
| `sharing/` | `.kalibra` bundles, Git folder sync, importers (promptfoo, OpenAI Evals, LangSmith, Langfuse) |
| `traces/` | traces and spans that apps send (SDK, OpenTelemetry, proxy), joined to eval rows; see `docs/design/sdk-and-traces.md` |

## Conventions

- New behaviour is an **operation**, not an HTTP route; the server, CLI and MCP pick it up from the registry.
- Errors users can act on are `KalibraError` with a code (`invalid`, `not_found`, `forbidden`, `conflict`, `unavailable`) and a plain-language message.
- Writes that matter go through repositories, so policies (`policy.ts`) and events apply.
- Tests live in `packages/core/test/`, named after the area (`checks.test.ts`, `hub.test.ts`, …).
