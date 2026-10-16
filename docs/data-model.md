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
| `runs` | dataset version, target/suite versions, settings, status, summary JSON |
| `results` | one per row × repetition: input, request, response, outputs, checks, metrics, logs |
| `blobs` | file metadata (hash, size, mime, name) |
| `labels` | human pass/fail per result and check (calibration) |
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

- `SecretStore` interface. Desktop: encrypted file with an OS-keychain key (Electron `safeStorage`). CLI/dev: `secrets.json` with 0600 permissions.
- Definitions only contain names. Values never appear in exports, logs (masked as `••••`) or MCP.

## Workspace folder

```
kalibra.db  kalibra.db-wal  kalibra.db-shm
blobs/
secrets.json (or secrets.enc)
.engine.json   (only while an engine is running)
```

Back it up like any folder. To share with a teammate today, copy the folder.
