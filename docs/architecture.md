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
| `packages/sdk` | `kalibra-sdk` for your app: traces and steps, eval-run linking, tool record/replay, `evaluate()` (evals as code). Zero dependencies; off in production unless enabled |
| `sdks/python` | `kalibra-sdk` on PyPI (import `kalibra`): the same SDK for Python apps, standard library only, Python 3.9+; see its [README](../sdks/python/README.md) |

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

## Where is…?

Each package has a README with its code map: [core](../packages/core/README.md) (and [core/src](../packages/core/src/README.md)), [server](../packages/server/README.md), [cli](../packages/cli/src/README.md), [web](../packages/web/README.md), [desktop](../packages/desktop/README.md), [demo](../packages/demo/README.md).

| Looking for… | Where |
|---|---|
| **a new check** | `packages/core/src/checks/<category>.ts` (`defineCheck`) + register it in `checks/index.ts`. The UI form comes from its `fields`. Tests: `packages/core/test/checks.test.ts`. |
| **a new operation** (UI + CLI + MCP at once) | `packages/core/src/ops/<area>.ts` (`defineOp`) + `ops/index.ts`. Set `access` when the default role is wrong. `test/registry.test.ts` guards descriptions and roles. |
| **a new target kind** | the config schema in `packages/core/src/specs.ts` (`TargetSpec`), the executor in `targets/<kind>.ts` + `targets/index.ts`, the form in `packages/web/src/components/targets/` |
| **sign-in providers** | `packages/core/src/hub/providers.ts` (config, env shortcuts), `hub/sso.ts` (OIDC, GitHub, gateways, who gets in), routes in `packages/server/src/index.ts` (`/api/auth/sso/*`), admin UI in `packages/web/src/components/admin/sign-in.tsx` |
| **permissions** | project roles and `opAccess` in `packages/core/src/registry.ts`; the decision in `hub/hub.ts` (`callProject`, `roleIn`, `capsFor`); code and folder policies in `policy.ts`; hub operations' rules in `hub/ops.ts`. Overview: [users-and-projects.md](users-and-projects.md). |
| **request authentication** (tokens, cookies, CSRF) | `packages/server/src/auth.ts` |
| **the UI for X** | the route in `packages/web/src/routes.tsx` → `src/pages/<x>.tsx` → parts in `src/components/<x>/`; shared building blocks in `src/components/ui/` |
| **database tables** | project data: `PROJECT_MIGRATIONS` in `packages/core/src/db.ts`; hub data: `packages/core/src/hub/schema.ts`; SQL per area in `src/repo/` |
| **how a run executes** | `packages/core/src/runner/runner.ts` (+ `evaluate.ts`, `summary.ts`, `conversation.ts`) |
| **model providers** | `packages/core/src/providers/index.ts` |
| **the MCP bridge** | `packages/cli/src/mcp.ts`; how it reaches Kalibra in `engine-client.ts` |
| **the release pipeline** | `.github/workflows/release.yml` (tags `v*`), `ci.yml` (pull requests), `packages/desktop/electron-builder.yml`, `Dockerfile`, `scripts/set-version.mjs`; how to release in [deploy.md](deploy.md) |
| **in-app docs** | `packages/web/src/docs/content.ts`, illustrations in `packages/web/public/docs/` |

## Projects and the team server

A **hub** sits above projects (`src/hub/`): `hub.db` holds accounts, sessions, tokens, projects, members and settings; every project is its own folder with its own `kalibra.db`, opened as an ordinary `Engine`. Every call goes through `Hub.callProject`, which resolves the caller's role and passes it, with the host's capabilities, to `Engine.call`. Local mode (desktop, npx) has one implicit user; server mode (`kalibra server`) adds sign-in. See [users-and-projects.md](users-and-projects.md).

## Seams for scaling the server


- UI talks only to the HTTP API (no Electron IPC for data).
- Every record carries an **actor** (user / agent / CLI).
- Files always go through the blob store (never local paths).
- Storage, blobs, secrets and jobs sit behind interfaces (SQLite → Postgres, folder → S3/GCS, keychain → Vault/KMS, in-process jobs → workers).
- Saves carry the version they edited (optimistic concurrency).
- Teams can also share without a server: `.kalibra` bundles and a Git-synced folder (`src/sharing/`).

See [research §11.6](research/market-and-product-analysis.md) for the full plan.
