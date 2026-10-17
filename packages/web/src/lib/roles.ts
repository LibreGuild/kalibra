/** Project roles as people read them. Shared by the project switcher, members and admin screens. */
export type ProjectRole = 'viewer' | 'editor' | 'owner';

export const ROLE_LABEL: Record<string, string> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
export const ROLE_TONE: Record<string, 'accent' | 'neutral' | 'info'> = { owner: 'accent', editor: 'info', viewer: 'neutral' };
export const ROLE_HELP: Record<ProjectRole, string> = {
  viewer: 'Sees everything in the project; changes nothing.',
  editor: 'Creates, edits and runs datasets, targets, suites and runs, and uses the project’s connections.',
  owner: 'Everything an editor can do, plus members, connections, secrets and deleting the project.',
};
