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
- **code**: may add or change JavaScript (script targets, hooks, expressions, script checks). Server setting `codePolicy`: `everyone` (default) or `admins`. Checked where definitions are written (`DefRepo`), for unsaved specs in test calls, for run overrides, and for imports (bundles are refused whole; importers drop code checks and list them).
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

## Agents (MCP)

- Local: the bridge finds the running app through `<data>/.engine.json`.
- Server: `kalibra mcp --server https://kalibra.example.com --project <name>` with `KALIBRA_TOKEN` set.

The bridge exposes project operations, hub operations (e.g. `list_projects`) and `use_project` to switch.

## Known limits

- Editors can use the project's secrets through targets they write, so a target pointing at another host can send a key there. Give editor rights to people you would give the keys to, and use `codePolicy: admins` to keep scripts with administrators.
- Script code is not sandboxed (Node's `vm` is not a security boundary). On a server it runs with the server's permissions: run Kalibra as an unprivileged user in a container.
