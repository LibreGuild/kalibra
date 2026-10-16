# Kalibra

Local-first, open-source evaluation for AI applications.

```bash
npx kalibra
```

That starts Kalibra on your machine and opens it in your browser. No account, no server, no installer. Needs Node.js 22.13 or newer.

- **Datasets** with text, audio and image columns. Import CSV/JSONL, upload recordings, generate rows, images or speech with a model, or let your coding agent fill them through MCP.
- **Targets** for any app: HTTP APIs (JSON, multipart, streaming), WebSocket streaming audio, a model + prompt, or your own script.
- **Layered checks**: status, latency, JSON schema, field rules, contains/regex, WER/CER with normalizers, BLEU/ROUGE, LLM judges you can calibrate against your own labels, and custom scripts.
- **Runs** with pass rates and confidence intervals, corpus WER, streaming latency, side-by-side comparisons and significance tests.

## Commands

```bash
npx kalibra                       # start and open the UI
npx kalibra serve --port 4317     # start without opening a browser
npx kalibra run --dataset D --target T --suite S --min-pass 0.9   # CI: exits non-zero below 90%
npx kalibra mcp                   # MCP server for Claude Code, Codex, Cursor, Gemini CLI…
npx kalibra ops                   # list every operation
```

Your workspace lives in `~/Kalibra/default` (change it with `--dir` or `KALIBRA_DIR`).

MIT licensed.
