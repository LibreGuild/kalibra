# Feature × competitor matrix

Date: 2026-10-17. Sources: [research report](research/market-and-product-analysis.md) plus public product docs. `?` = not verified.

**How to use this file:** each row is a capability. "Who has it" lists products that support it. If many products have it and Kalibra doesn't, it is table stakes and should move up the [roadmap](roadmap.md). If few or none have it and Kalibra does, it is a differentiator worth showing off.

Kalibra: `✅` shipped · `🧪` beta · `🛠` roadmap · `—` not planned. Priority hint: **High** = 4+ competitors have it and Kalibra doesn't.

Tags: `promptfoo` `DeepEval` (incl. Confident AI) `Langfuse` `Phoenix` (Arize Phoenix/AX) `Opik` `Braintrust` `LangSmith` `Kiln` `Inspect` `Weave` `Galileo` `Maxim` `Vertex` (Google Gen AI Eval) `Bedrock` (AWS Evals) `Foundry` (Azure AI Foundry) `Coval/Hamming` (voice)

## Data

| Feature | Kalibra | Who has it | Priority hint |
|---|---|---|---|
| Versioned datasets | ✅ | `Langfuse` `Phoenix` `Opik` `Braintrust` `LangSmith` `DeepEval` `Weave` `Kiln` | — |
| CSV / JSONL import | ✅ | `promptfoo` `Langfuse` `Phoenix` `Opik` `Braintrust` `LangSmith` `Kiln` `Vertex` `Bedrock` `Foundry` | — |
| Synthetic text generation | ✅ | `DeepEval` `Kiln` `promptfoo` `Braintrust` `Maxim` `Opik`? | — |
| Image dataset generation | ✅ | — | Differentiator |
| TTS audio generation for STT tests | ✅ | `Coval/Hamming` (synthetic callers) `Maxim`? | Differentiator |
| Audio augmentation (noise, phone line…) | ✅ | `Coval/Hamming`? | Differentiator |
| Human review of generated rows | ✅ | `Kiln` `Langfuse` `LangSmith` `Braintrust` | — |
| Safety / red-team datasets (static) | 🧪 | `promptfoo` `DeepEval` `Foundry` `Galileo`? | — |
| Dynamic multi-turn red teaming | 🛠 | `promptfoo` `DeepEval` `Foundry` | Medium |
| Dataset quality: coverage, variety, dedup (exact/near/meaning) | ✅ | `Kiln`? | Differentiator |

## Connecting to the app

| Feature | Kalibra | Who has it | Priority hint |
|---|---|---|---|
| Call any HTTP endpoint | ✅ | `promptfoo` `Braintrust` `Phoenix` (AX agent endpoints) `Maxim` | — |
| GUI request builder + cURL import | ✅ | `Braintrust`? `Maxim`? | Differentiator |
| WebSocket streaming audio target | ✅ | `Coval/Hamming` (phone) `promptfoo` (realtime providers) | Differentiator |
| Custom code target | ✅ | `promptfoo` `DeepEval` `Inspect` `Phoenix` `Opik` `Braintrust` `LangSmith` `Weave` | — |
| Score outputs produced elsewhere | ✅ | `DeepEval` `Langfuse` `Braintrust` `LangSmith` `Vertex` `Bedrock` `Foundry` `promptfoo` (workaround) | — |
| SDK / OpenTelemetry tracing & online evals | 🛠 | `Langfuse` `Phoenix` `Opik` `Braintrust` `LangSmith` `Weave` `Galileo` `Foundry` | **High** |
| Multi-turn conversations (scripted + simulated users) | ✅ | `Maxim` `DeepEval` `Kiln` `Coval/Hamming` `LangSmith`? | — |
| Voice-agent phone simulation | 🛠 | `Coval/Hamming` `Maxim` | Medium |
| Prompt playground | ✅ | `Braintrust` `LangSmith` `Langfuse` `Phoenix` `Opik` `Vertex` `Foundry` | — |

## Scoring

| Feature | Kalibra | Who has it | Priority hint |
|---|---|---|---|
| Deterministic checks (equals, contains, regex, JSON schema) | ✅ | `promptfoo` `DeepEval` `Braintrust` `LangSmith` `Weave` `Foundry` `Opik` | — |
| Layered gates (skip expensive checks) | ✅ | `promptfoo` (assert-set, partial) | Differentiator |
| BLEU / ROUGE | ✅ | `promptfoo` `Foundry` `Vertex` `Braintrust`? `DeepEval`? | — |
| WER / CER with normalizers | ✅ | `Coval/Hamming`? | Differentiator |
| LLM-as-judge | ✅ | all | — |
| Multimodal judge (images/audio) | ✅ | `Braintrust` `LangSmith` `Opik` `DeepEval` | — |
| Refusal / over-refusal check | 🧪 | `promptfoo` `DeepEval` `Foundry` | — |
| PII leak check | 🧪 | `promptfoo` `Weave` `Galileo` `Foundry` | — |
| Embedding similarity (local offline model or provider) | ✅ | `promptfoo` `DeepEval` `Braintrust` `Weave` `Foundry` | — |
| BERTScore | 🛠 | `DeepEval`? `Foundry`? | Low |
| RAG metrics (faithfulness, context recall…) | 🛠 | `DeepEval` `Phoenix` `Braintrust` `Vertex` `Bedrock` `Foundry` `Opik` | **High** |
| Agent / tool-call metrics | 🛠 | `promptfoo` `DeepEval` `Phoenix` `Vertex` `Bedrock` `Foundry` | **High** |
| Custom Python scorers | 🛠 | `DeepEval` `Inspect` `Phoenix` `Opik` `Braintrust` `LangSmith` `Weave` | **High** |
| Diarization metrics | 🛠 | — | Low |
| Image generation metrics (CLIPScore…) | 🛠 | `DeepEval` | Low |

## Analysis

| Feature | Kalibra | Who has it | Priority hint |
|---|---|---|---|
| Run comparison with regressions | ✅ | `Braintrust` `LangSmith` `Langfuse` `Phoenix` `Opik` `promptfoo` `Weave` | — |
| Compare several targets/models in one go (leaderboard) | ✅ | `promptfoo` `Braintrust` `LangSmith` `Vertex`? | — |
| Confidence intervals | ✅ | `Inspect`? `Braintrust`? | Differentiator |
| Significance test between runs (and against the best variant) | ✅ | — | Differentiator |
| Breakdown by tag / column | ✅ | `Braintrust` `LangSmith` `Phoenix`? | — |
| Trends over runs | ✅ | `Langfuse` `Braintrust` `LangSmith` `Weave` | — |
| Judge-vs-human calibration | ✅ | `LangSmith` `Kiln` `Galileo` | — |
| Team annotation queues | 🛠 | `Langfuse` `LangSmith` `Braintrust` `Phoenix` `Opik` | **High** |
| Failure clustering | ✅ | `LangSmith` `Braintrust` `Foundry` | — |
| Load / latency testing | 🛠 | — | Low |

## Workflow & platform

| Feature | Kalibra | Who has it | Priority hint |
|---|---|---|---|
| MCP server for coding agents | ✅ | `Braintrust` `Langfuse` `Phoenix` `Opik` `promptfoo` | — |
| Agent can fill & grade datasets in place | ✅ | — | Differentiator |
| CLI with CI exit codes | ✅ | `promptfoo` `DeepEval` `Braintrust` `LangSmith` `Inspect` | — |
| GitHub Action / PR comments | 🛠 | `Braintrust` `promptfoo` `LangSmith`? | Medium |
| Local-first, no server | ✅ | `promptfoo` `Kiln` `Inspect` `DeepEval` (library) | — |
| Desktop app | ❌ (npm and Docker only, by choice) | `Kiln` | — |
| Multi-provider auth (Bedrock, Vertex, Azure Entra) | ✅ | `promptfoo` `Kiln`? `DeepEval`? | — |
| Self-hosted team server (SSO, roles) | 🛠 | `Langfuse` `Phoenix` `Opik` `Braintrust` (enterprise) `LangSmith` (enterprise) | **High** |
| Importers from other tools (promptfoo, OpenAI Evals, LangSmith, Langfuse) | ✅ | `Weave` (Humanloop migration) `promptfoo` (OpenAI Evals) | Differentiator |
| Team sharing without a server (bundles, Git folder) | ✅ | `promptfoo` (config in Git) `Kiln`? `Inspect`? | — |
| OSI open-source license | ✅ (MIT) | `promptfoo` `DeepEval` `Langfuse` `Opik` `Inspect` | — |
