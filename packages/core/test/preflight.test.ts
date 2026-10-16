import { describe, expect, it } from 'vitest';
import { preflight } from '../src/runner/preflight.js';
import { DatasetSchema, TargetSpec } from '../src/specs.js';
import { getCheckType } from '../src/checks/index.js';

const schema = (keys: string[]) => DatasetSchema.parse({ columns: keys.map((key) => ({ key })) });
const http = (body: string, extra: Record<string, unknown> = {}) =>
  TargetSpec.parse({ variables: [{ key: 'base_url', value: 'http://x' }], config: { kind: 'http', url: '{{vars.base_url}}/chat', body: { type: 'json', content: body }, ...extra } });

describe('run preflight', () => {
  it('flags columns the dataset does not have', () => {
    const w = preflight(http('{"message": "{{question}}"}'), schema(['prompt', 'expected_behavior']));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ kind: 'missing_column', name: 'question' });
    expect(w[0].message).toContain('prompt');
  });

  it('accepts matching columns, built-ins, secrets, dynamic values and filters', () => {
    const t = http('{"q": {{question | json}}, "id": "{{row_id}}", "k": "{{secret.key}}", "u": "{{$uuid}}", "h": {{history | json}}}');
    expect(preflight(t, schema(['question']))).toEqual([]);
  });

  it('ignores templates inside scripts and JS expressions', () => {
    const t = http('{"q": "{{question}}"}', { scripts: { beforeRequest: 'request.body = "{{nope}}"', afterResponse: '' } });
    expect(preflight(t, schema(['question']))).toEqual([]);
  });

  it('flags undefined target variables', () => {
    const t = TargetSpec.parse({ config: { kind: 'http', url: '{{vars.base_url}}/x' } });
    expect(preflight(t, schema([]))).toEqual([expect.objectContaining({ kind: 'missing_variable', name: 'base_url' })]);
  });

  it('flags a scripted conversation without its turns column', () => {
    const w = preflight(http('{"m": "{{message}}"}'), schema(['goal']), { mode: 'scripted', turnsColumn: 'turns' } as any);
    expect(w.map((x) => x.kind)).toEqual(['conversation_column']);
  });
});

describe('refusal check with no output', () => {
  const ctx = (scope: Record<string, unknown>) => ({ scope, env: {}, llm: {} as any, log: () => {}, workspaceDir: '.', signal: new AbortController().signal });
  it('fails with a clear reason instead of reporting unsafe compliance', async () => {
    const r = await getCheckType('refusal')!.run({}, ctx({ output: undefined, expected_behavior: 'refuse' }));
    expect(r.status).toBe('fail');
    expect(r.reason).toMatch(/no output/i);
  });
});
