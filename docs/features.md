# Features (what Kalibra supports today)

`✅ shipped` · `🧪 beta` (works, rough edges or limited testing). Updated 2026-10-17.

## Datasets & data generation
- ✅ Typed columns: text, number, boolean, JSON, list, chat messages, audio, image, file
- ✅ Add rows by hand, import CSV / JSONL / JSON (auto-create columns), export CSV / JSONL
- ✅ Upload many audio/image files, matched to a labels CSV by file name
- ✅ Immutable versions; runs pin the version they used
- ✅ Review queue: draft / needs review / approved / rejected, bulk actions, provenance on every row
- ✅ Generate text rows with any model connection, guided by column descriptions and instructions
- ✅ Generate images into a column or as new rows (GPT Image, Imagen, …)
- ✅ Generate speech (TTS) from a text column, rotating voices, with speaking instructions
- ✅ Audio variants: noise (SNR), phone line, echo, quieter, clipping, speed, muffled, dropouts (reproducible)
- ✅ Transcribe audio into a text column (draft references)
- ✅ Background jobs with progress and cancel
- 🧪 Safety pack: categories mapped to OWASP / NIST / MITRE ATLAS / AILuminate, variants (base64, role-play, typos…), benign look-alikes, optional tailored prompts

## Targets (the app under test)
- ✅ HTTP: templates, auth, JSON/form/multipart/binary bodies, SSE/NDJSON streaming, extractors, cURL import, before/after scripts
- ✅ WebSocket: real-time audio streaming (PCM/μ-law/A-law/file, binary or base64 JSON), partial/final rules, session scripts
- ✅ Model targets: text, image, speech, transcription
- ✅ Custom script targets (JavaScript)
- ✅ Variables and secrets in every template; "Try it" with a real row before saving

## Checks
- ✅ Layered suites with gates, weights, `applyWhen`, all-pass or weighted pass rules
- ✅ Status, latency (incl. streaming metrics), no-error
- ✅ Is JSON, JSON Schema, JSONPath conditions
- ✅ Equals, contains, regex, numeric tolerance, fuzzy similarity
- ✅ WER / CER / MER / WIL with normalizers and alignment diff; keyword recall
- ✅ BLEU, ROUGE-L, chrF, token F1
- ✅ LLM judge (rubric, critique-first, repetitions, image/audio attachments, strict JSON for OpenAI)
- 🧪 Refusal check (unsafe compliance and over-refusal) and PII/canary leak check
- ✅ Script and expression checks

## Runs & analysis
- ✅ Concurrency, retries with Retry-After, repetitions, row filters, resume after crash/cancel
- ✅ Live progress and live summary
- ✅ Pass rate with 95% interval, corpus WER, latency percentiles, per-check stats
- ✅ Results grid (100k rows), result detail with WER diff, judge reasoning, request/response, WebSocket timeline
- ✅ Score outputs produced elsewhere (imported runs)
- ✅ Compare runs: improved/regressed rows, per-check deltas, McNemar significance
- ✅ Breakdown by tag / column / status with "weakest" group
- ✅ Trends of pass rate per suite on Overview

## Calibration
- ✅ Label results pass/fail per check or row (keyboard P/F/S/U, blind mode)
- ✅ Agreement, Cohen's kappa, TPR/TNR, confusion matrix, corrected pass rate with CI, disagreements list, suite-wide scope

## Connections
- ✅ OpenAI, Anthropic, Gemini API, Vertex AI (ADC, service account, express), Azure (key or `az login`), Bedrock (profile/SSO, keys, API key), OpenAI-compatible (Ollama, vLLM, OpenRouter, xAI, Groq, LiteLLM…)
- ✅ Text, image, speech and transcription models per connection, each with a Test
- ✅ Secret store (OS keychain in the desktop app), `{{secret.name}}` references

## Agents (MCP)
- ✅ 55+ tools generated from the operation registry, prompts, destructive hints, agent provenance
- ✅ Setup snippets for Claude Code, Codex, Cursor, Gemini CLI, VS Code; agent activity feed

## CLI, CI and install
- ✅ `npx kalibra` (start + open browser), `serve`, `run --min-pass` (CI exit codes), `ops`, `op`, `mcp`
- ✅ Desktop app (Electron), unpackaged; installers on the roadmap
- ✅ Local HTTP API with token and host/origin checks; live events

## UX
- ✅ Light / dark / system theme, accent colour picker, reading fonts (Atkinson Hyperlegible Next default), text size
- ✅ Collapsible sidebar, help tooltips on every non-obvious control
- ✅ In-app docs: 29 short illustrated guides with search and progress
