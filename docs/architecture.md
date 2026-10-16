# Architecture

An npm-workspaces monorepo, TypeScript everywhere.

## Packages

| Package | Role |
|---|---|
| `packages/core` | The engine: operation registry, storage, datasets, targets, checks, runner (incl. conversations, comparisons), jobs, providers, embeddings, insights, quality, sharing, audio |
| `packages/server` | HTTP API over the engine: operations, live events (SSE), file upload/download, static UI |
| `packages/web` | React UI (Vite, Tailwind, Radix, TanStack Query/Virtual) |
| `packages/cli` | `kalibra` CLI: `serve`, `run`, `op`, `ops`, `mcp`. Published to npm as `kalibra` |
| `packages/desktop` | Electron shell: starts the server, opens the UI, OS-keychain secrets |
| `packages/demo` | Mock apps under test (chat JSON/SSE, multi-turn session chat, STT batch + WebSocket) and demo data |

## How the pieces talk

```
                 ┌───────────────── Engine (core) ─────────────────┐
  Web UI ───────►│ HTTP API (server)  POST /api/ops/:name          │
  (browser or    │                    GET  /api/events  (SSE)      │
   Electron)     │                    POST /api/files, GET /files  │
                 │        │                                        │
  kalibra CLI ──►│  Operation registry ─► repos (SQLite) ─► blobs/  │
                 │        │                                        │
  kalibra mcp ──►│  runner · jobs · targets · checks · providers   │──► your app (HTTP/WS)
   ▲ (stdio)     └──────────────────────────────────────────────────┘──► model providers
   │
  Claude Code / Codex / Cursor / Gemini CLI
```

- **Everything is an operation.** `defineOp({ name, input: zodSchema, handler })`. The HTTP route, CLI `op` command and MCP tools are generated from the registry.
- **One writer.** The running engine owns the database. The CLI and MCP bridge read `<workspace>/.engine.json` and call the running engine over HTTP; if none is running, they open the workspace directly.
- **Live updates.** Every change emits an event; the UI refreshes affected queries, so edits made by agents or the CLI appear instantly.

## Security on localhost

- The engine binds to `127.0.0.1` with a random port and a per-launch **token** (Bearer header or an HttpOnly cookie set from `/?token=…`).
- **Host and Origin checks** block DNS rebinding and cross-site requests.
- Secrets never leave the secret store: definitions hold only names (`{{secret.name}}`), and MCP has no secret tools.

## Process layouts

| Mode | Processes |
|---|---|
| Desktop | Electron main runs engine + server in-process; window loads `http://127.0.0.1:<port>/?token=…` |
| `npx kalibra` | One Node process (bundled CLI) runs engine + server and opens the browser |
| Dev (`npm run dev`) | Engine on :4317 (tsx watch) + Vite UI on :5173 (proxy `/api`) + demo apps on :4400 |
| CI | `kalibra run …` opens the workspace directly, exits non-zero on failure |

## Where state lives

```
<workspace>/            default ~/Kalibra/default, or KALIBRA_DIR / --dir
  kalibra.db            SQLite (WAL): datasets, rows, definitions, runs, comparisons, results, labels, insights, activity
  blobs/ab/cd/<sha256>  uploaded and generated files, stored once by content hash
  secrets.json|.enc     secret values (desktop: encrypted with the OS keychain)
  .engine.json          address + token of the running engine (deleted on exit)

~/Kalibra/models/       shared by all workspaces, only after "Download": local embedding runtime + model
```

## Seams for a future server mode

Built in now so a self-hosted, multi-user server is mostly packaging later:

- UI talks only to the HTTP API (no Electron IPC for data).
- Every record carries an **actor** (user / agent / CLI).
- Files always go through the blob store (never local paths).
- Storage, blobs, secrets and jobs sit behind interfaces (SQLite → Postgres, folder → S3/GCS, keychain → Vault/KMS, in-process jobs → workers).
- Saves carry the version they edited (optimistic concurrency).
- Until then, teams share without a server: `.kalibra` bundles and a Git-synced folder (`src/sharing/`).

See [research §11.6](research/market-and-product-analysis.md) for the full plan.
