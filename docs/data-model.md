# Data model

SQLite via Node's built-in `node:sqlite` (no native modules), WAL mode. Migrations are an array in `packages/core/src/db.ts` tracked with `PRAGMA user_version`.

## Tables

| Table | Holds |
|---|---|
| `datasets` | name, description, `schema` (columns + instructions JSON), `revision` |
| `rows` | current row: `data` JSON, tags, status (`draft` / `needs_review` / `approved` / `rejected`), split, provenance, `rev` |
| `row_revs` | every content revision of a row (append-only) |
| `dataset_versions` + `dataset_version_rows` | immutable snapshots: which row at which revision |
| `defs` + `def_versions` | targets, suites, connections (kind + spec JSON), every saved version |
| `runs` | dataset version, target/suite versions, settings (incl. `overrides`, `conversation`), status, summary JSON, `group_id` + `variant_label` for comparisons |
| `run_groups` | comparisons: name, dataset, suite, settings with the variant list |
| `results` | one per row × repetition: input, request, response, outputs, checks, metrics, logs, `steps` (the app's trace steps, when it sent one) |
| `blobs` | file metadata (hash, size, mime, name) |
| `labels` | human pass/fail per result and check (calibration) |
| `insights` | saved analyses by `kind` + subject (e.g. `failure_themes` per run); the latest wins |
| `meta` | workspace settings, e.g. the Git sync folder |
| `traces` + `spans` | what apps sent (SDK, OpenTelemetry, OpenAI proxy): name, source, status, input/output, metadata, `run_id`/`result_id` when joined to a run row; spans with kind (`llm`/`tool`/`retrieval`/`agent`/`step`), parent, timing, attributes. Pruned after `retentionDays` (meta `traces`), except traces of runs |
| `tool_recordings` | tool responses by `(tool, args_hash)` for replay; `args_hash` = SHA-256 of canonical JSON (sorted keys, no spaces) |
| `activity` | who changed what (actor + op + summary) |

## Versioning rules

- **Datasets**: editing a row bumps its `rev` and appends to `row_revs`. A run snapshots the dataset first (reusing the last version if nothing changed), so results always point at exact row content.
- **Definitions**: every save that changes the spec creates a new `def_versions` row. Runs pin `target_version` and `suite_version`.
- **Optimistic concurrency**: updates accept `baseVersion` / `baseRevision` / `baseRev`. A stale write fails with `conflict`, and the UI or agent reloads and re-applies. This matters already, because the UI and an MCP agent can edit the same item.
- **Soft deletes**: `deleted_at` everywhere; past runs keep working.

## Files (blob store)

- Content-addressed: `blobs/ab/cd/<sha256>`; identical files are stored once.
- Dataset cells for audio/image/file columns hold `{ blob, name, mime, size }`.
- Served with Range support (`GET /api/files/:hash`) so audio can seek.

## Secrets

- `SecretStore` interface. Default: `secrets.json` in the project folder with 0600 permissions (a team server can plug in Vault/KMS behind the same interface).
- Definitions only contain names. Values never appear in exports, logs (masked as `••••`) or MCP.

## Data folder

```
hub.db                       accounts, sessions, tokens, ingest keys, projects, members, groups, settings, audit (src/hub/schema.ts)
hub-secrets.json             client secrets of sign-in providers made in the app (servers)
kalibra.db  blobs/  secrets.json (or secrets.enc)     the default project
projects/<id>/kalibra.db  blobs/  secrets.*           every other project
.engine.json                 only while a local engine is running
```

The tables above live in each project's `kalibra.db`; the hub's tables are listed in [users-and-projects.md](users-and-projects.md).

Back it up like any folder. To share with a teammate, export a `.kalibra` bundle or sync a Git folder (Settings → Share with your team); see [engine.md](engine.md#sharing-srcsharing).
