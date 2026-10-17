import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openHub } from '../src/engine-client.js';
import { detectGit, runUrl } from '../src/report.js';

const run = promisify(execFile);

describe('git details for CI runs', () => {
  const noGit = () => undefined;

  it('reads a GitHub pull request: source branch, number, base branch', () => {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/pull/42/merge', GITHUB_HEAD_REF: 'feature/better-prompt', GITHUB_BASE_REF: 'main', GITHUB_SHA: 'abc123', GITHUB_REF_NAME: '42/merge', GITHUB_REF_TYPE: 'branch' };
    expect(detectGit(env, {}, noGit)).toEqual({ branch: 'feature/better-prompt', commit: 'abc123', pr: 42, baseBranch: 'main' });
  });

  it('reads a push to main on GitHub, and lets flags win', () => {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main', GITHUB_REF_TYPE: 'branch', GITHUB_SHA: 'def456', GITHUB_BASE_REF: '' };
    expect(detectGit(env, {}, noGit)).toEqual({ branch: 'main', commit: 'def456' });
    expect(detectGit(env, { branch: 'release', baseBranch: 'develop' }, noGit)).toEqual({ branch: 'release', commit: 'def456', baseBranch: 'develop' });
  });

  it('falls back to the local repository, and to nothing outside one', () => {
    const git = (args: string[]) => (args.includes('--abbrev-ref') ? 'my-branch' : 'f00d');
    expect(detectGit({}, {}, git)).toEqual({ branch: 'my-branch', commit: 'f00d' });
    expect(detectGit({}, {}, () => 'HEAD')).toEqual({ commit: 'HEAD' });
    expect(detectGit({}, {}, noGit)).toBeUndefined();
  });

  it('links runs only on a team server', () => {
    expect(runUrl('https://kalibra.example.com/', 'Team evals', 'run_1')).toBe('https://kalibra.example.com/kalibra/p/Team%20evals/runs/run_1');
    expect(runUrl('https://kalibra.example.com/kalibra', 'p', 'r')).toBe('https://kalibra.example.com/kalibra/p/p/runs/r');
    expect(runUrl(undefined, 'p', 'r')).toBeUndefined();
  });
});

describe('kalibra eval-report', () => {
  let dir: string;
  let feature: string;
  const root = resolve(__dirname, '../../..');
  const cli = (...args: string[]) => run(join(root, 'node_modules/.bin/tsx'), [join(root, 'packages/cli/src/main.ts'), ...args, '--dir', dir], { env: { ...process.env, KALIBRA_URL: '', GITHUB_ACTIONS: '' } });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-report-'));
    const hub = await openHub(dir);
    const me = hub.localPrincipal();
    const call = (op: string, input: unknown) => hub.callProject<any>(me, 'default', op, input);
    await call('create_dataset', { name: 'Math', columns: [{ key: 'q' }, { key: 'expected' }] });
    await call('add_dataset_rows', { dataset: 'Math', rows: [{ data: { q: '1+1', expected: '2' } }, { data: { q: '2+2', expected: '4' } }] });
    await call('create_suite', { name: 'Exact', spec: { checks: [{ id: 'eq', type: 'equals', name: 'Matches', config: { actual: '{{output}}', expected: '{{expected}}' } }] } });
    const codeRun = async (branch: string, answer: (q: string) => string) => {
      const s = await call('start_code_run', { dataset: 'Math', suite: 'Exact', git: { branch, baseBranch: 'main' } });
      await call('submit_code_results', { runId: s.runId, results: s.rows.map((r: any) => ({ rowId: r.id, outputs: { output: answer(r.data.q) } })) });
      return (await call('finish_code_run', { runId: s.runId })).run.id as string;
    };
    await codeRun('main', (q) => String(eval(q)));
    feature = await codeRun('feature/x', (q) => (q === '2+2' ? '5' : String(eval(q))));
    await hub.close();
  }, 60_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('prints the markdown comparison with the base branch', async () => {
    const { stdout } = await cli('eval-report', feature);
    expect(stdout).toContain('<!-- kalibra-eval -->');
    expect(stdout).toMatch(/Pass rate 50\.0%/);
    expect(stdout).toMatch(/Compared with run #1 on `main` \(100\.0%\): \*\*−50\.0 pts\*\* · 1 new failure · 0 fixed/);
    expect(stdout).toMatch(/Matches: Got \\?"5\\?", expected \\?"4\\?"/);
  }, 60_000);

  it('prints JSON with --format json', async () => {
    const { stdout } = await cli('eval-report', feature, '--format', 'json');
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({ delta: -0.5, counts: { newFailures: 1, fixed: 0 }, baseline: { git: { branch: 'main' } } });
  }, 60_000);
});
