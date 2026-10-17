# Users, projects and permissions

How Kalibra decides who can see and change what. Code: `packages/core/src/hub/`, `packages/core/src/policy.ts`, `packages/server/src/`.

## Two ways to run

| | Local (desktop app, `npx kalibra`) | Team server (`kalibra server`) |
|---|---|---|
| Sign-in | none: one person, the computer's own login is the lock | required |
| API protection | per-launch token + Host/Origin must be this machine | session cookie (browser) or access token (agents, CLI) |
| Projects | yes | yes, with members and roles |
| Users, groups, members | hidden | managed by administrators and project owners |

Same code, same UI. The UI asks `GET /api/auth/status` for the mode and hides account features locally.

## Data layout

```
<data folder>/                  KALIBRA_DIR, default ~/Kalibra/default
  hub.db                        users, sessions, tokens, projects, members, groups, settings, audit log
  kalibra.db  blobs/  secrets   the default project (the workspace from before projects existed)
  projects/<id>/                every other project: its own kalibra.db, blobs/, secrets
```

One database per project means a missing `WHERE project_id = ?` can never leak data between projects; each project is an ordinary `Engine`. The hub (`Hub` class) opens one engine per project.

## Roles

**Server role**: `admin` (manage users, groups, settings; owner of every project) or `user`.

**Project role**, lowest to highest:

| Role | Can |
|---|---|
| viewer | read everything in the project, export a bundle |
| editor | also create, change, run, and anything that spends money or uses the project's secrets (model calls, test calls) |
| owner | also members, connections, secrets, folder sync |

A user's role is the highest of their own membership and their groups' memberships. Projects you are not a member of return "not found".

Every operation declares the role it needs (`access` in `defineOp`; default viewer for read-only, editor otherwise). `registry.test` and `hub.test` pin the important ones.

## One choke point

```
HTTP / MCP / CLI ─► Hub.callProject(principal, project, op, input)
                      ├─ project live and visible to the caller?        (else not_found)
                      ├─ caller's role (member / group / admin)
                      └─ Engine.call(op, input, actor, { role, caps })   (op's role checked in Registry)
```

`caps` (capabilities) are host policies on top of roles:
- **code**: may add or change JavaScript (script targets, hooks, expressions, script checks). Server setting `codePolicy`: `admins` (default on servers) or `everyone`. Checked where definitions are written (`DefRepo`), for unsaved specs in test calls, for run overrides, and for imports (bundles are refused whole; importers drop code checks and list them).
- **filesystem**: folder sync reads and writes the *server's* disk, so it is off on servers unless `--folder-root` confines it to one folder.
- **showPaths**: servers don't reveal their folder paths.

The current operation's context travels with the async call (`policy.ts`, `AsyncLocalStorage`), so deep code (e.g. an import creating definitions) can check it without passing it around.

## Accounts

- Passwords: scrypt (N=2¹⁷, r=8, p=1), at least 10 characters, not common, not containing the username. Five wrong passwords lock the account for 15 minutes; sign-in is also rate-limited per IP.
- First administrator: a one-time setup link printed at start (`/setup?code=…`), or `KALIBRA_ADMIN_USERNAME` / `KALIBRA_ADMIN_PASSWORD`. Accounts created with a starting password must change it at first sign-in.
- Sessions: random cookie (`__Host-kalibra_session` over HTTPS), only its SHA-256 stored, `HttpOnly; SameSite=Lax`, 14 days by default. Writes with a cookie must carry our `Origin` (CSRF).
- Access tokens (`kal_…`): for coding agents (MCP), the CLI and scripts. Shown once, stored as SHA-256, optional expiry, revocable. Tokens can do project work but never account management or secret values.
- Recovery from the server's machine: `kalibra users list | create | reset-password | make-admin`.
- The audit log (`list_audit`) records sign-ins, failures, and changes to accounts, members and settings.

## Sign-in providers

Besides passwords, a server can let people sign in through:

| Kind | Covers | The Kalibra server must reach |
|---|---|---|
| `oidc` | Google, Microsoft Entra, Okta, Auth0, Keycloak, GitLab, Dex, Authentik, most company SSO | the provider's issuer URL |
| `github` | github.com and GitHub Enterprise Server (`githubUrl`) | the GitHub server |
| `proxy` | a login gateway in front of Kalibra (Google IAP, Cloudflare Access, oauth2-proxy) | the JWKS URL (JWT mode) |

During sign-in the browser goes to the provider and back. The Kalibra server then calls the provider directly to exchange the code. An internal GitHub Enterprise that is only reachable inside an office therefore works when Kalibra also runs inside that network (or reaches it over VPN/interconnect).

**Who gets in**, set per provider:
- allowed email domains (verified emails only);
- allowed groups (an OIDC groups claim, or GitHub organisations and `org/team`);
- **invite-only by default**: an administrator creates the account with the person's email, and their first sign-in links to it;
- or automatic account creation for people who pass the rules;
- admin groups (members become administrators);
- mirrored groups (provider groups become Kalibra groups you can add to projects).

Configure providers in the app (Administration → Sign-in), or with environment variables. The app keeps client secrets write-only.

```sh
# Google, limited to one domain (accounts are created automatically because a domain is set)
KALIBRA_GOOGLE_CLIENT_ID=… KALIBRA_GOOGLE_CLIENT_SECRET=… KALIBRA_GOOGLE_DOMAINS=example.com
# GitHub Enterprise, limited to organisations
KALIBRA_GITHUB_URL=https://github.mycompany.com KALIBRA_GITHUB_CLIENT_ID=… KALIBRA_GITHUB_CLIENT_SECRET=… KALIBRA_GITHUB_ORGS=evals
# Any OIDC provider (company SSO, Keycloak, Okta…)
KALIBRA_OIDC_ISSUER=https://sso.example.com KALIBRA_OIDC_CLIENT_ID=… KALIBRA_OIDC_CLIENT_SECRET=… KALIBRA_OIDC_NAME="Company sign-in" KALIBRA_OIDC_GROUPS_CLAIM=groups
# Microsoft Entra (tenant id required)
KALIBRA_MICROSOFT_TENANT=… KALIBRA_MICROSOFT_CLIENT_ID=… KALIBRA_MICROSOFT_CLIENT_SECRET=…
# A login gateway passing a signed JWT (e.g. Google IAP)
KALIBRA_PROXY_JWT_HEADER=X-Goog-IAP-JWT-Assertion KALIBRA_PROXY_JWKS_URL=https://www.gstatic.com/iap/verify/public_key-jwk KALIBRA_PROXY_AUDIENCE=/projects/…/global/backendServices/…
# Several providers or every option: a JSON file, secrets as "env:NAME" or "file:/path"
KALIBRA_AUTH_CONFIG=/etc/kalibra/auth.json
```

Register the callback URL `https://<your server>/api/auth/sso/<provider id>/callback` at the provider. Kalibra needs no account with Google, GitHub or anyone else: each deployment registers its own OAuth client.

If a provider breaks, administrators can still sign in with a password even when password sign-in is turned off for everyone else. As a last resort, use `kalibra users reset-password` on the server.

## Running a team server

```sh
npm run build                      # or use the published package
KALIBRA_DIR=/srv/kalibra \
KALIBRA_PUBLIC_URL=https://kalibra.example.com \
  node packages/cli/dist/kalibra.mjs server --host 127.0.0.1 --port 4317 --trust-proxy
```

- Put a TLS reverse proxy (nginx, Caddy, a cloud load balancer) in front and pass `--trust-proxy`, so client addresses and HTTPS are known. Sessions use `__Host-` cookies over HTTPS.
- The first start prints a one-time link to create the administrator. Alternatively, set `KALIBRA_ADMIN_USERNAME` / `KALIBRA_ADMIN_PASSWORD`.
- Back up the data folder (`hub.db`, each project's `kalibra.db`, `blobs/`, secret files). It is the whole state.
- Run as an unprivileged user, ideally in a container: script targets and checks run JavaScript with the server's permissions.
- The desktop app connects to servers from **Servers → Connect to a team server…**. Each server opens in its own window and signs in on its own page.

## Agents (MCP)

- Local: the bridge finds the running app through `<data>/.engine.json`.
- Server: `kalibra mcp --server https://kalibra.example.com --project <name>` with `KALIBRA_TOKEN` set.

The bridge exposes project operations, hub operations (e.g. `list_projects`) and `use_project` to switch.

## Known limits

- Editors can use the project's secrets through targets they write, so a target pointing at another host can send a key there. Give editor rights to people you would give the keys to. Code stays with administrators unless you set `codePolicy: everyone`.
- Gateway header mode trusts whatever the listed proxy forwards: that proxy must remove client-sent copies of the headers (most gateways do; a plain reverse proxy needs to be told). JWT mode does not depend on this.
- GitHub org members can usually create teams; restrict team creation before using GitHub teams in admin or allowed groups. Admin groups only ever promote, never demote.
- Microsoft Entra does not send `email_verified`, so invitations by email don't link there; use automatic accounts with an allowed domain.
- Sign-ins in progress are kept in memory: a restart in the middle of one asks the person to try again, and several server instances would need a shared store.
- Script code is not sandboxed (Node's `vm` is not a security boundary). On a server it runs with the server's permissions: run Kalibra as an unprivileged user in a container.
