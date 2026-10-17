# @kalibra/server

The HTTP API in front of the engine. It serves the built web UI, authenticates every request, and hands each call to the hub (`Hub.callProject` / `Hub.call`), which decides access. One server serves both local mode (`npx kalibra`: a per-launch token) and team-server mode (sessions, access tokens, sign-in providers).

## Code map

| File | Owns |
|---|---|
| `src/index.ts` | `startServer`: the route table (comment at the top lists every route), the `/kalibra` base path (redirect from `/`, 404 elsewhere), sign-in routes (`/kalibra/api/auth/*`, provider redirects), project routes (`/kalibra/api/projects/:p/ops`, events, files), CSRF and forced password change |
| `src/auth.ts` | who is calling: the local token, session cookies (`__Host-` over HTTPS), access tokens, gateway headers; Origin/Host checks; the sign-in rate limiter |
| `src/http.ts` | JSON responses and errors (`KalibraError` code → HTTP status), body reading, file streaming with Range and a sandbox CSP, the built UI with security headers |

New features rarely need a route: add an operation in `packages/core/src/ops/` and it is reachable at `POST /kalibra/api/projects/:p/ops/<name>` with permissions applied.

## Run and test

- Started by the CLI (`kalibra serve`, `kalibra server`). For development: `npm run dev` from the repo root.
- Tests: `npx vitest run packages/server` (in `test/`):
  - `server.test.ts`: local-mode hardening;
  - `server-mode.test.ts`: sign-in, CSRF, roles over HTTP;
  - `sso.test.ts`: fake OIDC/GitHub/gateway providers;
  - `security.test.ts`;
  - `uploads.test.ts`.
