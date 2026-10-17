# Kalibra

Local-first, open-source evaluation for AI applications.

```bash
npx kalibra@next     # current beta
```

That starts Kalibra on your machine and opens it in your browser. No account, no server, no installer. Needs Node.js 22.13 or newer.

- **Datasets** with text, audio and image columns. Import CSV/JSONL, upload recordings, generate rows, images or speech with a model, or let your coding agent fill them through MCP.
- **Targets** for any app: HTTP APIs (JSON, multipart, streaming), WebSocket streaming audio, a model + prompt, or your own script. Multi-turn conversations, scripted or with a simulated user.
- **Layered checks**: status, latency, JSON schema, field rules, contains/regex, WER/CER with normalizers, meaning similarity, BLEU/ROUGE, LLM judges you can calibrate against your own labels, safety checks, and custom scripts.
- **Runs** with pass rates and confidence intervals, corpus WER, streaming latency, comparisons of several models or targets, failure themes and significance tests.
- **Projects and teams**: projects on your machine, or `kalibra server` for a team with sign-in (passwords, any OIDC/SSO, GitHub and GitHub Enterprise), roles and access tokens for agents.

## Commands

```bash
npx kalibra@next                        # start and open the UI
npx kalibra@next serve --port 4317      # start without opening a browser
npx kalibra@next server                 # team server: sign-in, users, project members
npx kalibra@next run --dataset D --target T --suite S --min-pass 0.9   # CI: exits non-zero below 90%
npx kalibra@next mcp                    # MCP server for Claude Code, Codex, Cursor, Gemini CLI…
npx kalibra@next backup ./backup        # consistent copy of all data, safe while running
```

Data lives in `~/Kalibra/default` (change it with `--dir` or `KALIBRA_DIR`). A team server also ships as a Docker image: `ghcr.io/libreguild/kalibra:next`.

Docs: https://github.com/LibreGuild/kalibra/tree/main/docs

MIT licensed.
