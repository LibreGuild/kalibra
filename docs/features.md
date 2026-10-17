# Features (what Kalibra supports today)

`✅ shipped` · `🧪 beta` (works, rough edges or limited testing). Updated 2026-10-17.

## Datasets & data generation
- ✅ Typed columns: text, number, boolean, JSON, list, chat messages, audio, image, file
- ✅ Add rows by hand, import CSV / JSONL / JSON (auto-create columns), export CSV / JSONL
- ✅ Upload many audio/image files, matched to a labels CSV by file name
- ✅ Immutable versions; runs pin the version they used
- ✅ Review queue: draft / needs review / approved / rejected, bulk actions, provenance on every row
- ✅ Generate text rows with any model connection, guided by column descriptions and instructions
- ✅ Generate images into a column or as new rows (GPT Image, Imagen, …), optionally kept under a file size (e.g. 50 KB: re-encoded as JPEG and scaled down when needed)
- ✅ Generate speech (TTS) from a text column, rotating voices, with speaking instructions
- ✅ Audio variants: noise (SNR), phone line, echo, quieter, clipping, speed, muffled, dropouts (reproducible)
- ✅ Transcribe audio into a text column (draft references)
- ✅ Background jobs with progress and cancel
- 🧪 Safety pack: categories mapped to OWASP / NIST / MITRE ATLAS / AILuminate, variants (base64, role-play, typos…), benign look-alikes, optional tailored prompts

## Dataset quality
- ✅ Quality tab: rows in use, empty cells, exact copies, "Worth fixing" flags with suggestions
- ✅ Coverage of category-like columns (dominant values, allowed values with no rows) and variety (length spread, new word pairs, overlap between rows, repetition)
- ✅ Duplicates: exact, near (small edits) or meaning (embeddings); "Keep one of each" rejects the extras, nothing is deleted
- 🧪 Fill gaps: a model writes rows for under-represented values of a column (background job, rows land as needs review)

## Targets (the app under test)
- ✅ HTTP: templates, auth, JSON/form/multipart/binary bodies, SSE/NDJSON streaming, extractors, cURL import, before/after scripts
- ✅ WebSocket: real-time audio streaming (PCM/μ-law/A-law/file, binary or base64 JSON), partial/final rules, session scripts
- ✅ Model targets: text, image, speech, transcription
- ✅ Custom script targets (JavaScript)
- ✅ Variables and secrets in every template; "Try it" with a real row before saving
- ✅ Prompt playground: one prompt, up to 25 rows (typed or from a dataset), up to 4 models side by side, optional suite scoring, save as a model target, "Run full eval" on the whole dataset (a run, or a comparison for several models)

## Checks
- ✅ Layered suites with gates, weights, `applyWhen`, all-pass or weighted pass rules
- ✅ Status, latency (incl. streaming metrics), no-error
- ✅ Is JSON, JSON Schema, JSONPath conditions
- ✅ Equals, contains, regex, numeric tolerance, fuzzy similarity
- ✅ WER / CER / MER / WIL with normalizers and alignment diff; keyword recall
- ✅ BLEU, ROUGE-L, chrF, token F1
- ✅ Meaning matches (embeddings): free offline local model or a connection's embedding model
- 🧪 Meaning errors in a transcript: an LLM counts only the STT errors that change the meaning
- ✅ Conversation checks: goal achieved, conversation mentions, number of turns
- ✅ LLM judge (rubric, critique-first, repetitions, image/audio attachments, strict JSON for OpenAI)
- 🧪 Refusal check (unsafe compliance and over-refusal) and PII/canary leak check
- ✅ Script and expression checks

## Runs & analysis
- ✅ Concurrency, retries with Retry-After, repetitions, row filters, resume after crash/cancel
- ✅ Live progress and live summary
- ✅ Setup warnings before a run ("Check before you start"): `{{columns}}` the dataset lacks, undefined `{{vars.x}}`, missing turns column
- ✅ Multi-turn conversations: scripted turns from a list column; transcript in the result, turn count and per-turn latency metrics
- 🧪 Simulated users: a model plays a persona with a goal, decides when it is done and whether the goal was met
- ✅ Comparisons: 2–8 variants (targets, or one target with another model, temperature, variables or config) on one dataset version; leaderboard, per-check table, side-by-side outputs, McNemar test against the best
- ✅ Run overrides: change model, variables or any config field for one run without editing the target
- ✅ Pass rate with 95% interval, corpus WER, latency percentiles, per-check stats
- ✅ Results grid (100k rows), result detail with WER diff, judge reasoning, request/response, WebSocket timeline
- ✅ Score outputs produced elsewhere (imported runs)
- ✅ Compare runs: improved/regressed rows, per-check deltas, McNemar significance
- ✅ Breakdown by tag / column / status with "weakest" group
- ✅ Failure themes: instant quick groups by failing check and reason pattern (free)
- 🧪 AI failure themes: named themes with likely cause, suggested fix and severity (model + local embeddings)
- ✅ Trends of pass rate per suite on Overview

## Calibration
- ✅ Label results pass/fail per check or row (keyboard P/F/S/U, blind mode)
- ✅ Agreement, Cohen's kappa, TPR/TNR, confusion matrix, corrected pass rate with CI, disagreements list, suite-wide scope

## Connections
- ✅ OpenAI, Anthropic, Gemini API, Vertex AI (ADC, service account, express), Azure (key or `az login`), Bedrock (profile/SSO, keys, API key), OpenAI-compatible (Ollama, vLLM, OpenRouter, xAI, Groq, LiteLLM…)
- ✅ Text, image, speech, transcription and embedding models per connection, each with a Test
- ✅ Local embedding model (all-MiniLM-L6-v2): one-time ~110 MB download into `~/Kalibra/models`, then free and offline
- ✅ Secret store (OS keychain in the desktop app), `{{secret.name}}` references

## Projects, users and team servers
- ✅ Projects on the desktop and on servers, each with its own datasets, targets, suites, runs, connections and secrets
- ✅ Team server mode: sign-in, users, groups, project members with viewer / editor / owner roles, administrators
- ✅ Passwords (scrypt, strength rules, lockout, forced change), one-time setup link, recovery CLI, audit log
- ✅ Sign-in with any OIDC provider, GitHub or GitHub Enterprise, or a login gateway; invite-only or automatic accounts; domain, group, org rules; admin and mirrored groups
- ✅ Access tokens for agents and scripts; account management needs a signed-in person
- ✅ Server policies: who may add code, folder sync off or confined, no server paths shown
- 🧪 Desktop app connects to team servers (Servers menu)

## Sharing (no server)
- ✅ `.kalibra` bundles: datasets with audio/images, targets, suites, connections, optional runs; secret names only, never values; on conflict keep both, skip or update mine
- ✅ Folder sync for Git: byte-stable text files, "Check for changes" preview, apply as new versions, optional prune
- 🧪 Importers: promptfoo config, OpenAI Evals JSONL (+ graders), LangSmith and Langfuse dataset exports, with a report of what could not be mapped

## Agents (MCP)
- ✅ ~100 tools generated from the operation registry (every feature above), prompts, destructive hints, agent provenance
- ✅ Setup snippets for Claude Code, Codex, Cursor, Gemini CLI, VS Code; agent activity feed

## CLI, CI and install
- ✅ `npx kalibra` (start + open browser), `serve`, `run --min-pass` (CI exit codes), `ops`, `op`, `mcp`
- ✅ Desktop app (Electron), unpackaged; installers on the roadmap
- ✅ Local HTTP API with token and host/origin checks; live events

## UX
- ✅ Light / dark / system theme, accent colour picker, reading fonts (Atkinson Hyperlegible Next default), text size
- ✅ Collapsible sidebar grouped by use (build and measure · tools · docs and settings), help tooltips on every non-obvious control
- ✅ Progressive disclosure: dataset **Add rows** and **Generate** menus, "Most used" checks first, run page tabs (Results, Checks, Failure themes, Breakdown, Metrics)
- ✅ Focus rings for keyboard users only
- ✅ In-app docs: 35 short illustrated guides with search and progress
