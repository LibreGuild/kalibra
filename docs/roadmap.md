# Roadmap

Prioritized by user value and by how many competitors already have it (see [competitors.md](competitors.md)). One line each.

## Shipped (October 2026)
- ✅ **Projects, users and permissions**: projects everywhere (one database each), viewer/editor/owner roles, groups, team server mode with sign-in, access tokens for agents, audit log, recovery CLI.
- ✅ **Sign-in providers**: any OIDC provider (Google, Microsoft, Okta, Keycloak, company SSO), GitHub and GitHub Enterprise, login gateways (IAP, Cloudflare Access, oauth2-proxy); invite-only or automatic accounts, domain/group rules, admin and mirrored groups.
- ✅ **Multi-turn conversations & simulated users**: scripted turns or a model playing a persona with a goal; goal / mentions / turn-count checks.
- ✅ **Comparisons**: 2–8 targets or model variants on one dataset version, leaderboard with significance against the best.
- ✅ **Embedding similarity**: free local model (offline) or any connection's embedding model.
- ✅ **Prompt playground**: a prompt across up to 4 models side by side, save as a target, run on the whole dataset.
- ✅ **Importers**: promptfoo, OpenAI Evals JSONL + graders, LangSmith and Langfuse dataset exports.
- ✅ **Git folder sync + `.kalibra` bundles**: share definitions and datasets without a server.
- ✅ **Failure clustering**: instant quick groups plus AI themes with cause and fix.
- ✅ **Dataset quality & dedup**: coverage, variety, exact/near/meaning duplicates, fill gaps.
- ✅ **Run setup warnings**: missing columns and variables caught before a run starts.

## Now
- **RAG metrics** (faithfulness, context precision/recall, answer relevancy): table stakes for RAG apps; most competitors ship them.
- **Agent / tool-call metrics** (tool correctness, trajectory match, task completion): agents are where teams struggle most.
- **BERTScore** (token-level embedding match, on the local embedding runtime): finer than whole-text similarity.
- **Braintrust importer**: one more migration path (OpenAI Evals users are already covered before its 2026-11-30 shutdown).
- **GitHub Action + PR comment**: makes CI usage one line.

## Next
- **Annotation queues for teams**: assign rows, multiple annotators, agreement between people.
- **Dynamic red-team attacks** (multi-turn crescendo, GOAT-style attacker models, built on the simulated user): static prompts miss adaptive jailbreaks.
- **Python plugin runtime**: custom Python checks and heavy ML metrics without bloating the app.
- **OpenTelemetry trace ingestion & online evals**: score real production traffic with the same suites.

## Later
- **Server scale-out**: Postgres and object storage (S3/GCS) behind the existing storage interfaces, shared session store for several server instances, LDAP and SAML (today via Keycloak/Dex), per-secret allowed hosts.
- **Voice-agent simulation** (phone / WebRTC callers, barge-in and turn-taking metrics).
- **Diarization metrics** (DER, JER, cpWER) for multi-speaker STT.
- **Image metrics plugin** (CLIPScore, ImageReward, VQAScore) for image generation apps.
- **Load-testing mode**: concurrency sweeps, goodput against latency SLOs.
- **PII scrubbing** when seeding datasets from production logs.
- **i18n** of the UI.
