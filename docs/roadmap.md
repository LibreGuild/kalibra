# Roadmap

Prioritized by user value and by how many competitors already have it (see [competitors.md](competitors.md)). One line each.

## Now
- **RAG metrics** (faithfulness, context precision/recall, answer relevancy): table stakes for RAG apps; most competitors ship them.
- **Agent / tool-call metrics** (tool correctness, trajectory match, task completion): agents are where teams struggle most.
- **Embedding similarity & BERTScore** (provider embeddings first, local ONNX plugin later): meaning-level comparison without a judge.
- **Multi-turn conversations & simulated users**: chatbots fail on turn 4, not turn 1.
- **Prompt playground**: try a prompt across models side by side before wiring a target.
- **Importers** (OpenAI Evals JSONL/graders, promptfoo YAML, Langfuse/LangSmith/Braintrust exports): OpenAI Evals shuts down 2026-11-30; easy migration wins users.
- **GitHub Action + PR comment**: makes CI usage one line.

## Next
- **Installers + auto-update** (electron-builder, unsigned first): for people without Node.
- **Git folder mirror + `.kalibra` bundles**: share definitions through Git, datasets and runs as files.
- **Annotation queues for teams**: assign rows, multiple annotators, agreement between people.
- **Dynamic red-team attacks** (multi-turn crescendo, GOAT-style attacker models): static prompts miss adaptive jailbreaks.
- **Python plugin runtime**: custom Python checks and heavy ML metrics without bloating the app.
- **Failure clustering**: group failing rows into themes automatically.
- **Dataset diversity dashboard & dedup**: coverage heatmaps, near-duplicate removal for generated data.
- **OpenTelemetry trace ingestion & online evals**: score real production traffic with the same suites.

## Later
- **Self-hosted server mode**: users, SSO, roles, Postgres, object storage; same engine (seams already in place).
- **Voice-agent simulation** (phone / WebRTC callers, barge-in and turn-taking metrics).
- **Diarization metrics** (DER, JER, cpWER) for multi-speaker STT.
- **Image metrics plugin** (CLIPScore, ImageReward, VQAScore) for image generation apps.
- **Load-testing mode**: concurrency sweeps, goodput against latency SLOs.
- **PII scrubbing** when seeding datasets from production logs.
- **i18n** of the UI.
