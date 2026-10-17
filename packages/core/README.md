# @kalibra/core

The engine. Everything Kalibra knows and does lives here: storage, datasets, targets, checks, runs, jobs, model providers, and the hub (accounts, projects, permissions, sign-in). The UI, CLI, HTTP API and MCP bridge are thin clients over its **operations**. Not published on its own: the CLI bundles it.

- **Code map:** [src/README.md](src/README.md), folder by folder.
- **Run:** nothing to start by itself. Use the CLI (`npm run dev` from the repo root) or embed it:
  ```ts
  const hub = new Hub({ dir: '/tmp/k', mode: 'local' });
  await hub.callProject(hub.localPrincipal(), 'default', 'list_datasets', {});
  ```
- **Test:** `npx vitest run packages/core` (tests in `test/`, one file per area). Typecheck: `npx tsc -p packages/core`.

## Where to start

| I want to… | Look at |
|---|---|
| add an operation (it appears in the UI API, CLI and MCP at once) | `src/ops/<area>.ts` (`defineOp`), register it in `src/ops/index.ts`; set `access` if the default role is wrong; `test/registry.test.ts` |
| add a check | `src/checks/<category>.ts` (`defineCheck`), register it in `src/checks/index.ts` `CHECK_TYPES`; the UI form is generated from `fields` |
| add a target kind | the config in `src/specs.ts` (`TargetSpec` union), the executor in `src/targets/<kind>.ts`, the dispatch in `src/targets/index.ts`; the form in `packages/web/src/components/targets/` |
| change the database | append a migration to `PROJECT_MIGRATIONS` in `src/db.ts` (project data) or `src/hub/schema.ts` (hub data). Never edit a migration that has shipped. |
| change who may do what | `src/registry.ts` (roles, `opAccess`), `src/hub/hub.ts` (`callProject`, `roleIn`, `capsFor`), `src/policy.ts` (code and folder policies) |
| change sign-in | `src/hub/accounts.ts` (passwords, sessions, tokens), `src/hub/providers.ts` and `src/hub/sso.ts` (OIDC, GitHub, gateways) |
| add a model provider | `src/providers/index.ts` (`PROVIDERS`, `providerFor`) |
| change how a run executes | `src/runner/runner.ts` (rows, retries, scoring), `src/runner/summary.ts` (pass rates, metrics) |
