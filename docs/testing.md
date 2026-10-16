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
| `demo/test/e2e.test.ts` | Full path: seed → chat run → batch STT → streaming STT → imported outputs → compare → agent rows |

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
- `POST /api/stt`: multipart speech-to-text with small deterministic transcript errors.
- `WS /ws/stt`: streaming STT. JSON start → binary PCM or base64 JSON frames → stop; partials every ~300 ms, one final.

Audio fixtures are generated with macOS `say` in six English accents; tests that need them skip if `say` is missing.

## Tips

- Tests that hit real model providers are not part of the suite. Use the app's **Test** buttons or a script against the dev engine.
- Each test that needs an engine creates one in a temp folder: `new Engine({ dir: mkdtempSync(...) })`.
