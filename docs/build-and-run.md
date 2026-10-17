# Build and run

## Prerequisites

- **Node.js 22.13+** (uses the built-in `node:sqlite`; no native modules to compile).
- Optional: macOS `say` (demo audio fixtures), `ffmpeg` on PATH (decoding non-WAV audio).

## Develop

```bash
npm install
npm run dev                 # engine :4317 (tsx watch) + UI :5173 (Vite) + demo apps :4400
npm run demo -- --seed      # once: fill ./.kalibra-dev with demo datasets, targets, suites
```

Open http://localhost:5173. The dev workspace is `./.kalibra-dev` (git-ignored).

Run pieces separately:

```bash
npm run dev:server          # engine only
npm run dev:web             # UI only
npm run demo                # demo apps only
```

## Check

```bash
npm run typecheck           # tsc for every package
npm test                    # vitest: unit + integration + end-to-end
```

## Build

```bash
npm run build               # web UI → CLI bundle → desktop bundle
```

| Output | What it is |
|---|---|
| `packages/web/dist` | Static UI |
| `packages/cli/dist/kalibra.mjs` + `dist/web` | Single-file CLI (minified, ~3 MB) with the UI bundled |
| `packages/desktop/dist` | Electron main (`main.cjs`), UI and CLI copy |

## Run the builds

```bash
node packages/cli/dist/kalibra.mjs              # start + open the browser
node packages/cli/dist/kalibra.mjs serve --port 4317
node packages/cli/dist/kalibra.mjs run --dataset D --target T --suite S --min-pass 0.9
npm run start -w @kalibra/desktop               # desktop app (after npm run build)
```

Data folder: `~/Kalibra/default`, or `--dir` / `KALIBRA_DIR`. Pick a project with `--project` (`kalibra projects` lists them).

Team server (sign-in, users, roles): `node packages/cli/dist/kalibra.mjs server --public-url https://kalibra.example.com`. Setup, sign-in providers and recovery (`kalibra users …`) are in [users-and-projects.md](users-and-projects.md).

## Publish to npm (maintainer)

The `packages/cli` package is the public `kalibra` package. It bundles everything, so it has no runtime dependencies.

```bash
cd packages/cli
npm pack                    # inspect the tarball (prepack builds it)
npx -y --package="$PWD/kalibra-0.1.0.tgz" kalibra --help   # try it like a user
npm publish                 # maintainer only, with your npm account
```

Users then run `npx kalibra`. No installer, no code-signing prompts.

## Desktop installers

`npm run dist -w @kalibra/desktop -- --mac` (or `--win`, `--linux`) after building the web UI and CLI writes unsigned installers to `packages/desktop/release/` (electron-builder: `.dmg` and `.zip`, NSIS `setup.exe`, AppImage). Releases build all three in GitHub Actions; see [deploy.md](deploy.md).

`npx kalibra` avoids unsigned-app warnings, which is why it is the recommended install for developers.
