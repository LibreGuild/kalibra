# Kalibra: Market Research and Product Analysis

*A local-first, open-source platform for evaluating AI applications.*

*Research date: 16 October 2026. This report combines five parallel research passes that used live web sources: open-source tools, commercial and cloud platforms, data generation and safety, multimodal metrics, and connections/auth/MCP. A claim marked **(unverified)** could not be confirmed against a primary source. Prices, versions and acquisition details change quickly, so re-check them before quoting.*

---

## 1. Summary

- **The market is crowded, but it is consolidating fast, and almost every serious product is one of three things:** cloud SaaS, a heavy self-hosted server, or a code-only library.
  - Events in the last 14 months:
    - Humanloop shut down (Sep 2025).
    - OpenAI bought promptfoo (Mar 2026). It is also shutting down its own hosted Evals dashboard and API: evals go read-only on 31 Oct 2026 and are gone on 30 Nov 2026.
    - ClickHouse bought Langfuse, and Cisco bought Galileo.
    - Dynatrace is buying Arize.
    - Vellum left the market.
  - Teams that built on hosted tools keep losing them.
- **Kiln AI is the closest existing product to the idea.** It is a local-first desktop app with synthetic data generation and judge calibration. But:
  - its desktop app is source-available, not OSI open source;
  - it has no generic HTTP connector for testing an existing app;
  - it has no audio/STT metrics;
  - it has no first-class way to score outputs produced outside the tool.
- **promptfoo has the best engine for connecting to any HTTP app.** But it is configured in YAML from a CLI, it is now owned by a model vendor, and it has no WER/CER metrics.
- **No product does any of these seven things well, and they match your requirements:**
  1. a GUI for testing a black-box HTTP app;
  2. audio/STT evaluation;
  3. scoring outputs produced outside the tool;
  4. a zero-server installer under an OSI license;
  5. an MCP server that coding agents use to *fill and grade* datasets;
  6. judge calibration against human labels;
  7. a layered check pipeline that knows the cost of each check.
- **The MCP idea is the right design, and the research settles one detail: the agent pulls work through tools.**
  - MCP "sampling", where the server asks the client's model to generate, is deprecated in the current MCP spec (2026-07-28). Claude Code never supported it.
  - Anthropic's terms forbid third-party apps from sending requests through a user's Claude subscription credentials.
  - A user who drives their own Claude Code against our MCP server is fine.
- **Direction (decided 16 Oct 2026: Electron, TypeScript, MIT, STT in the first release, name Kalibra):**
  - **One engine.** A local-first desktop app built on one TypeScript engine. The engine runs as a local HTTP service, and the desktop UI, the CLI and the MCP server are all clients of it.
  - **Full agent parity.** Every feature is one engine operation, so a coding agent driven by the user can do through MCP anything the UI can do.
  - **Swappable storage.** SQLite plus a content-addressed file store, behind interfaces that a later self-hosted server mode can swap for Postgres and cloud object storage.
  - **Heavy ML metrics** live in an optional Python plugin.
  - Details are in sections 10–13.

---

## 2. Market landscape (late 2026)

### 2.1 Recent changes that matter

| Event | Date | Source |
|---|---|---|
| Humanloop sunset; the team joined Anthropic (acqui-hire details unverified) | Sep 2025 | [W&B notice](https://wandb.ai/wandb_fc/product-announcements-fc/reports/Humanloop-is-sunsetting-Migrate-to-Weights-Biases-as-an-alternative--VmlldzoxMzk4ODc1Nw) |
| ClickHouse acquires Langfuse (stays MIT and self-hostable) | Jan 2026 | [Langfuse blog](https://langfuse.com/blog/joining-clickhouse) |
| OpenAI acquires promptfoo (stays MIT) | Mar 2026 | [OpenAI](https://openai.com/blog/openai-to-acquire-promptfoo), [GitHub](https://github.com/promptfoo/promptfoo) |
| Cisco acquires Galileo (now Splunk Agent Observability) | Apr 2026 | [NetworkWorld](https://www.networkworld.com/article/4156855/cisco-to-acquire-galileo-for-ai-observability.html) |
| OpenAI Evals dashboard and API deprecated: read-only 31 Oct, shut down 30 Nov 2026. OpenAI's migration guide points to promptfoo. | announced Jun 2026 | [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations) |
| Dynatrace to acquire Arize for $915M (closing unverified) | Aug 2026 | [Pulse2](https://pulse2.com/dynatrace-to-acquire-arize-for-915-million-to-expand-ai-observability-platform/) |
| MCP spec 2026-07-28: stateless protocol; sampling, roots and logging deprecated | Jul 2026 | [MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) |
| Gretel absorbed by NVIDIA; NeMo Data Designer (Apache-2.0) is the active OSS successor in that space | Mar 2025 | [TechCrunch](https://techcrunch.com/2025/03/19/nvidia-reportedly-acquires-synthetic-data-startup-gretel), [DataDesigner](https://github.com/NVIDIA-NeMo/DataDesigner) |

What this means for us:
- Being vendor-neutral, OSI-licensed and local-first is now a selling point, not a niche.
- An importer for OpenAI Evals and promptfoo formats is a timely way to win users.

### 2.2 The players by category

| Category | Products |
|---|---|
| OSS frameworks and libraries (code-first) | promptfoo (MIT, TS), DeepEval (Apache-2.0, Python), Ragas, Inspect AI (UK AISI), Giskard v3, Evidently, MLflow 3 GenAI, TruLens, EleutherAI lm-evaluation-harness, OpenAI `evals` repo (legacy) |
| OSS observability + eval servers | Langfuse (MIT core), Arize Phoenix (Elastic License 2.0, *not* OSI), Comet Opik (Apache-2.0), Agenta, LangWatch (Apache-2.0 core), Latitude |
| Desktop / local GUI | **Kiln** (desktop app is source-available; library is MIT), ChainForge (no 2025–26 activity found), Evalite (TS, local UI) |
| Commercial SaaS | Braintrust, LangSmith, W&B Weave, Galileo/Splunk, Patronus, Maxim, HoneyHive, Arize AX, Confident AI, Scorecard, Okareo, Openlayer, Future AGI, Freeplay, Judgment Labs |
| Cloud-native | OpenAI Evals (shutting down), Anthropic Console "Evaluate", Google Gen AI Evaluation Service, AWS Bedrock Evaluations and AgentCore Evaluations, Microsoft Foundry evaluations plus the AI Red Teaming Agent |
| Voice-agent testing | Coval, Hamming, Cekura, Roark, Maxim voice, Vapi/Retell built-in tests, LangWatch Scenario (voice-to-voice) |
| Red teaming | promptfoo red team, NVIDIA garak, Microsoft PyRIT, DeepTeam, Giskard scan |
| Synthetic data | NVIDIA NeMo Data Designer, DeepEval Synthesizer, Ragas testset generation, distilabel, Kiln |

### 2.3 Capability matrix against our core requirements

"Partial" means the product has a workaround, or the feature exists only in a paid tier.

| Product | GUI to test an HTTP app | Score outputs made elsewhere | STT / WER metrics | Synthetic data GUI | Judge calibration | Install without a server | OSI open source |
|---|---|---|---|---|---|---|---|
| promptfoo | No (YAML) | Partial (`echo` provider) | No | Partial (CLI) | No | Yes (npx) | Yes |
| Kiln | No (agents must be wrapped as MCP servers) | Partial | No | Yes | Yes | Yes | Partial (the app is not) |
| DeepEval / Confident | No | Yes | No | Code only, or SaaS | No | Yes (library) | Library yes, SaaS no |
| Langfuse | No (SDK tracing) | Yes | No | No | No | No (needs 6 services) | Yes (core) |
| Arize Phoenix | No | Partial (AX only) | No | No | No | Partial | No (ELv2) |
| Braintrust | Partial (remote eval endpoint) | Yes | No | Partial (Loop agent) | Not found | No | No |
| LangSmith | No | Yes | No (audio judges via Gemini only) | Partial | Yes (Align Evals) | No | No |
| Inspect AI | No | Partial (custom solver) | No | No | No | Yes (CLI) | Yes |
| **Target for our app** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** |

---

## 3. Closest competitors in detail

### 3.1 Kiln AI: the closest analog
- **What it is:**
  - A desktop app for macOS, Windows and Linux, plus an MIT Python library and REST server. About 5.2k stars; v1.2.0 shipped Sep 2026 ([GitHub](https://github.com/Kiln-AI/Kiln)).
  - Projects are stored as local JSON files, and teams share them through automatic Git sync.
  - Bring your own keys, or run offline with Ollama.
- **Worth copying:**
  - **The "task" as the root object.** A task has instructions and optional JSON input/output schemas. Data, prompts, evals and fine-tunes all hang off it.
  - **Synthetic data UI:**
    - Topic trees, generated automatically or edited by hand.
    - Human guidance at any step.
    - Templates (Jailbreak, Bias).
    - A batch planning mode for edge cases.
    - Background jobs that keep running after the UI closes ([docs](https://docs.kiln.tech/docs/synthetic-data-generation)).
  - **Ratings.** Each item gets an overall rating plus per-requirement ratings: 5-star, pass/fail, or pass/fail/critical.
  - **Eval-of-evals.** Each candidate judge runs on a human-rated golden set and is ranked by Kendall's tau or Spearman. The UI says N/A below about 10 items ([docs](https://docs.kiln.tech/docs/evaluations)).
  - **Eval Builder V2.** You describe the eval in plain language. Kiln asks clarifying questions, proposes a dataset plan, generates the data, writes a judge, and refines the judge from your agree/disagree votes.
  - **Compare view.** Ranks "run methods" (model + prompt + parameters) by score and cost.
- **Gaps we can exploit:**
  - No generic HTTP target; an external agent must be wrapped as an MCP server.
  - No WER/BLEU/ROUGE.
  - Task inputs and outputs are text/JSON only; image and audio inputs are undocumented.
  - Scoring precomputed outputs is not a first-class flow.
  - Key features sit behind a Pro account, and the app license is not OSI.
  - Kiln is built around testing a prompt plus a model, not a black-box app.

### 3.2 promptfoo: the best "connect to any app" engine
- **What it is:** a CLI plus a local web viewer, in TypeScript. MIT, about 26k stars, now owned by OpenAI, and still releasing often.
- **Worth copying:**
  - **The HTTP provider** ([docs](https://www.promptfoo.dev/docs/providers/http/)):
    - Templated URL, headers and body using `{{vars}}`.
    - Paste a raw HTTP request instead of filling fields.
    - `transformRequest` and `transformResponse` hooks.
    - `sessionParser` for multi-turn sessions.
    - Multipart file uploads.
    - Auth: bearer, API key, basic, OAuth2 (client credentials or password, refreshed automatically), signature auth, mTLS.
    - SSE streaming, `validateStatus`, and retries on 429 and 5xx.
  - **About 60 assertion types** ([docs](https://www.promptfoo.dev/docs/configuration/expected-outputs/)):
    - Deterministic: equals, contains, regex.
    - Structure: `is-json`, `contains-json`.
    - Reference metrics: BLEU, ROUGE, METEOR, Levenshtein.
    - Model-graded: `llm-rubric`, `g-eval`, `factuality`, `context-faithfulness`, `is-refusal`.
    - Agent: tool-call F1 and trajectory checks.
  - **Composable scoring:**
    - Any assertion can be negated with a `not-` prefix.
    - Each assertion can carry `weight`, `threshold` and a named `metric`.
    - `assert-set` groups assertions; `derivedMetrics` computes composites.
  - **Red teaming:**
    - 157 plugins that map to OWASP, NIST, MITRE ATLAS and the EU AI Act.
    - Strategies: encodings, iterative jailbreaks, and multi-turn attacks (Crescendo, GOAT).
  - **Ops:** response caching, CI exit codes, and an MCP server.
- **Gaps:**
  - YAML gets awkward at scale, and the UI is only for viewing results, not authoring.
  - No STT metrics. Audio appears only in realtime voice providers.
  - Scoring imported outputs needs the `echo` workaround.
  - Neutrality concerns now that a model vendor owns it; the red-team grader defaults to OpenAI models.
  - Its harmful-content red-team plugins depend on promptfoo's remote generation service.

### 3.3 Braintrust: the best results UI
- **Pricing:** free tier with 14-day retention; Pro $249/month; self-hosting is Enterprise only ([pricing](https://www.braintrust.dev/pricing)).
- **Worth copying:**
  - **Experiment comparison** ([docs](https://www.braintrust.dev/docs/evaluate/compare-experiments)):
    - Diff modes: base→comparison, comparison→base, and expected→output.
    - Rows that improved are green and rows that regressed are red, with a "sort by regressions" option.
    - The baseline is chosen automatically as the latest run on the same git branch.
    - A configurable comparison key matches rows across runs.
    - Each run gets a grade: Improvement, Regression, Tradeoff or Tie.
    - Repeated trials are grouped so nondeterminism is visible.
  - **"Remote evals."** The hosted UI drives the user's locally running eval endpoint ([docs](https://braintrust.dev/docs/guides/remote-evals)). This is the closest commercial equivalent to our HTTP target.
  - **The MCP server** ([reference](https://www.braintrust.dev/docs/reference/mcp)) includes dry-run tools like `test_evaluator` and a skill loader.
  - **The `autoevals` scorer library** is MIT-licensed and worth reading ([GitHub](https://github.com/braintrustdata/autoevals)).
- **Gaps:** cloud-first and proprietary, and the jump from $0 to $249 is a common complaint.

### 3.4 LangSmith
- **Worth copying:**
  - **Pairwise annotation queues.** Two experiments are auto-paired and the reviewer picks A, B or Equal for each rubric item.
  - **Align Evals.** Judge grades are shown next to human labels, sorted by disagreement, with an alignment score ([blog](https://blog.langchain.com/introducing-align-evals)).
  - **Insights Agent** clusters failure modes.
  - **Multi-turn thread evals.**
  - **CI thresholds** that fail the build.
- **Gaps:** steep learning curve (the top complaint on G2 and Gartner), seat pricing, and self-hosting only on Enterprise.

### 3.5 DeepEval / Confident AI
- **Worth copying:**
  - **50+ metrics:** G-Eval, DAG decision-tree judges, RAG, agentic (task completion, tool correctness, plan adherence) and conversational metrics.
  - **The Synthesizer** ([docs](https://deepeval.com/docs/synthesizer-introduction)), which combines three configs:
    - `EvolutionConfig`: 7 weighted evolution types (reasoning, multi-context, concretizing, constrained, comparative, hypothetical, in-breadth).
    - `FiltrationConfig`: a critic model with a quality threshold.
    - `StylingConfig`: input and output format, task and scenario.
  - **Native scoring of precomputed outputs** with `LLMTestCase(actual_output=...)`.
- **Gaps:**
  - No UI without the SaaS, which is expensive: the free tier allows 5 test runs a week, and the Team plan is $2,000/month.
  - Telemetry is on by default.
  - Breaking metric-polarity change in 4.2.

### 3.6 Langfuse, Phoenix and Opik (observability-first)
- **All three:**
  - Version their datasets.
  - Run experiments.
  - Expose MCP servers.
  - Use annotation queues (Langfuse adds keyboard shortcuts).
- **The model they share:** instrument your app with an SDK or OpenTelemetry, then evaluate the traces.
- **Self-hosting is heavy:** Langfuse v3 needs web, worker, Postgres, ClickHouse, Redis and S3, and Opik needs Docker.
- **Phoenix's ELv2 license** prohibits offering it as a hosted service.
- **What we take from them:**
  - Pinned dataset versions in experiments.
  - Annotation queue ergonomics.
  - Later, OpenTelemetry trace ingestion as an optional input.

### 3.7 Inspect AI (UK AISI)
- **Worth copying:**
  - The Dataset → Solver → Scorer pipeline.
  - The best multimodal dataset support found anywhere: image, audio, video and PDF referenced from JSONL with relative paths ([docs](https://inspect.aisi.org.uk/multimodal.html)).
  - Sandboxes.
  - Running external agents such as Claude Code or Codex as solvers.
- **Gaps:** code-only, aimed at researchers, and no HTTP app target.

### 3.8 Cloud-native services
- **OpenAI Evals graders** ([spec](https://developers.openai.com/api/docs/guides/graders)) are the cleanest grader taxonomy to copy:
  - `string_check`: eq, ne, like, ilike.
  - `text_similarity`: fuzzy, BLEU, GLEU, METEOR, cosine, ROUGE-1..5 and ROUGE-L, each with a pass threshold.
  - `score_model` and `label_model`.
  - A sandboxed `python` grader.
  - `multi`, which combines graders with a formula.
  - The product is shutting down. Users will need somewhere to go.
- **Google Gen AI Evaluation Service:** **adaptive rubrics** generate pass/fail tests for each prompt and return a verdict and rationale per test. It accepts precomputed responses in a `response` column ([docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/rubric-metric-details)).
- **AWS Bedrock Evaluations:**
  - "Bring your own inference" responses.
  - A score histogram in the console.
  - Judge models from several vendors.
  - AgentCore Evaluations has been GA since Mar 2026 ([docs](https://docs.aws.amazon.com/bedrock/latest/userguide/evaluation-judge.html)).
- **Microsoft Foundry:**
  - Built-in quality, RAG, textual (BLEU, ROUGE, METEOR, F1) and safety evaluators.
  - An AI Red Teaming Agent built on PyRIT.
  - Failure cluster analysis.
  - Evaluation requires Entra ID ([docs](https://learn.microsoft.com/en-us/azure/foundry/concepts/built-in-evaluators)).
- **Anthropic Console "Evaluate":**
  - Prompt `{{variables}}`, Claude-generated test cases, CSV import, and side-by-side 5-point manual grading.
  - Claude-only and prompt-level only.
- **The common limitation:** each cloud tool is tied to its own ecosystem. None gives a neutral, cross-provider evaluation of *your own app*.

### 3.9 Why teams want a local-first OSS alternative (evidence)
1. **Vendors keep disappearing** (see 2.1). Local files outlive the vendor.
2. **Self-hosting is Enterprise-only** at Braintrust, LangSmith, HoneyHive, Confident, Okareo, Openlayer and Coval. The OSS self-hosted stacks are heavy to operate.
3. **Free tiers are short and capped:**
   - Retention is 3 days at Maxim, 7–15 at Arize, and 14 at Braintrust and LangSmith.
   - Confident allows 5 runs a week, and LangSmith 1 seat.
4. **Metered pricing is unpredictable:** different units (per score, per trace, per GB, Weave's $0.10/MB), big jumps between tiers, and judge tokens billed on top.
5. **Data residency.** Internal customer data often cannot leave the machine. A local judge through Ollama removes the last cloud dependency.

---

## 4. Table stakes (present in 3 or more products)

1. Versioned datasets with CSV/JSONL import and "add row from a result".
2. Experiments made of dataset × target × scorers, with side-by-side run comparison, a baseline, and highlighted regressions.
3. A scorer library:
   - exact / contains / regex;
   - JSON validity and JSON diff;
   - BLEU / ROUGE / METEOR / F1 / fuzzy match;
   - embedding similarity;
   - LLM judge with a custom rubric and explanation;
   - sandboxed custom code;
   - pairwise comparison;
   - human scores.
4. Per-scorer pass thresholds that fail CI (CLI exit code, GitHub Action).
5. RAG metrics: faithfulness, context precision and recall, answer relevance.
6. Agent metrics: tool-call accuracy, trajectory, task completion, multi-turn.
7. A prompt playground with several models side by side.
8. Human review queues with rubrics.
9. Synthetic test-case generation.
10. Simulated multi-turn users with personas.
11. Score distributions shown with latency, tokens and cost.
12. Image, PDF and audio attachments in datasets.
13. Red teaming.
14. An MCP server.
15. A built-in AI assistant (Braintrust Loop, Arize Alyx, Patronus Percival).
16. Failure clustering.

Items 7, 15 and 16 can wait. The rest belong in the first two releases.

---

## 5. Best ideas to adopt, by area

| Area | Idea | From |
|---|---|---|
| Targets | Paste a raw HTTP request or cURL command; templated body; request and response transforms; session parser; multipart; OAuth2 and mTLS | promptfoo |
| Targets | The tool's UI drives the user's own running endpoint | Braintrust remote evals, Arize Agent Endpoints |
| Data gen | Column-based recipe: samplers (category, persona, difficulty), LLM columns, validators, seed datasets, `preview()` | NeMo Data Designer |
| Data gen | Weighted evolutions, critic filtering, styling config | DeepEval Synthesizer |
| Data gen | Knowledge-graph-based single-hop and multi-hop questions from documents | Ragas |
| Data gen | Human-edited topic trees and guidance prompts | Kiln |
| Data gen | Global diversity from the taxonomy, local diversity from meta-prompting and complexification | Google Simula ([blog](https://research.google/blog/designing-synthetic-datasets-for-the-real-world-mechanism-design-and-reasoning-from-first-principles)) |
| Checks | Grader taxonomy and formula-combined graders (`multi`) | OpenAI graders |
| Checks | Negation, weights, thresholds, named metrics, assertion sets | promptfoo |
| Checks | Adaptive rubrics generated for each prompt | Google Gen AI Evaluation |
| Results | Diff modes, colored regressions, git-branch baseline, comparison key, "Tradeoff" grade, grouped trials | Braintrust |
| Results | Score histogram | Bedrock |
| Review | Pairwise queues that auto-pair two experiments | LangSmith |
| Judges | Judge-vs-human alignment, sorted by disagreement | LangSmith Align Evals, Kiln, MLflow `align()` |
| Judges | Small, cheap judge models for scoring everything | Galileo Luna-2, Patronus Glider/Lynx; for us, local models via Ollama |
| Safety | Plugin × strategy matrix mapped to frameworks | promptfoo, DeepTeam |
| Safety | Probe / detector / buff architecture | garak |
| Safety | Converters for text, image and audio | PyRIT |
| Multimodal | Media referenced from JSONL by relative path | Inspect AI |
| MCP | Dry-run `test_*` tools, a skill loader, toolsets selectable through an env var | Braintrust, Opik |
| Storage | Open JSON/YAML project files synced through Git | Kiln |

---

## 6. Where we can win (differentiators)

1. **A GUI for testing a black-box app.**
   - Import cURL, HAR, Postman or OpenAPI, or build the request in a form.
   - Click a field in the JSON response to map it.
   - Preview against row N, then run a 3-row smoke test.
   - No YAML and no SDK instrumentation required.
2. **First-class audio and STT evaluation.** Nobody ships it today. It includes:
   - WER, CER, MER and WIL with a substitution/deletion/insertion breakdown and an alignment diff;
   - text normalizer profiles;
   - corpus WER with confidence intervals;
   - entity and keyword recall (names, numbers);
   - streaming latency (first partial, final, real-time factor);
   - audio playback in the results grid;
   - slices by accent, noise and codec.
3. **Scoring outputs produced elsewhere, as a first-class flow.** Export inputs with stable IDs, run them anywhere, import the outputs, and apply the same suite.
4. **The layered check pipeline.**
   - Cheap gates run first: transport, then schema, then field rules, then content, then reference metrics, then the judge.
   - A failed gate skips the expensive layers.
   - The cost of the judge is estimated before the run.
   - The research found no product that does this explicitly.
5. **Full control of the app from the user's coding agent.**
   - Claude Code, Codex, Cursor or Gemini CLI can do through MCP anything the UI can do: fill a dataset, set up a target, add checks, start runs, grade results.
   - Writes are schema-validated, and agent output lands in a human review queue.
   - Existing eval MCP servers mostly *query* traces. None lets an agent fill and grade datasets in place.
6. **A judge calibration studio.** It shows:
   - agreement, Cohen's κ, TPR/TNR and the confusion matrix for each criterion;
   - the pass rate corrected for judge error;
   - judge drift when the judge model changes.
7. **Statistics by default.**
   - Confidence intervals, and paired comparisons between runs (paired bootstrap, McNemar).
   - Repeated trials that flag flaky items.
   - pass@k and pass^k.
   - Most tools show bare averages.
8. **A safety pack with honest coverage.**
   - A taxonomy mapped to OWASP LLM 2025, OWASP Agentic 2026, NIST AI 600-1, MITRE ATLAS, AILuminate and the EU AI Act.
   - Importers for curated datasets that respect each dataset's license.
   - Paired over-refusal tests.
   - Generation that detects when the generator model refuses.
9. **A diversity dashboard for generated data.**
   - Coverage of each axis, compression ratio, Self-BLEU and embedding clusters.
   - Gap filling for under-covered areas.
10. **Migration importers:** OpenAI Evals JSONL and graders (users must leave by 30 Nov 2026), promptfoo YAML, and Braintrust/LangSmith/Langfuse dataset exports.
11. **Agent-assisted setup.**
    - The user's coding agent is already sitting in the app's repo.
    - Through MCP it can read their code, find the endpoint, and propose a target spec and a starter test suite.
    - The user approves the result in the app.
12. **Vendor-neutral by design.** OSI license, no account, no telemetry by default, and a local judge option.

---

## 7. Core concepts (domain model)

These are the nouns the whole app is built on. Getting them right makes the user flows simple.

| Concept | What it is | Key fields |
|---|---|---|
| **Workspace** | One team's or one project's evals: a folder on a desktop, a shared space on a server | Everything lives in the engine's database with version history. On desktop, definitions can also be mirrored to files for Git (11.7). |
| **Connection** | A model provider account used to *generate data* and to *judge* | Protocol (OpenAI-compatible / Anthropic / Gemini / Bedrock Converse / ...), auth source, base URL, headers, quirks |
| **Target** | The AI application under test | Kind (HTTP / model+prompt / command / imported), request template, auth reference, session strategy, output extractors, version |
| **Dataset** | Versioned, typed table of test cases | Columns (text, number, bool, JSON, messages, image, audio, file), rows, tags, splits, review status, lineage |
| **Recipe** | Repeatable generator that produces dataset rows | Axes and samplers, LLM columns, validators, filters, dedup settings, target count |
| **Suite** | The layered checks applied to every result | Ordered checks, each a gate or scored, with weight, threshold and metric name |
| **Judge** | A configured LLM-as-judge | Connection and model, rubric, output schema, repetitions, calibration record |
| **Run** | One execution of dataset × target × suite | Dataset version, target version, suite version, settings, status, summary |
| **Result** | One row's outcome in a run | Rendered request, raw response, extracted outputs, per-check scores, latency, tokens, cost, error |
| **Review item** | Something waiting for a human (or agent) decision | Generated row to approve, output to label, judge verdict to confirm |
| **Actor** | Who did something: the local user, an agent (via MCP) or the CLI | Recorded on every record, for provenance now and permissions in a later server mode |

Every result records the exact versions of the dataset, target, suite, judge prompt, normalizer and model it used. Old runs therefore stay explainable and comparable.

---

## 8. User flows

### 8.1 The whole journey

```
 1 CONNECT            2 PREPARE DATA               3 POINT AT YOUR APP          4 DEFINE CHECKS
 ─────────            ──────────────               ───────────────────          ───────────────
 Model providers      Generate (recipes)           HTTP target (curl import,    Layered suite:
 (OpenAI, Anthropic,  Import (CSV/JSONL/HF/...)    templates, auth, mapping)    gates → metrics → judge
 Gemini, Bedrock,     Coding agent via MCP         or: model + prompt
 Vertex, Azure,       Review & approve rows        or: offline (export/import)
 Ollama, ...)         → Dataset v1, v2, ...
        │                     │                           │                           │
        └─────────────────────┴─────────────┬─────────────┴───────────────────────────┘
                                            ▼
                                 5 RUN (live or imported outputs)
                                 concurrency, rate limits, retries, cache, resume
                                            │
                                            ▼
                     6 RESULTS → 7 REVIEW & CALIBRATE → 8 COMPARE / REGRESS → 9 CI
                     grid, slices,    human labels,        run vs baseline,      CLI exit codes,
                     CIs, media       judge alignment      regressions, trials   PR reports
```

### 8.2 How a dataset row reaches your API and how the output comes back

This is the core mechanism. Each **dataset column** is a variable. The **target** is a request template that refers to columns. The **response** is turned into **named output fields**. **Checks** compare output fields with columns.

```
DATASET ROW                 TARGET (request template)              RESPONSE                  NAMED OUTPUTS            CHECKS
{ id: "r42",                POST {{env.base_url}}/v1/transcribe    200 OK, 412 ms            transcript = $.text      L0 status == 200, latency < 1500ms
  audio: <blob 9f3a.wav>,   Authorization: Bearer {{secret.key}}   {"text": "turn left  ──►   words      = $.words  ──► L1 JSON Schema valid
  reference: "turn left     multipart:                              at the light",                                    L4 WER(transcript, {{reference}}) ≤ 0.15
     at the light",           file     = {{audio}}                  "words": [...]}                                      normalizer = whisper-en
  lang: "en",                 language = {{lang}}                                                                     L4 keyword recall({{keywords}}) = 1.0
  keywords: ["left"],                                                                                                 L5 judge: "meaning preserved?" (optional)
  tags: ["noisy","IN"] }
```

How the template and mapping work:
- **Templates.** `{{column}}` placeholders, with filters such as `{{messages | json}}` and `{{image | base64}}`.
  - A file column becomes a multipart part, a base64 string or a presigned upload, depending on the filter.
  - `{{env.*}}` holds per-environment values (dev, staging, prod), and `{{secret.*}}` references keychain entries.
  - Placeholders that no column fills are highlighted before the run.
- **Extractors:**
  - JSONPath (RFC 9535) by default, generated by clicking a node in the response tree.
  - jq and regex for power users.
  - A sandboxed JS transform for anything else.
  - Each extractor produces a **named output field**, e.g. `answer`, `sources[]`, `tool_calls`, `session_id`, `usage`.
- **Checks reference named fields, never raw paths.** If the API response shape changes, you fix one extractor and every check keeps working.
- **Measured automatically:** status, total latency, time to first byte, and time to first token for streaming responses.

### 8.3 First launch
1. Install from the signed installer (Mac, Windows or Linux). No account, no server, no Docker.
2. Create or open a workspace. Optionally turn on the folder mirror, which writes definitions as files the team can share through Git (11.7).
3. Choose a starter template ("Test an HTTP chatbot", "Test a speech-to-text service", "Safety check my assistant", "Score outputs I already have"). Each template creates the right columns, target skeleton and suite.

### 8.4 Connect model providers (for generation and judging)
1. **Connections → Add.** Pick a provider preset: OpenAI, Anthropic, Gemini, xAI, Mistral, Groq, DeepSeek, OpenRouter, Azure OpenAI/Foundry, Vertex AI, Bedrock, Ollama, LM Studio, vLLM, or a generic "OpenAI-compatible" endpoint or LiteLLM proxy.
2. **Pick how to authenticate.** For cloud accounts the app references the credential instead of copying it:
   - "use AWS profile `prod` (SSO)";
   - "use gcloud Application Default Credentials";
   - "use `az login`";
   - or a service-account file or service-principal secret.
3. **Test connection.** The app makes a one-token call and lists models. It shows the resolved identity (AWS account/role, GCP principal, Entra tenant) and region.
4. Secrets go to the OS keychain. Workspace files only hold references, so they are safe to commit.

### 8.5 Prepare data: generate a text dataset
1. **Datasets → New → Generate with a recipe.** Describe the app ("customer-support bot for a bank; answers in JSON with `answer` and `sources`").
2. **Schema.** The app proposes columns: `question`, `expected_answer`, `expected_behavior` (answer / refuse / ask-clarify), `difficulty`, `persona`, `topic`. You edit them.
3. **Diversity axes.**
   - Accept or edit an LLM-proposed **topic tree**.
   - Add axes: persona (library or custom), difficulty, intent (benign / borderline / adversarial), language and locale, length, and noise (typos, slang).
   - Choose the sampling mode: stratified, pairwise coverage, or quotas per cell.
4. **Rules.**
   - Natural-language constraints ("never include real customer names", "amounts in INR").
   - Optional few-shot seed rows from real data. PII is scrubbed first.
5. **Preview 10 rows.** Check the cost estimate, adjust, then generate N rows. Generation runs in the background with retries.
6. **Quality gates run automatically:**
   - schema and rule validators;
   - an LLM-judge filter ("on-spec? realistic? label correct?");
   - deduplication in three passes (exact, near-duplicate, semantic).
7. **Diversity report.** An axis coverage heatmap and repetition metrics. One click fills the gaps it finds.
8. **Review queue.** Approve, edit or reject rows, with bulk actions sorted by judge score or outlier. Approved rows become **Dataset v1**, an immutable snapshot, and selected rows can be promoted to the **golden set**.
9. **Split.** Dev, test, and a sealed holdout that is never used while tuning prompts.

### 8.6 Prepare data: safety dataset
1. **Datasets → New → Safety pack.**
2. Pick categories from one taxonomy that is mapped to OWASP LLM Top 10 2025, OWASP Agentic Top 10 2026, NIST AI 600-1, MITRE ATLAS, AILuminate hazards and the EU AI Act.
3. Choose sources:
   - **Curated public datasets.** The app shows each license and asks the user to accept gated terms themselves before download.
   - **Generated objectives**, written as descriptions of a request, not operational payloads.
   - **Deterministic converters**: base64, ROT13, leetspeak, homoglyphs, typos, persona and role-play wrappers.
4. **Over-refusal pairs are added automatically**: benign prompts that look harmful (XSTest / OR-Bench style). Each row gets an `expected_behavior` label.
5. **Refusal-aware generation.** When the generator model refuses, the app detects it, routes the row to a fallback model (for example a local open-weight model) or a template, and logs the refusal rate.
6. Results later show a 2×2 view: harmful-and-complied (bad) against benign-and-refused (over-refusal).

### 8.7 Prepare data: image and audio datasets
- **Images:**
  - **Generate** with gpt-image, Gemini image models, FLUX through fal/Replicate, or a local model.
  - **Render programmatically** (HTML → PNG, charts) when exact ground truth matters (receipts, forms, screenshots), because diffusion models garble text.
  - **Augment**: blur, JPEG compression, rotation, low light.
  - **Import** a folder plus a metadata CSV/JSONL.
  - Each image is stored once by content hash. The provenance (model, prompt, seed) is recorded.
- **Audio for STT:**
  - **Import real recordings** first: a folder plus a transcript CSV, or a Common Voice or NeMo manifest. Real audio is essential.
  - **Generate** a TTS matrix of voice × accent × speed × emotion × domain vocabulary (numbers, names, jargon, code-switching).
  - **Augment**: background noise (MUSAN), room reverb, MP3/Opus compression, a telephony chain (8 kHz, band-pass, G.711), clipping.
  - **Verify labels.** A round-trip check with an independent ASR model drops TTS mispronunciations so the reference text stays correct.
  - **Report real and synthetic WER separately.** TTS audio is cleaner than real speech, and research shows the gap persists.

### 8.8 Drive the app from a coding agent (MCP)
The user's own coding agent (Claude Code, Codex, Cursor or Gemini CLI) connects to the app's MCP server and can do anything the UI can do.
- The user writes the prompt in their own terminal.
- The agent uses its own model under the user's own account.
- The app never launches the agent, never calls it, and never touches its credentials.

This is ordinary MCP use, so the app needs no API key or spend of its own for this.

**Setup (once).** In the app, open **Agents → Connect a coding agent**. The app shows a ready-to-paste snippet for each client:

```bash
claude mcp add kalibra -- kalibra mcp
# Codex: [mcp_servers.kalibra] in ~/.codex/config.toml
# Cursor: .cursor/mcp.json   Gemini CLI: settings.json
```

**Example: "Create 100 synthetic rows for the `support-questions` dataset."**
1. **Define the dataset (optional).** In the app, the user sets the columns, types, allowed values, a description for each column, and generation instructions ("retail-banking customer questions; about 30% should require a refusal; amounts in INR"). The agent can also create the dataset itself.
2. **Prompt.** In their terminal, the user gives Claude Code the prompt above.
3. **The agent reads the dataset.** It calls `list_datasets` to find `support-questions`, then `get_dataset_schema`, which returns:
   - columns, types and constraints;
   - the column descriptions and generation instructions;
   - a few sample rows;
   - the current row count and tag distribution.
4. **The agent submits rows.**
   - It writes rows with its own model and sends them with `add_dataset_rows` in batches of 20–50.
   - The app validates each row against the schema and removes duplicates.
   - The app answers with the accepted rows and the rejected ones, with field-level errors. The agent fixes the rejected rows and resubmits.
5. **The user reviews.**
   - Rows appear live in the open app, marked **needs review**.
   - Each row records its provenance: client name, the model the agent reports, and a timestamp.
   - The user approves rows in the review queue, or asks the agent to fix the ones they rejected.

**The same pattern works for every feature.** For example:
- *"Set up a target for our /transcribe endpoint."* The agent reads the repo, calls `create_target`, then `test_target`.
- *"Add a JSON-schema gate and a WER ≤ 15% check to the STT suite."* (`add_check`)
- *"Run the suite against staging and show me the 10 worst rows."* (`start_run`, `get_run_status`, `query_results`)
- *"Grade the pending items in run 42 against the rubric."* (`list_pending_grades`, `submit_grades`)

**How parity is guaranteed.**
- Each feature is implemented once, as an engine operation. An operation has a name, a description, input and output JSON Schemas, and flags (read-only, destructive).
- The UI, the CLI and the MCP tools are all built from that one operation registry, so nothing can ship in the UI without also existing for the agent.
- Tool names use only letters, digits, `_` and `-`, because some model APIs reject dots in tool names.

**Guardrails:**
- **Destructive operations** (deleting a dataset or runs) carry MCP's `destructiveHint`, so the client asks the user first. Deleted items go to a trash, and datasets are versioned, so any agent edit can be undone.
- **Agent output starts in review.** Rows and grades created by an agent carry provenance.
  - Agent grades count only after they are calibrated against human labels (8.14).
  - The app warns when the same model family both generated the data and grades it (self-preference bias).
- **Returned content is data.** Dataset rows and app outputs returned to the agent are marked as data, never as instructions. No tool exposes secrets or a shell.
- **Paging.** Large results are paged to stay under client limits (Claude Code's default tool-output cap is 25k tokens).
- **Clarifying questions.** When the client supports MCP elicitation, the app can ask through it. Otherwise it returns a `needs_clarification` result.

**Why this direction.**
- MCP sampling (a server borrowing the client's model) is deprecated, and Claude Code never implemented it. The agent therefore has to call the app, not the other way round.
- The user drives their own agent, and the app never handles their Claude or ChatGPT credentials, so this is ordinary MCP use.
- Agent work still counts against the user's own plan limits.

### 8.9 Connect the app under test
1. **Targets → New**, then pick one of four entry points:
   - **Paste a cURL command** (devtools "Copy as cURL"), HAR, Postman collection or OpenAPI spec.
   - **Build the request in a form**: method, URL, headers, body, multipart.
   - **"My app speaks OpenAI Chat Completions"** preset.
   - **Command target**: run the user's script with JSON over stdin/stdout, for apps without an endpoint.
2. **Map variables.** Autocomplete `{{column}}` from the dataset schema. Unmapped placeholders are highlighted.
3. **Auth for the target:** none, bearer, API key, basic, OAuth2 client credentials (token cached and refreshed), mTLS, HMAC signing, or AWS SigV4 (API Gateway/Lambda behind IAM). A pre-request script hook covers anything else.
4. **Sessions and multi-turn:**
   - A row carries `turns[]`, and the template exposes `{{message}}` and `{{history | json}}`.
   - The session ID comes from a response header or field, or is generated per row.
5. **Streaming:**
   - SSE: a per-event extractor that concatenates the events.
   - WebSocket: a send template, then collect messages until a terminator condition is met.
   - Time to first token is captured in both cases.
6. **Live preview** against row N shows the rendered request with secrets masked. **Send**, then click fields in the response to create named outputs.
7. **Smoke test on 3 rows** with status, latency and extracted outputs. Save to create **Target v1**.
8. **Or let your coding agent do it.** Ask it: *"Read this repo and create an eval target for the /chat endpoint."* It calls `create_target` and `test_target` over MCP (8.8), and the target appears in the app as a draft for you to review.

**Streaming audio targets (WebSocket STT).** These ship in the first release, alongside batch upload. A streaming target defines:
- **Connection:**
  - a `wss://` URL with `{{variables}}`;
  - auth as a header, a query token, or the first message;
  - an optional start/config message template, e.g. `{"type":"start","sample_rate":16000,"language":"{{lang}}"}`.
- **Sending audio:**
  - encoding (PCM16, μ-law, A-law, Opus);
  - sample rate and channels (the engine converts the dataset audio to match);
  - frame size (20–100 ms);
  - binary frames, or base64 inside a JSON message template;
  - pacing: real time (the default, because latency numbers mean nothing otherwise), N× real time, or as fast as possible.
- **Ending the stream:** a closing message template (e.g. `{"type":"stop"}`), closing the socket, or trailing silence.
- **Reading messages:**
  - extractors that mark each message as partial or final (e.g. `$.is_final == true`);
  - the text (e.g. `$.channel.alternatives[0].transcript`) and optional word timings;
  - a rule for when the stream is done: a final message, socket close, or an idle timeout.
- **Presets:** for common vendor protocols (Deepgram, AssemblyAI, Azure Speech, Google, ElevenLabs, OpenAI Realtime transcription), plus a fully custom setup for in-house services such as the team's own.
- **Measured on every stream.** Every frame sent and message received is timestamped with a monotonic clock. That gives:
  - connection setup time;
  - time to first partial, counted from the first audio frame;
  - final latency, counted from the last audio frame to the final transcript;
  - partial cadence and stability (how often partials arrive, and how much they rewrite earlier text);
  - real-time factor;
  - WER/CER on the final transcript.
- **Per run:** p50/p95/p99 for each latency, and a setting for N parallel streams. A full load-test mode comes later.

**Batch STT:**
- In the first release: synchronous file upload, as multipart or base64 JSON.
- In v2: async "submit, then poll" transcription APIs.

### 8.10 Build the check pipeline (the layers)

```
L0 Transport    status code, timeout, latency/TTFT SLO                     free
L1 Structure    is JSON, JSON Schema, required fields                        free
L2 Field rules  JSONPath assertions: type, range, enum, length, set-equal    free
L3 Content      equals / contains / regex / numeric tolerance / Levenshtein  free
L4 Reference    BLEU, ROUGE, chrF, token-F1, WER/CER, embedding similarity   cheap
L5 Judgment     LLM-judge rubric (binary per criterion), pairwise, human     costly
```

How checks behave:
- **Gate or scored.** Any check can be a *gate*: if it fails, later layers are skipped for that row. That saves judge cost and keeps failure reasons clear ("schema invalid", not "judge said 2/5"). Otherwise the check is *scored*.
- **Fields on every check:** weight, threshold, named metric, a negation option, and an "applies when" condition (for example only when `expected_behavior == refuse`).
- **Judges:**
  - Default to binary pass/fail for each criterion, with a critique written before the verdict.
  - Use structured output, include the reference answer when one exists, and allow k repetitions.
  - For pairwise judging, run both orders to cancel position bias.
- **Cost estimate before the run:** judge calls × tokens × price, reduced by the expected gate failure rate from the last run.

### 8.11 Run and look at results
1. **Runs → New**: choose dataset version, target version and suite. Then set:
   - environment (dev or staging);
   - concurrency;
   - rate limit;
   - repetitions (k);
   - cache on/off;
   - subset (all, failed-last-time, a tag, or a split).
2. **The live run view:**
   - A progress bar, with results streaming into the grid.
   - Running pass rate, p50/p95 latency, error classes (4xx, 429, 5xx, timeout, schema-invalid), tokens and spend.
   - Pause, resume, or cancel. A crash resumes where it stopped.
3. **The results grid:**
   - A virtualized table that handles 100k rows.
   - Filter by check, tag, score or error. Sort by worst. Slice by any column (accent, persona, difficulty).
4. **The row detail** shows:
   - the rendered request, raw response and extracted outputs;
   - each check with its reasoning;
   - a WER alignment diff with audio playback, or image side-by-side;
   - a "add to regression dataset" button.
5. **The summary** shows:
   - each metric with a 95% confidence interval;
   - score histograms;
   - corpus WER and the per-utterance distribution;
   - the worst cases;
   - flaky items (when k > 1).

### 8.12 Compare runs (did my change make it better?)
1. Pick a baseline: the previous run, a pinned run, or the latest run on the same Git branch.
2. Rows are matched across runs by row ID or a chosen comparison key.
3. View modes:
   - baseline → new, with a character diff;
   - expected → output;
   - side-by-side.
4. Improved rows show green and regressed rows red. "Sort by regressions" puts the regressions first.
5. **A verdict for each metric**, using a paired test and the confidence interval of the difference: Improvement, Regression, Tradeoff, or No significant difference.
6. **Pairwise review.** Send both runs to a pairwise human or judge queue (A / B / tie per rubric item).

### 8.13 Score outputs you already have (offline mode)
For teams without an API, or whose app runs only inside their own infrastructure:
1. **Export inputs.**
   - Dataset → **Export for external run**: CSV or JSONL with a stable `row_id`.
   - For media, a folder plus a manifest.
2. Run your own system on those inputs, however you like.
3. **Import outputs.**
   - Runs → **Import outputs**: drop the file and map `row_id` and the output column(s).
   - Optional columns: `latency_ms`, `tokens`, `cost`, `error`.
   - Generated images or audio go in an output folder named by `row_id`.
4. The app creates an **imported run** and applies the same suite. L0 transport checks are skipped. Everything else works the same, including comparison against live runs.
5. Re-import a newer outputs file to create a new run and compare.

### 8.14 Calibrate the judge (can I trust the LLM grader?)
1. **Calibrate → pick a judge.** The app samples about 100 results, balanced between likely passes and likely fails.
2. **Label in a fast keyboard-driven queue.** You may edit the criteria while labelling: research ("Who Validates the Validators") shows the criteria themselves drift once people start grading, and edits are versioned.
3. **The app shows:**
   - agreement %, Cohen's κ, TPR/TNR and a confusion matrix for each criterion;
   - the disagreements first.
4. **Iterate on the judge prompt or model**, comparing each version against the saved baseline.
5. **Reports use a corrected pass rate**: the observed pass rate adjusted for the judge's error rates, with a confidence interval.
6. **Judge drift.** When the judge model changes, re-run calibration and show the change in agreement.

### 8.15 CI and automation
```bash
kalibra run --suite support-bot --dataset golden@v3 --target staging --fail-on regression
# exit code ≠ 0 on threshold failure or significant regression
# writes JUnit XML + a Markdown summary (for PR comments) + a results bundle
```
The same engine powers the GUI, the CLI and MCP, so a run started from CI can be opened in the desktop app.

### 8.16 Worked examples

**A. Speech-to-text service (the user's office use case)**
- **Dataset:** columns `audio` (file), `reference` (text), `lang`, `accent`, `noise`, `keywords[]`.
  - Real recordings: 300 clips.
  - TTS-generated and augmented: 1,500 clips across accents, noise levels and the telephony codec.
- **Targets:** two targets on the same dataset, so results can be compared side by side.
  - **Batch:** multipart POST with `file = {{audio}}` and `language = {{lang}}`. Extractors: `transcript = $.text` and `words = $.words`.
  - **Streaming:** WebSocket, sending 20 ms PCM16 frames at real-time pace. The final text comes from messages where `is_final` is true.
- **Suite:**
  - L0: status (batch) or connection success (streaming), and latency p95 under 1 s.
  - L1: schema.
  - L4: WER with the `whisper-en` normalizer, CER, entity/keyword recall; for streaming, time to first partial, final latency and RTF.
  - L5 (optional): a judge asked "did any meaning-changing error occur (names, numbers, negation)?"
- **Results:**
  - Corpus WER with a confidence interval, shown per slice (accent × noise × real vs synthetic).
  - The worst clips, with an alignment diff and audio playback.
  - The most frequent substitution pairs ("fifteen" → "fifty").

**B. JSON chat/RAG API**
- **Dataset:** `question`, `expected_answer`, `must_cite[]`, `expected_behavior`.
- **Target:** POST `{"message": "{{question}}", "user_id": "eval-{{id}}"}`. Extractors: `answer = $.answer`, `sources = $.sources[*].id`, `confidence = $.confidence`.
- **Suite:**
  - L0: 200, latency under 3 s.
  - L1: JSON Schema.
  - L2: `sources` is not empty, and `confidence` is between 0 and 1.
  - L3: `answer` contains none of the forbidden phrases.
  - L4: embedding similarity to `expected_answer` ≥ 0.8.
  - L5: a binary judge for "grounded in sources" and "answers the question".

**C. Safety check of an assistant**
- **Dataset:** safety pack, 600 rows. Half are harmful objectives in several converter forms; half are benign-but-scary prompts.
- **Suite:**
  - A refusal classifier or judge compared against `expected_behavior`.
  - A PII-leak regex pack.
  - A system-prompt-leak canary string.
- **Results:** attack success rate per category and framework ID, plus the over-refusal rate.

---

## 9. Feature list by section

**MVP** is the first public release. **v2** follows it. **Later** depends on demand. The MVP is still large, so section 13 suggests a narrower first slice.

### 9.1 Connections (model providers)

| Stage | Features |
|---|---|
| MVP | **Generic OpenAI-compatible adapter with presets.** It covers OpenAI, xAI, Mistral, Groq, Together, Fireworks, DeepSeek, Perplexity, OpenRouter, HF Inference Providers, Ollama, LM Studio, vLLM, llama.cpp and the LiteLLM proxy. |
| MVP | **Dedicated adapters:** Anthropic, Gemini API, Azure OpenAI/Foundry (API key and Entra), Vertex AI (ADC, service account, impersonation, express-mode key), Bedrock (profiles/SSO, static keys, Bedrock API key). |
| MVP | Test-connection button that shows the resolved identity. |
| MVP | Secrets in the keychain; credential *sources* rather than copies. |
| MVP | Per-connection rate limits and a price table. |
| v2 | Image generation, TTS and STT provider adapters (OpenAI images/audio, Gemini/Imagen, fal, Replicate, BFL, ElevenLabs, Deepgram, AssemblyAI, Google STT, Azure Speech, AWS Transcribe) as async submit/poll jobs. |
| v2 | Local embedding model (ONNX) so similarity checks work offline. |
| Later | Anthropic Workload Identity Federation and profiles. |
| Later | Claude in Foundry/Vertex/Bedrock fine-tuning flags. |
| Later | Gateway presets (Portkey, Cloudflare AI Gateway). |

### 9.2 Data prep

| Stage | Features |
|---|---|
| MVP | Typed datasets: text, number, bool, JSON, messages, image, audio, file. |
| MVP | Import and export of CSV, JSONL, Parquet, folder + manifest, and Hugging Face pull. |
| MVP | Immutable versions with diffs; tags and splits; per-row provenance. |
| MVP | Recipe engine: axes and samplers, Jinja-style LLM columns, validators, LLM-judge filter, 3-pass dedup, preview, cost estimate, background generation. |
| MVP | Topic-tree builder and persona library. |
| MVP | Review queue: approve, edit, reject, bulk actions, golden promotion. |
| v2 | Safety pack: taxonomy and framework mapping, license-aware curated importers, converters, over-refusal pairing, refusal-aware generation with fallback. |
| v2 | Diversity dashboard and gap filling. |
| v2 | Evolutions for difficulty. |
| v2 | RAG test sets generated from documents (single-hop and multi-hop). |
| v2 | Image datasets: generation, programmatic rendering, augmentation, typographic prompt-injection images. |
| v2 | Audio datasets: TTS matrix, noise/RIR/codec/telephony augmentation, round-trip label verification. |
| v2 | Importers: OpenAI Evals JSONL, promptfoo YAML/CSV, DeepEval goldens, Ragas test sets, NeMo ASR manifest. |
| Later | Multi-turn conversation simulation and crescendo-style escalation scripts. |
| Later | Seeding from production logs with PII scrubbing (Presidio). |
| Later | Contamination checks against public benchmarks. |
| Later | Croissant dataset cards. |

### 9.3 Targets (app under test)

| Stage | Features |
|---|---|
| MVP | HTTP target: cURL and raw-request import; templated URL, headers, body and multipart; auth (bearer, API key, basic, OAuth2 client credentials); JSONPath extractors with click-to-map; SSE streaming; preview; 3-row smoke test; environments. |
| MVP | Model + prompt target, for testing prompts directly. |
| MVP | Imported-outputs target (offline mode). |
| MVP | WebSocket target: message templates; binary or base64 audio streaming at real-time pace; partial/final extractors; vendor presets plus a custom protocol (see 8.9). |
| MVP | Batch STT: synchronous upload as multipart or base64 JSON. |
| v2 | Import from Postman, HAR and OpenAPI. |
| v2 | Multi-turn sessions. |
| v2 | Async "submit, then poll" targets (batch transcription APIs). |
| v2 | Command target (JSON over stdio). |
| v2 | mTLS, HMAC and SigV4 target auth. |
| v2 | jq extractors and a sandboxed JS transform. |
| Later | gRPC target. |
| Later | Simulated-user agent. |
| Later | Voice-agent phone/WebRTC simulation. |
| Later | OpenTelemetry trace ingestion. |

### 9.4 Checks and metrics

| Stage | Features |
|---|---|
| MVP | Layered gate/score pipeline with weights, thresholds, negation and "applies when". |
| MVP | Deterministic checks: equals, contains (any/all), regex, starts-with, is-JSON, JSON Schema, JSONPath field rules, numeric tolerance, Levenshtein, length. |
| MVP | Latency, TTFT, tokens and cost. |
| MVP | Reference metrics: BLEU/sacreBLEU, chrF, ROUGE-L, token-F1, exact match. |
| MVP | **STT:** WER, CER, MER and WIL with the S/D/I alignment; normalizer profiles (none, basic, Whisper-English port, custom regex plus substitution dictionary); corpus vs per-utterance WER; keyword/entity recall; streaming metrics (connection time, time to first partial, final latency, partial stability, RTF) with p50/p95/p99. |
| MVP | Embedding similarity through a provider's embeddings API. |
| MVP | LLM judge: binary rubric/checklist, reference-guided, pairwise with order swap, structured output, k repetitions. |
| MVP | Custom JS check in a QuickJS sandbox. |
| MVP | Image: IoU and detection precision/recall/F1, OCR CER, VQA exact-match, VLM checklist judge (TIFA/DSG style). |
| v2 | RAG metrics (faithfulness, context precision/recall, relevancy). |
| v2 | Tool-call and trajectory matching; pass@k and pass^k. |
| v2 | Semantic WER via a judge. |
| v2 | Timestamp accuracy. |
| v2 | ASR confidence calibration. |
| v2 | Refusal and over-refusal classifiers. |
| v2 | PII regex pack. |
| v2 | Adaptive per-row rubrics. |
| v2 | Grader formulas (combine checks). |
| Later (optional Python plugin) | BERTScore. |
| Later (optional Python plugin) | Diarization DER/JER/cpWER (pyannote.metrics, meeteval). |
| Later (optional Python plugin) | CLIPScore and ImageReward. |
| Later (optional Python plugin) | DNSMOS and UTMOS for TTS. |
| Later (optional Python plugin) | Speaker similarity. |
| Later (optional Python plugin) | VQAScore and HPSv3 (GPU). |
| Later (optional Python plugin) | FID/KID. |
| Later (optional Python plugin) | Local safety classifiers (Llama Guard 4, gpt-oss-safeguard, Granite Guardian, ShieldGemma 2). |
| Later (optional Python plugin) | Custom Python checks. |

### 9.5 Runs, results and comparison

| Stage | Features |
|---|---|
| MVP | Execution: concurrency, token-bucket rate limiting, retries that honour `Retry-After`, a request cache, crash-safe resume, and runs on a subset. |
| MVP | Live view, and a virtualized grid with filters, slices and sort-by-worst. |
| MVP | Row detail with the full request/response trace, audio playback and image viewer. |
| MVP | Summary with confidence intervals and histograms. |
| MVP | Two-run comparison with regressions highlighted. |
| v2 | Paired significance tests and an Improvement/Regression/Tradeoff verdict. |
| v2 | Grouped repeated trials (flaky detection). |
| v2 | Git-branch baselines. |
| v2 | Pairwise review queues. |
| v2 | Leaderboard across run configurations (score × cost × latency). |
| Later | Failure clustering. |
| Later | Load/latency test mode (concurrency sweep, goodput against SLOs). |
| Later | In-app assistant. |

### 9.6 Review and calibration

| Stage | Features |
|---|---|
| MVP | Keyboard-driven review queue for generated rows and run outputs. |
| v2 | Judge calibration studio (κ, TPR/TNR, confusion matrix, corrected pass rate, drift). |
| v2 | Versioned criteria. |
| Later | Multi-annotator agreement; Argilla/Label Studio sync. |

### 9.7 MCP and coding agents

| Stage | Features |
|---|---|
| MVP | stdio MCP server in the same binary (`kalibra mcp`). It is a thin client of the local engine API and starts the engine headless if the app is closed. |
| MVP | **Full parity:** MCP tools are generated from the engine's operation registry. Every UI feature is available to the agent: datasets, generation, targets, suites, runs, results and review. |
| MVP | Schema-validated batch writes with per-row errors. Agent provenance on everything it creates. Agent output goes to the review queue. |
| MVP | Prompts (`/kalibra:generate-rows`, `/kalibra:grade-pending`) and resources (dataset schemas, rubrics). |
| MVP | Config snippets generated for each client (Claude Code, Codex, Cursor, Gemini CLI, VS Code). |
| v2 | Elicitation for clarifying questions when the client supports it. |
| v2 | Streamable HTTP transport on localhost with token auth, for clients that prefer it. |
| Later | Streamable HTTP with OAuth in server mode (11.6). |

### 9.8 CLI, sharing and settings

| Stage | Features |
|---|---|
| MVP | CLI `run`, `import` and `export`, with exit codes, JUnit and Markdown reports. |
| MVP | Version history for every definition in the database. Optional folder mirror of definitions for Git (desktop only). |
| MVP | Storage dashboard and retention settings. |
| v2 | `.kalibra` bundles (zip with definitions, datasets, runs and media) that open in another person's app, and later upload to a server. |
| v2 | GitHub Action. |
| Later | Self-hosted server mode (`kalibra serve`, Docker): web UI, user management, SSO, Postgres, cloud object storage (see 11.6). Never required for desktop use. |

---

## 10. Connections: provider authentication matrix

| Provider | Auth methods to support | Notes |
|---|---|---|
| OpenAI | API key (project and service-account keys); optional org and project headers | Chat Completions plus Responses; images; audio |
| Anthropic | API key; bearer token (gateways); Workload Identity Federation (OIDC → short-lived token); profiles in `~/.config/anthropic` ([WIF docs](https://platform.claude.com/docs/en/manage-claude/wif-reference)) | Also reachable through Bedrock, Vertex, Microsoft Foundry and "Claude Platform on AWS" |
| Google Gemini API | API key (`x-goog-api-key`) | Also has an OpenAI-compatible endpoint |
| Google Vertex AI (renamed "Gemini Enterprise Agent Platform" in Apr 2026) | ADC (`gcloud auth application-default login`); service-account JSON; service-account impersonation; Workload Identity Federation; express-mode API key (Gemini only, low rate limit) | Needs project and location. **Claude on Vertex does not accept API keys.** Many orgs block SA key creation, so ADC and impersonation must be first-class. |
| AWS Bedrock | Static keys + session token; named profiles; IAM Identity Center / SSO; AssumeRole (with MFA); `credential_process`; Bedrock API keys (short-term recommended; long-term creates an IAM user) ([docs](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)) | Needs region and cross-region inference profiles (`us.`, `eu.`, `global.`). Use the Converse API for uniformity and InvokeModel for model-specific features. An OpenAI-compatible `bedrock-mantle` endpoint also exists. |
| Azure OpenAI / Foundry | API key; Entra ID via service-principal secret or certificate, `az login`, interactive browser or device code (good for desktop), DefaultAzureCredential | Prefer the GA v1 API (`…/openai/v1/`, no api-version). The legacy deployment URL is still needed for older resources. Token scope differs between classic and Foundry docs, so support both. Claude in Foundry has its own `/anthropic/v1` endpoint. Foundry *evaluations* require Entra. |
| xAI, Mistral, Groq, Together, Fireworks, DeepSeek, Perplexity, OpenRouter, Cohere (compat API), HF Inference Providers | Bearer API key | OpenAI-compatible; handle per-provider quirks (no `json_schema`, no `stream_options`, etc.) with flags |
| Local: Ollama, LM Studio, vLLM, llama.cpp, LocalAI, TGI | None or optional key | OpenAI-compatible; Ollama also exposes an Anthropic-compatible `/v1/messages`; needs long timeouts and model discovery |
| Gateways: LiteLLM proxy, Portkey, Cloudflare AI Gateway | Custom base URL and arbitrary headers | Offer LiteLLM as a *connection type*, not an embedded library (see 11.4) |
| Speech and image APIs | Header names vary: `xi-api-key` (ElevenLabs), `Token` (Deepgram), raw key (AssemblyAI), `x-key` (BFL), `Key` (fal), SigV4 (Transcribe), ADC (Google STT), subscription key + region or Entra (Azure Speech) | Many are async (submit then poll) or WebSocket streaming; the adapter interface must support jobs, multipart and binary outputs |

**Design rule.** Model each connection as **protocol + auth source + base URL + headers + quirks**. Four wire protocols cover about 95% of models: OpenAI Chat/Responses, Anthropic Messages, Gemini generateContent, and Bedrock Converse.

---

## 11. Storage, performance and architecture

### 11.1 How much data to expect (estimates)
| Item | Rough size |
|---|---|
| One result row (rendered request + response + check results) | 2–25 KB raw, about 5–10× smaller with zstd |
| Run of 10,000 rows | 20–250 MB raw, roughly 5–50 MB compressed |
| Audio dataset, 1,000 clips × 10 s, 16 kHz mono 16-bit | about 320 MB, stored once |
| Image dataset, 1,000 images | 0.5–3 GB depending on resolution |
| A busy team over a year | tens of GB without retention rules |

### 11.2 Storage design
- **Definitions** (connections without secrets, targets, suites, recipes, judge prompts) live in the database with full version history: who changed what, and when. On desktop they can also be mirrored to small YAML/JSON files for Git (11.7).
- **Data and results** live in **SQLite in WAL mode** in the workspace.
  - Each result stores extracted outputs and scores in columns. The raw request and response bodies are stored zstd-compressed.
  - Indexes on run, status, check, tag and score.
  - Run summaries are kept in their own table and updated incrementally, so dashboards never scan every row.
- **Media** go in a **content-addressed blob store** (`blobs/ab/cd/<sha256>`).
  - Datasets and runs refer to a file by hash and never copy it.
  - Identical TTS outputs or repeated generations deduplicate automatically.
- **Retention.** Keep summaries, extracted outputs and scores forever. Delete raw bodies of unpinned runs older than N days or beyond N runs. A storage dashboard shows the space per dataset and run, with one-click cleanup.
- **Large-run export** to Parquet for analysis in DuckDB, pandas or Hugging Face.
- Everything is local. Nothing leaves the machine except the calls the user configures (providers, their own app).

### 11.3 Performance rules
- **The engine runs as its own process** (the local server). The UI never blocks on I/O or scoring.
- **Writes go through one writer queue** in batched transactions, reaching thousands of rows per second on SQLite. Results stream to the UI as small events.
- **The UI uses a virtualized grid with keyset pagination.** It never loads a whole run into memory. Media load lazily, with thumbnails and waveforms generated once and cached.
- **Concurrency is controlled per connection and per target:**
  - token-bucket rate limits;
  - `Retry-After`-aware exponential backoff with jitter;
  - retries and 429s counted separately from failures;
  - first-attempt latency reported separately from latency with retries.
- **The request cache** is keyed by a hash of the rendered request, target version and model parameters, and is opt-in per run. Re-running a suite after only changing checks costs nothing. Changing the judge only re-runs the judge.
- **Runs are crash-safe**: each item has its own state, so a run resumes after a crash or after the laptop sleeps.
- **Heavy ML metrics** run in an optional Python worker pool, on CPU, Apple MPS or CUDA. They are never in the main path.

### 11.4 Tech stack (decided 16 Oct 2026)
- **One TypeScript engine (`core`), run as a local HTTP service.**
  - **One API for everything.** The desktop UI, the CLI and the MCP server are all clients of the same API. That API is also the REST interface for anyone who wants to script the app.
  - **One writer.** The engine is the only process that writes to the database. Every change is pushed to the open UI as a live event, whether it came from the UI, the CLI or an agent.
  - **Why TypeScript:**
    - The Vercel AI SDK has the best coverage of the hard auth cases: Bedrock SSO/SigV4 and API keys, Vertex ADC/impersonation and express mode, Azure Entra and the v1 API ([Bedrock](https://ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock), [Azure](https://ai-sdk.dev/providers/ai-sdk-providers/azure), [Vertex](https://ai-sdk.dev/providers/ai-sdk-providers/google-vertex)). It also has image, transcription and speech primitives.
    - There is an official MCP TypeScript SDK.
    - Contributors only need one language.
    - The engine ships as an npm package for CI.
  - **Keep the AI SDK behind our own `Connection` interface**, so swapping it or adding raw adapters stays cheap.
- **Desktop shell: Electron.**
  - **Why:** Electron includes Node, so the engine needs no separate runtime. Chromium renders audio, video and images the same way on every OS. Signing and auto-update are mature.
  - **Accepted cost:** an installer over 100 MB, and more RAM than Tauri.
  - **Startup:** Electron starts the engine on 127.0.0.1 with a random port and a per-launch token, then loads the web UI.
  - **Rebinding protection:** the engine checks the Host and Origin headers to block DNS-rebinding attacks.
- **UI:** a React web app.
  - It talks to the engine only through the HTTP API and its event stream.
  - The few desktop-only features (native file picker, OS keychain, notifications) sit behind a small platform interface.
- **Storage:** SQLite (`better-sqlite3`) + zstd + the blob store, behind repository and blob-store interfaces (see 11.6). Parquet export via DuckDB is optional.
- **Secrets:**
  - Use Electron `safeStorage`, which encrypts with an OS-keychain-backed key.
  - Use envelope encryption so large credentials (service-account JSON) fit.
  - On Linux, warn when only the plaintext `basic_text` backend is available ([docs](https://electronjs.org/docs/latest/api/safe-storage)).
- **User code sandbox:** QuickJS (WASM) for custom JS checks and transforms.
- **Python:** an optional plugin runtime for heavy ML metrics and custom Python checks.
  - It uses an interpreter the user provides, or a `uv`-managed one.
  - It is never required.
- **Avoid embedding LiteLLM.**
  - PyPI versions 1.82.7/1.82.8 (Mar 2026) shipped a credential stealer ([Comet write-up](https://www.comet.com/site/blog/litellm-supply-chain-attack/)). That is unacceptable for an app that holds every provider key.
  - Support a LiteLLM *proxy URL* instead.
  - More generally: pin dependencies, keep a lockfile, publish an SBOM, and keep provider dependencies minimal.
- **MCP transport:**
  - stdio by default (`kalibra mcp`), as a thin client of the engine API. If the app is closed, it starts the engine headless.
  - Optional Streamable HTTP later ([MCP security](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)).
  - Support MCP spec versions 2026-07-28 and 2025-11-25, because clients are mixed.
- **License: MIT** for now. It can be revisited later.

### 11.5 Process layout

```
                 ┌──────────────── Engine (`kalibra serve`, TypeScript) ─────────────────┐
 Electron UI ───►│ HTTP API + live event stream                                          │
 (web app)       │  ├─ Operation registry (one definition per feature: UI = CLI = MCP)   │
                 │  ├─ Connections (AI SDK behind own interface) ──► providers / Ollama  │
 Browser (later)►│  ├─ Target runner (HTTP / SSE / WebSocket / command) ──► user's app   │
                 │  ├─ Generators, checks, judges, statistics                            │
 `kalibra` CLI ─►│  ├─ Job scheduler (concurrency, rate limits, retries, cache, resume)  │
                 │  └─ Storage interfaces ──► SQLite + blobs/ (desktop)                  │
 `kalibra mcp` ─►│                       └──► Postgres + S3/GCS/Azure Blob (server, later)│
 (stdio)  ▲      └───────────────────────────────────────────────────────────────────────┘
          │                                   ▲
 Claude Code / Codex / Cursor / Gemini CLI    │ optional
                                      Python plugin worker (heavy ML metrics)
```

### 11.6 Server mode later: seams to build in now
A self-hosted server mode is a likely later feature: web UI, user management, SSO, cloud storage, and a big-data store for results. It should be the **same engine in the same repo**, not a separate product.
- A separate server codebase would duplicate the engine, and the two copies would drift apart.
- With a shared engine, server mode becomes mostly packaging (`kalibra serve` plus a Docker image) and adapters.

Build none of the server features now. The seams below are cheap to put in from the start and expensive to retrofit:

| Seam | Desktop now | Server later |
|---|---|---|
| UI ↔ engine | HTTP API + event stream on localhost | Same API behind TLS and a login |
| Platform-only features | Native file dialogs, keychain and notifications behind a platform interface | Browser upload, server secret store, web notifications |
| Database | SQLite through a query layer that also targets Postgres (e.g. Kysely or Drizzle) | Postgres |
| Media and large files | Content-addressed blob store on local disk | S3, GCS or Azure Blob behind the same interface |
| Getting files in | Always *upload into the blob store*; never store a path on the user's disk. On desktop the "upload" is a fast local copy or hard link. | Real uploads; the server cannot read the user's laptop |
| Identity | Every record carries `workspace_id` and an `actor` (user, agent or CLI); one local user | OIDC/SSO login, with roles and permissions on the same records |
| Secrets | OS keychain | Vault, KMS or the cloud provider's secret manager |
| Provider auth sources | Local sources allowed ("AWS profile on this machine", gcloud ADC, `az login`) | Service accounts and workload identity only |
| Long-running work | In-process job queue | Separate worker processes on a durable queue |
| MCP | stdio | Streamable HTTP with OAuth |
| Analytics | Summary tables in SQLite; Parquet export | Optional exporter to ClickHouse or BigQuery |
| Sharing | Optional Git folder mirror plus `.kalibra` bundles | One shared workspace; bundles to move work in and out (11.7) |
| Concurrent edits | Version check on every save (UI vs agent) | Same check, across users |

If paid enterprise features are ever wanted, the common pattern is an `ee/` folder with its own license in the same repo, while the core stays MIT. Langfuse and LangWatch both do this.

Suggested repo layout:

```
packages/
  core/      engine: operation registry, runners, checks, judges, storage interfaces
  server/    HTTP API + event stream over core (the desktop runs this locally)
  web/       React UI; talks only to the server API
  desktop/   Electron shell: starts the server, loads the web UI, platform features
  cli/       kalibra run | import | export | serve | mcp
```

### 11.7 Sharing on a desktop and on a server
Git can only be the sharing mechanism between desktops. On a hosted server everyone works in the same live workspace, and there is no Git. So in both modes the **engine's database is the source of truth**, and Git is just one optional sync channel on desktop.

| | Desktop (now) | Server (later) |
|---|---|---|
| Where definitions live | Database, with version history | Same schema, on Postgres |
| How teammates share definitions | Optional folder mirror. Definitions are written as YAML/JSON files the team commits to Git. When the files change (e.g. after `git pull`), the app imports them as new versions. | Everyone sees the same workspace. Permissions decide who can edit. |
| How datasets and results travel | `.kalibra` bundles: a zip with definitions, dataset versions, runs and media | Already shared. Bundles still move work between desktop and server. |
| History | Version history in the app; Git history for mirrored files | Version history and audit log in the app |
| Concurrent edits | The UI and an MCP agent can edit the same item, so every save carries the version it started from. A stale save is rejected, and the user or agent re-applies it. | Same mechanism, across users |
| Moving from desktop to server | Upload bundles, or import the mirrored Git folder once | — |

**What this means for building now:**
- **Stable IDs and immutable versions.** Every definition has a stable ID and an immutable version number. Runs refer to exact versions.
- **Optimistic concurrency from day one.** Every API write that edits an existing item states the version it started from. This matters immediately, because the UI and an agent can edit the same suite at the same time.
- **Sync is an adapter.** The folder mirror and bundle import/export sit on top of the database. Turning the mirror off, as a server does, changes nothing else.
- **One bundle format.** It is the same in both modes, so moving work from a laptop to a server, or back, needs no conversion.
- **What the mirror leaves out.** Mirrored files never contain secrets (only references to them) or run results. Results are too big for Git and travel in bundles.

---

## 12. Safety and responsibility in the product itself

- **Store harmful test content safely.** Harmful red-team rows are kept at the *objective* level (a description of the attack), not as operational payloads. They are flagged, encrypted at rest, and shown behind a content warning.
- **Hard blocks:** no CSAM, and no generation of CBRN uplift content beyond descriptions of objectives. These blocks are not configurable.
- **Respect dataset licenses and gated terms.** The user accepts those terms themselves before the app downloads anything. The app records the license on every row.
- **Treat everything that comes back as data.** Dataset rows and app outputs are untrusted. The MCP server returns them as data fields and never as instructions to the agent. It exposes no shell or secret-reading tools and never returns secrets.
- **Privacy defaults:** telemetry off, and no network calls the user did not configure. A local-judge option keeps sensitive data entirely on the machine.

---

## 13. Decisions and next steps

**Decided (16 Oct 2026):**
- **Desktop shell:** Electron, with a TypeScript engine.
- **Scope:** the first release includes STT evaluation.
- **License:** MIT for now.
- **MCP:** the user drives their own coding agent, which can control every feature of the app through MCP. The app never launches or calls an agent.
- **STT targets:** both batch (file upload) and streaming over WebSocket are in the first release. The team's own STT apps stream over WebSocket.
- **Sharing:**
  - The database is the source of truth in both modes.
  - On desktop, an optional folder mirror shares definitions through Git, and `.kalibra` bundles carry datasets and results.
  - On a server, everyone shares one workspace, and the same bundles move work in and out (11.7).
- **Server mode:** not built now. The engine is designed as a local HTTP service with the seams in 11.6.
- **Project name: Kalibra** (CLI `kalibra`).
  - A made-up word from *calibrate* + *libra* (Latin for scales, the symbol of weighing and judgment).
  - On 16 Oct 2026 the name was free on npm, and no conflicting GitHub project turned up.
  - Check trademarks and domains before the public launch.
  - Runner-up names: *Evalyst* (eval + analyst) and *Provyn* (prove + it).

**Proposed first release:**
- Connections (the 9.1 MVP rows).
- Typed datasets with import/export and versions, recipe-based text generation, and the review queue.
- HTTP target, WebSocket streaming-audio target (STT) and imported-outputs mode.
- Layered checks:
  - deterministic checks and JSON Schema;
  - BLEU/ROUGE;
  - **WER/CER/MER with normalizers and an alignment diff**;
  - **streaming STT latency** (time to first partial, final latency, RTF);
  - embedding similarity;
  - LLM judge.
- Runs, with the results grid, audio playback and two-run comparison.
- MCP with full parity, and the CLI.

**Before coding starts:**
- Check the Kalibra name for trademark and domain conflicts.
- Collect the team's WebSocket STT protocol details, so the first custom preset matches it:
  - audio encoding and sample rate;
  - binary vs base64 frames;
  - the start and stop messages;
  - the shape of partial and final messages.

---

## Sources (primary references)

**Open-source tools:**
- [promptfoo](https://github.com/promptfoo/promptfoo)
- [promptfoo HTTP provider](https://www.promptfoo.dev/docs/providers/http/)
- [promptfoo assertions](https://www.promptfoo.dev/docs/configuration/expected-outputs/)
- [promptfoo red team](https://www.promptfoo.dev/docs/red-team/plugins/)
- [Kiln](https://github.com/Kiln-AI/Kiln)
- [Kiln evals](https://docs.kiln.tech/docs/evaluations)
- [DeepEval](https://github.com/confident-ai/deepeval)
- [Langfuse v4](https://langfuse.com/changelog/2026-08-17-langfuse-v4)
- [Phoenix](https://github.com/Arize-ai/phoenix)
- [Opik](https://github.com/comet-ml/opik)
- [Inspect multimodal](https://inspect.aisi.org.uk/multimodal.html)
- [MLflow align judges](https://docs.databricks.com/aws/en/mlflow3/genai/eval-monitor/align-judges)
- [Giskard](https://github.com/Giskard-AI/giskard-oss)
- [LangWatch](https://github.com/langwatch/langwatch)

**Commercial and cloud platforms:**
- [Braintrust compare](https://www.braintrust.dev/docs/evaluate/compare-experiments)
- [Braintrust remote evals](https://braintrust.dev/docs/guides/remote-evals)
- [Braintrust MCP](https://www.braintrust.dev/docs/reference/mcp)
- [LangSmith Align Evals](https://blog.langchain.com/introducing-align-evals)
- [OpenAI graders](https://developers.openai.com/api/docs/guides/graders)
- [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations)
- [Google adaptive rubrics](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/rubric-metric-details)
- [Bedrock judge evals](https://docs.aws.amazon.com/bedrock/latest/userguide/evaluation-judge.html)
- [Foundry evaluators](https://learn.microsoft.com/en-us/azure/foundry/concepts/built-in-evaluators)
- [Anthropic eval tool](https://platform.claude.com/docs/en/test-and-evaluate/eval-tool)

**Data generation and safety:**
- [NeMo Data Designer](https://github.com/NVIDIA-NeMo/DataDesigner)
- [DeepEval Synthesizer](https://deepeval.com/docs/synthesizer-introduction)
- [Ragas testset](https://docs.ragas.io/en/stable/howtos/applications/singlehop_testset_gen/)
- [Diversity metrics (Shaib et al.)](https://arxiv.org/abs/2403.00553)
- [SemDeDup](https://arxiv.org/abs/2303.09540)
- [garak](https://reference.garak.ai/en/stable/cliref.html)
- [PyRIT](https://microsoft.github.io/PyRIT/latest/code/framework)
- [DeepTeam](https://github.com/confident-ai/deepteam)
- [Azure AI Red Teaming Agent](https://learn.microsoft.com/azure/ai-foundry/concepts/ai-red-teaming-agent)
- [XSTest](https://huggingface.co/datasets/Paul/XSTest)
- [HarmBench](https://huggingface.co/datasets/walledai/HarmBench)
- [Aegis 2.0](https://huggingface.co/datasets/nvidia/Aegis-AI-Content-Safety-Dataset-2.0)
- [gpt-oss-safeguard](https://openai.com/index/gpt-oss-safeguard-technical-report)

**Metrics:**
- [jiwer](https://jitsi.github.io/jiwer/usage/)
- [Open ASR Leaderboard paper](https://arxiv.org/abs/2510.06961)
- [MeetEval](https://github.com/fgnt/meeteval)
- [Pipecat STT benchmark](https://github.com/pipecat-ai/stt-benchmark)
- [Seed-TTS-eval](https://github.com/BytedanceSpeech/seed-tts-eval)
- [VQAScore / GenAI-Bench](https://arxiv.org/abs/2406.13743)
- [GenEval 2](https://arxiv.org/abs/2512.16853)
- [PoLL judge juries](https://arxiv.org/abs/2404.18796)
- [EvalGen](https://arxiv.org/abs/2404.12272)
- [Adding error bars to evals](https://arxiv.org/abs/2411.00640)
- [GuideLLM](https://github.com/vllm-project/guidellm)

**Connections and MCP:**
- [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [MCP client matrix](https://modelcontextprotocol.io/extensions/client-matrix)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Claude Code headless](https://code.claude.com/docs/en/headless)
- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Codex MCP](https://developers.openai.com/codex/mcp)
- [Codex non-interactive](https://developers.openai.com/codex/noninteractive)
- [Bedrock API keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)
- [Vertex express mode](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/overview)
- [Azure OpenAI v1 API](https://learn.microsoft.com/azure/ai-foundry/openai/api-version-lifecycle)
- [Claude in Microsoft Foundry](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry)
- [Anthropic WIF](https://platform.claude.com/docs/en/manage-claude/wif-reference)
- [LiteLLM supply-chain incident](https://www.comet.com/site/blog/litellm-supply-chain-attack/)
