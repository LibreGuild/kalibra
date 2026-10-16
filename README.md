# Kalibra

Local-first, open-source evaluation for AI applications. Build test datasets (text, audio, images), point Kalibra at your app (HTTP API, WebSocket stream, model + prompt, or your own script), score every result with layered checks (status → schema → fields → content → WER/BLEU/similarity → LLM judge), and compare runs. Everything runs on your machine; no account, no server to host.

## Principles

- **Nothing is blocked.** Forms cover the common cases; every step has a script escape hatch (request hooks, response parsers, WebSocket session scripts, custom checks).
- **One engine, three front doors.** The desktop UI, the `kalibra` CLI and the MCP server all call the same operations, so a coding agent can do anything the UI can.
- **Your data stays local.** A workspace is a folder: `kalibra.db` (SQLite) plus content-addressed files. Secrets live in the OS keychain-backed store, never in definitions.

## Quick start (development)

Requires Node.js 22.13+ (macOS, Linux or Windows).

```bash
npm install
npm run dev                  # engine :4317 + UI http://localhost:5173 + demo apps :4400
npm run demo -- --seed       # (in another terminal, once) fill ./.kalibra-dev with demo data
```

The demo apps are a bank support chatbot (JSON and SSE) and a speech-to-text service (multipart upload and streaming WebSocket) with deliberate mistakes, so every check has something to find.

## Desktop app

```bash
npm run build                # web UI + CLI + Electron bundle
npm run start -w @kalibra/desktop
```

The workspace defaults to `~/Kalibra/default` (override with `KALIBRA_DIR`). Installers (`.dmg`, `.exe`, AppImage) are not packaged yet.

## CLI

```bash
node packages/cli/dist/kalibra.mjs serve --open                  # engine + UI in your browser
node packages/cli/dist/kalibra.mjs run --dataset "Voice commands" --target "Demo STT (batch upload)" --suite "STT checks (batch)" --min-pass 0.8
node packages/cli/dist/kalibra.mjs ops                           # every operation
node packages/cli/dist/kalibra.mjs op list_datasets
```

`run` exits non-zero when the run fails or the pass rate is below `--min-pass`, so it drops into CI.

## Coding agents (MCP)

Open **Coding agents** in the app for the exact command for your setup. With Claude Code:

```bash
claude mcp add kalibra -- node /path/to/kalibra.mjs mcp --dir ~/Kalibra/default
```

Then ask in your own words, e.g. *"Create 50 synthetic rows for the Kalibra dataset 'Support questions'"*. The agent reads the schema, submits rows in batches, gets per-row validation errors back, and the rows appear live in the app for review. Kalibra never launches or calls an agent; you drive your own.

## Repository layout

```
packages/
  core/     engine: operation registry, datasets, targets (HTTP/SSE/WebSocket/audio), checks, runner, providers
  server/   HTTP API + live events (SSE) + file serving; the desktop runs it on 127.0.0.1 with a token
  web/      React UI (Vite, Tailwind)
  cli/      kalibra serve | run | op | mcp
  desktop/  Electron shell
  demo/     mock apps under test + demo data
docs/research/   market research and product analysis
```

## Tests

```bash
npm test         # unit tests + an end-to-end run against the demo apps
npm run typecheck
```

## License

MIT
