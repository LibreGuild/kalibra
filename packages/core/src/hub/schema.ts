/*
 * The hub database (hub.db, next to the default project's kalibra.db) holds everything that is
 * not inside a project: user accounts, sign-in sessions, access tokens, the list of projects,
 * who may use each project, and server settings. Project data stays in each project's own
 * kalibra.db, so projects cannot leak into each other by a missing WHERE clause.
 *
 * Append new migrations at the end; never edit one that has shipped.
 */
export const HUB_MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    -- scrypt hash (see passwords.ts); NULL for accounts that only sign in through a provider
    password_hash TEXT,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    disabled INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );
  CREATE UNIQUE INDEX users_username ON users(username);
  CREATE INDEX users_email ON users(email COLLATE NOCASE);

  -- Accounts at sign-in providers (OIDC, GitHub, a trusted proxy) linked to a user.
  CREATE TABLE identities (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    email TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    last_login_at TEXT,
    PRIMARY KEY (provider, subject)
  );
  CREATE INDEX identities_user ON identities(user_id);

  -- Browser sign-ins. Only a SHA-256 of the cookie value is stored.
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  -- Personal access tokens for coding agents (MCP), the CLI and scripts. Only a SHA-256 is stored.
  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX tokens_user ON tokens(user_id);

  -- dir is relative to the hub folder: "." for the default project, "projects/<id>" for the rest.
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    dir TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE UNIQUE INDEX projects_name ON projects(name COLLATE NOCASE) WHERE deleted_at IS NULL;

  CREATE TABLE user_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    -- "local" for groups an administrator manages; a provider id for groups synced at sign-in
    source TEXT NOT NULL DEFAULT 'local',
    external_key TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX user_groups_name ON user_groups(name);
  CREATE UNIQUE INDEX user_groups_external ON user_groups(source, external_key) WHERE external_key IS NOT NULL;

  CREATE TABLE user_group_members (
    group_id TEXT NOT NULL REFERENCES user_groups(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    added_at TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX user_group_members_user ON user_group_members(user_id);

  -- A user or a group with a role in a project.
  CREATE TABLE members (
    project_id TEXT NOT NULL REFERENCES projects(id),
    principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
    principal_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'owner')),
    added_at TEXT NOT NULL,
    added_by TEXT NOT NULL,
    PRIMARY KEY (project_id, principal_type, principal_id)
  );
  CREATE INDEX members_principal ON members(principal_type, principal_id);

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- Security-relevant events: sign-ins, account and permission changes.
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '{}',
    ip TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX audit_at ON audit(at);
  `,
  // 2: ingest keys let an app (SDK, OpenTelemetry, proxy) send traces to one project and nothing else
  `
  CREATE TABLE ingest_keys (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX ingest_keys_project ON ingest_keys(project_id);
  `,
  // 3: case-insensitive names through lower() indexes instead of COLLATE NOCASE, which means the
  // same in SQLite and Postgres (lookups compare lower(name) = lower(?))
  `
  DROP INDEX users_username;
  CREATE UNIQUE INDEX users_username ON users(lower(username));
  DROP INDEX users_email;
  CREATE INDEX users_email ON users(lower(email));
  DROP INDEX projects_name;
  CREATE UNIQUE INDEX projects_name ON projects(lower(name)) WHERE deleted_at IS NULL;
  DROP INDEX user_groups_name;
  CREATE UNIQUE INDEX user_groups_name ON user_groups(lower(name));
  `,
  // 4: sign-ins in progress (OIDC/GitHub state, PKCE verifier) live in the database, so the provider
  // can send the browser back to any instance behind a load balancer
  `
  CREATE TABLE sso_pending (
    state TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sso_pending_expires ON sso_pending(expires_at);
  `,
  // 5: secrets of sign-in providers made in the app, encrypted with KALIBRA_SECRET_KEY, when the data
  // folder may disappear (a bucket or Postgres deployment; see deploy/secrets.ts)
  `
  CREATE TABLE secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  `,
];
