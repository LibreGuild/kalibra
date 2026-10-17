import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/hub/hub.js';
import { Gate } from '../src/hub/passwords.js';
import { identityKey, MAX_PENDING, safeNext } from '../src/hub/sso.js';
import { codeIn } from '../src/sharing/common.js';
import type { Principal, User } from '../src/hub/types.js';

/* Regression tests from the security review of accounts, projects and sign-in. */

const PW = 'correct horse battery';
const dirs: string[] = [];
const hubs: Hub[] = [];
const as = (user: User, extra: Partial<Principal> = {}): Principal => ({ user, via: 'user', ...extra });

async function server() {
  const dir = mkdtempSync(join(tmpdir(), 'kalibra-sec-'));
  dirs.push(dir);
  const hub = await Hub.open({ dir, mode: 'server' });
  hubs.push(hub);
  const admin = await hub.completeSetup((await hub.setupCode())!, { username: 'admin', password: PW });
  const alice = await hub.call<User>(as(admin), 'create_user', { username: 'alice', password: PW, mustChangePassword: false });
  return { hub, admin, alice };
}

afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe('code policy', () => {
  it('treats WebSocket session scripts as code', async () => {
    const { hub, admin, alice } = await server();
    await hub.call(as(admin), 'update_server_settings', { codePolicy: 'admins' });
    const p = await hub.call<any>(as(alice), 'create_project', { name: 'WS' });
    const spec = { config: { kind: 'websocket', url: 'wss://example.test/stt', scripts: { session: 'return { output: require("fs").readFileSync("/etc/passwd", "utf8") }' } } };
    expect(codeIn(spec)).toEqual(['session']);
    await expect(hub.callProject(as(alice), p.id, 'create_target', { name: 'Sneaky', spec })).rejects.toThrow(/only administrators/);
    await expect(hub.callProject(as(alice), p.id, 'test_target', { spec, values: {} })).rejects.toThrow(/only administrators/);
  });
});

describe('sign-in providers', () => {
  it('keeps fields a partial save leaves out (no defaults filled in)', async () => {
    const { hub, admin } = await server();
    await hub.call(as(admin), 'save_auth_provider', { name: 'Corp', kind: 'oidc', issuer: 'https://idp.example', clientId: 'c', clientSecret: 's', allowedDomains: ['corp.example'], autoCreate: true });
    // Turning it off must not reset who it lets in, nor its issuer.
    await hub.call(as(admin), 'save_auth_provider', { id: 'corp', enabled: false });
    await hub.call(as(admin), 'save_auth_provider', { id: 'corp', enabled: true });
    expect(await hub.providers.get('corp')).toMatchObject({ enabled: true, issuer: 'https://idp.example', allowedDomains: ['corp.example'], autoCreate: true });
  });

  it('refuses gateway trust lists that cover every address', async () => {
    const { hub, admin } = await server();
    for (const everyone of ['0.0.0.0/0', '::/0', '*']) {
      await expect(hub.call(as(admin), 'save_auth_provider', { name: 'Gate', kind: 'proxy', emailHeader: 'X-Email', trustedProxies: [everyone] })).rejects.toThrow(/from anywhere/);
    }
  });

  it('links invited accounts by email only when exactly one active account has it', async () => {
    const { hub, admin } = await server();
    await hub.providers.save({ name: 'Corp', id: 'corp', kind: 'oidc', issuer: 'https://idp.example', clientId: 'c', clientSecret: 's' });
    const corp = await hub.providers.get('corp');
    await hub.call(as(admin), 'create_user', { username: 'dup1', email: 'dup@corp.example' });
    await hub.call(as(admin), 'create_user', { username: 'dup2', email: 'DUP@corp.example' });
    const profile = { subject: 's-dup', email: 'dup@corp.example', emailVerified: true, name: 'Dup', username: 'dup', groups: [] };
    await expect(hub.sso.admit(corp, profile, '')).rejects.toThrow(/More than one Kalibra account/);
  });

  it('does not hand an account to a second identity at the same provider (reused email addresses)', async () => {
    const { hub, admin } = await server();
    await hub.providers.save({ name: 'Corp', id: 'corp', kind: 'oidc', issuer: 'https://idp.example', clientId: 'c', clientSecret: 's' });
    const corp = await hub.providers.get('corp');
    const lee = await hub.call<User>(as(admin), 'create_user', { username: 'lee', email: 'lee@corp.example' });
    const first = await hub.sso.admit(corp, { subject: 'employee-1', email: 'lee@corp.example', emailVerified: true, name: 'Lee', username: 'lee', groups: [] }, '');
    expect(first.id).toBe(lee.id);
    // Years later the address goes to someone new at the same company IdP.
    await expect(hub.sso.admit(corp, { subject: 'employee-2', email: 'lee@corp.example', emailVerified: true, name: 'New Lee', username: 'lee2', groups: [] }, '')).rejects.toThrow(/linked to another Corp account/);
  });

  it('scopes identities to the server they came from, so repointing a provider cannot take over accounts', async () => {
    const { hub } = await server();
    await hub.providers.save({ name: 'GitHub', id: 'gh', kind: 'github', githubUrl: 'https://github.com', clientId: 'c', clientSecret: 's', autoCreate: true });
    const before = await hub.sso.admit(await hub.providers.get('gh'), { subject: '4242', email: '', emailVerified: false, name: 'Octo', username: 'octo', groups: [] }, '');
    await hub.providers.save({ id: 'gh', githubUrl: 'https://github.mycompany.example' });
    const after = await hub.sso.admit(await hub.providers.get('gh'), { subject: '4242', email: '', emailVerified: false, name: 'Someone else', username: 'someone', groups: [] }, '');
    expect(after.id).not.toBe(before.id);
    expect(identityKey(await hub.providers.get('gh'), '4242')).toBe('https://github.mycompany.example#4242');
  });

  it('only returns to same-site paths, whatever characters browsers ignore', () => {
    for (const evil of ['/\t/evil.example', '/\n/evil.example', '/\\evil.example', '/\\/evil.example', '//evil.example', 'https://evil.example', '/api/hub/get_me', '/\u0000x', '/kalibra//evil.example', '/kalibra/api/hub/get_me', '/kalibra/\\evil.example']) {
      expect(safeNext(evil), JSON.stringify(evil)).toBe('/');
    }
    expect(safeNext('/p/abc/runs?tab=checks#x')).toBe('/p/abc/runs?tab=checks#x');
    // App paths: the server adds /kalibra in front, so a full /kalibra/… path is accepted too.
    expect(safeNext('/kalibra/p/abc/runs')).toBe('/p/abc/runs');
    expect(safeNext('/kalibra')).toBe('/');
    expect(safeNext('/kalibraevil')).toBe('/kalibraevil');
  });

  it('keeps a bounded number of sign-ins in progress', async () => {
    const { hub } = await server();
    await hub.providers.save({ name: 'GitHub', id: 'gh', kind: 'github', githubUrl: 'https://github.com', clientId: 'c', clientSecret: 's' });
    for (let i = 0; i < MAX_PENDING + 50; i++) await hub.sso.start('gh', { redirectUri: 'https://k.example/api/auth/sso/gh/callback' });
    expect((await hub.db.get('SELECT COUNT(*) AS n FROM sso_pending')).n).toBeLessThanOrEqual(MAX_PENDING);
  }, 60_000); // a few thousand statements: seconds over a network database
});

describe('accounts', () => {
  it('locks the account even when wrong passwords arrive in parallel', async () => {
    const { hub } = await server();
    await Promise.allSettled(Array.from({ length: 8 }, () => hub.accounts.authenticate('alice', 'wrong password!')));
    await expect(hub.accounts.authenticate('alice', PW)).rejects.toThrow(/Too many wrong passwords/);
  });

  it('runs a bounded number of password hashes at once and refuses an endless queue', async () => {
    const gate = new Gate(2, 1);
    let running = 0;
    let peak = 0;
    const task = () =>
      gate.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
      });
    const runs = [task(), task(), task()];
    await expect(task()).rejects.toMatchObject({ code: 'unavailable' });
    await Promise.all(runs);
    expect(peak).toBe(2);
    await task(); // slots are released afterwards
  });

  it('does not let people change their own email (sign-in providers link accounts by email)', async () => {
    const { hub, alice } = await server();
    await expect(hub.call(as(alice), 'update_me', { email: 'boss@corp.example' })).rejects.toThrow(/administrator/);
    const me = await hub.call<User>(as(alice), 'update_me', { name: 'Alice A.', email: '' });
    expect(me).toMatchObject({ name: 'Alice A.', email: '' });
  });

  it('gives the configured password to an existing account named as the configured administrator', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kalibra-sec-'));
    dirs.push(dir);
    const hub = await Hub.open({ dir, mode: 'server' });
    hubs.push(hub);
    await hub.accounts.create({ username: 'root', password: 'someone elses password', role: 'user' }, 'test');
    await hub.ensureAdmin('root', 'the configured one');
    const root = await hub.accounts.authenticate('root', 'the configured one');
    expect(root.role).toBe('admin');
    await expect(hub.accounts.authenticate('root', 'someone elses password')).rejects.toThrow();
  });

  it('refuses setup codes of any length without failing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kalibra-sec-'));
    dirs.push(dir);
    const hub = await Hub.open({ dir, mode: 'server' });
    hubs.push(hub);
    for (const code of ['', 'x', `${await hub.setupCode()}x`]) await expect(hub.completeSetup(code, { username: 'a1', password: PW })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('lookups by id or name', () => {
  it('prefers an id over something named like it', async () => {
    const { hub, admin, alice } = await server();
    const a = await hub.call<any>(as(admin), 'create_project', { name: 'First' });
    const b = await hub.call<any>(as(admin), 'create_project', { name: 'Second' });
    await hub.call(as(admin), 'update_project', { project: a.id, name: b.id });
    expect((await hub.projects.get(b.id)).name).toBe('Second');

    // A username can't be someone's id.
    await expect(hub.call(as(admin), 'create_user', { username: alice.id, password: PW })).rejects.toThrow(/taken/);
    expect((await hub.accounts.find(alice.id))?.username).toBe('alice');

    const g1 = await hub.call<any>(as(admin), 'create_group', { name: 'Real' });
    await hub.call(as(admin), 'create_group', { name: g1.id });
    expect((await hub.projects.group(g1.id)).name).toBe('Real');
  });

  it('does not rename a synced group when refusing to edit its members', async () => {
    const { hub, admin } = await server();
    const g = await hub.projects.createGroup({ name: 'speech', source: 'corp', externalKey: 'speech' });
    await expect(hub.call(as(admin), 'update_group', { id: g.id, name: 'renamed', users: ['alice'] })).rejects.toThrow(/come from corp/);
    expect((await hub.projects.group(g.id)).name).toBe('speech');
  });
});
