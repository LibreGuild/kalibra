# Overview

Kalibra is a local-first, open-source tool for evaluating AI applications. It runs on your machine (desktop app, `npx kalibra`, or a local server), tests your real app over HTTP, WebSocket, a model call or a script, and scores every result with checks you choose.

## The core loop

```
Dataset ──► Target ──► Suite ──► Run ──► Compare / Breakdown / Calibrate
 test        how to     layered   every     did it improve? where does it
 cases       call your  checks    row       fail? can I trust the judge?
             app                  scored
```

- **Dataset**: typed rows (text, numbers, lists, JSON, chat messages, audio, images, files). Versioned.
- **Target**: a recipe for calling your app once per row, using `{{column}}` placeholders.
- **Suite**: an ordered set of checks in layers, cheapest first. A failing gate skips the expensive layers.
- **Run**: dataset × target × suite, one call per row or a multi-turn conversation (scripted or a simulated user). Results stream in live; the summary has confidence intervals.
- **Compare / Breakdown / Calibrate**: row-by-row run comparison with a significance test, comparisons of several targets or models in one go, failure themes, slices by tag or column, and judge-vs-human agreement.

Around the loop: the **Playground** tries a prompt across models before you wire a target, the dataset **Quality** tab finds gaps and duplicates, and **bundles** or a **Git folder** share everything with a team without a server.

## Principles

| Principle | What it means in the code |
|---|---|
| **Local-first** | A workspace is a folder: SQLite + content-addressed files. No account, no telemetry. |
| **Nothing is blocked** | Forms cover common cases; every step has a script escape hatch (request hooks, response parsers, WebSocket session scripts, script checks, script targets). |
| **One engine, three front doors** | The UI, the CLI and the MCP bridge all call the same operations. If the UI can do it, an agent can too. |
| **Vendor-neutral** | Any model provider (OpenAI, Anthropic, Gemini, Vertex, Bedrock, Azure, OpenAI-compatible, local). |
| **Honest numbers** | Wilson intervals, corpus WER, McNemar tests, judge calibration. Bare averages are avoided. |
| **Open** | MIT license. |

## Who it is for

- Teams shipping chatbots, RAG, agents, speech-to-text, TTS and image apps who need repeatable tests.
- Developers who already work with coding agents (Claude Code, Codex, Cursor, Gemini CLI) and want those agents to fill data and run evals.
- Anyone who can't send customer data to a hosted eval SaaS.

Next: [architecture.md](architecture.md).
