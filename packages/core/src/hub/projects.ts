import type { Db } from '../db.js';
import { PROJECT_ROLES, type Actor, type ProjectRole } from '../registry.js';
import { conflict, invalid, KalibraError, newId, notFound, nowIso, parseJson } from '../util.js';
import type { Group, Member, Project } from './types.js';

/*
 * Projects and who may use them. A member is a user or a group with a role; a user's role in a
 * project is the highest of their own membership and their groups' memberships. Server
 * administrators are owners of every project (see Hub.roleIn).
 */

/** The project that lives directly in the hub folder (the workspace from before projects existed). */
export const DEFAULT_PROJECT = 'default';

const toProject = (r: any): Project => ({
  id: r.id,
  name: r.name,
  description: r.description,
  dir: r.dir,
  createdAt: r.created_at,
  createdBy: parseJson<Actor>(r.created_by, { kind: 'user', id: 'local' }),
  updatedAt: r.updated_at,
  ...(r.deleted_at ? { deletedAt: r.deleted_at } : {}),
});

const rank = (r: ProjectRole) => PROJECT_ROLES.indexOf(r);
const highest = (roles: ProjectRole[]): ProjectRole | undefined => roles.sort((a, b) => rank(b) - rank(a))[0];

export class Projects {
  constructor(private db: Db) {}

  // ── Projects ──────────────────────────────────────────────────────────────

  /** Makes sure the default project exists (it holds the data of workspaces older than projects). */
  ensureDefault(name: string) {
    if (this.db.get('SELECT 1 FROM projects WHERE id = ?', DEFAULT_PROJECT)) return;
    const now = nowIso();
    this.db.run('INSERT INTO projects (id, name, description, dir, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', DEFAULT_PROJECT, name, '', '.', now, JSON.stringify({ kind: 'system', id: 'kalibra' }), now);
  }

  list(opts: { deleted?: boolean } = {}): Project[] {
    return this.db.all(`SELECT * FROM projects WHERE deleted_at IS ${opts.deleted ? 'NOT ' : ''}NULL ORDER BY name COLLATE NOCASE`).map(toProject);
  }

  /** A live project by id or name. */
  get(idOrName: string): Project {
    // An id wins over another project named like it (e.g. a project called "default").
    const r = this.db.get('SELECT * FROM projects WHERE (id = ? OR name = ? COLLATE NOCASE) AND deleted_at IS NULL ORDER BY id = ? DESC LIMIT 1', idOrName, idOrName, idOrName);
    if (!r) throw notFound('Project', idOrName);
    return toProject(r);
  }

  getAny(id: string): Project {
    const r = this.db.get('SELECT * FROM projects WHERE id = ?', id);
    if (!r) throw notFound('Project', id);
    return toProject(r);
  }

  create(input: { name: string; description?: string }, actor: Actor): Project {
    const name = cleanName(input.name);
    this.assertFreeName(name);
    const id = newId('prj');
    const now = nowIso();
    this.db.run(
      'INSERT INTO projects (id, name, description, dir, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, name, input.description?.trim() ?? '', `projects/${id}`, now, JSON.stringify(actor), now,
    );
    return this.get(id);
  }

  update(id: string, patch: { name?: string; description?: string }): Project {
    const cur = this.get(id);
    const name = patch.name !== undefined ? cleanName(patch.name) : cur.name;
    if (name.toLowerCase() !== cur.name.toLowerCase()) this.assertFreeName(name);
    this.db.run('UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?', name, patch.description?.trim() ?? cur.description, nowIso(), cur.id);
    return this.get(cur.id);
  }

  /** Moves a project to the trash. Its folder stays on disk until an administrator removes it. */
  trash(id: string) {
    const cur = this.get(id);
    if (cur.id === DEFAULT_PROJECT) throw invalid('The default project cannot be deleted. Rename it or remove its contents instead.');
    this.db.run('UPDATE projects SET deleted_at = ? WHERE id = ?', nowIso(), cur.id);
    return cur;
  }

  restore(id: string) {
    const cur = this.getAny(id);
    if (!cur.deletedAt) return cur;
    this.assertFreeName(cur.name);
    this.db.run('UPDATE projects SET deleted_at = NULL, updated_at = ? WHERE id = ?', nowIso(), id);
    return this.get(id);
  }

  private assertFreeName(name: string) {
    if (this.db.get('SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL', name)) throw conflict(`A project named "${name}" already exists`);
  }

  // ── Members ───────────────────────────────────────────────────────────────

  members(projectId: string): Member[] {
    return this.db
      .all(
        `SELECT m.*, u.name AS user_name, u.username, g.name AS group_name
           FROM members m
           LEFT JOIN users u ON m.principal_type = 'user' AND u.id = m.principal_id
           LEFT JOIN user_groups g ON m.principal_type = 'group' AND g.id = m.principal_id
          WHERE m.project_id = ?
          ORDER BY m.principal_type DESC, COALESCE(u.name, g.name) COLLATE NOCASE`,
        projectId,
      )
      .map((m) => ({
        type: m.principal_type,
        id: m.principal_id,
        name: m.user_name ?? m.group_name ?? m.principal_id,
        ...(m.username ? { username: m.username } : {}),
        role: m.role,
        addedAt: m.added_at,
      }));
  }

  /** Adds a member or changes their role. Keeps at least one owner. */
  setMember(projectId: string, type: 'user' | 'group', id: string, role: ProjectRole, by: string) {
    const exists = type === 'user' ? this.db.get('SELECT 1 FROM users WHERE id = ?', id) : this.db.get('SELECT 1 FROM user_groups WHERE id = ?', id);
    if (!exists) throw notFound(type === 'user' ? 'User' : 'Group', id);
    const cur = this.db.get('SELECT role FROM members WHERE project_id = ? AND principal_type = ? AND principal_id = ?', projectId, type, id);
    if (cur?.role === 'owner' && role !== 'owner') this.assertNotLastOwner(projectId);
    this.db.run(
      `INSERT INTO members (project_id, principal_type, principal_id, role, added_at, added_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, principal_type, principal_id) DO UPDATE SET role = excluded.role`,
      projectId, type, id, role, nowIso(), by,
    );
  }

  removeMember(projectId: string, type: 'user' | 'group', id: string) {
    const cur = this.db.get('SELECT role FROM members WHERE project_id = ? AND principal_type = ? AND principal_id = ?', projectId, type, id);
    if (!cur) throw notFound('Member', id);
    if (cur.role === 'owner') this.assertNotLastOwner(projectId);
    this.db.run('DELETE FROM members WHERE project_id = ? AND principal_type = ? AND principal_id = ?', projectId, type, id);
  }

  private assertNotLastOwner(projectId: string) {
    const owners = this.db.get("SELECT COUNT(*) AS n FROM members WHERE project_id = ? AND role = 'owner'", projectId).n;
    if (owners <= 1) throw new KalibraError('conflict', 'A project needs at least one owner. Make someone else an owner first.');
  }

  /** The user's own role in a project, from direct membership and their groups (not admin rights). */
  memberRole(projectId: string, userId: string): ProjectRole | undefined {
    const roles = this.db
      .all(
        `SELECT role FROM members WHERE project_id = ? AND principal_type = 'user' AND principal_id = ?
         UNION ALL
         SELECT m.role FROM members m JOIN user_group_members gm ON gm.group_id = m.principal_id
          WHERE m.project_id = ? AND m.principal_type = 'group' AND gm.user_id = ?`,
        projectId, userId, projectId, userId,
      )
      .map((r) => r.role as ProjectRole);
    return highest(roles);
  }

  /** Project ids the user is a member of (directly or through a group), with their role. */
  rolesOf(userId: string): Map<string, ProjectRole> {
    const out = new Map<string, ProjectRole>();
    const rows = this.db.all(
      `SELECT project_id, role FROM members WHERE principal_type = 'user' AND principal_id = ?
       UNION ALL
       SELECT m.project_id, m.role FROM members m JOIN user_group_members gm ON gm.group_id = m.principal_id
        WHERE m.principal_type = 'group' AND gm.user_id = ?`,
      userId, userId,
    );
    for (const r of rows) {
      const cur = out.get(r.project_id);
      if (!cur || rank(r.role) > rank(cur)) out.set(r.project_id, r.role);
    }
    return out;
  }

  /** Drops a user's or group's memberships everywhere (when a group is deleted). */
  removePrincipal(type: 'user' | 'group', id: string) {
    this.db.run('DELETE FROM members WHERE principal_type = ? AND principal_id = ?', type, id);
  }

  memberCount(projectId: string): number {
    return this.db.get('SELECT COUNT(*) AS n FROM members WHERE project_id = ?', projectId).n;
  }

  // ── Groups ────────────────────────────────────────────────────────────────

  groups(): Group[] {
    return this.db
      .all('SELECT g.*, (SELECT COUNT(*) FROM user_group_members gm WHERE gm.group_id = g.id) AS n FROM user_groups g ORDER BY g.name')
      .map((g) => ({ id: g.id, name: g.name, description: g.description, source: g.source, ...(g.external_key ? { externalKey: g.external_key } : {}), members: g.n, createdAt: g.created_at }));
  }

  group(idOrName: string): Group {
    const all = this.groups();
    const g = all.find((x) => x.id === idOrName) ?? all.find((x) => x.name.toLowerCase() === idOrName.toLowerCase());
    if (!g) throw notFound('Group', idOrName);
    return g;
  }

  createGroup(input: { name: string; description?: string; source?: string; externalKey?: string }): Group {
    const name = cleanName(input.name);
    if (this.db.get('SELECT 1 FROM user_groups WHERE name = ?', name)) throw conflict(`A group named "${name}" already exists`);
    const id = newId('grp');
    this.db.run(
      'INSERT INTO user_groups (id, name, description, source, external_key, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id, name, input.description?.trim() ?? '', input.source ?? 'local', input.externalKey ?? null, nowIso(),
    );
    return this.group(id);
  }

  updateGroup(id: string, patch: { name?: string; description?: string }): Group {
    const cur = this.group(id);
    const name = patch.name !== undefined ? cleanName(patch.name) : cur.name;
    if (name.toLowerCase() !== cur.name.toLowerCase() && this.db.get('SELECT 1 FROM user_groups WHERE name = ?', name)) throw conflict(`A group named "${name}" already exists`);
    this.db.run('UPDATE user_groups SET name = ?, description = ? WHERE id = ?', name, patch.description?.trim() ?? cur.description, cur.id);
    return this.group(cur.id);
  }

  deleteGroup(id: string) {
    const g = this.group(id);
    this.db.tx(() => {
      this.db.run('DELETE FROM user_group_members WHERE group_id = ?', g.id);
      this.removePrincipal('group', g.id);
      this.db.run('DELETE FROM user_groups WHERE id = ?', g.id);
    });
    return g;
  }

  /** The group mirroring a provider group, created on first sight. */
  ensureExternalGroup(source: string, externalKey: string): Group {
    const found = this.db.get('SELECT id FROM user_groups WHERE source = ? AND external_key = ?', source, externalKey);
    if (found) return this.group(found.id);
    // Group names are unique; prefix with the provider when a local group already has the name.
    let name = externalKey.slice(0, 80);
    if (this.db.get('SELECT 1 FROM user_groups WHERE name = ?', name)) name = `${source}: ${externalKey}`.slice(0, 80);
    return this.createGroup({ name, description: `Synced from ${source}`, source, externalKey });
  }

  groupMembers(groupId: string): { id: string; username: string; name: string }[] {
    return this.db.all('SELECT u.id, u.username, u.name FROM user_group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY u.name COLLATE NOCASE', groupId);
  }

  setGroupMembers(groupId: string, userIds: string[]) {
    const g = this.group(groupId);
    this.db.tx(() => {
      this.db.run('DELETE FROM user_group_members WHERE group_id = ?', g.id);
      for (const id of new Set(userIds)) {
        if (!this.db.get('SELECT 1 FROM users WHERE id = ?', id)) throw notFound('User', id);
        this.db.run('INSERT INTO user_group_members (group_id, user_id, added_at) VALUES (?, ?, ?)', g.id, id, nowIso());
      }
    });
  }

  /** Puts the user in exactly these groups of one source (used when a provider reports groups at sign-in). */
  syncUserGroups(userId: string, source: string, groupIds: string[]) {
    this.db.tx(() => {
      this.db.run('DELETE FROM user_group_members WHERE user_id = ? AND group_id IN (SELECT id FROM user_groups WHERE source = ?)', userId, source);
      for (const id of new Set(groupIds)) this.db.run('INSERT OR IGNORE INTO user_group_members (group_id, user_id, added_at) VALUES (?, ?, ?)', id, userId, nowIso());
    });
  }

  userGroups(userId: string): { id: string; name: string; source: string }[] {
    return this.db.all('SELECT g.id, g.name, g.source FROM user_group_members gm JOIN user_groups g ON g.id = gm.group_id WHERE gm.user_id = ? ORDER BY g.name', userId);
  }
}

function cleanName(name: string) {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n) throw invalid('Name is required');
  if (n.length > 80) throw invalid('Use at most 80 characters');
  return n;
}
