import { useMemo, useState } from 'react';
import { Bot, Eye, Trash2 } from 'lucide-react';
import { Page } from '../components/layout/shell';
import { Badge, Card, CodeBlock, CopyButton, ErrorBox, Loading, SectionTitle, Tabs } from '../components/ui/display';
import { Tip } from '../components/ui/overlay';
import { useMeta, useOp } from '../lib/api';
import { timeAgo } from '../lib/format';

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function snippets(cmd: { command: string; args: string[]; env?: Record<string, string> }) {
  const env = cmd.env ?? {};
  const envFlags = Object.entries(env).map(([k, v]) => `-e ${k}=${shellQuote(v)} `).join('');
  const jsonServer = { command: cmd.command, args: cmd.args, ...(Object.keys(env).length ? { env } : {}) };
  return {
    claude: `claude mcp add kalibra ${envFlags}-- ${[cmd.command, ...cmd.args].map(shellQuote).join(' ')}`,
    codex: `# ~/.codex/config.toml\n[mcp_servers.kalibra]\ncommand = ${JSON.stringify(cmd.command)}\nargs = ${JSON.stringify(cmd.args)}${Object.keys(env).length ? `\nenv = { ${Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')} }` : ''}`,
    cursor: `// .cursor/mcp.json (project) or ~/.cursor/mcp.json (global)\n${JSON.stringify({ mcpServers: { kalibra: jsonServer } }, null, 2)}`,
    gemini: `// ~/.gemini/settings.json\n${JSON.stringify({ mcpServers: { kalibra: jsonServer } }, null, 2)}`,
    vscode: `// .vscode/mcp.json\n${JSON.stringify({ servers: { kalibra: { type: 'stdio', ...jsonServer } } }, null, 2)}`,
  };
}

const EXAMPLES = [
  { text: 'Create 50 synthetic rows for the Kalibra dataset "Support questions". Read its schema first and cover refusals too.', hint: 'Fills a dataset in place. Rows land in the review queue.' },
  { text: '/kalibra:generate-rows', hint: 'Built-in prompt: asks for the dataset and count, then fills it.' },
  { text: 'Read this repo, find the /transcribe endpoint and create a Kalibra target for it. Test it with one row.', hint: 'Agent-assisted setup from your own codebase.' },
  { text: 'Add a check to the "STT checks (streaming)" suite: WER must be under 10% for rows tagged en-IN.', hint: 'Edits a suite; the change shows up here instantly.' },
  { text: 'Make phone-line and noisy-café variants of every clip in "Voice commands", then rerun the streaming STT suite and compare.', hint: 'Audio augmentation + run + comparison in one go.' },
  { text: 'Create a safety pack for our banking assistant (prompt injection, data leaks, account takeover) and run it against the chat API.', hint: 'Builds the dataset and suite, then reports what slipped through.' },
  { text: 'Run "Voice commands" through "Demo STT (batch upload)" with "STT checks (batch)", then explain the worst failures.', hint: 'Runs, waits and reports.' },
];

export function AgentsPage() {
  const meta = useMeta();
  const ops = useOp<any[]>('list_operations');
  const activity = useOp<any[]>('list_activity', { limit: 20, actorKind: 'agent' });
  const [client, setClient] = useState('claude');

  const snip = meta.data?.mcp ? snippets(meta.data.mcp) : null;
  const tools = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const o of (ops.data ?? []).filter((o) => o.mcp)) {
      if (!groups.has(o.category)) groups.set(o.category, []);
      groups.get(o.category)!.push(o);
    }
    return [...groups.entries()];
  }, [ops.data]);

  return (
    <Page
      title="Coding agents"
      description="Drive Kalibra from Claude Code, Codex, Cursor, Gemini CLI or any MCP client. You type the prompt in your own agent; it reads and changes Kalibra through MCP, using your own subscription. Kalibra never launches or calls an agent."
    >
      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <SectionTitle help="The command starts a small MCP bridge that talks to this running Kalibra. Run the setup once per agent.">1. Connect your agent</SectionTitle>
            {meta.error ? (
              <ErrorBox error={meta.error} />
            ) : !snip ? (
              meta.isLoading ? <Loading /> : <div className="text-[0.8125rem] text-ink-muted">This server did not report how to start the MCP bridge. Run <code className="font-mono">npx kalibra mcp</code> as your agent's MCP command.</div>
            ) : (
              <>
                <Tabs
                  value={client}
                  onChange={setClient}
                  tabs={[
                    { value: 'claude', label: 'Claude Code' },
                    { value: 'codex', label: 'Codex CLI' },
                    { value: 'cursor', label: 'Cursor' },
                    { value: 'gemini', label: 'Gemini CLI' },
                    { value: 'vscode', label: 'VS Code' },
                  ]}
                />
                <CodeBlock className="mt-3" value={(snip as any)[client]} />
                <p className="mt-2 text-[0.78125rem] text-ink-faint">
                  {client === 'claude' ? 'Run this in your terminal, then restart Claude Code (or run /mcp) to load the tools.' : 'Add this to the config file, then restart the agent.'}
                </p>
              </>
            )}
          </Card>

          <Card>
            <SectionTitle help="Anything you can do in this app, the agent can do too. Destructive tools are marked so your agent asks before using them.">2. Ask in your own words</SectionTitle>
            <ul className="flex flex-col divide-y divide-line">
              {EXAMPLES.map((e) => (
                <li key={e.text} className="flex items-start justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="font-mono text-[0.78125rem]">{e.text}</div>
                    <div className="mt-0.5 text-[0.78125rem] text-ink-faint">{e.hint}</div>
                  </div>
                  <CopyButton text={e.text} />
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <SectionTitle help="Generated from the same operation list the UI uses, so the agent always has full parity. Only secret values are never exposed.">
              Tools your agent gets ({(ops.data ?? []).filter((o) => o.mcp).length})
            </SectionTitle>
            <div className="flex flex-col gap-4">
              {tools.map(([cat, list]) => (
                <div key={cat}>
                  <div className="mb-1.5 text-[0.75rem] font-semibold uppercase tracking-wide text-ink-faint">{cat}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {list.map((o) => (
                      <Tip key={o.name} content={o.description}>
                        <span className="inline-flex items-center gap-1 rounded-md border border-line bg-raised px-2 py-0.5 font-mono text-[0.75rem]">
                          {o.readOnly && <Eye className="size-3 text-ink-faint" />}
                          {o.destructive && <Trash2 className="size-3 text-bad" />}
                          {o.name}
                        </span>
                      </Tip>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <Card className="h-fit">
          <SectionTitle help="Changes made through MCP, with the client that made them. Rows added by agents also wait for your review.">Agent activity</SectionTitle>
          {(activity.data ?? []).length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center text-[0.8125rem] text-ink-muted">
              <Bot className="size-6 text-ink-faint" />
              No agent activity yet.
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {activity.data!.map((a) => (
                <li key={a.id} className="min-w-0">
                  <div className="truncate text-[0.8125rem]">{a.summary}</div>
                  <div className="flex items-center gap-1.5 text-[0.75rem] text-ink-faint">
                    <Badge tone="accent">{a.actor?.client ?? 'agent'}</Badge> {timeAgo(a.at)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  );
}
