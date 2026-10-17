# Deploy and release

Ways to run Kalibra, and how a release is made. Sign-in and roles: [users-and-projects.md](users-and-projects.md).

## Ways to run

| | For | Get it |
|---|---|---|
| `npx kalibra@next` | one person, in a browser, no install | npm (needs Node 22.13+) |
| `npm i -g kalibra@next`, then `kalibra` | the same, as a command you keep | npm |
| Docker / `kalibra server` | a team, with sign-in | `ghcr.io/libreguild/kalibra:next` |

Kalibra is for developers, so it ships as the npm package and the Docker image only. There are no desktop installers (they were dropped on 2026-10-17).

## Addresses: everything under `/kalibra`

Every address Kalibra serves starts with `/kalibra`:

| What | Address |
|---|---|
| UI | `/kalibra/` (`/` redirects there) |
| API, sign-in, live events, files | `/kalibra/api/…` |
| Health check | `/kalibra/api/health` |
| Traces from apps (SDKs, OpenTelemetry, OpenAI proxy) | `/kalibra/api/projects/<project>/…` |

Anything else is `404`. `KALIBRA_PUBLIC_URL`, `KALIBRA_URL` and `--server` take the origin (`https://kalibra.example.com`); Kalibra adds `/kalibra` itself, and an address that already ends in `/kalibra` works too.

**Behind a load balancer** (AWS ALB, Google Cloud Load Balancing, nginx, Traefik…): route the path prefix `/kalibra/*` (and `/kalibra`) to Kalibra's port 4317, and use `/kalibra/api/health` as the health check. Other apps can share the same host name on other paths. Live updates are a long-lived event stream (`/kalibra/api/projects/<p>/events`): give that route an idle timeout of a minute or more (Kalibra sends a keep-alive every 30 s) and turn off response buffering.

## Docker

```sh
docker run -d --name kalibra -p 4317:4317 -v kalibra-data:/data \
  -e KALIBRA_PUBLIC_URL=https://kalibra.example.com \
  ghcr.io/libreguild/kalibra:next
docker logs kalibra        # one-time link to create the administrator
```

- Runs `kalibra server` as an unprivileged user (uid 1000). All data is in `/data`, and `/backups` is for backups.
- Health check: `GET /kalibra/api/health`. `docker ps` shows `healthy`.
- The UI is at `https://kalibra.example.com/kalibra/` (see [Addresses](#addresses-everything-under-kalibra)).
- Images exist for amd64 and arm64. Tags: `<version>`, `next` (newest pre-release) and `latest` (newest stable).
- Environment variables:
  - `KALIBRA_PUBLIC_URL`;
  - `KALIBRA_TRUST_PROXY=1` behind a proxy;
  - `KALIBRA_ADMIN_USERNAME` / `KALIBRA_ADMIN_PASSWORD`;
  - the sign-in providers listed in [users-and-projects.md](users-and-projects.md#sign-in-providers);
  - `KALIBRA_FOLDER_ROOT` to allow folder sync.

**With HTTPS:** [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) runs Kalibra behind Caddy, which gets the certificate automatically:

```sh
cd deploy
cp .env.example .env            # optional: providers, first administrator
# set your DNS name in Caddyfile and KALIBRA_PUBLIC_URL in docker-compose.yml
docker compose up -d
docker compose logs kalibra     # setup link
```

## Back up, restore, upgrade

```sh
# Consistent snapshot, safe while running (databases via SQLite VACUUM INTO, files copied)
kalibra backup /path/to/backup-2026-10-17
# In Docker / Compose
docker compose exec kalibra node /app/kalibra.mjs backup /backups/$(date +%F)
docker compose cp kalibra:/backups ./backups
```

- **Restore:** stop Kalibra, then put the backup folder in place of the data folder. For Docker, copy it into the `/data` volume. Or point `--dir` / `KALIBRA_DIR` at the backup folder.
- **Upgrade:** pull the new image (or install the new version) and start it. Databases migrate forward automatically on start. Back up first; an older version refuses to open data written by a newer one.
- **Locked out:** on the server's machine, run `kalibra users reset-password <name>` (in Docker: `docker exec -it kalibra node /app/kalibra.mjs users reset-password admin`).

## Releasing (maintainers)

1. Push a version tag; the tag is the version:
   ```sh
   git tag v0.1.1-beta.1 && git push origin v0.1.1-beta.1
   ```
2. `.github/workflows/release.yml` then:
   - **stages** `kalibra` on npm (dist-tag `next` for pre-releases, `latest` otherwise);
   - pushes the Docker image to GHCR (amd64 and arm64);
   - creates the GitHub release with install notes for npm and Docker (no files), marked pre-release for `-beta` / `-rc`.
3. **Approve the npm release:** on npmjs.com open avatar → **Staged Packages**, check the version, and approve it with 2FA. Only then does it go live; reject it to drop it.
4. Rerun a release: Actions → Release → Run workflow → enter the tag.

**npm publishing** uses trusted publishing (OIDC), so no npm token is stored anywhere:
- The `kalibra` package trusts `LibreGuild/kalibra` → `release.yml` (npmjs.com → kalibra → Settings → Trusted Publisher).
- That trust is limited to `npm stage publish`. A workflow, even a compromised one, can only propose a version; a maintainer with 2FA puts it live. This is npm's recommended setup. To let CI publish directly, delete the connection and create it again with "Allow npm publish" ticked.
- The very first version (`0.1.0-beta.1`) was published by hand, because npm only allows trusted publishing for packages that already exist.

**Docker image visibility:** images from a private repository start private on GHCR. To let anyone pull without logging in, open GitHub → LibreGuild → Packages → kalibra → Package settings → Change visibility → Public.

**Local equivalents:**

| What | Command |
|---|---|
| Image | `docker build -t kalibra:local .` |
| npm package contents | `npm pack -w kalibra --dry-run` |
| Set a version everywhere | `node scripts/set-version.mjs 0.1.1-beta.1` (CI does this from the tag; also sets the Python SDK's `0.1.1b1`) |

## Limits for now

- **No auto-update:** `npx kalibra@next` always runs the newest `next`; a global install updates with `npm i -g kalibra@next`; Docker with `docker pull`.
- **The local embedding model** downloads its runtime with npm the first time, so it needs network access once. Without it, use an embedding model from a connection instead.
