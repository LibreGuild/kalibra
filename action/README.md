# Kalibra eval action

Runs a Kalibra suite against your app on your team server for every pull request, then comments on the PR with:
- the pass rate and its confidence interval;
- the change against the base branch;
- the rows that newly fail, with the reason.

The action keeps a single comment and updates it on every push.

```yaml
# .github/workflows/eval.yml
on:
  pull_request:
  push:
    branches: [main]   # runs on main become the baseline for pull requests

permissions:
  contents: read
  pull-requests: write

jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: LibreGuild/kalibra/action@v0
        with:
          server: https://kalibra.example.com
          token: ${{ secrets.KALIBRA_TOKEN }}   # Account → Access tokens in Kalibra
          project: Support bot
          dataset: Support questions
          target: Staging API
          suite: Chat checks
          min-pass: "0.9"                       # optional: fail the check below 90%
```

| Input | Default | |
|---|---|---|
| `server`, `token` | – | Your Kalibra team server and an access token (keep it in a secret) |
| `project`, `dataset`, `target`, `suite` | – | What to run |
| `min-pass` | empty | Fail the step below this pass rate (0–1) |
| `baseline` | `auto` | `auto` compares with the latest run on the base branch; or a run id |
| `comment` | `true` | Comment on the pull request |
| `kalibra-version` | `latest` | npm version or dist-tag of the CLI |

The same report is available without the action:

```bash
KALIBRA_URL=https://kalibra.example.com KALIBRA_TOKEN=kal_… \
  npx kalibra run --dataset … --target … --suite … --baseline auto --report markdown
```

`kalibra eval-report <runId>` prints it for a run that has already finished. Runs record their branch, commit and pull request automatically on GitHub Actions; set them with `--git-branch`, `--git-commit` and `--base-branch` elsewhere.
