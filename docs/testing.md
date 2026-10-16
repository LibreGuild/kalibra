# Testing

Vitest, configured in the root `vitest.config.ts` (`packages/*/test/**/*.test.ts`).

## Layout

| File | Covers |
|---|---|
| `core/test/metrics.test.ts` | WER/CER alignment, normalizers, BLEU, ROUGE-L, chrF, token F1 |
| `core/test/checks.test.ts` | Check types end to end (status, schema, JSONPath, WER details, contains, script…) |
| `core/test/audio.test.ts` | WAV decode/encode, resampling, μ-law/A-law |
| `core/test/targets-curl.test.ts` | cURL import |
| `core/test/targets-integration.test.ts` | HTTP, multipart and WebSocket executors against the demo apps |
| `core/test/media.test.ts` | Audio augmentation DSP, jobs, media ops with a stubbed model client |
| `core/test/labels.test.ts` | Kappa, corrected pass rate, sampling, suite-wide agreement |
| `core/test/insights.test.ts` | Breakdowns and trends |
| `core/test/safety.test.ts` | Refusal and PII checks, converters, safety dataset creation |
| `core/test/preflight.test.ts` | Setup warnings (missing columns/variables, turns column), refusal check on empty output |
| `core/test/conversation.test.ts` | Scripted turns, simulated users (stubbed model), model targets replaying history, conversation checks |
| `core/test/groups.test.ts` | Run overrides; comparisons: validation, one dataset version, ranking, side-by-side filters, delete |
| `core/test/embeddings.test.ts` | Cosine + LRU cache, connection embeddings (fake fetch), local model status, `semantic_similarity`, `semantic_wer` |
| `core/test/themes.test.ts` | Free grouping, clustering, `cluster_failures` / `get_failure_themes` |
| `core/test/quality.test.ts` | Quality report, coverage rules, exact/near duplicates, quality ops |
| `core/test/playground.test.ts` | Playground: typed rows, rows × variants as a job, suite scoring, image attachments, save as target |
| `core/test/sharing.test.ts` | Bundles round trip, folder sync (byte-stable, dry run, prune, legacy specs) |
| `core/test/sharing-importers.test.ts` | promptfoo, OpenAI Evals, LangSmith, Langfuse importers |
| `core/test/registry.test.ts` | Op parity guard: metadata, unique names, no secret tools on MCP, destructive deletes |
| `demo/test/e2e.test.ts` | Full path: seed → chat run → batch STT → streaming STT → scripted conversations → comparison → imported outputs → compare → agent rows |

## Run a subset

```bash
npx vitest run packages/core/test/metrics.test.ts
npx vitest run -t "corpus WER"
npx vitest            # watch mode
```

## The demo apps

`packages/demo` starts mock apps under test (port 4400 by default, port 0 in tests):

- `POST /api/chat`: a bank support bot with deliberate failures (500s, broken JSON, slow replies, missing fields, refusals) and weak safety (falls for base64 and role-play).
- `POST /api/chat/stream`: the same answers as OpenAI-style SSE.
- `POST /api/chat/session`: a multi-turn bot with memory, `{message, session_id?}` → `{answer, session_id}` (for conversation runs).
- `POST /api/stt`: multipart speech-to-text with small deterministic transcript errors.
- `WS /ws/stt`: streaming STT. JSON start → binary PCM or base64 JSON frames → stop; partials every ~300 ms, one final.

Audio fixtures are generated with macOS `say` in six English accents; tests that need them skip if `say` is missing.

## Tips

- Tests that hit real model providers are not part of the suite. Use the app's **Test** buttons or a script against the dev engine. Model-dependent features (simulated users, AI themes, fill gaps, playground) are tested with a stubbed model client.
- The local embedding model is not downloaded in tests; embedding tests use a stub embedder.
- Each test that needs an engine creates one in a temp folder: `new Engine({ dir: mkdtempSync(...) })`.
