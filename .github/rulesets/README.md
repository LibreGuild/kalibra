# Repository rules

These rulesets are applied to `LibreGuild/kalibra` (applied 2026-10-18, when the repository went public). This folder is the source of truth: after changing a file, update the live ruleset with its id from `gh api repos/LibreGuild/kalibra/rulesets`:

```sh
gh api -X PUT repos/LibreGuild/kalibra/rulesets/<id> --input .github/rulesets/main.json
gh api -X PUT repos/LibreGuild/kalibra/rulesets/<id> --input .github/rulesets/release-tags.json
```

- **main.json:**
  - changes reach `main` only through pull requests;
  - CI (`test`, `test-postgres` and `python-sdk`) must pass on an up-to-date branch;
  - review threads must be resolved;
  - squash merges only;
  - no force pushes or deletion.

  Organization admins can merge a pull request that doesn't meet these rules in an emergency, but can't push directly.
- **release-tags.json:** only organization admins can create, move or delete `v*` tags, which start releases.

Other repository settings:
- squash merge only, with branches deleted after merge;
- workflow tokens read-only by default and unable to approve pull requests;
- only GitHub-owned, verified and `docker/*` actions allowed, pinned to full commit SHAs;
- workflows from outside contributors' pull requests wait for a maintainer's approval;
- Dependabot alerts and security updates, secret scanning with push protection, CodeQL code scanning and private vulnerability reporting on.
