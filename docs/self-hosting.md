# Self-hosting Kalibra

Everything you need to run Kalibra yourself: which setup to pick, what to set, and what happens. Sign-in providers and roles are in [users-and-projects.md](users-and-projects.md); how releases are made is in [releasing.md](releasing.md); the design behind this page is in [design/storage-and-scaling.md](design/storage-and-scaling.md).

## Pick a setup

Kalibra is one program (the npm package or the Docker image) in every setup. Three optional settings decide where its data lives:

| Setup | Set | Instances | Pick it when |
|---|---|---|---|
| **A. Single** (default) | nothing | 1 | a laptop, or a VM whose disk you keep |
| **B. Single + bucket** | `KALIBRA_STORAGE_URL` | 1 | a VM or container you may delete: the databases stay on local disk and sync to the bucket every 10 s; a new machine picks up where the old one stopped |
| **C. Postgres** | `KALIBRA_DATABASE_URL` (+ `KALIBRA_STORAGE_URL` if the disk may go away) | 1 | you already run Postgres and want its backups and failover |
| **D. Scaled** | `KALIBRA_DATABASE_URL` + `KALIBRA_STORAGE_URL` + `KALIBRA_REDIS_URL` | many | several instances behind a load balancer |

Start with A or B. A small team is well served by one instance; move to C or D later with [`kalibra migrate`](#moving-between-setups).

Kalibra checks the combination at start and stops with a clear message if something is missing (for example Redis without Postgres, or a bucket without `KALIBRA_SECRET_KEY`). The first log line names the setup it is using, without passwords.

## Run it

**npm** (Node.js 22.13 or newer):

```sh
npx kalibra@next                     # one person, opens the browser, no sign-in
npm i -g kalibra@next && kalibra     # the same, installed
kalibra server --host 0.0.0.0        # a team server with sign-in (port 4317)
```

**Docker** (amd64 and arm64; runs `kalibra server` as uid 1000; data in `/data`):

```sh
docker run -d --name kalibra -p 4317:4317 -v kalibra-data:/data \
  -e KALIBRA_PUBLIC_URL=https://kalibra.example.com \
  ghcr.io/libreguild/kalibra:next
docker logs kalibra                  # one-time link to create the administrator
```

Open `<address>/kalibra/`. With HTTPS on one machine, [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) runs Kalibra behind Caddy, which gets the certificate itself (`cp .env.example .env`, set your DNS name, `docker compose up -d`).

The image is minimal (distroless: Node.js only, no shell). Run commands in it with `docker exec kalibra /nodejs/bin/node /app/kalibra.mjs <command>`.

## Settings

Every flag has an environment variable; flags win.

**Where data lives**

| Variable (flag) | Default | What it does |
|---|---|---|
| `KALIBRA_DIR` (`--dir`) | `~/Kalibra/default`, `/data` in Docker | The data folder. In setups B–D it only holds caches and can be thrown away. |
| `KALIBRA_DATABASE_URL` (`--database-url`) | SQLite in the data folder | Postgres, see [Postgres](#postgres) |
| `KALIBRA_DATABASE_SCHEMA` | `kalibra` | Schema prefix (`kalibra_hub`, `kalibra_p_<project>`), so several Kalibras can share one database |
| `KALIBRA_DATABASE_POOL` | `10` | Most Postgres connections per instance |
| `KALIBRA_STORAGE_URL` (`--storage`) | the data folder | A bucket, see [Buckets](#buckets) |
| `KALIBRA_SQLITE_SYNC_SECONDS` | `10` | Setup B: how often changed databases sync to the bucket |
| `KALIBRA_CACHE_MAX_MB` | `1024` | Local cache for files read from the bucket |
| `KALIBRA_TAKEOVER=1` (`--takeover`) | off | Setup B: instead of refusing to start while another instance holds the bucket, ask it to hand over (or wait for its lease to expire if it stopped). Set it wherever a new instance starts before the old one stops (Cloud Run, Kubernetes) |
| `KALIBRA_REDIS_URL` (`--redis-url`) | none | Setup D, see [Several instances](#several-instances) |
| `KALIBRA_SECRET_KEY` | none | Required with Postgres or a bucket. Encrypts provider keys stored in the database. Create with `openssl rand -base64 32` and keep it safe: without it, stored provider keys can't be read and must be entered again. |

**Server**

| Variable (flag) | Default | What it does |
|---|---|---|
| `KALIBRA_PORT` (`--port`) | `4317` | Port |
| `KALIBRA_HOST` (`--host`) | `127.0.0.1` (`0.0.0.0` in Docker) | Listen address |
| `KALIBRA_PUBLIC_URL` (`--public-url`) | none | The address people use, e.g. `https://kalibra.example.com` (sign-in callbacks are built from it) |
| `KALIBRA_TRUST_PROXY=1` (`--trust-proxy`) | off | Behind a proxy or load balancer: use `X-Forwarded-*` |
| `KALIBRA_ADMIN_USERNAME`, `KALIBRA_ADMIN_PASSWORD` | none | Create the first administrator at start (otherwise use the one-time link in the log) |
| `KALIBRA_FOLDER_ROOT` (`--folder-root`) | off | Allow Git folder sync inside this folder |
| Sign-in providers | none | `KALIBRA_GOOGLE_*`, `KALIBRA_GITHUB_*`, `KALIBRA_MICROSOFT_*`, `KALIBRA_OIDC_*`, `KALIBRA_PROXY_*`: see [users-and-projects.md](users-and-projects.md#sign-in-providers) |

## Addresses and load balancers

Everything Kalibra serves starts with `/kalibra`: the UI at `/kalibra/` (`/` redirects there), the API, sign-in, live updates and files at `/kalibra/api/…`, traces from apps at `/kalibra/api/projects/<project>/…`, and the health check at `/kalibra/api/health`. Anything else is `404`. Settings that take an address (`KALIBRA_PUBLIC_URL`, `KALIBRA_URL`, `--server`) take the origin; Kalibra adds `/kalibra`.

Behind a load balancer (Google Cloud Load Balancing, AWS ALB, Azure Application Gateway, nginx, Traefik):
- route `/kalibra` and `/kalibra/*` to port 4317; health check `/kalibra/api/health`;
- live updates are a long event stream: an idle timeout of a minute or more (Kalibra sends a keep-alive every 30 s), no response buffering;
- set `KALIBRA_TRUST_PROXY=1`, so sign-in limits see each user's address (otherwise a few wrong passwords from anyone lock everyone out for 10 minutes);
- no sticky sessions needed, even with several instances.

## Buckets

`KALIBRA_STORAGE_URL` is one of:

| Cloud | URL | Credentials (each cloud's usual chain) | Permission on the bucket |
|---|---|---|---|
| Google Cloud Storage | `gs://bucket/prefix` | the VM's or Cloud Run's service account; elsewhere `GOOGLE_APPLICATION_CREDENTIALS` | Storage Object Admin |
| Amazon S3 | `s3://bucket/prefix` (+ `KALIBRA_S3_REGION` or `AWS_REGION`) | instance or task role, `AWS_PROFILE`, or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` | `s3:GetObject`, `PutObject`, `DeleteObject`, `ListBucket` |
| S3-compatible (MinIO, Cloudflare R2) | `s3://bucket/prefix` + `KALIBRA_S3_ENDPOINT=https://…` | access key variables as for S3 | read, write, delete, list |
| Azure Blob Storage | `az://account/container/prefix` | managed identity or `az login` (DefaultAzureCredential), or `AZURE_STORAGE_CONNECTION_STRING` | Storage Blob Data Contributor |

Use a private bucket in the same region as Kalibra (traffic between them is then free). Uploaded files are stored once, by content (`<prefix>/files/…`), and read through a local cache.

**With SQLite (setup B)** the bucket also holds the databases:
- Every 10 s, each database that changed uploads its new pages as one object; an idle Kalibra uploads nothing. Now and then a fresh full copy is written and older ones are removed.
- On start, a database that is missing locally (a new machine) or older than the bucket is restored before Kalibra opens it, and checked for integrity.
- On a normal stop Kalibra syncs once more. After a crash, at most the last 10 s are lost; runs that were in progress show as "interrupted" and can be resumed.
- **Make "stop" reach Kalibra.** Docker hosts with `live-restore` (Google's Container-Optimized OS among them) leave containers running when the machine shuts down, so Kalibra is killed after the network is gone and can't sync or give the lease back. Stop the container first, e.g. on a Compute Engine VM a shutdown script (metadata `shutdown-script`): `docker stop -t 30 kalibra`. Tested: with it, stopping the VM synced and released the lease; without it, the next machine waited for the lease to expire (about 90 s) and, if the last write was under 10 s old, could miss it.
- **Cloud Run:** deleting a service doesn't stop its instance at once (it can keep running for a minute or so), and a new service on the same bucket would wait for its lease. With `KALIBRA_TAKEOVER=1` the new instance asks the old one to hand over, which works for both redeploys and delete-and-recreate.
- Only one machine may use a bucket prefix at a time. Kalibra holds a lease in the bucket and a second instance refuses to start.
- **Rolling deploys** (a new Cloud Run revision, a Kubernetes update, a new VM before the old one is gone) start the new instance while the old one still runs. Start Kalibra with `KALIBRA_TAKEOVER=1`: the new instance asks the old one to hand over. Within a few seconds the old one stops serving data, lets requests in progress finish, syncs one last time and gives the lease back; the new one restores and starts serving. Kalibra opens its port only after that, so the platform keeps sending people to the old instance until the new one is ready (Cloud Run's default startup check, which waits for the port, is enough; allow it a minute). Meanwhile the old instance answers `503` with `Retry-After: 5` ("Kalibra is moving to a new instance. Try again in a few seconds."), which people see for those few seconds, and runs in progress show as interrupted and can be resumed. If the old instance doesn't answer (it crashed, or runs an older Kalibra), the new one waits until its lease expires, about 90 s after its last check-in. If no new instance takes over within 2 minutes, the old one exits so the platform starts it again.
- Cost: about one upload per changed database per sync (GCS/S3 charge about $0.005 per 1,000) plus storage, typically a few dollars a month or less. Raise `KALIBRA_SQLITE_SYNC_SECONDS` to upload less often.

## Postgres

Any Postgres 14 or newer: Cloud SQL, Amazon RDS/Aurora, Azure Database for PostgreSQL, Neon, Supabase, or your own. Kalibra keeps everything in schemas `kalibra_hub` and `kalibra_p_<project>` and creates them itself, so the user needs to be allowed to create schemas in its database:

```sql
CREATE DATABASE kalibra;
CREATE USER kalibra WITH PASSWORD '…';
GRANT CONNECT, CREATE ON DATABASE kalibra TO kalibra;
```

| Where | `KALIBRA_DATABASE_URL` |
|---|---|
| Cloud SQL from Cloud Run (socket) | `postgres://kalibra:PASSWORD@/kalibra?host=/cloudsql/PROJECT:REGION:INSTANCE` (and `--add-cloudsql-instances` on the service) |
| Cloud SQL from a VM (private IP or the Auth Proxy) | `postgres://kalibra:PASSWORD@10.0.0.5:5432/kalibra` |
| RDS, Azure, Neon, Supabase | `postgres://kalibra:PASSWORD@HOST:5432/kalibra?sslmode=require` |

URL-encode special characters in the password. Tables are created and upgraded at start (several instances can start together). Back up with your provider's automated backups; `kalibra backup <folder>` also writes a portable SQLite copy of everything.

## Several instances

Setup D runs any number of identical instances behind a load balancer. Redis (`redis://` or `rediss://` for TLS: Memorystore, ElastiCache, Azure Cache for Redis, Upstash, or your own) carries what used to live in one process:
- live updates reach browsers connected to any instance;
- sign-in, user, role and key lookups are cached and refreshed on every change;
- sign-in limits are shared;
- a run belongs to the instance running it, which renews a lease every 15 s; if that instance dies, another resumes the run from its last saved row, and stopping one instance hands its runs to the others;
- cancelling a run or job works from any instance.

Memorystore and ElastiCache have private addresses only: run Kalibra in the same network (on Cloud Run, use Direct VPC egress). Command-line tools on another machine (`kalibra users …`) without `KALIBRA_REDIS_URL` change the database directly; servers pick the change up within 60 s.

Postgres without Redis (setup C) is for one instance only: Kalibra warns at start.

## Where to run it

| | Cheapest that works | Scales out |
|---|---|---|
| Google Cloud | a small Compute Engine VM (e2-small) with setup A on a persistent disk, or B with a bucket; stop it when idle | Cloud Run + Cloud SQL + Memorystore + Cloud Storage (setup D) |
| AWS | an EC2 instance with A or B (S3) | ECS Fargate + RDS/Aurora + ElastiCache + S3 |
| Azure | a VM with A or B (Blob Storage) | Container Apps + Azure Database for PostgreSQL + Azure Cache for Redis + Blob Storage |

Runs execute inside the server, so the server must be running while a run is in progress; closing the browser doesn't matter. On platforms that stop idle containers (Cloud Run, Container Apps), keep at least one instance running (minimum instances 1, CPU always allocated) if runs take longer than a few minutes; otherwise a stopped run shows as interrupted (setups A–C) or is resumed by the next instance (setup D).

## Moving between setups

```sh
# From a data folder (setup A) to Postgres and/or a bucket. Stop Kalibra first.
KALIBRA_SECRET_KEY=… kalibra migrate --dir ~/Kalibra/default \
  --database-url postgres://… --storage gs://my-bucket/kalibra
kalibra migrate --dir … --storage … --dry-run    # show what would be copied
```

It copies users, projects (including those in the trash), every project's data, uploaded files and stored provider keys (encrypted with `KALIBRA_SECRET_KEY`), refuses a target that already has data, and checks the row counts at the end by reading the target back. The source folder is never changed; everyone signs in again afterwards (sessions aren't moved).

- `--storage` alone (setup B): each database is uploaded as the first snapshot of its bucket sync, the same way a running Kalibra does it.
- `--database-url` alone (setup C with files on disk): files stay in the folder, so run Kalibra with `--dir` pointing at it (or migrate again with `--storage` to move them).
- `--force` deletes the target's data before copying. It can't be undone.

## Back up, restore, upgrade

| Setup | Back up | Restore |
|---|---|---|
| A | `kalibra backup <folder>` (safe while running) or disk snapshots | stop Kalibra, put the folder in place of the data folder (or point `--dir` at it) |
| B | the bucket is the backup (keep versioning or a copy job on it); `kalibra backup` too | start on any machine with the same `KALIBRA_STORAGE_URL` and `KALIBRA_SECRET_KEY` |
| C, D | your Postgres backups plus the bucket; `kalibra backup` writes a portable SQLite copy | restore Postgres and point Kalibra at it |

In Docker: `docker exec kalibra /nodejs/bin/node /app/kalibra.mjs backup /backups/$(date +%F)`.

**Upgrade:** install the new version or pull the new image and restart. Databases upgrade themselves at start; back up first, since an older version refuses data written by a newer one. **Locked out:** on the server's machine, `kalibra users reset-password <name>` (Docker: `docker exec -it kalibra /nodejs/bin/node /app/kalibra.mjs users reset-password admin`).

## Limits

- Provider keys are encrypted with one `KALIBRA_SECRET_KEY`; changing the key isn't supported yet (enter the keys again after a change).
- Runs execute in the server process; separate workers (Cloud Run Jobs, ECS tasks) aren't supported yet.
- The local embedding model downloads its runtime once (network needed); in Docker it is built in.
