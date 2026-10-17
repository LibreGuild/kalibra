# Repository rules

GitHub only enforces branch and tag rules on private repositories with GitHub Pro/Team (or once the repository is public). Apply these then:

```sh
gh api -X POST repos/LibreGuild/kalibra/rulesets --input .github/rulesets/main.json
gh api -X POST repos/LibreGuild/kalibra/rulesets --input .github/rulesets/release-tags.json
```

- **main.json:**
  - changes reach `main` only through pull requests;
  - CI (`test` and `python-sdk`) must pass on an up-to-date branch;
  - review threads must be resolved;
  - squash merges only;
  - no force pushes or deletion.

  Organization admins can merge a pull request that doesn't meet these rules in an emergency, but can't push directly.
- **release-tags.json:** only organization admins can create, move or delete `v*` tags, which start releases.

Settings already applied, which don't need a paid plan:
- squash merge only, with branches deleted after merge;
- workflow tokens read-only by default and unable to approve pull requests;
- only GitHub-owned, verified and `docker/*` actions allowed;
- Dependabot alerts and security updates on.
