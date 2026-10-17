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
- The cloud SDKs are loaded only when a bucket is configured.

## SQLite sync to the bucket (mode B)

- Every `KALIBRA_SQLITE_SYNC_SECONDS` (default 10) each changed database ships its new WAL pages to the bucket as one object; nothing is uploaded when nothing changed.
- Kalibra owns checkpointing (`wal_autocheckpoint=0`), so no change is missed; anything unexpected (WAL reset by another process, a gap) falls back to a fresh full snapshot.
- A new full snapshot (generation) is taken periodically and old generations are deleted, so a restore downloads one snapshot plus a bounded number of page sets.
- Layout: `<prefix>/sqlite/<db>/generations/<gen>/snapshot.db.gz`, `…/<gen>/pages/<seq>.gz`, `<prefix>/sqlite/<db>/manifest.json`, `<prefix>/lease.json`.
- On start: a database missing locally (or behind the bucket) is restored before it is opened; `PRAGMA integrity_check` must pass.
- On shutdown: a final sync. A crash loses at most the last interval; runs that were in progress come back as "interrupted" and can be resumed.

## Several instances (mode D)

What used to live in one process and where it lives now:

| State | Single instance | Several instances |
|---|---|---|
| Live updates to browsers | in-process event bus | Redis pub/sub (`kalibra:events`) |
| Session / user / membership / ingest-key lookups | in-process cache | Redis cache with TTL, invalidated on change (`kalibra:invalidate`) |
| Sign-in rate limits | in memory | Redis counters |
| Pending SSO sign-ins | database | database |
| Singleton background work (pruning, recovery sweeps) | timer | timer + Redis lock |
| A run in progress | the process that started it | same, plus a **lease** in the database renewed every 15 s; if the instance dies, another instance resumes the run from its last saved row |
| Cancelling a run | in-process signal | status in the database + an event, checked between rows |

Load balancers need no sticky sessions; live event streams reconnect to any instance.

## Not in scope (yet)

Workers as separate jobs (Cloud Run Jobs, ECS tasks), secret managers (Secret Manager, KMS, Vault), Postgres row-level multi-tenancy, LDAP/SAML.
