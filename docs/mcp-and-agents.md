# MCP and coding agents

Coding agents (Claude Code, Codex CLI, Cursor, Gemini CLI, VS Code…) drive Kalibra through MCP. The user types the prompt in their own agent; **Kalibra never launches or calls an agent.**

## How the bridge works

```
agent ──stdio──► kalibra mcp ──HTTP + token──► running engine
                    │                    (or opens the workspace directly)
                    └─ tools generated from the operation registry
```

- `packages/cli/src/mcp.ts`. Tools = every operation except secret handling (`mcp: false`): about 100, covering everything the UI does (conversations, comparisons, playground, failure themes, quality, sharing and importers included).
- Annotations: `readOnlyHint` and `destructiveHint` come from the operation, so clients ask before deleting.
- Calls carry an **agent actor** (MCP client name). Rows agents add start as `needs_review`, with provenance.
- Results are JSON text, truncated at 60k characters with a "use offset/limit" note.
- Projects: the bridge works in one project at a time (`--project`, else the default one). Hub tools such as `list_projects` and `create_project` are included, plus `use_project` to switch. Account management (users, tokens, passwords) and secret values are never exposed.

## Setup

The **Coding agents** page shows the exact command for the current install. Typical shapes:

```bash
claude mcp add kalibra -- npx -y kalibra mcp --dir ~/Kalibra/default
```

```toml
# ~/.codex/config.toml
[mcp_servers.kalibra]
command = "npx"
args = ["-y", "kalibra", "mcp", "--dir", "/Users/me/Kalibra/default"]
```

Cursor / Gemini CLI / VS Code use the same command in their JSON config (`mcpServers` or `servers`).

On a team server, create an access token (Account → Access tokens) and point the bridge at the server:

```bash
claude mcp add kalibra --env KALIBRA_TOKEN=kal_… -- npx -y kalibra mcp --server https://kalibra.example.com --project "Team evals"
```

The agent then acts as you, with your role in each project; activity shows it as "claude-code via <your name>".

## Prompts

- `/kalibra:generate-rows`: read the schema, write rows in batches, fix rejections.
- `/kalibra:run-and-report`: start a run, wait, explain failures.
- `/kalibra:setup-target`: read the repo, create and test a target.

## Good patterns

- Agents should call `get_dataset_schema` before `add_dataset_rows`; batch 20–50 rows; resend only rejected rows.
- Use `baseVersion` / `baseRevision` on updates to avoid overwriting edits.
- Read `warnings` from `start_run` / `start_comparison` (or call `preflight_run` first): an empty `{{column}}` silently ruins a run.
- Long work returns a `jobId` (`fill_gaps`, `cluster_failures`, multi-call `playground_run`, `download_embedding_model`); poll `get_job`. Comparisons: poll `get_comparison`, then `compare_rows` with `filter: "disagreements"`.
- After a run, `get_failure_themes` is a cheap first look at what broke; `dataset_quality` and `find_duplicates` before trusting a generated dataset.
- `export_to_folder` / `import_from_folder` take absolute paths on the user's machine; use `dryRun` before applying.
- Calibrate agent-written grades against human labels before trusting them.

## Security notes

- No secret values via MCP; secrets are referenced by name only.
- Dataset rows and app outputs returned to agents are data, not instructions (watch for prompt injection in test data).
- The MCP bridge uses stdio: no extra network port. The engine API it calls needs the per-launch token.
- Agent work uses the user's own agent plan; Kalibra never stores or routes agent credentials.
