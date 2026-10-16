import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Actor } from '@kalibra/core';
import { connect, type OpsClient } from './engine-client.js';

/*
 * MCP bridge. Tools are generated from the engine's operation registry, so a coding agent can do
 * everything the UI can (except handling secret values). The user drives their own agent; Kalibra
 * never launches or calls one. Calls are recorded with an "agent" actor for provenance.
 */

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
1. Call start_run, then poll get_run until status is completed (wait a few seconds between polls).
2. Report the pass rate with its interval, each check's pass rate, and corpus metrics such as WER.
3. Call query_results with filter "failed" and sort "score", look at the worst rows with get_result, and explain the main failure patterns.`,
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

export async function runMcp(dir: string) {
  let client: OpsClient | undefined;
  const server = new Server(
    { name: 'kalibra', version: '0.1.0' },
    {
      capabilities: { tools: {}, prompts: {} },
      instructions:
        'Kalibra evaluates AI applications. Datasets hold test rows; targets call the app under test; suites hold layered checks; runs score results. Read before you write (get_dataset_schema, get_target, get_suite). Pass baseVersion/baseRevision when updating so you never overwrite a newer edit. Rows you add start as "needs_review" for a human. Never ask for or handle secret values.',
    },
  );

  const actor = (): Actor => {
    const info = server.getClientVersion();
    const name = info?.name ?? 'mcp-client';
    return { kind: 'agent', id: name, client: name };
  };

  const getClient = async () => (client ??= await connect(dir, actor()));

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const ops = (await (await getClient()).describe()).filter((o) => o.mcp);
    return {
      tools: ops.map((o) => ({
        name: o.name,
        title: o.title,
        description: o.description,
        inputSchema: { type: 'object', ...o.inputSchema },
        annotations: { title: o.title, readOnlyHint: o.readOnly, destructiveHint: o.destructive, idempotentHint: o.readOnly, openWorldHint: false },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const c = await getClient();
    try {
      const result = await c.call(req.params.name, req.params.arguments ?? {});
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
