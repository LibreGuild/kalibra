# Releasing (maintainers)

How a version gets to npm, PyPI, GHCR and GitHub Releases. Running Kalibra yourself is in [self-hosting.md](self-hosting.md).

1. Push a version tag; the tag is the version:
   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```
2. `.github/workflows/release.yml` then:
   - **stages** `kalibra` (the app) and `kalibra-sdk` (the JavaScript SDK) on npm (dist-tag `next` for pre-releases, `latest` otherwise);
   - publishes `kalibra-sdk` (the Python SDK) on PyPI (`0.3.0-beta.1` becomes `0.3.0b1`);
   - pushes the Docker image to GHCR (amd64 and arm64);
   - creates the GitHub release with install notes for npm and Docker (no files), marked pre-release for `-beta` / `-rc`.
3. **Approve the npm releases:** on npmjs.com open avatar → **Staged Packages**, check both versions, and approve them with 2FA. Only then do they go live; reject one to drop it.
4. Rerun a release: Actions → Release → Run workflow → enter the tag. Every step skips what is already published.

**npm publishing** uses trusted publishing (OIDC), so no npm token is stored anywhere:
- The `kalibra` and `kalibra-sdk` packages trust `LibreGuild/kalibra` → `release.yml` (npmjs.com → package → Settings → Trusted Publisher).
- That trust is limited to `npm stage publish`. A workflow, even a compromised one, can only propose a version; a maintainer with 2FA puts it live. This is npm's recommended setup. To let CI publish directly, delete the connection and create it again with "Allow npm publish" ticked.
- The very first version of each package (`kalibra` 0.1.0-beta.1, `kalibra-sdk` 0.2.1) was published by hand, because npm only allows trusted publishing for packages that already exist.

**PyPI publishing** also uses trusted publishing: the `kalibra-sdk` project trusts `LibreGuild/kalibra` → `release.yml` (pypi.org → project → Publishing). It was registered as a "pending publisher" before the first upload, so the first release created the project. PyPI has no staging: a release tag publishes the Python SDK directly.

**Docker image visibility:** images from a private repository start private on GHCR. To let anyone pull without logging in, open GitHub → LibreGuild → Packages → kalibra → Package settings → Change visibility → Public.

**Local equivalents:**

| What | Command |
|---|---|
| Image | `docker build -t kalibra:local .` |
| npm package contents | `npm pack -w kalibra --dry-run`, `npm pack -w kalibra-sdk --dry-run` |
| Python SDK package | `python -m build sdks/python && twine check --strict sdks/python/dist/*` |
| Set a version everywhere | `node scripts/set-version.mjs 0.2.0` (CI does this from the tag; also sets the Python SDK; pre-releases like `0.3.0-beta.1` become `0.3.0b1` there) |
