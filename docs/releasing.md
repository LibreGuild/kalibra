# Releasing (maintainers)

How a version gets to npm, GHCR and GitHub Releases. Running Kalibra yourself is in [self-hosting.md](self-hosting.md).

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
