# The engine (`packages/core`)

## Operations

```ts
defineOp({
  name: 'add_dataset_rows',            // snake_case, becomes the MCP tool name
  title: 'Add rows',
  description: '…',                    // shown in the API, CLI help and to agents
  category: 'datasets',
  input: z.object({ … }),              // zod → validated input → JSON Schema for MCP
  readOnly?, destructive?,             // become MCP readOnlyHint / destructiveHint
  quiet?,                              // not shown in the activity feed
  mcp?: false,                         // hidden from agents (secret handling only)
  handler: ({ engine, actor }, input) => …,
});
```

- Ops live in `src/ops/*.ts` and are registered in `src/ops/index.ts`.
- `engine.call(name, input, actor)` validates, runs, logs non-read-only calls to `activity`, and emits an event.
- `test/registry.test.ts` guards parity: every op has a title, description and object input, names are unique, secret ops stay off MCP, `delete_*` ops are destructive.

| File | Operations |
|---|---|
| `datasets.ts` | `list_datasets` `get_dataset_schema` `create_dataset` `update_dataset` `delete_dataset` `list_rows` `add_dataset_rows` `update_row` `set_rows_status` `delete_rows` `create_dataset_version` `list_dataset_versions` `import_rows` `export_dataset` `generate_rows` |
| `defs.ts` | `list/get/create/update/delete_*` and `list_*_versions` for targets, suites, connections; `test_target` `parse_curl` `list_check_types` `list_providers` `test_connection` `list_models` `list_secrets` (+ `set_secret` `delete_secret`, UI only) |
| `runs.ts` | `start_run` `preflight_run` `import_outputs` `list_runs` `get_run` `cancel_run` `resume_run` `delete_run` `query_results` `get_result` `compare_runs` |
| `groups.ts` | `start_comparison` `get_comparison` `compare_rows` `list_comparisons` `cancel_comparison` `delete_comparison` |
| `conversations.ts` | `test_conversation` |
| `themes.ts` | `get_failure_themes` `cluster_failures` |
| `insights.ts` · `labels.ts` | `run_breakdown` `suite_trend` · `label_result` `list_labels` `next_to_label` `judge_agreement` |
| `quality.ts` | `dataset_quality` `find_duplicates` `resolve_duplicates` `fill_gaps` `embeddings_status` `download_embedding_model` `test_embeddings` |
| `playground.ts` | `playground_run` `save_playground_target` |
| `media.ts` · `safety.ts` | jobs, `generate_images` `generate_speech` `transcribe_rows` `augment_audio` · `list_safety_categories` `create_safety_dataset` |
| `sharing.ts` | `export_bundle` `inspect_bundle` `import_bundle` `get/set_sharing_settings` `export_to_folder` `import_from_folder` `inspect_external` `import_external` |
| `workspace.ts` | `get_workspace` `list_operations` `list_activity` `upload_file` `get_file_info` |

## Actors, activity, events

- **Actor** = `{ kind: 'user' | 'agent' | 'cli' | 'system', id, client?, model? }`. The MCP bridge sends `x-kalibra-actor`.
- Agent-added rows default to `needs_review` and record provenance (client, model).
- **Events** (`events.ts`): `dataset.changed`, `rows.changed`, `def.changed`, `run.updated`, `result.updated`, `job.updated`, `activity`. Streamed to the UI over SSE.

## Jobs

`engine.jobs.start(kind, title, async (job) => { job.progress(done, total); job.itemError(…) })`. Used for image/speech generation, transcription, audio variants, the safety pack, fill gaps, AI failure themes, playground runs with more than one call, and the local embedding download. In memory; ops are idempotent ("fill empty rows") so an interrupted job can be re-run.

## Runner

```
start_run ─► dataset version snapshot ─► pending results (row × repetition)
          ─► N workers ─► executeTarget ─► retries (Retry-After, backoff+jitter)
                       ─► evaluateChecks (layers, gates) ─► saveResult ─► event
          ─► live summary every ~2 s ─► final summary
```

- Crash or cancel leaves rows `pending`; `resume_run` continues. Runs left `running` become `interrupted` on startup.
- **Imported runs** skip the target and score outputs from a file.
- **Preflight** (`runner/preflight.ts`): `start_run`, `start_comparison` and `preflight_run` return `warnings` for `{{column}}`s the dataset lacks, `{{vars.x}}` not set on the target, and a scripted conversation without its turns column. Scripts and JS expressions are not scanned.
- **Overrides** (`settings.overrides`, `runner/overrides.ts`): change variables, model/connection/temperature (model targets) or any config field (deep-merged) for one run. Stored in the run, so it stays reproducible; the target is not versioned.
- **Conversations** (`settings.conversation`, `runner/conversation.ts`): `scripted` sends each user message from a list column; `simulated` lets a model play `{{persona}}` with `{{goal}}` and decide when it is done. The target is called once per turn with `message`, `history`, `turn`, `conversation_id` and `session_id` (from the previous reply's `session_id` output). Checks run once on the final state; `outputs.transcript`, `outputs.stop_reason`, `outputs.goal_met` (simulated); metrics `turns`, `turn_latency_ms`, `conversation_ms`. `test_conversation` tries one without a run.
- **Comparisons** (`ops/groups.ts`): a run group with 2–8 variants, each an ordinary run tagged `group_id` + `variant_label`, all pinned to one dataset version. Ranked by pass rate, then mean score, then p50 latency; each variant gets an exact McNemar test on paired rows against the best (`clearly worse` below p 0.05, `could be noise` above it, `tied` at equal pass rates).

## Checks and gates

- Layers 0–5: Transport, Structure, Fields, Content, Reference metrics, Judgment.
- A failing **gate** skips every check in later layers for that row.
- `applyWhen` (JS expression) makes a check conditional.
- Row pass: all checks pass, or weighted score ≥ threshold.

## Summaries

- Pass rate with a **Wilson 95% interval**.
- **Corpus WER/CER** = Σ errors ÷ Σ reference units (checks report `details.errors` / `details.refUnits`).
- Percentiles (p50/p95/p99) for every numeric metric.
- `compare_runs`: row matching + exact **McNemar** p-value. `run_breakdown`: per tag/column groups. `judge_agreement`: kappa, TPR/TNR, corrected pass rate.
- `get_failure_themes`: free groups by first failing check + normalized reason (numbers, ids, quotes stripped). `cluster_failures` (job): failure summaries clustered with the local embedding model (or assigned by the model when it isn't downloaded), then named with cause, fix and severity; saved in `insights`, latest wins.
- `dataset_quality`: fill per column, coverage of category-like columns, length spread, distinct-2, self-BLEU, compression ratio, exact copies, flags. `find_duplicates`: exact / near (character overlap) / semantic (cosine).

## Templates

`{{ path | filter }}` in URLs, headers, bodies and check configs.

- Paths: row columns, `vars.*`, `secret.*`, `output`, `outputs.*`, `response.*`, `metrics.*`, `$uuid`, `$timestamp`. Conversations add `message`, `history`, `turn`, `conversation_id`, `session_id`.
- Filters: `json`, `raw`, `base64`, `dataurl`, `text`, `urlencode`, `upper`, `lower`, `trim`, `default(x)`, `join(sep)`, `first`, `last`, `length`.
- In JSON bodies, `{{x}}` inside quotes is escaped automatically; `{{x | json}}` inserts raw JSON.

## Scripts (escape hatches)

`runScript(code, args)` runs user JS in a `vm` context with `fetch`, `Buffer`, `crypto`, `require`. **Trust model:** scripts run with the user's permissions (like npm scripts). A hosted server mode must swap in a real sandbox.

## Providers

- Built on the Vercel AI SDK behind `createLlmClient`: `text`, `json`, `image`, `speech`, `transcribe`.
- Connections reference **credential sources**: secret names, AWS profiles/SSO, gcloud ADC, service-account files, `az` CLI tokens.
- Structured output schemas are made **strict** (all keys required, optional → nullable) so OpenAI's strict mode accepts them.
- `inferModelKind(model)` routes connection tests to the right API (text / image / speech / transcription).
- **Embeddings** (`providers/embeddings.ts`, `engine.embeddings`): a connection's embedding model via `embedMany`, or a local model (`Xenova/all-MiniLM-L6-v2`). The local Transformers.js + ONNX runtime (~100 MB) is not bundled: `download_embedding_model` installs it with the model into `~/Kalibra/models` (`KALIBRA_MODELS_DIR`), pruning other platforms' binaries. Vectors are LRU-cached. Used by `semantic_similarity`, meaning duplicates and failure themes.

## Sharing (`src/sharing/`)

- **Bundle** (`.kalibra`, zip via fflate): manifest + definitions + datasets (rows, optional media) + optional runs. Ids are remapped on import; conflicts: `rename`, `skip` or `new_version`. Secret values never leave; the report lists secret names to set.
- **Folder** (Git): `kalibra.json`, `targets/`, `suites/`, `connections/`, `datasets/<slug>/schema.json` + `rows.jsonl`, optional `media/`. Byte-stable (sorted keys, rows in dataset order, specs normalized through the current schema). Import diffs content hashes; `dryRun` previews; nothing is deleted without `prune`. System folders and the workspace itself are refused.
- **Importers**: promptfoo (tests → dataset, assertions → suite, http/model providers → targets), OpenAI Evals JSONL (+ graders file), LangSmith and Langfuse dataset exports. The report lists mapped checks and what could not be mapped.
