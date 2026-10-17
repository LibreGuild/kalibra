import { execFileSync } from 'node:child_process';
import { BASE_PATH, publicOrigin, type GitInfo } from '@kalibra/core';

/*
 * CI helpers for `kalibra run --baseline … --report markdown` and `kalibra eval-report`: which
 * branch, commit and pull request a run belongs to (so pull requests compare with their base
 * branch), and links to runs on a team server. The report itself is rendered by core
 * (renderEvalReport), so the CLI, the SDKs and the server all print the same thing.
 */

type Env = Record<string, string | undefined>;
type Git = (args: string[]) => string | undefined;

/** Runs a git command in the current folder; undefined outside a repository or without git. */
const localGit: Git = (args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim() || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Git details of the code under test. Flags win; then GitHub Actions variables (a pull request's
 * source branch, its number and its base branch); then the local repository.
 */
export function detectGit(env: Env, flags: { branch?: string; commit?: string; baseBranch?: string } = {}, git: Git = localGit): GitInfo | undefined {
  const onGithub = env.GITHUB_ACTIONS === 'true';
  const pr = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '')?.[1];
  const branch =
    flags.branch ||
    (onGithub ? env.GITHUB_HEAD_REF || (env.GITHUB_REF_TYPE === 'branch' ? env.GITHUB_REF_NAME : undefined) : undefined) ||
    (onGithub ? undefined : git(['rev-parse', '--abbrev-ref', 'HEAD']));
  const commit = flags.commit || (onGithub ? env.GITHUB_SHA : git(['rev-parse', 'HEAD']));
  const baseBranch = flags.baseBranch || (onGithub ? env.GITHUB_BASE_REF || undefined : undefined);
  const info: GitInfo = {
    ...(branch && branch !== 'HEAD' ? { branch } : {}),
    ...(commit ? { commit } : {}),
    ...(pr ? { pr: Number(pr) } : {}),
    ...(baseBranch ? { baseBranch } : {}),
  };
  return Object.keys(info).length ? info : undefined;
}

/** Link to a run on a team server (none for the local app, whose address needs its per-launch token). */
export function runUrl(server: string | undefined, project: string, runId: string): string | undefined {
  if (!server) return undefined;
  return `${publicOrigin(server)}${BASE_PATH}/p/${encodeURIComponent(project)}/runs/${encodeURIComponent(runId)}`;
}
