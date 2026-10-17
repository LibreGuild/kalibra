import { z } from 'zod';
import { PROJECT_ROLES, roleAtLeast, type Actor, type BaseOpDef, type ProjectRole } from '../registry.js';
import { invalid, KalibraError, notFound, parseJson } from '../util.js';
import type { Hub } from './hub.js';
import { PASSWORD_MAX } from './passwords.js';
import { AuthProviderConfig } from './providers.js';
import type { Principal } from './types.js';

/*
 * Hub operations: your account, projects, members, and (for administrators) users, groups and
 * server settings. They use the same operation pattern as project operations, so the UI, CLI and
 * MCP all get them the same way. Account management is marked `mcp: false`: agents and access
 * tokens can work in projects but cannot create users, mint tokens or change passwords.
 */

export interface HubOpContext {
  hub: Hub;
  principal: Principal;
  actor: Actor;
  ip: string;
}

export interface HubOpDef<I extends z.ZodType = z.ZodType, O = unknown> extends BaseOpDef<HubOpContext, I, O> {
  category: 'account' | 'projects' | 'admin';
  /** "user": anyone signed in (or the local user). "admin": server administrators. Project ops check project roles inside. */
  access: 'user' | 'admin';
  /** Only meaningful on a team server (accounts, members, tokens). */
  serverOnly?: boolean;
}

const defineHubOp = <I extends z.ZodType, O>(def: HubOpDef<I, O>): HubOpDef<I, O> => def;

const role = z.enum(PROJECT_ROLES);
const projectRef = z.string().describe('Project id or name');

/** The caller's role in a project, failing when it is below `needed`. */
function requireRole({ hub, principal }: HubOpContext, project: string, needed: ProjectRole) {
  const found = hub.projectFor(principal, project);
  if (!roleAtLeast(found.role, needed)) throw new KalibraError('forbidden', `Only project ${needed}s can do this`);
  return found.project;
}

/** A member reference: one of user (id or username) or group (id or name). */
function memberRef(hub: Hub, i: { user?: string; group?: string }): { type: 'user' | 'group'; id: string } {
  if (!!i.user === !!i.group) throw invalid('Give either a user or a group');
  if (i.user) {
    const u = hub.accounts.find(i.user);
    if (!u) throw notFound('User', i.user);
    return { type: 'user', id: u.id };
  }
  return { type: 'group', id: hub.projects.group(i.group!).id };
}

/** Linked sign-in methods of a user, with the provider's display name. */
function identitiesOf(hub: Hub, userId: string) {
  const names = new Map(hub.providers.list().map((p) => [p.id, p.name]));
  return hub.accounts.identities(userId).map((i) => ({ ...i, providerName: names.get(i.provider) ?? i.provider }));
}

/** Where providers send people back to; relative when the server's public address is not configured. */
const callbackBase = (hub: Hub) => hub.publicUrl() ?? '';

const publicUser = (u: { id: string; username: string; name: string }) => ({ id: u.id, username: u.username, name: u.name });

export const HUB_OPS: HubOpDef<any, any>[] = [
  // ── You ───────────────────────────────────────────────────────────────────
  defineHubOp({
    name: 'get_me',
    title: 'Who am I',
    description: 'The signed-in user, whether this is a team server or a single-user install, and what you may do (create projects, manage the server).',
    category: 'account',
    access: 'user',
    readOnly: true,
    input: z.object({}),
    handler: ({ hub, principal }) => {
      const s = hub.mode === 'server' ? hub.settings() : undefined;
      const isAdmin = principal.user.role === 'admin';
      return {
        user: principal.user,
        mode: hub.mode,
        via: principal.via,
        isAdmin,
        canCreateProjects: hub.mode === 'local' || isAdmin || !!s?.allowProjectCreation,
        canWriteCode: hub.capsFor(principal).code,
        groups: hub.mode === 'server' ? hub.projects.userGroups(principal.user.id) : [],
        identities: hub.mode === 'server' ? identitiesOf(hub, principal.user.id) : [],
      };
    },
  }),

  defineHubOp({
    name: 'update_me',
    title: 'Update your profile',
    description: 'Changes your display name or email.',
    category: 'account',
    access: 'user',
    serverOnly: true,
    mcp: false,
    input: z.object({ name: z.string().min(1).max(100).optional(), email: z.string().max(200).optional() }),
    handler: ({ hub, principal }, i) => hub.accounts.update(principal.user.id, i),
  }),

  defineHubOp({
    name: 'change_password',
    title: 'Change your password',
    description: 'Sets a new password after checking the current one. Signs out your other sessions.',
    category: 'account',
    access: 'user',
    serverOnly: true,
    mcp: false,
    quiet: true,
    input: z.object({ current: z.string().max(PASSWORD_MAX), next: z.string().max(PASSWORD_MAX) }),
    handler: async ({ hub, principal, actor, ip }, i) => {
      const user = hub.accounts.get(principal.user.id);
      if (!user.hasPassword) throw invalid('This account signs in through a sign-in provider and has no password here');
      await hub.accounts.authenticate(user.username, i.current).catch(() => {
        throw new KalibraError('forbidden', 'The current password is wrong');
      });
      if (i.current === i.next) throw invalid('Pick a password different from the current one');
      await hub.accounts.setPassword(user.id, i.next);
      hub.accounts.revokeAllSessions(user.id, principal.sessionId);
      hub.audit(actor, 'password.changed', user.username, {}, ip);
      return { changed: true };
    },
  }),

  defineHubOp({
    name: 'list_sessions',
    title: 'Your sign-ins',
    description: 'Browsers where you are signed in.',
    category: 'account',
    access: 'user',
    serverOnly: true,
    mcp: false,
    readOnly: true,
    input: z.object({}),
    handler: ({ hub, principal }) => hub.accounts.listSessions(principal.user.id).map((s) => ({ ...s, current: s.id === principal.sessionId })),
  }),

  defineHubOp({
    name: 'revoke_session',
    title: 'Sign out a browser',
    description: 'Ends one of your sessions.',
    category: 'account',
    access: 'user',
    serverOnly: true,
    mcp: false,
    input: z.object({ id: z.string() }),
    handler: ({ hub, principal }, i) => {
      hub.accounts.revokeSession(i.id, principal.user.id);
      return { revoked: i.id };
    },
  }),

  defineHubOp({
    name: 'list_tokens',
    title: 'Your access tokens',
    description: 'Tokens that let coding agents (MCP), the CLI and scripts act as you on this server.',
    category: 'account',
    access: 'user',
    serverOnly: true,
    mcp: false,
    readOnly: true,
    input: z.object({}),
    handler: ({ hub, principal }) => hub.accounts.listTokens(principal.user.id),
  }),

  defineHubOp({
    name: 'create_token',
    title: 'Create an access token',
    description: 'Creates a token for a coding agent, the CLI or a script. The token is shown once; store it like a password.',
    category: 'account',
    access: 'user',
    serverOnly: true,
    mcp: false,
    input: z.object({ name: z.string().min(1).max(100), expiresInDays: z.number().int().min(1).max(3650).optional() }),
    handler: ({ hub, principal, actor, ip }, i) => {
      const t = hub.accounts.createToken(principal.user.id, i);
      hub.audit(actor, 'token.created', t.name, { id: t.id, expiresAt: t.expiresAt }, ip);
      return t;
    },
  }),

  defineHubOp({
    name: 'revoke_token',
    title: 'Revoke an access token',
    description: 'Stops a token from working.',
    category: 'account',
    access: 'user',
    serverOnly: true,
    mcp: false,
    destructive: true,
    input: z.object({ id: z.string() }),
    handler: ({ hub, principal, actor, ip }, i) => {
      // Administrators may revoke anyone's token (e.g. one that leaked).
      const t = hub.accounts.revokeToken(i.id, principal.user.role === 'admin' ? undefined : principal.user.id);
      hub.audit(actor, 'token.revoked', t.name, { id: t.id }, ip);
      return { revoked: t.id };
    },
  }),

  // ── Projects ──────────────────────────────────────────────────────────────
  defineHubOp({
    name: 'list_projects',
    title: 'List projects',
    description: 'Projects you can open, with your role in each. Every project has its own datasets, targets, suites, runs, connections and secrets.',
    category: 'projects',
    access: 'user',
    readOnly: true,
    input: z.object({}),
    handler: ({ hub, principal }) =>
      hub.visibleProjects(principal).map((p) => ({ id: p.id, name: p.name, description: p.description, role: p.role, createdAt: p.createdAt, members: hub.mode === 'server' ? hub.projects.memberCount(p.id) : undefined })),
  }),

  defineHubOp({
    name: 'get_project',
    title: 'Get a project',
    description: 'One project with your role in it.',
    category: 'projects',
    access: 'user',
    readOnly: true,
    input: z.object({ project: projectRef }),
    handler: ({ hub, principal }, i) => {
      const { project, role: r } = hub.projectFor(principal, i.project);
      const { dir, ...rest } = project;
      return { ...rest, role: r, ...(hub.mode === 'local' ? { dir: hub.engine(project.id).dir } : {}) };
    },
  }),

  defineHubOp({
    name: 'create_project',
    title: 'Create a project',
    description: 'Creates an empty project. On a team server you become its owner and can add members.',
    category: 'projects',
    access: 'user',
    input: z.object({ name: z.string().min(1).max(80), description: z.string().max(500).default('') }),
    handler: ({ hub, principal, actor, ip }, i) => {
      const allowed = hub.mode === 'local' || principal.user.role === 'admin' || hub.settings().allowProjectCreation;
      if (!allowed) throw new KalibraError('forbidden', 'Only administrators can create projects on this server');
      const project = hub.projects.create(i, actor);
      if (hub.mode === 'server') hub.projects.setMember(project.id, 'user', principal.user.id, 'owner', principal.user.id);
      hub.engine(project.id);
      hub.audit(actor, 'project.created', project.name, { id: project.id }, ip);
      const { dir, ...rest } = project;
      return { ...rest, role: 'owner' };
    },
  }),

  defineHubOp({
    name: 'update_project',
    title: 'Rename a project',
    description: 'Changes a project’s name or description (owners).',
    category: 'projects',
    access: 'user',
    input: z.object({ project: projectRef, name: z.string().min(1).max(80).optional(), description: z.string().max(500).optional() }),
    handler: (ctx, i) => {
      const p = requireRole(ctx, i.project, 'owner');
      const next = ctx.hub.projects.update(p.id, i);
      if (next.name !== p.name) ctx.hub.audit(ctx.actor, 'project.renamed', next.name, { id: p.id, from: p.name }, ctx.ip);
      const { dir, ...rest } = next;
      return rest;
    },
  }),

  defineHubOp({
    name: 'delete_project',
    title: 'Delete a project',
    description: 'Moves a project to the trash (owners). Its files stay on disk; an administrator can restore it.',
    category: 'projects',
    access: 'user',
    destructive: true,
    input: z.object({ project: projectRef }),
    handler: (ctx, i) => {
      const p = requireRole(ctx, i.project, 'owner');
      ctx.hub.projects.trash(p.id);
      ctx.hub.closeEngine(p.id);
      ctx.hub.audit(ctx.actor, 'project.deleted', p.name, { id: p.id }, ctx.ip);
      return { deleted: p.id };
    },
  }),

  defineHubOp({
    name: 'list_deleted_projects',
    title: 'Projects in the trash',
    description: 'Deleted projects an administrator can restore.',
    category: 'admin',
    access: 'admin',
    readOnly: true,
    input: z.object({}),
    handler: ({ hub }) => hub.projects.list({ deleted: true }).map(({ dir, ...p }) => p),
  }),

  defineHubOp({
    name: 'restore_project',
    title: 'Restore a project',
    description: 'Brings a deleted project back.',
    category: 'admin',
    access: 'admin',
    input: z.object({ id: z.string() }),
    handler: ({ hub, actor, ip }, i) => {
      const p = hub.projects.restore(i.id);
      hub.audit(actor, 'project.restored', p.name, { id: p.id }, ip);
      return p;
    },
  }),

  // ── Members ───────────────────────────────────────────────────────────────
  defineHubOp({
    name: 'list_members',
    title: 'List project members',
    description: 'Users and groups with access to a project and their roles: viewer (read), editor (change and run), owner (also members, connections and secrets).',
    category: 'projects',
    access: 'user',
    serverOnly: true,
    readOnly: true,
    input: z.object({ project: projectRef }),
    handler: (ctx, i) => ctx.hub.projects.members(requireRole(ctx, i.project, 'viewer').id),
  }),

  defineHubOp({
    name: 'set_member',
    title: 'Add or change a member',
    description: 'Gives a user or a group a role in a project (owners).',
    category: 'projects',
    access: 'user',
    serverOnly: true,
    mcp: false,
    input: z.object({ project: projectRef, user: z.string().optional().describe('User id or username'), group: z.string().optional().describe('Group id or name'), role }),
    handler: (ctx, i) => {
      const p = requireRole(ctx, i.project, 'owner');
      const m = memberRef(ctx.hub, i);
      ctx.hub.projects.setMember(p.id, m.type, m.id, i.role, ctx.principal.user.id);
      ctx.hub.audit(ctx.actor, 'member.set', p.name, { [m.type]: m.id, role: i.role }, ctx.ip);
      return ctx.hub.projects.members(p.id);
    },
  }),

  defineHubOp({
    name: 'remove_member',
    title: 'Remove a member',
    description: 'Takes a user’s or group’s access to a project away (owners). A project always keeps at least one owner.',
    category: 'projects',
    access: 'user',
    serverOnly: true,
    mcp: false,
    destructive: true,
    input: z.object({ project: projectRef, user: z.string().optional(), group: z.string().optional() }),
    handler: (ctx, i) => {
      const p = requireRole(ctx, i.project, 'owner');
      const m = memberRef(ctx.hub, i);
      ctx.hub.projects.removeMember(p.id, m.type, m.id);
      ctx.hub.audit(ctx.actor, 'member.removed', p.name, { [m.type]: m.id }, ctx.ip);
      return ctx.hub.projects.members(p.id);
    },
  }),

  defineHubOp({
    name: 'list_people',
    title: 'People and groups',
    description: 'Active users and groups on this server, to pick project members from.',
    category: 'projects',
    access: 'user',
    serverOnly: true,
    readOnly: true,
    input: z.object({}),
    handler: ({ hub }) => ({
      users: hub.accounts.list().filter((u) => !u.disabled).map(publicUser),
      groups: hub.projects.groups().map((g) => ({ id: g.id, name: g.name, members: g.members })),
    }),
  }),

  // ── Administration ────────────────────────────────────────────────────────
  defineHubOp({
    name: 'list_users',
    title: 'List users',
    description: 'Every account on this server.',
    category: 'admin',
    access: 'admin',
    serverOnly: true,
    mcp: false,
    readOnly: true,
    input: z.object({}),
    handler: ({ hub }) =>
      hub.accounts.list().map((u) => ({ ...u, groups: hub.projects.userGroups(u.id), projects: hub.projects.rolesOf(u.id).size, identities: hub.accounts.identities(u.id).map((i) => i.provider) })),
  }),

  defineHubOp({
    name: 'create_user',
    title: 'Create a user',
    description: 'Creates an account. Give a starting password (they change it at first sign-in), or none for accounts that only use a sign-in provider.',
    category: 'admin',
    access: 'admin',
    serverOnly: true,
    mcp: false,
    input: z.object({
      username: z.string().min(2).max(64),
      name: z.string().max(100).default(''),
      email: z.string().max(200).default(''),
      password: z.string().max(PASSWORD_MAX).optional(),
      role: z.enum(['admin', 'user']).default('user'),
      mustChangePassword: z.boolean().default(true),
    }),
    handler: async ({ hub, actor, ip, principal }, i) => {
      const user = await hub.accounts.create({ ...i, mustChangePassword: i.password ? i.mustChangePassword : false }, principal.user.id);
      hub.audit(actor, 'user.created', user.username, { id: user.id, role: user.role }, ip);
      return user;
    },
  }),

  defineHubOp({
    name: 'update_user',
    title: 'Change a user',
    description: 'Changes a user’s name, email, server role, or disables the account (disabling signs them out everywhere).',
    category: 'admin',
    access: 'admin',
    serverOnly: true,
    mcp: false,
    input: z.object({
      id: z.string().describe('User id or username'),
      name: z.string().min(1).max(100).optional(),
      email: z.string().max(200).optional(),
      role: z.enum(['admin', 'user']).optional(),
      disabled: z.boolean().optional(),
    }),
    handler: ({ hub, actor, ip, principal }, i) => {
      const cur = hub.accounts.find(i.id);
      if (!cur) throw notFound('User', i.id);
      if (cur.id === principal.user.id && i.disabled) throw invalid('You cannot disable your own account');
      const next = hub.accounts.update(cur.id, i);
      const changes = Object.fromEntries((['role', 'disabled', 'name', 'email'] as const).filter((k) => i[k] !== undefined && i[k] !== cur[k]).map((k) => [k, i[k]]));
      if (Object.keys(changes).length) hub.audit(actor, 'user.updated', next.username, changes, ip);
      return next;
    },
  }),

  defineHubOp({
    name: 'reset_user_password',
    title: 'Reset a password',
    description: 'Sets a new password for a user and signs them out everywhere. By default they must change it at next sign-in.',
    category: 'admin',
    access: 'admin',
    serverOnly: true,
    mcp: false,
    quiet: true,
    input: z.object({ id: z.string(), password: z.string().max(PASSWORD_MAX), mustChangePassword: z.boolean().default(true) }),
    handler: async ({ hub, actor, ip }, i) => {
      const user = hub.accounts.find(i.id);
      if (!user) throw notFound('User', i.id);
      await hub.accounts.setPassword(user.id, i.password, { mustChange: i.mustChangePassword });
      hub.accounts.revokeAllSessions(user.id);
      hub.audit(actor, 'password.reset', user.username, {}, ip);
      return { reset: user.id };
    },
  }),

  defineHubOp({
    name: 'list_groups',
    title: 'List groups',
    description: 'Groups of users. Add a group to a project to give all its members access at once.',
    category: 'admin',
    access: 'admin',
    serverOnly: true,
    mcp: false,
    readOnly: true,
    input: z.object({}),
    handler: ({ hub }) => hub.projects.groups().map((g) => ({ ...g, users: hub.projects.groupMembers(g.id) })),
  }),

  defineHubOp({
    name: 'create_group',
    title: 'Create a group',
    description: 'Creates a group, optionally with its members.',
    category: 'admin',
    access: 'admin',
    serverOnly: true,
    mcp: false,
    input: z.object({ name: z.string().min(1).max(80), description: z.string().max(500).default(''), users: z.array(z.string()).default([]) }),
    handler: ({ hub, actor, ip }, i) => {
      const g = hub.projects.createGroup(i);
      if (i.users.length) hub.projects.setGroupMembers(g.id, i.users.map((u) => hub.accounts.find(u)?.id ?? u));
      hub.audit(actor, 'group.created', g.name, { id: g.id }, ip);
      return hub.projects.group(g.id);
    },
  }),

  defineHubOp({
    name: 'update_group',
    title: 'Change a group',
    description: 'Renames a group, changes its description, or replaces its members.',
    category: 'admin',
    access: 'admin',
    serverOnly: true,
    mcp: false,
    input: z.object({ id: z.string(), name: z.string().min(1).max(80).optional(), description: z.string().max(500).optional(), users: z.array(z.string()).optional() }),
    handler: ({ hub, actor, ip }, i) => {
      const g = hub.projects.updateGroup(i.id, i);
      if (i.users) {
        if (g.source !== 'local') throw invalid(`Members of "${g.name}" come from ${g.source} at sign-in and cannot be edited here`);
        hub.projects.setGroupMembers(g.id, i.users.map((u: string) => hub.accounts.find(u)?.id ?? u));
      }
      hub.audit(actor, 'group.updated', g.name, { id: g.id, members: i.users?.length }, ip);
      return { ...hub.projects.group(g.id), users: hub.projects.groupMembers(g.id) };
    },
  }),

  defineHubOp({
    name: 'delete_group',
    title: 'Delete a group',
    description: 'Deletes a group and its project memberships. Its users keep their own memberships.',
    category: 'admin',
    access: 'admin',
    serverOnly: true,
    mcp: false,
    destructive: true,
    input: z.object({ id: z.string() }),
    handler: ({ hub, actor, ip }, i) => {
      const g = hub.projects.deleteGroup(i.id);
      hub.audit(actor, 'group.deleted', g.name, { id: g.id }, ip);
      return { deleted: g.id };
    },
  }),

  defineHubOp({
    name: 'get_server_settings',
    title: 'Server settings',
    description: 'Who may create projects, who may add code, and how long sign-ins last.',
    category: 'admin',
    access: 'admin',
    serverOnly: true,
    mcp: false,
    readOnly: true,
    input: z.object({}),
    handler: ({ hub }) => hub.settings(),
  }),

  defineHubOp({
    name: 'update_server_settings',
    title: 'Change server settings',
    description: 'Changes server settings.',
    category: 'admin',
    access: 'admin',
    serverOnly: true,
    mcp: false,
    input: z.object({
      allowProjectCreation: z.boolean().optional(),
      codePolicy: z.enum(['everyone', 'admins']).optional(),
      sessionDays: z.number().int().min(1).max(365).optional(),
      passwordLogin: z.boolean().optional(),
    }),
    handler: ({ hub, actor, ip }, i) => {
      const next = hub.updateSettings(i);
      hub.audit(actor, 'settings.updated', 'server', i, ip);
      return next;
    },
  }),

  defineHubOp({
    name: 'list_auth_providers',
    title: 'Sign-in providers',
    description: 'Ways to sign in besides a password (OIDC such as Google or company SSO, GitHub / GitHub Enterprise, a login gateway), with who each lets in.',
    category: 'admin',
    access: 'admin',
    serverOnly: true,
    mcp: false,
    readOnly: true,
    input: z.object({}),
    handler: async ({ hub }) => ({
      providers: await Promise.all(hub.providers.list().map((p) => hub.providers.view(p, callbackBase(hub)))),
      callbackBase: callbackBase(hub),
    }),
  }),

  defineHubOp({
    name: 'save_auth_provider',
    title: 'Save a sign-in provider',
    description: 'Adds or changes a sign-in provider made in the app. The client secret is write-only: send it to set or replace it.',
    category: 'admin',
    access: 'admin',
    serverOnly: true,
    mcp: false,
    quiet: true,
    input: AuthProviderConfig.partial().extend({ id: z.string().optional(), clientSecret: z.string().max(2000).optional() }),
    handler: async ({ hub, actor, ip }, i) => {
      const saved = await hub.providers.save(i);
      hub.audit(actor, 'provider.saved', saved.name, { id: saved.id, kind: saved.kind, enabled: saved.enabled, secretChanged: !!i.clientSecret }, ip);
      return hub.providers.view(saved, callbackBase(hub));
    },
  }),

  defineHubOp({
    name: 'delete_auth_provider',
    title: 'Remove a sign-in provider',
    description: 'Removes a provider made in the app. Accounts stay; people who only used it need a password or another provider.',
    category: 'admin',
    access: 'admin',
    serverOnly: true,
    mcp: false,
    destructive: true,
    input: z.object({ id: z.string() }),
    handler: async ({ hub, actor, ip }, i) => {
      const p = hub.providers.get(i.id);
      await hub.providers.delete(i.id);
      hub.audit(actor, 'provider.deleted', p.name, { id: p.id }, ip);
      return { deleted: p.id };
    },
  }),

  defineHubOp({
    name: 'list_audit',
    title: 'Security log',
    description: 'Sign-ins, failed sign-ins, and changes to accounts, members and settings.',
    category: 'admin',
    access: 'admin',
    serverOnly: true,
    mcp: false,
    readOnly: true,
    input: z.object({ limit: z.number().int().min(1).max(1000).default(200), action: z.string().optional().describe('Only actions starting with this, e.g. "login"') }),
    handler: ({ hub }, i) =>
      hub.db
        .all(i.action ? 'SELECT * FROM audit WHERE action LIKE ? ORDER BY id DESC LIMIT ?' : 'SELECT * FROM audit ORDER BY id DESC LIMIT ?', ...(i.action ? [`${i.action}%`, i.limit] : [i.limit]))
        .map((a) => ({ id: a.id, at: a.at, actor: parseJson(a.actor, {}), action: a.action, subject: a.subject, details: parseJson(a.details, {}), ip: a.ip })),
  }),
];
