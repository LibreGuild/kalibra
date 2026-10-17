# @kalibra/desktop

The desktop app (Electron). It starts the hub and HTTP server on 127.0.0.1 with a per-launch token, opens the web UI in a window, keeps secrets encrypted with the OS keychain, and can open team servers in their own windows.

## Code map

| File | Owns |
|---|---|
| `src/main.ts` | app start-up (`boot`), the local window and its navigation guard, team-server windows (separate cookies per server, browser user agent), the Servers menu and the "Connect to a team server" form, keychain-encrypted secrets per project |
| `src/server-list.ts` | saved team servers (no Electron imports, so it is unit-tested), address normalisation, the connect form page |
| `build.mjs` | bundles `main.ts` with the engine and server into `dist/main.cjs`, copies the web UI and the CLI (for the MCP bridge) |
| `electron-builder.yml`, `build/icon.*` | installers: macOS dmg/zip (arm64 and x64), Windows NSIS, Linux AppImage; unsigned for now |

## Run and test

- Run from source: `npm run desktop` from the repo root (builds everything, then starts Electron).
- Installers for this machine: `npm run dist -w @kalibra/desktop -- --mac` (or `--win`, `--linux`); output in `release/`. Releases build all three in GitHub Actions (`docs/deploy.md`).
- Tests: `npx vitest run packages/desktop`.
