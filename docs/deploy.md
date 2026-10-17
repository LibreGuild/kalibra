# Deploy and release

Ways to run Kalibra, and how a release is made. Sign-in and roles: [users-and-projects.md](users-and-projects.md).

## Ways to run

| | For | Get it |
|---|---|---|
| Desktop app | one person, no sign-in | installers from the GitHub release (unsigned for now) |
| `npx kalibra@next` | one person, in a browser, no install | npm (needs Node 22.13+) |
| Docker / `kalibra server` | a team, with sign-in | `ghcr.io/libreguild/kalibra:next` |

**Unsigned installers:**
- **macOS:** the first time, right-click the app → **Open** → Open. Or run `xattr -dr com.apple.quarantine /Applications/Kalibra.app`.
- **Windows:** SmartScreen shows "Windows protected your PC". Click **More info → Run anyway**.
- **Linux:** `chmod +x Kalibra-*.AppImage`, then run it.

## Docker

```sh
docker run -d --name kalibra -p 4317:4317 -v kalibra-data:/data \
  -e KALIBRA_PUBLIC_URL=https://kalibra.example.com \
  ghcr.io/libreguild/kalibra:next
docker logs kalibra        # one-time link to create the administrator
```

- Runs `kalibra server` as an unprivileged user (uid 1000). All data is in `/data`, and `/backups` is for backups.
- Health check: `GET /api/health`. `docker ps` shows `healthy`.
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
   git tag v0.1.0-beta.1 && git push origin v0.1.0-beta.1
   ```
2. `.github/workflows/release.yml` then:
   - builds the desktop installers on macOS (arm64 and x64), Windows and Linux;
   - creates the GitHub release with the installers and `SHA256SUMS.txt`, marked pre-release for `-beta` / `-rc`;
   - pushes the Docker image to GHCR;
   - **stages** `kalibra` on npm (dist-tag `next` for pre-releases, `latest` otherwise).
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
| Installers for this machine | `npm run build -w @kalibra/web && npm run build -w kalibra && npm run dist -w @kalibra/desktop -- --mac` (or `--win`, `--linux`); files land in `packages/desktop/release/` |
| npm package contents | `npm pack -w kalibra --dry-run` |
| Set a version everywhere | `node scripts/set-version.mjs 0.1.0-beta.2` (CI does this from the tag) |

## Limits for now

- **Installers are unsigned:** see the first-open steps above. Signing needs an Apple Developer ID and a Windows code-signing certificate.
- **No auto-update:** download new releases by hand.
- **The local embedding model in the desktop app** downloads its runtime with npm, so it needs Node.js installed. Without it, use an embedding model from a connection instead.
