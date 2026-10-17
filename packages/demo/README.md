# @kalibra/demo

Mock "apps under test" and sample data, so Kalibra can be tried and tested without a real AI app. Not shipped to users.

| File | Owns |
|---|---|
| `src/servers.ts` | the mock apps on one port: support chat (JSON and SSE streaming), multi-turn session chat, speech-to-text (batch upload and WebSocket streaming) |
| `src/data.ts` | demo datasets, targets and suites matching the mock apps |
| `src/fixtures.ts` | demo audio: spoken commands made with macOS `say` (tone clips elsewhere) |
| `src/seed.ts` | fills a workspace with datasets, targets and suites through operations |
| `src/main.ts` | `npm run demo` (start the apps) and `npm run demo -- --seed` (also seed the running engine or a folder) |

## Run and test

- `npm run demo -- --seed` while `npm run dev` is running; the apps listen on http://127.0.0.1:4400.
- `npx vitest run packages/demo`: the end-to-end test seeds a temporary workspace and runs every demo target.
