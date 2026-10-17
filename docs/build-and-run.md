# Build and run

## Prerequisites

- **Node.js 22.13+** (uses the built-in `node:sqlite`; no native modules to compile).
- Optional: macOS `say` (demo audio fixtures), `ffmpeg` on PATH (decoding non-WAV audio).

## Develop

```bash
npm install
npm run dev                 # engine :4317 (tsx watch) + UI :5173/kalibra/ (Vite) + demo apps :4400
npm run demo -- --seed      # once: fill ./.kalibra-dev with demo datasets, targets, suites
```

Open http://localhost:5173/kalibra/. The dev workspace is `./.kalibra-dev` (git-ignored). Everything Kalibra serves is under `/kalibra` (see [self-hosting.md](self-hosting.md#addresses-and-load-balancers)); Vite proxies `/kalibra/api` to the engine.

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
npm run build               # JS SDK → web UI → CLI bundle
```

| Output | What it is |
|---|---|
| `packages/web/dist` | Static UI |
| `packages/cli/dist/kalibra.mjs` + `dist/web` | Single-file CLI (minified, ~3 MB) with the UI bundled |
| `packages/sdk/dist` | JavaScript SDK (`kalibra-sdk`), ESM + CJS + types |

## Run the builds

```bash
node packages/cli/dist/kalibra.mjs              # start + open the browser
node packages/cli/dist/kalibra.mjs serve --port 4317
node packages/cli/dist/kalibra.mjs run --dataset D --target T --suite S --min-pass 0.9
```

Data folder: `~/Kalibra/default`, or `--dir` / `KALIBRA_DIR`. Pick a project with `--project` (`kalibra projects` lists them).

Team server (sign-in, users, roles): `node packages/cli/dist/kalibra.mjs server --public-url https://kalibra.example.com`. Setup, sign-in providers and recovery (`kalibra users …`) are in [users-and-projects.md](users-and-projects.md).

## Publish to npm (maintainer)

The `packages/cli` package is the public `kalibra` package. It bundles everything, so it has no runtime dependencies.

```bash
cd packages/cli
npm pack                    # inspect the tarball (prepack builds it)
npx -y --package="$PWD/kalibra-0.1.1-beta.1.tgz" kalibra --help   # try it like a user
```

Releases are staged from a version tag by GitHub Actions and approved on npmjs.com; see [releasing.md](releasing.md). Users then run `npx kalibra` (or `npm i -g kalibra`). Kalibra ships as npm and Docker only: no installers, no code-signing prompts.
