# Kalibra docs

Short reads for people building or contributing to Kalibra. Each file takes a few minutes. Start at the top.

| File | What it covers |
|---|---|
| [overview.md](overview.md) | What Kalibra is, the core loop, and the principles behind it |
| [architecture.md](architecture.md) | Packages, how they talk, process layouts, where state lives, and **Where is…?** (which file to open for a change) |
| [engine.md](engine.md) | Operations, actors, events, jobs, the runner (preflight, overrides, conversations, comparisons), checks, summaries, templates, scripts, providers, embeddings, sharing |
| [data-model.md](data-model.md) | SQLite tables, versioning, blobs, secrets, workspace folder |
| [users-and-projects.md](users-and-projects.md) | Projects, roles, sign-in (passwords, SSO, GitHub, gateways), tokens, running a team server |
| [deploy.md](deploy.md) | npx and npm, Docker and Compose, backups and upgrades, how a release is made |
| [targets-and-checks.md](targets-and-checks.md) | Every target kind and every check type, one line each |
| [build-and-run.md](build-and-run.md) | Install, dev mode, demo data, builds, CLI, npm publishing |
| [testing.md](testing.md) | Test layout, running subsets, what the demo apps simulate |
| [mcp-and-agents.md](mcp-and-agents.md) | The MCP bridge, client setup, tools, provenance, security |
| [contributing.md](contributing.md) | Code style and how to add an operation, check, target kind or page |
| [features.md](features.md) | Everything Kalibra supports today |
| [roadmap.md](roadmap.md) | What comes next, prioritized |
| [competitors.md](competitors.md) | Feature × competitor matrix for prioritizing |
| [research/market-and-product-analysis.md](research/market-and-product-analysis.md) | The original market research and product analysis |

End-user guides live inside the app (profile menu → **Platform docs**); the SDK reference is at `/kalibra/sdk-docs` (profile menu → **SDK docs**).

**Package code maps:** [core](../packages/core/README.md) · [core/src](../packages/core/src/README.md) · [server](../packages/server/README.md) · [cli](../packages/cli/src/README.md) · [web](../packages/web/README.md) · [demo](../packages/demo/README.md)
