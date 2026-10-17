# cli/src: code map

The `kalibra` command, published to npm as `kalibra` (user docs: [../README.md](../README.md)). `build.mjs` bundles this folder, the engine and the server into one file (`dist/kalibra.mjs`) and copies the built web UI next to it.

| File | Owns |
|---|---|
| `main.ts` | argument parsing and commands: `serve` (local), `server` (team), `run` (CI, with `--min-pass`), `projects`, `ops`, `op`, `users` (account recovery), `backup`, `mcp`; the help text; `VERSION` (set by `scripts/set-version.mjs`) |
| `engine-client.ts` | how the CLI and MCP bridge reach Kalibra: a team server (`--server` + `KALIBRA_TOKEN`), a running local app (`.engine.json`), or an in-process hub; project switching; desktop secrets |
| `mcp.ts` | the MCP bridge (stdio): tools generated from the operation registries, `use_project`, prompts |
| `backup.ts` | consistent backups (SQLite `VACUUM INTO` + files) |

## Run and test

- From source: `npx tsx packages/cli/src/main.ts <command>`, e.g. `serve --dev`.
- Build: `npm run build -w @kalibra/web && npm run build -w kalibra`.
- Tests: `npx vitest run packages/cli` (`mcp.test.ts` spawns the bridge over stdio).
