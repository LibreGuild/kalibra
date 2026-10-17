# Design: deployment modes (database, storage, Redis)

Kalibra runs as one container (or one `npx kalibra`/`kalibra server` process) in every mode. Three optional settings decide where state lives. Nothing changes for local users: with no settings it is SQLite and files in the data folder, exactly as before.

| Setting | Unset (default) | Set |
|---|---|---|
| `KALIBRA_DATABASE_URL` | SQLite files in the data folder | Postgres (`postgres://…`): Cloud SQL, RDS/Aurora, Azure, Neon, Supabase, self-run |
| `KALIBRA_STORAGE_URL` | uploaded files in the data folder | a bucket: `gs://bucket/prefix`, `s3://bucket/prefix`, `az://account/container/prefix` |
| `KALIBRA_REDIS_URL` | in-process cache, events and locks | Redis (`redis://`, `rediss://`): Memorystore, ElastiCache, Azure Cache, Upstash, self-run |

## Modes

| Mode | Settings | Instances | Use when |
|---|---|---|---|
| **A. Single** | none | 1 | laptop, one VM with a persistent disk |
| **B. Single + bucket** | storage | 1 | a VM or container whose disk can disappear: SQLite stays on local disk and is synced to the bucket every 10 s; a new machine restores from the bucket |
| **C. Postgres** | database (+ storage) | 1 | you already run Postgres and want its backups/HA; one instance |
| **D. Scaled** | database + storage + Redis | many | several instances behind a load balancer |

Rules checked at start (clear errors, no silent fallbacks):
- Redis requires Postgres (SQLite means one instance; Redis would add nothing).
- More than one instance (Redis set) requires bucket storage (files must be shared).
- A bucket or Postgres requires `KALIBRA_SECRET_KEY` (secrets must survive the machine and are stored encrypted in the database, not in a local file).
- Mode B takes a **lease** in the bucket; a second instance on the same bucket refuses to start (or with `--takeover` waits for the lease to expire).

## Data layer

- `Db` is asynchronous (`run`/`get`/`all`/`exec`/`tx`) with two drivers: SQLite (`node:sqlite`) and Postgres (`pg`).
- SQL stays SQLite-flavoured with `?` placeholders; the Postgres driver translates placeholders and the few dialect differences. DDL migrations exist per dialect; a test checks both define the same tables and columns.
- **Postgres layout:** one database; schema `kalibra_hub` for the hub and `kalibra_p_<projectId>` per project, so the per-project SQL is unchanged. One shared connection pool (`KALIBRA_DATABASE_POOL`, default 10); `search_path` is set on a connection only when it switches project.
- **Transactions:** SQLite serialises writers; Postgres transactions run `SERIALIZABLE` and are retried on serialization failures, so read-modify-write code (run numbers, versions, counters) keeps SQLite's guarantees.
- Migrations run under a Postgres advisory lock (several instances can start at once).
- `kalibra migrate --database-url … [--storage …]` copies an existing data folder (hub, every project, files) into Postgres and/or a bucket. `kalibra backup` writes a portable SQLite copy in every mode.

## Files (blob store)

- `FsBlobStore` (default) or a bucket store for GCS, S3 (and S3-compatible: `KALIBRA_S3_ENDPOINT` for MinIO/R2) and Azure Blob. Files are content-addressed (`files/aa/bb/<sha256>`), written once, never changed. Metadata stays in the database (`blobs` table).
- Reads stream from the bucket (ranges for audio seeking) through a bounded local cache in the data folder.
- Credentials come from each cloud's default chain: Google ADC (metadata server on GCP), the AWS chain (env, profile, instance/task role), Azure `DefaultAzureCredential` or `AZURE_STORAGE_CONNECTION_STRING`.
- The cloud SDKs are loaded only when a bucket is configured: they are separate chunks of the CLI bundle (`dist/chunks`, about 2.4 MB in all), not npm dependencies (installed, they would add ~120 MB to every `npx kalibra`).
- A project can only read files it has a `blobs` record of (the bucket copy is shared), like files on disk, which live per project.

## SQLite sync to the bucket (mode B)

- Every `KALIBRA_SQLITE_SYNC_SECONDS` (default 10) each changed database ships its new WAL pages to the bucket as one object; nothing is uploaded when nothing changed.
- Kalibra owns checkpointing (`wal_autocheckpoint=0`), so no change is missed; anything unexpected (WAL reset by another process, a gap) falls back to a fresh full snapshot.
- A new full snapshot (generation) is taken periodically and old generations are deleted, so a restore downloads one snapshot plus a bounded number of page sets.
- Layout: `<prefix>/sqlite/<db>/generations/<gen>/snapshot.db.gz`, `…/<gen>/pages/<seq>.gz`, `<prefix>/sqlite/<db>/manifest.json`, `<prefix>/lease.json`.
- On start: a database missing locally (or behind the bucket) is restored before it is opened; `PRAGMA integrity_check` must pass.
- On shutdown: a final sync. A crash loses at most the last interval; runs that were in progress come back as "interrupted" and can be resumed.
- `<file>.sync.json` next to each database records the generation and page set the local file matches (and its size/mtime at a clean close). On start: a clean, untouched file continues its generation; a file ahead of the bucket (crash, changes made while not syncing) starts a new snapshot; a file behind the bucket or never synced with it is moved aside (`*.behind-bucket-<time>.bak`) and restored.
- A failed upload or a WAL reset by another process falls back to a new snapshot, retried with back-off while the bucket keeps failing.
- Lease: renewed every 30 s, stale after 90 s; `--takeover` waits for staleness. A holder that finds its lease taken exits. At start Kalibra checks the bucket honours conditional writes and warns if not (GCS's S3-compatible API ignores them; S3, GCS, Azure and MinIO honour them).

## What stays in the local data folder

With a bucket (and with Postgres), nothing in the data folder is needed to rebuild Kalibra on a new machine:

| In the data folder | With a bucket / Postgres |
|---|---|
| `hub.db`, `kalibra.db`, `projects/*/kalibra.db` | synced to the bucket (SQLite) or in Postgres |
| `blobs/` (uploaded files) | in the bucket; `cache/files/` is a disposable local cache |
| `secrets.json`, `hub-secrets.json` | in the database, encrypted with `KALIBRA_SECRET_KEY`; an old file is imported once and renamed `.imported` |
| `<db>.sync.json`, `*.bak` | local bookkeeping and set-aside copies; safe to lose |
| `engine.json` | local mode only: how the CLI finds a running Kalibra; recreated at start |
| `~/Kalibra/models` (`KALIBRA_MODELS_DIR`) | the local embedding model: downloaded again on demand (built into the Docker image) |

Folders used for folder sync and `kalibra backup` output are wherever you point them.

## Several instances (mode D)

What used to live in one process and where it lives now. Everything goes through a `Coordinator` (`packages/core/src/coord/`): `LocalCoordinator` in memory for one instance, `RedisCoordinator` with `KALIBRA_REDIS_URL` (keys and channels prefixed `kalibra:`, so a Redis can be shared with other apps).

| State | One instance | Several instances |
|---|---|---|
| Live updates to browsers | in-process event bus | every event is also published on `kalibra:events` (tagged with its instance), and delivered to live streams on the others; each stream gets each event once |
| Session / token / user / role / project / ingest-key / settings lookups | read from the database each request (cached in memory with Postgres) | Redis cache, 60 s TTL; **any** committed hub write except bookkeeping (last seen, audit, pending sign-ins) bumps one epoch, so no write path can leave a stale entry; inside a transaction lookups read the database |
| Sign-in rate limits | sliding window in memory | sliding window in Redis (sorted set), shared |
| Pending SSO sign-ins | database (`sso_pending`, taken with one `DELETE … RETURNING`) | same |
| The one-time setup code | in memory, new each start | database, created once, so every instance prints the same link |
| A run in progress | the process that started it; a crash leaves it "interrupted" | a **lease** in the database (`runs.lease_owner`, `lease_until`, 45 s, renewed every 15 s). Every 30 s (under a Redis lock per project) an instance resumes runs nobody holds from their last saved row. Shutting down hands runs back at once; an instance that lost its lease stops without touching the run |
| Cancelling a run | in-process signal | `runs.cancel_requested` + a message on `kalibra:control`; the executing instance stops right away (or at its next renewal) |
| Background jobs (generation, transcription…) | in memory | still executed where started; their record (with a heartbeat) is in Redis, so `get_job`/`list_jobs`/`cancel_job` work everywhere and a job whose instance stopped shows as failed |
| Trace ids the runner sent (joining OpenTelemetry spans to rows) | in memory | also in Redis (30 min), so spans reaching another instance are still joined; "trace arrived" wakes the waiting runner through the event bus |
| Caches of compiled scripts/schemas, OIDC discovery, gateway sign-ins (60 s) | per process | per process (they hold nothing another instance could change, or expire quickly) |

Load balancers need no sticky sessions; live event streams reconnect to any instance.

## Not in scope (yet)

Workers as separate jobs (Cloud Run Jobs, ECS tasks), secret managers (Secret Manager, KMS, Vault), Postgres row-level multi-tenancy, LDAP/SAML.
