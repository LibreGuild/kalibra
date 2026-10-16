# Kalibra

Local-first, open-source evaluation for AI applications. Build test datasets (text, audio, images), point Kalibra at your real app (HTTP API, WebSocket stream, a model, or your own script), score every result with layered checks (status → schema → fields → content → WER/BLEU/meaning → LLM judge), then compare runs and models, find the weak slices and calibrate your judges. Everything runs on your machine: no account and no server to host.

## Quick start

```bash
npx kalibra
```

Starts Kalibra and opens it in your browser. Needs Node.js 22.13+. Your workspace lives in `~/Kalibra/default`.

## Develop

```bash
npm install
npm run dev                 # engine :4317 + UI http://localhost:5173 + demo apps :4400
npm run demo -- --seed      # once: demo datasets, targets and suites in ./.kalibra-dev
npm test && npm run typecheck
```

The demo apps are a bank support chatbot (JSON, SSE and a multi-turn session endpoint) and a speech-to-text service (upload + streaming WebSocket) with deliberate mistakes, so every check has something to catch.

## Highlights

- **Data:** typed datasets with versions and a review queue; generate text rows, images and speech with any model; audio variants (noise, phone line, echo…); a safety pack mapped to OWASP/NIST/MITRE ATLAS; a Quality tab for coverage, variety and duplicates.
- **Any app:** HTTP (cURL import, multipart, SSE), WebSocket audio streaming with every knob, model targets, custom scripts. Or import outputs you produced elsewhere.
- **Conversations:** scripted multi-turn runs or a simulated user with a persona and a goal.
- **Honest scoring:** layered checks with gates, WER/CER with normalizers, meaning similarity with a free offline embedding model, LLM judges with image/audio attachments, refusal and PII checks, confidence intervals, corpus WER, significance tests.
- **Pick the best:** compare several targets or models on one dataset with a leaderboard; try prompts side by side in the playground; failure themes say what broke and why.
- **Trust your judge:** blind human labelling, kappa, corrected pass rates.
- **Agents welcome:** an MCP server so Claude Code, Codex, Cursor or Gemini CLI can fill datasets, set up targets and run evals. You drive your own agent; Kalibra never launches one.
- **Team sharing without a server:** `.kalibra` bundles, a Git-synced folder, and importers for promptfoo, OpenAI Evals, LangSmith and Langfuse.
- **Never blocked:** every structured option has a script escape hatch.

## Docs

- In the app: sidebar → **Docs** (short, illustrated guides).
- For developers: [docs/](docs/README.md): [overview](docs/overview.md) · [architecture](docs/architecture.md) · [engine](docs/engine.md) · [data model](docs/data-model.md) · [targets & checks](docs/targets-and-checks.md) · [build & run](docs/build-and-run.md) · [testing](docs/testing.md) · [MCP](docs/mcp-and-agents.md) · [contributing](docs/contributing.md)
- Product: [features](docs/features.md) · [roadmap](docs/roadmap.md) · [competitor matrix](docs/competitors.md)

## Repository layout

```
packages/
  core/     engine: operations, datasets, targets, checks, runner, jobs, providers, audio
  server/   HTTP API + live events + file serving
  web/      React UI
  cli/      kalibra serve | run | op | mcp  (published as `kalibra` on npm)
  desktop/  Electron shell
  demo/     mock apps under test + demo data
docs/       developer docs and research
```

## License

MIT
