import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openHub } from '../src/engine-client.js';

/** The MCP bridge as a coding agent sees it: spawned over stdio, working in projects. */
describe('MCP bridge', () => {
  let dir: string;
  let client: Client;
  const text = (r: any) => JSON.parse(r.content[0].text);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-mcp-'));
    const hub = openHub(dir);
    await hub.call(hub.localPrincipal(), 'create_project', { name: 'Voice' });
    hub.close();
    const root = resolve(__dirname, '../../..');
    client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: join(root, 'node_modules/.bin/tsx'), args: [join(root, 'packages/cli/src/main.ts'), 'mcp', '--dir', dir], stderr: 'ignore' }));
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists project tools, hub tools and use_project, but no account or secret management', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['use_project', 'list_projects', 'create_project', 'list_datasets', 'start_run']));
    for (const hidden of ['set_secret', 'create_user', 'create_token', 'change_password', 'update_server_settings']) expect(names).not.toContain(hidden);
  });

  it('works in the default project and switches with use_project', async () => {
    await client.callTool({ name: 'create_dataset', arguments: { name: 'From agent', columns: [{ key: 'q' }] } });
    const switched = text(await client.callTool({ name: 'use_project', arguments: { project: 'voice' } }));
    expect(switched.now.name).toBe('Voice');
    expect(text(await client.callTool({ name: 'list_datasets', arguments: {} }))).toEqual([]);
    await client.callTool({ name: 'use_project', arguments: { project: 'default' } });
    const [ds] = text(await client.callTool({ name: 'list_datasets', arguments: {} }));
    expect(ds.name).toBe('From agent');
    const [act] = text(await client.callTool({ name: 'list_activity', arguments: {} }));
    expect(act.actor).toMatchObject({ kind: 'agent', client: 'test-agent' });
    const missing = await client.callTool({ name: 'use_project', arguments: { project: 'nope' } });
    expect(missing.isError).toBe(true);
  });
});
