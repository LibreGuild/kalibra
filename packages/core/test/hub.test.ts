import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/hub/hub.js';
import { MAX_FAILED_LOGINS } from '../src/hub/accounts.js';
import { checkPasswordStrength, hashPassword, verifyPassword } from '../src/hub/passwords.js';
import type { Principal, User } from '../src/hub/types.js';
import { opAccess } from '../src/registry.js';

const dirs: string[] = [];
const hubs: Hub[] = [];
function makeHub(mode: 'local' | 'server', extra: { folderRoot?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kalibra-hub-'));
  dirs.push(dir);
  const hub = new Hub({ dir, mode, ...extra });
  hubs.push(hub);
  return hub;
}
afterEach(() => {
  hubs.splice(0).forEach((h) => h.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const PW = 'correct horse battery';
const as = (user: User, extra: Partial<Principal> = {}): Principal => ({ user, via: 'user', ...extra });

async function serverWithPeople() {
  const hub = makeHub('server');
  const admin = await hub.completeSetup(hub.setupCode()!, { username: 'admin', password: PW });
  const mk = (username: string) => hub.call(as(admin), 'create_user', { username, password: PW, mustChangePassword: false });
  const [alice, bob, carol] = await Promise.all([mk('alice'), mk('bob'), mk('carol')]);
  return { hub, admin, alice, bob, carol };
}

describe('passwords', () => {
  it('hashes with scrypt and verifies', async () => {
    const h = await hashPassword(PW);
    expect(h).toMatch(/^scrypt\$131072\$8\$1\$/);
    expect(await verifyPassword(PW, h)).toBe(true);
    expect(await verifyPassword('wrong password!', h)).toBe(false);
    expect(await verifyPassword(PW, 'garbage')).toBe(false);
  });

  it('rejects short, common and username-based passwords', () => {
    expect(() => checkPasswordStrength('short')).toThrow(/at least 10/);
    expect(() => checkPasswordStrength('password123')).toThrow(/easy to guess/);
    expect(() => checkPasswordStrength('aaaaaaaaaaaa')).toThrow(/easy to guess/);
    expect(() => checkPasswordStrength('alice-is-great', 'alice')).toThrow(/username/);
    expect(() => checkPasswordStrength(PW, 'alice')).not.toThrow();
  });
});

describe('local hub (npx kalibra)', () => {
  it('has a default project and keeps projects apart', async () => {
    const hub = makeHub('local');
    const me = hub.localPrincipal();
    expect(hub.needsSetup()).toBe(false);
    const projects = await hub.call<any[]>(me, 'list_projects', {});
    expect(projects.map((p) => p.id)).toEqual(['default']);
    const second = await hub.call<any>(me, 'create_project', { name: 'Voice' });
    await hub.callProject(me, 'default', 'create_dataset', { name: 'Only here', columns: [{ key: 'q' }] });
    const inDefault = await hub.callProject<any[]>(me, 'default', 'list_datasets', {});
    const inSecond = await hub.callProject<any[]>(me, second.id, 'list_datasets', {});
    expect(inDefault.map((d) => d.name)).toEqual(['Only here']);
    expect(inSecond).toEqual([]);
    // Projects can be named instead of id'd, case-insensitively.
    expect((await hub.callProject<any[]>(me, 'voice', 'list_datasets', {})).length).toBe(0);
  });

  it('has no accounts, members or tokens', async () => {
    const hub = makeHub('local');
    await expect(hub.call(hub.localPrincipal(), 'list_users', {})).rejects.toMatchObject({ code: 'unavailable' });
    await expect(hub.call(hub.localPrincipal(), 'create_token', { name: 'x' })).rejects.toMatchObject({ code: 'unavailable' });
    expect((await hub.call<any>(hub.localPrincipal(), 'get_me', {})).user.name).toBe('You');
  });

  it('cannot delete the default project; others go to the trash and come back', async () => {
    const hub = makeHub('local');
    const me = hub.localPrincipal();
    await expect(hub.call(me, 'delete_project', { project: 'default' })).rejects.toThrow(/cannot be deleted/);
    const p = await hub.call<any>(me, 'create_project', { name: 'Temp' });
    await hub.call(me, 'delete_project', { project: p.id });
    await expect(hub.callProject(me, p.id, 'list_datasets', {})).rejects.toMatchObject({ code: 'not_found' });
    expect((await hub.call<any[]>(me, 'list_deleted_projects', {})).map((x) => x.id)).toEqual([p.id]);
    await hub.call(me, 'restore_project', { id: p.id });
    expect(await hub.callProject(me, p.id, 'list_datasets', {})).toEqual([]);
  });
});

describe('server setup and sign-in', () => {
  it('needs a one-time code to create the first administrator', async () => {
    const hub = makeHub('server');
    expect(hub.needsSetup()).toBe(true);
    const code = hub.setupCode()!;
    expect(code.length).toBeGreaterThan(20);
    await expect(hub.completeSetup('nope', { username: 'admin', password: PW })).rejects.toMatchObject({ code: 'forbidden' });
    const admin = await hub.completeSetup(code, { username: 'admin', password: PW });
    expect(admin.role).toBe('admin');
    expect(hub.needsSetup()).toBe(false);
    expect(hub.setupCode()).toBeUndefined();
    await expect(hub.completeSetup(code, { username: 'admin2', password: PW })).rejects.toMatchObject({ code: 'conflict' });
    expect(() => hub.localPrincipal()).toThrow(/Sign in/);
  });

  it('authenticates, locks after repeated wrong passwords and hides which usernames exist', async () => {
    const { hub } = await serverWithPeople();
    expect((await hub.accounts.authenticate('ALICE', PW)).username).toBe('alice');
    const unknown = await hub.accounts.authenticate('nobody', PW).catch((e) => e.message);
    const wrong = await hub.accounts.authenticate('alice', 'wrong password!').catch((e) => e.message);
    expect(unknown).toBe(wrong);
    for (let i = 1; i < MAX_FAILED_LOGINS; i++) await hub.accounts.authenticate('alice', 'wrong password!').catch(() => {});
    await expect(hub.accounts.authenticate('alice', PW)).rejects.toThrow(/Too many wrong passwords/);
  });

  it('refuses disabled accounts and their sessions and tokens', async () => {
    const { hub, admin, bob } = await serverWithPeople();
    const session = hub.accounts.createSession(bob.id, { days: 1 });
    const token = hub.accounts.createToken(bob.id, { name: 'agent' });
    expect(hub.accounts.resolveSession(session.secret)?.user.id).toBe(bob.id);
    expect(hub.accounts.resolveToken(token.token)?.user.id).toBe(bob.id);
    await hub.call(as(admin), 'update_user', { id: 'bob', disabled: true });
    expect(hub.accounts.resolveSession(session.secret)).toBeUndefined();
    expect(hub.accounts.resolveToken(token.token)).toBeUndefined();
    await expect(hub.accounts.authenticate('bob', PW)).rejects.toThrow(/Wrong username or password/);
  });

  it('stores only hashes of sessions and tokens, and expires and revokes them', async () => {
    const { hub, alice } = await serverWithPeople();
    const s = hub.accounts.createSession(alice.id, { days: 1 });
    const t = hub.accounts.createToken(alice.id, { name: 'ci', expiresInDays: 1 });
    expect(t.token.startsWith('kal_')).toBe(true);
    const raw = JSON.stringify([hub.db.all('SELECT * FROM sessions'), hub.db.all('SELECT * FROM tokens')]);
    expect(raw).not.toContain(s.secret);
    expect(raw).not.toContain(t.token);
    hub.db.run('UPDATE sessions SET expires_at = ?', '2000-01-01T00:00:00.000Z');
    expect(hub.accounts.resolveSession(s.secret)).toBeUndefined();
    hub.accounts.revokeToken(t.id, alice.id);
    expect(hub.accounts.resolveToken(t.token)).toBeUndefined();
    expect(hub.accounts.resolveToken('not-a-token')).toBeUndefined();
  });

  it('keeps one active administrator and stops admins disabling themselves', async () => {
    const { hub, admin, alice } = await serverWithPeople();
    await expect(hub.call(as(admin), 'update_user', { id: admin.id, role: 'user' })).rejects.toThrow(/last active administrator/);
    await expect(hub.call(as(admin), 'update_user', { id: admin.id, disabled: true })).rejects.toThrow(/your own account/);
    await hub.call(as(admin), 'update_user', { id: alice.id, role: 'admin' });
    await hub.call(as(admin), 'update_user', { id: admin.id, role: 'user' });
    expect(hub.accounts.get(admin.id).role).toBe('user');
  });

  it('changes passwords only with the current one, and signs other sessions out', async () => {
    const { hub, alice } = await serverWithPeople();
    const keep = hub.accounts.createSession(alice.id, { days: 1 });
    const other = hub.accounts.createSession(alice.id, { days: 1 });
    const me = as(alice, { sessionId: keep.id });
    await expect(hub.call(me, 'change_password', { current: 'wrong password!', next: 'another long one' })).rejects.toThrow(/current password is wrong/);
    await hub.call(me, 'change_password', { current: PW, next: 'another long one' });
    expect(hub.accounts.resolveSession(keep.secret)).toBeDefined();
    expect(hub.accounts.resolveSession(other.secret)).toBeUndefined();
    expect((await hub.accounts.authenticate('alice', 'another long one')).id).toBe(alice.id);
  });

  it('records security events in the audit log', async () => {
    const { hub, admin } = await serverWithPeople();
    const log = await hub.call<any[]>(as(admin), 'list_audit', {});
    expect(log.map((a) => a.action)).toEqual(expect.arrayContaining(['setup.completed', 'user.created']));
  });
});

describe('project access on a server', () => {
  it('lets members in with their role and hides projects from everyone else', async () => {
    const { hub, alice, bob, carol } = await serverWithPeople();
    const p = await hub.call<any>(as(alice), 'create_project', { name: 'Chatbot' });
    await hub.call(as(alice), 'set_member', { project: p.id, user: 'bob', role: 'viewer' });

    // carol is not a member: the project does not exist for her.
    expect(await hub.call<any[]>(as(carol), 'list_projects', {})).toEqual([]);
    await expect(hub.callProject(as(carol), p.id, 'list_datasets', {})).rejects.toMatchObject({ code: 'not_found' });

    // bob reads but cannot change anything.
    expect(await hub.callProject(as(bob), p.id, 'list_datasets', {})).toEqual([]);
    await expect(hub.callProject(as(bob), p.id, 'create_dataset', { name: 'x', columns: [{ key: 'q' }] })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(hub.call(as(bob), 'set_member', { project: p.id, user: 'carol', role: 'owner' })).rejects.toMatchObject({ code: 'forbidden' });

    // As an editor he can work, but connections and secrets stay with owners.
    await hub.call(as(alice), 'set_member', { project: p.id, user: 'bob', role: 'editor' });
    await hub.callProject(as(bob), p.id, 'create_dataset', { name: 'Questions', columns: [{ key: 'q' }] });
    await expect(hub.callProject(as(bob), p.id, 'create_connection', { name: 'OpenAI', spec: { provider: 'openai' } })).rejects.toThrow(/owner role/);
    await expect(hub.callProject(as(bob), p.id, 'set_secret', { name: 'k', value: 'v' })).rejects.toMatchObject({ code: 'forbidden' });
    await hub.callProject(as(alice), p.id, 'create_connection', { name: 'OpenAI', spec: { provider: 'openai' } });
  });

  it('gives access through groups, picking the highest role', async () => {
    const { hub, admin, alice, carol } = await serverWithPeople();
    const p = await hub.call<any>(as(alice), 'create_project', { name: 'STT' });
    await hub.call(as(admin), 'create_group', { name: 'Speech team', users: ['carol'] });
    await hub.call(as(alice), 'set_member', { project: p.id, group: 'Speech team', role: 'editor' });
    await hub.call(as(alice), 'set_member', { project: p.id, user: 'carol', role: 'viewer' });
    expect(hub.roleIn(as(carol), p.id)).toBe('editor');
    await hub.call(as(admin), 'delete_group', { id: 'Speech team' });
    expect(hub.roleIn(as(carol), p.id)).toBe('viewer');
  });

  it('keeps an owner in every project', async () => {
    const { hub, alice } = await serverWithPeople();
    const p = await hub.call<any>(as(alice), 'create_project', { name: 'Solo' });
    await expect(hub.call(as(alice), 'set_member', { project: p.id, user: 'alice', role: 'editor' })).rejects.toThrow(/at least one owner/);
    await expect(hub.call(as(alice), 'remove_member', { project: p.id, user: 'alice' })).rejects.toThrow(/at least one owner/);
  });

  it('makes administrators owners everywhere and can stop users creating projects', async () => {
    const { hub, admin, alice } = await serverWithPeople();
    const p = await hub.call<any>(as(alice), 'create_project', { name: 'Private' });
    expect(hub.roleIn(as(admin), p.id)).toBe('owner');
    await hub.call(as(admin), 'update_server_settings', { allowProjectCreation: false });
    await expect(hub.call(as(alice), 'create_project', { name: 'Another' })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await hub.call<any>(as(alice), 'get_me', {})).canCreateProjects).toBe(false);
  });

  it('records who did what with their name', async () => {
    const { hub, alice } = await serverWithPeople();
    const p = await hub.call<any>(as(alice), 'create_project', { name: 'Named' });
    await hub.callProject(as(alice, { via: 'agent', client: 'claude-code' }), p.id, 'create_dataset', { name: 'D', columns: [{ key: 'q' }] });
    const [a] = await hub.callProject<any[]>(as(alice), p.id, 'list_activity', {});
    expect(a.actor).toMatchObject({ kind: 'agent', id: alice.id, name: 'alice', client: 'claude-code' });
  });
});

describe('password resets by an administrator', () => {
  it('end sessions and, by default, access tokens', async () => {
    const { hub, admin, alice } = await serverWithPeople();
    const t1 = hub.accounts.createToken(alice.id, { name: 'agent' });
    await hub.call(as(admin), 'reset_user_password', { id: 'alice', password: 'temporary password 1' });
    expect(hub.accounts.resolveToken(t1.token)).toBeUndefined();
    const t2 = hub.accounts.createToken(alice.id, { name: 'agent' });
    await hub.call(as(admin), 'reset_user_password', { id: 'alice', password: 'temporary password 2', revokeTokens: false });
    expect(hub.accounts.resolveToken(t2.token)?.user.id).toBe(alice.id);
  });
});

describe('access tokens', () => {
  it('work in projects but never for account management or secrets', async () => {
    const { hub, alice } = await serverWithPeople();
    const p = await hub.call<any>(as(alice), 'create_project', { name: 'Agents' });
    const t = hub.accounts.createToken(alice.id, { name: 'claude' });
    const viaToken = as(alice, { via: 'agent', tokenId: t.id });
    expect(await hub.callProject(viaToken, p.id, 'list_datasets', {})).toEqual([]);
    expect((await hub.call<any[]>(viaToken, 'list_projects', {})).length).toBe(1);
    await expect(hub.call(viaToken, 'create_token', { name: 'more' })).rejects.toThrow(/Kalibra app/);
    await expect(hub.call(as(alice, { via: 'cli', tokenId: t.id }), 'change_password', { current: PW, next: 'x'.repeat(12) })).rejects.toThrow(/signed in/);
    await expect(hub.callProject(as(alice, { via: 'cli', tokenId: t.id }), p.id, 'set_secret', { name: 'k', value: 'v' })).rejects.toThrow(/signed in/);
  });
});

describe('server policies', () => {
  const scriptTarget = { config: { kind: 'script', code: 'return { output: 1 }' } };

  it('lets only administrators add or change code when the policy says so', async () => {
    const { hub, admin, alice } = await serverWithPeople();
    const p = await hub.call<any>(as(alice), 'create_project', { name: 'Code' });
    await hub.call(as(admin), 'update_server_settings', { codePolicy: 'admins' });
    await expect(hub.callProject(as(alice), p.id, 'create_target', { name: 'S', spec: scriptTarget })).rejects.toThrow(/only administrators/);
    await expect(hub.callProject(as(alice), p.id, 'test_target', { spec: scriptTarget, values: {} })).rejects.toThrow(/only administrators/);

    // An administrator writes the script; editors may still rename it or change other fields, and run it.
    const t = await hub.callProject<any>(as(admin), p.id, 'create_target', { name: 'S', spec: scriptTarget });
    await hub.callProject(as(alice), p.id, 'update_target', { id: t.id, name: 'Scripted', spec: { ...t.spec, variables: [{ key: 'a', value: 'b' }] } });
    await expect(hub.callProject(as(alice), p.id, 'update_target', { id: t.id, spec: { ...t.spec, config: { ...t.spec.config, code: 'return 2' } } })).rejects.toThrow(/only administrators/);
    const res = await hub.callProject<any>(as(alice), p.id, 'test_target', { target: t.id, values: {} });
    expect(res.outputs.output).toBe(1);

    // Run overrides can replace config fields, so they are checked too.
    await hub.callProject(as(alice), p.id, 'create_dataset', { name: 'D', columns: [{ key: 'q' }] });
    await hub.callProject(as(alice), p.id, 'add_dataset_rows', { dataset: 'D', rows: [{ data: { q: 'a' } }] });
    await hub.callProject(as(admin), p.id, 'create_suite', { name: 'Suite', spec: { checks: [] } });
    await expect(
      hub.callProject(as(alice), p.id, 'start_run', { dataset: 'D', target: t.id, suite: 'Suite', settings: { overrides: { config: { code: 'return 3' } } } }),
    ).rejects.toThrow(/only administrators/);
  });

  it('refuses whole bundles that carry code instead of importing half of them', async () => {
    const { hub, admin, alice } = await serverWithPeople();
    const p = await hub.call<any>(as(alice), 'create_project', { name: 'Bundles' });
    // Team servers let only administrators write code by default.
    expect(hub.settings().codePolicy).toBe('admins');
    await expect(hub.callProject(as(alice), p.id, 'create_target', { name: 'Script', spec: scriptTarget })).rejects.toThrow(/only administrators/);
    await hub.callProject(as(admin), p.id, 'create_target', { name: 'Script', spec: scriptTarget });
    await hub.callProject(as(alice), p.id, 'create_dataset', { name: 'D', columns: [{ key: 'q' }] });
    const bundle = await hub.callProject<any>(as(alice), p.id, 'export_bundle', { everything: true });
    const other = await hub.call<any>(as(alice), 'create_project', { name: 'Receiver' });
    // Blobs are per project: upload the bundle into the receiving project first.
    const bytes = await hub.engine(p.id).blobs.get(bundle.hash);
    const up = await hub.callProject<any>(as(alice), other.id, 'upload_file', { name: 'b.kalibra', base64: Buffer.from(bytes).toString('base64') });
    await expect(hub.callProject(as(alice), other.id, 'import_bundle', { blob: up.hash })).rejects.toThrow(/contains JavaScript/);
    expect(await hub.callProject(as(alice), other.id, 'list_datasets', {})).toEqual([]);
    await hub.callProject(as(admin), other.id, 'import_bundle', { blob: up.hash });
    expect((await hub.callProject<any[]>(as(alice), other.id, 'list_targets', {})).map((x) => x.name)).toEqual(['Script']);
  });

  it('turns folder sync off on servers unless confined to a folder', async () => {
    const { hub, alice } = await serverWithPeople();
    const p = await hub.call<any>(as(alice), 'create_project', { name: 'Folders' });
    await expect(hub.callProject(as(alice), p.id, 'export_to_folder', { dir: '/tmp/x' })).rejects.toThrow(/turned off/);

    const root = mkdtempSync(join(tmpdir(), 'kalibra-root-'));
    dirs.push(root);
    const confined = makeHub('server', { folderRoot: root });
    const admin = await confined.completeSetup(confined.setupCode()!, { username: 'admin', password: PW });
    const q = await confined.call<any>(as(admin), 'create_project', { name: 'F' });
    await confined.callProject(as(admin), q.id, 'export_to_folder', { dir: 'team-evals' });
    await expect(confined.callProject(as(admin), q.id, 'export_to_folder', { dir: '../escape' })).rejects.toThrow(/must be inside/);
    await expect(confined.callProject(as(admin), q.id, 'export_to_folder', { dir: '/etc' })).rejects.toThrow(/must be inside/);
  });

  it('does not show server paths', async () => {
    const { hub, alice } = await serverWithPeople();
    const p = await hub.call<any>(as(alice), 'create_project', { name: 'Paths' });
    expect((await hub.callProject<any>(as(alice), p.id, 'get_workspace', {})).dir).toBeUndefined();
    expect((await hub.call<any>(as(alice), 'get_project', { project: p.id })).dir).toBeUndefined();
  });
});

describe('operation access levels', () => {
  it('needs editor for read-only calls that spend money or use secrets, and owner for secrets and the disk', () => {
    const hub = makeHub('local');
    const access = (name: string) => opAccess(hub.engine('default').registry.get(name)!);
    for (const n of ['list_datasets', 'get_run', 'query_results', 'export_bundle', 'preflight_run', 'list_secrets']) expect(access(n), n).toBe('viewer');
    for (const n of ['test_target', 'test_connection', 'list_models', 'test_conversation', 'test_embeddings', 'find_duplicates', 'create_dataset', 'start_run', 'label_result'])
      expect(access(n), n).toBe('editor');
    for (const n of ['set_secret', 'delete_secret', 'create_connection', 'update_connection', 'delete_connection', 'export_to_folder', 'import_from_folder', 'set_sharing_settings'])
      expect(access(n), n).toBe('owner');
    // Every op says what it needs.
    for (const d of hub.engine('default').registry.describe()) expect(['viewer', 'editor', 'owner']).toContain(d.access);
  });
});
