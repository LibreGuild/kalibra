import type { Actor, ProjectRole } from '../registry.js';

/** Server-wide role. Administrators manage accounts, groups and settings, and own every project. */
export type ServerRole = 'admin' | 'user';

/**
 * How the hub runs:
 *  - local:  `npx kalibra` (`kalibra serve`). One person, no sign-in; the per-launch token
 *            protects the API. Projects exist, members do not.
 *  - server: a team server. Everyone signs in; projects have members and roles.
 */
export type HubMode = 'local' | 'server';

export interface User {
  id: string;
  username: string;
  name: string;
  email: string;
  role: ServerRole;
  disabled: boolean;
  mustChangePassword: boolean;
  hasPassword: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

/**
 * Someone calling the hub: a user, through the browser (a session), or through an access token
 * used by a coding agent, the CLI or a script.
 */
export interface Principal {
  user: User;
  /** "user" for the person in the app; "agent"/"cli" when acting through a token or the MCP bridge. */
  via: 'user' | 'agent' | 'cli';
  client?: string;
  model?: string;
  sessionId?: string;
  /** Set when authenticated with an access token. Account management needs a signed-in session instead. */
  tokenId?: string;
}

/** The single person of a local hub (`npx kalibra`). */
export const LOCAL_ACCOUNT: User = {
  id: 'local',
  username: 'local',
  name: 'You',
  email: '',
  role: 'admin',
  disabled: false,
  mustChangePassword: false,
  hasPassword: false,
  createdAt: '1970-01-01T00:00:00.000Z',
};

export const actorOf = (p: Principal): Actor => ({ kind: p.via, id: p.user.id, name: p.user.name, ...(p.client ? { client: p.client } : {}), ...(p.model ? { model: p.model } : {}) });

export interface Project {
  id: string;
  name: string;
  description: string;
  /** Folder relative to the hub folder. */
  dir: string;
  createdAt: string;
  createdBy: Actor;
  updatedAt: string;
  deletedAt?: string;
}

export interface Member {
  type: 'user' | 'group';
  id: string;
  /** Display name of the user or group. */
  name: string;
  /** Username, for users. */
  username?: string;
  role: ProjectRole;
  addedAt: string;
}

export interface Group {
  id: string;
  name: string;
  description: string;
  source: string;
  externalKey?: string;
  members: number;
  createdAt: string;
}
