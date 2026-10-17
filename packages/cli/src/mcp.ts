import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Actor } from '@kalibra/core';
import { connect, type ConnectOptions, type OpsClient } from './engine-client.js';

/*
 * MCP bridge. Tools are generated from the operation registries (project operations plus hub
 * operations such as list_projects), so a coding agent can do everything the UI can, except
 * handling secret values and managing accounts. The user drives their own agent; Kalibra never
 * launches or calls one. Calls are recorded with an "agent" actor for provenance.
 *
 * The bridge works in one project at a time; the agent switches with the use_project tool.
 */

/** A tool the bridge itself answers: which project the following calls go to. */
const USE_PROJECT = {
  name: 'use_project',
  title: 'Switch project',
  description: 'Makes later calls work in another project (see list_projects). Every project has its own datasets, targets, suites, runs and connections.',
  inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project id or name' } }, required: ['project'] },
};

const MAX_TEXT = 60_000;

const PROMPTS = [
  {
    name: 'generate-rows',
    description: 'Write new rows for a dataset that follow its columns and instructions',
    arguments: [
      { name: 'dataset', description: 'Dataset name or id', required: true },
      { name: 'count', description: 'How many rows to add (default 20)', required: false },
      { name: 'guidance', description: 'Extra guidance for these rows', required: false },
    ],
    text: (a: Record<string, string>) =>
      `Add ${a.count || 20} new rows to the Kalibra dataset "${a.dataset}".
1. Call get_dataset_schema to read the columns, their descriptions, the instructions and sample rows.
2. Write varied, realistic rows that follow the column types exactly. Cover different cases rather than repeating patterns.${a.guidance ? `\n   Extra guidance: ${a.guidance}` : ''}
3. Send them with add_dataset_rows in batches of 20–50. If rows are rejected, read the reasons, fix those rows and resend only them.
4. Finish with a one-line summary of what you added. The rows appear in Kalibra for review.`,
  },
  {
    name: 'run-and-report',
    description: 'Run a suite against a target on a dataset and summarize the failures',
    arguments: [
      { name: 'dataset', description: 'Dataset name or id', required: true },
      { name: 'target', description: 'Target name or id', required: true },
      { name: 'suite', description: 'Suite name or id', required: true },
    ],
    text: (a: Record<string, string>) =>
      `Use Kalibra to evaluate target "${a.target}" on dataset "${a.dataset}" with suite "${a.suite}".
1. Call start_run. If it returns warnings (e.g. the target uses a column the dataset lacks), stop and tell me before waiting on results. Otherwise poll get_run until status is completed (wait a few seconds between polls).
2. Report the pass rate with its interval, each check's pass rate, and corpus metrics such as WER.
3. Call get_failure_themes to see failures grouped by cause. Then call query_results with filter "failed" and sort "score", look at the worst rows with get_result, and explain the main failure patterns.`,
  },
  {
    name: 'setup-target',
    description: 'Read this codebase and create a Kalibra target for one of its endpoints',
    arguments: [{ name: 'endpoint', description: 'Which endpoint or feature to test', required: true }],
    text: (a: Record<string, string>) =>
      `Find how the endpoint "${a.endpoint}" is called in this codebase (route, method, request body, auth, response shape).
Then create a Kalibra target with create_target (kind "http" or "websocket"), using {{column}} placeholders for dataset values and {{secret.NAME}} for credentials (ask me to store secrets in the Kalibra app; never put secret values in the target).
Map the main response field to an output named "output" with a JSONPath extractor. Try it with test_target and fix it until it works.`,
  },
];

export async function runMcp(dir: string, connectOpts: ConnectOptions = {}) {
  let client: OpsClient | undefined;
  const server = new Server(
    { name: 'kalibra', version: '0.1.0' },
    {
      capabilities: { tools: {}, prompts: {} },
      instructions:
        'Kalibra evaluates AI applications. Work happens inside a project (list_projects, use_project); each holds datasets (test rows), targets (call the app under test), suites (layered checks) and runs (scored results). Read before you write (get_dataset_schema, get_target, get_suite). Pass baseVersion/baseRevision when updating so you never overwrite a newer edit. Rows you add start as "needs_review" for a human. Never ask for or handle secret values.',
    },
  );

  const actor = (): Actor => {
    const info = server.getClientVersion();
    const name = info?.name ?? 'mcp-client';
    return { kind: 'agent', id: name, client: name };
  };

  const getClient = async () => (client ??= await connect(dir, actor(), connectOpts));
  let hubOps = new Set<string>();

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const ops = (await (await getClient()).describe()).filter((o) => o.mcp);
    hubOps = new Set(ops.filter((o) => o.hub).map((o) => o.name));
    return {
      tools: [USE_PROJECT, ...ops.map((o) => ({
        name: o.name,
        title: o.title,
        description: o.description,
        inputSchema: { type: 'object', ...o.inputSchema },
        annotations: { title: o.title, readOnlyHint: o.readOnly, destructiveHint: o.destructive, idempotentHint: o.readOnly, openWorldHint: false },
      }))],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const c = await getClient();
    try {
      const name = req.params.name;
      const args = req.params.arguments ?? {};
      if (!hubOps.size) hubOps = new Set((await c.describe()).filter((o) => o.hub).map((o) => o.name));
      const result =
        name === USE_PROJECT.name
          ? { now: await c.useProject(String((args as any).project ?? '')) }
          : hubOps.has(name)
            ? await c.hub(name, args)
            : await c.call(name, args);
      let text = JSON.stringify(result, null, 1);
      if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n… truncated (${text.length} chars). Use offset/limit to page.`;
      return { content: [{ type: 'text', text }] };
    } catch (e: any) {
      return { isError: true, content: [{ type: 'text', text: `${e.code ? `[${e.code}] ` : ''}${e.message ?? String(e)}` }] };
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map(({ text, ...p }) => p),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const p = PROMPTS.find((x) => x.name === req.params.name);
    if (!p) throw new Error(`Unknown prompt: ${req.params.name}`);
    return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text((req.params.arguments ?? {}) as Record<string, string>) } }] };
  });

  await server.connect(new StdioServerTransport());
  const shutdown = async () => {
    await client?.close();
    process.exit(0);
  };
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
}
