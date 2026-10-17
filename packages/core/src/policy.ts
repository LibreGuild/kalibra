import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { OpContext } from './registry.js';
import { codeIn, codeSnippets } from './sharing/common.js';
import { KalibraError } from './util.js';

/*
 * Host policies that apply on top of project roles, enforced where the data is written so every
 * path (operations, imports, agents, the playground) is covered by one check.
 *
 * The context of the operation being executed travels with the async call chain, so a repository
 * deep inside an import can ask "may this caller write code?" without every function passing it on.
 */

const store = new AsyncLocalStorage<OpContext>();

/** Runs `fn` as part of operation `ctx` (Engine.call does this for every operation). */
export const withCall = <T>(ctx: OpContext, fn: () => T): T => store.run(ctx, fn);

/** The operation currently executing, if any. Engine-internal work (recovery, seeds) has none. */
export const currentCall = (): OpContext | undefined => store.getStore();

/**
 * Throws when the current caller may not write code and `after` adds or changes JavaScript
 * compared with `before`. Removing code, or saving other fields of a definition that already
 * has code, is always allowed — so editors can still tweak a target an administrator scripted.
 */
export function assertCodeChange(before: unknown, after: unknown, what: string) {
  const ctx = currentCall();
  if (!ctx || ctx.caps.code) return;
  const had = new Map<string, number>();
  for (const s of codeSnippets(before)) had.set(s, (had.get(s) ?? 0) + 1);
  for (const s of codeSnippets(after)) {
    const n = had.get(s) ?? 0;
    if (n === 0) {
      throw new KalibraError(
        'forbidden',
        `${what} adds or changes JavaScript (${codeIn(after).join(', ')}). On this server only administrators can add or change code.`,
      );
    }
    had.set(s, n - 1);
  }
}

/**
 * Checks a folder path given to folder sync and returns it resolved. Servers turn folder sync off,
 * or confine it to one directory, because the path is on the server's disk, not the user's.
 */
export function allowedFolder(ctx: OpContext, dir: string): string {
  if (!ctx.caps.filesystem) throw new KalibraError('forbidden', 'Folder sync is turned off on this server. Use bundles to share, or ask an administrator.');
  if (!ctx.caps.folderRoot) return dir; // folder sync itself checks the path (absolute, not a system folder)
  const root = resolve(ctx.caps.folderRoot);
  const target = resolve(root, dir);
  if (!isInside(realish(root), realish(target))) {
    throw new KalibraError('forbidden', `Folders must be inside ${root} on this server`);
  }
  return target;
}

function isInside(root: string, path: string) {
  const rel = relative(root, path);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

/** Real path of `p`, following links in the part of it that exists (the rest may not exist yet). */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return p;
    rest.unshift(cur.slice(parent.length + 1));
    cur = parent;
  }
  return resolve(realpathSync(cur), ...rest);
}
