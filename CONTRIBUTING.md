# Contributing

1. Branch from `main` (`feature/…`, `fix/…`).
2. Keep changes focused. Run `npm run typecheck` and `npm test`, and add tests for new behaviour.
3. Open a pull request. CI (typecheck, tests, build and the Python SDK tests) must pass. Changes reach `main` through squash-merged pull requests only.
4. Releases are cut by maintainers with a version tag (`v0.1.1-beta.2`). Nothing is built for release or published on ordinary pushes or pull requests.

Code style, how to add an operation, check or page, and where things live: [docs/contributing.md](docs/contributing.md) and [docs/architecture.md](docs/architecture.md).
