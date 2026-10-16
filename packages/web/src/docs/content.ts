import type { Guide, GuideGroup } from './types';

/*
 * Every guide is short on purpose: one "why", a few steps, one picture or toy, a tip, a gotcha.
 * If a guide needs more than ~250 words, it should be two guides.
 */

export const GROUPS: { id: GuideGroup; blurb: string }[] = [
  { id: 'Start here', blurb: 'The whole idea in two minutes.' },
  { id: 'Build', blurb: 'Test data, your app, and what "good" means.' },
  { id: 'Measure', blurb: 'Run, read, compare, trust.' },
  { id: 'Connect', blurb: 'Models, agents and your terminal.' },
  { id: 'Recipes', blurb: 'Real jobs, start to finish.' },
  { id: 'Reference', blurb: 'Words, answers and fine print.' },
];

export const GUIDES: Guide[] = [
  // ── Start here ─────────────────────────────────────────────────────────────
  {
    slug: 'welcome',
    title: 'Kalibra in 60 seconds',
    promise: 'The one loop everything else hangs off.',
    group: 'Start here',
    icon: 'Sparkles',
    minutes: 1,
    image: '/docs/hero.jpg',
    blocks: [
      { type: 'lead', text: 'Your AI app works on your laptop. Kalibra tells you whether it works on **everything else**.' },
      { type: 'demo', name: 'loop', caption: 'Five nouns. That is the whole product.' },
      {
        type: 'defs',
        items: [
          { term: 'Dataset', text: 'Your test cases. Text, numbers, chats, audio, images.' },
          { term: 'Target', text: 'How to call your app: HTTP, WebSocket, a model, or a script.' },
          { term: 'Suite', text: 'What "good" means, as a stack of checks.' },
          { term: 'Run', text: 'Every row through your app, every result scored.' },
          { term: 'Compare', text: 'Did today\'s change help or hurt? With real statistics.' },
        ],
      },
      { type: 'tip', text: 'Want a playground first? Run `npm run demo -- --seed` and you get a support chatbot and a speech-to-text service with mistakes baked in.' },
      { type: 'note', title: 'Everything stays local', text: 'One folder on your machine. No account, no cloud, no telemetry.' },
      { type: 'links', links: [{ to: '/datasets', label: 'Start with a dataset', primary: true }, { to: '/docs/install', label: 'Install options' }] },
    ],
    next: 'install',
  },
  {
    slug: 'install',
    title: 'Install & launch',
    promise: 'Three ways in. Pick the one that matches your mood.',
    group: 'Start here',
    icon: 'Rocket',
    minutes: 2,
    blocks: [
      { type: 'lead', text: 'No servers to host, nothing to sign up for. Kalibra is just a program on your machine.' },
      { type: 'heading', text: 'The fastest way' },
      { type: 'code', label: 'Needs Node.js 22.13 or newer', code: 'npx kalibra' },
      { type: 'text', text: 'It starts the engine and opens the app in your browser. Nothing is installed globally, and there is no "unknown developer" pop-up.' },
      { type: 'heading', text: 'Other ways' },
      {
        type: 'defs',
        items: [
          { term: 'Desktop app', text: 'The same app in its own window. Secrets go to your OS keychain.' },
          { term: 'Dev mode', text: '`npm run dev` from the repo: engine, UI with hot reload, and the demo apps.' },
          { term: 'Headless', text: '`kalibra serve` on a box; `kalibra run` in CI.' },
        ],
      },
      { type: 'heading', text: 'Where your stuff lives' },
      { type: 'text', text: 'A workspace folder (default `~/Kalibra/default`, or `KALIBRA_DIR`). Inside: `kalibra.db` and a `blobs/` folder for audio and images. Back it up like any folder.' },
      { type: 'gotcha', text: 'Two engines on the same workspace is fine for reading, but keep one app open at a time so live updates reach you.' },
    ],
    next: 'datasets',
  },

  // ── Build ──────────────────────────────────────────────────────────────────
  {
    slug: 'datasets',
    title: 'Datasets',
    promise: 'Typed test cases you can fill five different ways.',
    group: 'Build',
    icon: 'Database',
    minutes: 3,
    image: '/docs/datasets.jpg',
    blocks: [
      { type: 'lead', text: 'Garbage in, garbage verdicts. A good dataset is the most valuable thing you will build here.' },
      { type: 'heading', text: 'Columns have types' },
      { type: 'demo', name: 'columns', caption: 'Every column becomes a {{placeholder}} your target can send.' },
      { type: 'heading', text: 'Five ways to add rows' },
      {
        type: 'steps',
        items: [
          { text: '**Type them.** Add a row, fill the form. Great for the weird edge case you just thought of.' },
          { text: '**Import** a CSV, JSONL or JSON file. New columns are created for you.' },
          { text: '**Upload files.** Drop 200 recordings, plus an optional CSV that maps file names to transcripts.' },
          { text: '**Generate with a model.** Kalibra reads your column descriptions and instructions, then writes varied rows.' },
          { text: '**Ask your coding agent.** Claude Code, Codex and friends can fill it through MCP.', link: { to: '/agents', label: 'Set up an agent' } },
        ],
      },
      { type: 'heading', text: 'Review, then freeze' },
      { type: 'text', text: 'Generated and agent rows land as **Needs review**. Approve the good ones. **Save version** freezes a numbered snapshot; every run also snapshots automatically.' },
      { type: 'tip', text: 'Write the column descriptions and **Instructions** like a brief to a new teammate. Generators and agents read them word for word.' },
      { type: 'gotcha', text: 'Duplicates are rejected on purpose. If an import "loses" rows, check the rejected list.' },
      { type: 'links', links: [{ to: '/datasets', label: 'Open Datasets', primary: true }] },
    ],
    next: 'media',
  },
  {
    slug: 'media',
    title: 'Generate images & audio',
    promise: 'Pictures, voices and noisy variants, made for you.',
    group: 'Build',
    icon: 'Wand2',
    minutes: 3,
    image: '/docs/media.jpg',
    blocks: [
      { type: 'lead', text: 'Real recordings are gold, but you rarely have enough. Fill the gaps with generated media, then stress it.' },
      {
        type: 'defs',
        items: [
          { term: 'Generate images', text: 'A prompt template like `A receipt from {{store}}` makes one image per row (or new rows from a list of prompts).' },
          { term: 'Generate speech', text: 'Turns a text column into audio. Rotate voices, add instructions like "speak fast, Indian English".' },
          { term: 'Audio variants', text: 'Copies of your clips with background noise, a phone line, echo, quieter or faster speech.' },
          { term: 'Transcribe into a column', text: 'Draft reference transcripts from audio with a transcription model, then fix them in review.' },
        ],
      },
      { type: 'demo', name: 'variants', caption: 'One clean clip, five harder versions.' },
      {
        type: 'steps',
        title: 'Do this',
        items: [
          { text: 'Add an image, speech or transcription model to a connection.', link: { to: '/connections', label: 'Connections' } },
          { text: 'Open a dataset → **Add rows** → pick the generator.' },
          { text: 'Watch the progress bar. It runs in the background, so keep working.' },
          { text: 'Review the new rows. Each one remembers the model and prompt that made it.' },
        ],
      },
      { type: 'tip', text: 'Report real and synthetic results separately (tag them). TTS audio is cleaner than real life, so it flatters your speech-to-text.' },
      { type: 'gotcha', text: 'Generated transcripts are drafts, not ground truth. Review them before trusting WER numbers built on them.' },
    ],
    next: 'targets',
  },
  {
    slug: 'targets',
    title: 'Targets: point at your app',
    promise: 'Teach Kalibra how to call your thing. Any thing.',
    group: 'Build',
    icon: 'Crosshair',
    minutes: 3,
    image: '/docs/targets.jpg',
    blocks: [
      { type: 'lead', text: 'Kalibra tests your real app, not a toy copy. A target is the recipe for calling it once per row.' },
      {
        type: 'defs',
        items: [
          { term: 'HTTP API', text: 'Paste a cURL from devtools, done. JSON, forms, multipart file uploads, SSE streaming.' },
          { term: 'WebSocket', text: 'Streaming audio and realtime chat, with every knob exposed.' },
          { term: 'Model + prompt', text: 'Test a prompt (or an image, speech or transcription model) directly.' },
          { term: 'Custom script', text: 'Write JavaScript that calls your app however it likes. Return `{ output }`.' },
        ],
      },
      { type: 'heading', text: 'Placeholders do the plumbing' },
      { type: 'demo', name: 'template', caption: 'Edit the row or the template and watch the request change.' },
      {
        type: 'steps',
        items: [
          { text: 'Create a target and pick a kind.', link: { to: '/targets', label: 'Open Targets' } },
          { text: 'Put `{{column}}` wherever row values go, `{{vars.base_url}}` for environments, `{{secret.name}}` for keys.' },
          { text: 'Under **Outputs**, map the response field you care about to `output` (e.g. `$.answer`).' },
          { text: 'Hit **Send** in **Try it** with a real row. Fix, repeat, save.' },
        ],
      },
      { type: 'tip', text: 'Inside a JSON body, `{{question}}` is escaped for you. Use `{{tags | json}}` to drop in raw arrays or objects.' },
      { type: 'gotcha', text: 'Secrets never live in the target. Store them under Connections → Secrets and reference them by name.' },
    ],
    next: 'websocket',
  },
  {
    slug: 'websocket',
    title: 'Streaming audio over WebSocket',
    promise: 'Real-time speech-to-text, measured to the millisecond.',
    group: 'Build',
    icon: 'Radio',
    minutes: 3,
    blocks: [
      { type: 'lead', text: 'Streaming STT lives or dies on latency. Kalibra replays your audio like a real microphone and times everything.' },
      { type: 'demo', name: 'ws-timeline', caption: 'What one row looks like on the wire.' },
      { type: 'heading', text: 'The knobs' },
      {
        type: 'defs',
        items: [
          { term: 'Messages on open', text: 'Your start/config message, e.g. `{"type":"start","sample_rate":16000}`.' },
          { term: 'Encoding', text: 'PCM 16-bit, float32, μ-law, A-law, or the original file bytes.' },
          { term: 'Frames', text: 'Sample rate, channels, 20–100 ms frames. Kalibra resamples your audio to match.' },
          { term: 'Send as', text: 'Binary frames, or text messages like `{"audio":"{{chunk_base64}}"}`.' },
          { term: 'Pacing', text: 'Real time (honest latency), 2× real time, or as fast as possible.' },
          { term: 'Incoming', text: 'Where the text is (`$.text`), which messages are final, when the session is done.' },
        ],
      },
      { type: 'tip', text: 'Latency numbers only mean something with **real-time pacing**. Use "fast" for quick accuracy checks only.' },
      { type: 'gotcha', text: 'If your service sends several finals per utterance, set **Session is done when** to "socket closes" or "quiet for N ms".' },
      { type: 'note', title: 'Weird protocol?', text: 'The **onMessage** and **session** scripts let you drive the socket yourself. Nothing is off limits.' },
    ],
    next: 'checks',
  },
  {
    slug: 'checks',
    title: 'Suites & layered checks',
    promise: 'Cheap checks first, smart checks last.',
    group: 'Build',
    icon: 'ListChecks',
    minutes: 4,
    image: '/docs/checks.jpg',
    blocks: [
      { type: 'lead', text: 'A broken response should fail in a millisecond, not after a $0.02 LLM judge call.' },
      { type: 'demo', name: 'layers', caption: 'A failing gate stops the row early. Cheaper, and the reason stays obvious.' },
      { type: 'heading', text: 'Every check, in one line' },
      {
        type: 'defs',
        items: [
          { term: 'status / latency / no error', text: 'Did the call work, and fast enough?' },
          { term: 'is JSON / JSON Schema', text: 'Is the response the right shape?' },
          { term: 'JSONPath', text: 'Does `$.confidence` exist, exceed 0.5, have 3 items…?' },
          { term: 'equals / contains / regex / numeric / similarity', text: 'Classic content comparisons.' },
          { term: 'WER / CER', text: 'Speech-to-text accuracy, with text normalizers.' },
          { term: 'keyword recall', text: 'Were the names and numbers right? (WER barely notices those.)' },
          { term: 'BLEU / ROUGE-L / chrF / token F1', text: 'Overlap with a reference answer.' },
          { term: 'LLM judge', text: 'A model grades against your criteria. Can look at images and audio too.' },
          { term: 'script / expression', text: 'Your own rule in JavaScript.' },
        ],
      },
      { type: 'tip', text: '**Only run when** (applyWhen) keeps checks honest: `expected_behavior === \'refuse\'` runs the refusal check on refusal rows only.' },
      { type: 'gotcha', text: 'WER without a normalizer punishes "15" vs "fifteen". Pick the **english** normalizer unless formatting matters.' },
      { type: 'links', links: [{ to: '/suites', label: 'Open Suites', primary: true }, { to: '/docs/recipe-judge', label: 'Build a judge you can trust' }] },
    ],
    next: 'runs',
  },

  // ── Measure ────────────────────────────────────────────────────────────────
  {
    slug: 'runs',
    title: 'Runs & results',
    promise: 'Numbers you can defend in a meeting.',
    group: 'Measure',
    icon: 'Play',
    minutes: 3,
    image: '/docs/runs.jpg',
    blocks: [
      { type: 'lead', text: 'A run sends every row through your target and scores it. You watch it fill in live.' },
      { type: 'demo', name: 'passrate', caption: 'Drag the slider: more rows, tighter interval.' },
      {
        type: 'defs',
        items: [
          { term: 'Pass rate ± interval', text: 'The 95% interval says how much the number could wobble by chance.' },
          { term: 'Corpus WER', text: 'All errors ÷ all reference words. Fairer than averaging per-clip WER.' },
          { term: 'Streaming metrics', text: 'First partial, final latency and real-time factor, with p50/p95/p99.' },
          { term: 'Results grid', text: 'Filter failed rows, sort by worst score or slowest, search anything.' },
        ],
      },
      { type: 'heading', text: 'Read a failure in 5 seconds' },
      { type: 'demo', name: 'wer', caption: 'Type what your app "heard". Red is missed, green is what it said instead.' },
      { type: 'tip', text: 'Click a check in the Checks table to see only the rows it failed.' },
      { type: 'gotcha', text: 'Retries hide flakiness. Set retries to 0 when you are measuring reliability, not just correctness.' },
      { type: 'links', links: [{ to: '/runs', label: 'Open Runs', primary: true }] },
    ],
    next: 'compare',
  },
  {
    slug: 'compare',
    title: 'Compare runs',
    promise: 'Better, worse, or just noise?',
    group: 'Measure',
    icon: 'GitCompare',
    minutes: 2,
    blocks: [
      { type: 'lead', text: 'Pass rate went from 82% to 85%. Celebrate? Maybe. Kalibra checks if it is real.' },
      { type: 'demo', name: 'compare' },
      {
        type: 'steps',
        items: [
          { text: 'Open a run → **Compare with…** → pick the baseline.' },
          { text: 'Start with **Regressed** rows. They are the ones that will bite you.' },
          { text: 'Read the significance line. Below p = 0.05 is likely a real change.' },
        ],
      },
      { type: 'tip', text: 'Compare runs on the **same dataset version**. Kalibra matches rows by id, so the comparison is row-for-row.' },
      { type: 'gotcha', text: 'Ten rows can\'t prove much. If the verdict says "could be noise", add rows before you argue.' },
    ],
    next: 'imported',
  },
  {
    slug: 'imported',
    title: 'Score outputs from anywhere',
    promise: 'No API? No problem. Bring your own outputs.',
    group: 'Measure',
    icon: 'FileInput',
    minutes: 2,
    blocks: [
      { type: 'lead', text: 'Some apps only run inside a notebook, a cluster or a customer site. Kalibra scores their outputs anyway.' },
      {
        type: 'steps',
        items: [
          { text: 'Dataset → **Export** → CSV or JSONL. Every row keeps its `row_id`.' },
          { text: 'Run your app on those inputs, wherever it lives.' },
          { text: 'Save a file with `row_id`, `output` (and optional `latency_ms`, `error`).' },
          { text: 'Runs → **Score outputs from a file** → pick the suite. Same checks, same charts.', link: { to: '/runs', label: 'Open Runs' } },
        ],
      },
      { type: 'code', label: 'outputs.csv', code: 'row_id,output,latency_ms\nrow_mvbay99r…,"Block it in the app or call 1800-123-456",412' },
      { type: 'tip', text: 'Imported runs compare with live runs, so you can benchmark a vendor\'s batch output against your own service.' },
      { type: 'gotcha', text: 'Transport checks (status, latency) need a live call; imported runs skip what they can\'t know.' },
    ],
    next: 'calibration',
  },
  {
    slug: 'calibration',
    title: 'Calibrate your judge',
    promise: 'Trust an LLM judge only after it agrees with you.',
    group: 'Measure',
    icon: 'Scale',
    minutes: 3,
    image: '/docs/calibration.jpg',
    blocks: [
      { type: 'lead', text: 'An LLM judge is a measuring tape. Before you use it, check it against a ruler: you.' },
      {
        type: 'steps',
        items: [
          { text: 'Open a run → Checks → **Calibrate** on the judge check.' },
          { text: 'Label 30–100 rows Pass or Fail. **Blind mode** hides the judge\'s verdict so it can\'t sway you.' },
          { text: 'Read agreement, kappa and the confusion matrix. Fix the judge prompt where you disagree.' },
          { text: 'Re-run and re-check. Repeat until agreement is boringly high.' },
        ],
      },
      { type: 'demo', name: 'confusion', caption: 'Where you and the judge agree (diagonal) and argue (corners).' },
      {
        type: 'defs',
        items: [
          { term: 'Agreement', text: 'How often you both said the same thing.' },
          { term: 'Cohen\'s kappa', text: 'Agreement minus luck. Above 0.6 is good, above 0.8 is great.' },
          { term: 'Corrected pass rate', text: 'The pass rate after adjusting for the judge\'s known mistakes.' },
        ],
      },
      { type: 'tip', text: 'Label a balanced sample: half the judge\'s passes, half its fails. Otherwise you only learn about the easy cases.' },
      { type: 'gotcha', text: 'Expect your own criteria to change while labeling. That\'s normal. Update the rubric and relabel a few.' },
    ],
    next: 'connections',
  },

  // ── Connect ────────────────────────────────────────────────────────────────
  {
    slug: 'connections',
    title: 'Connections & secrets',
    promise: 'Every major model provider, with the auth your company actually uses.',
    group: 'Connect',
    icon: 'Plug',
    minutes: 3,
    blocks: [
      { type: 'lead', text: 'Connections power judges, generators and model targets. Your app under test is a target, not a connection.' },
      {
        type: 'defs',
        items: [
          { term: 'OpenAI · Anthropic · Gemini', text: 'API key. Optional base URL for proxies.' },
          { term: 'Azure OpenAI / Foundry', text: 'API key, or your `az login` (Entra ID, auto-refreshed).' },
          { term: 'AWS Bedrock', text: 'Your AWS profile or SSO, access keys, or a Bedrock API key.' },
          { term: 'Google Vertex AI', text: 'gcloud login (ADC), a service-account file, or an express-mode key.' },
          { term: 'OpenAI-compatible', text: 'Ollama, vLLM, LM Studio, OpenRouter, xAI, Groq, LiteLLM…' },
        ],
      },
      { type: 'heading', text: 'One connection, many models' },
      { type: 'text', text: 'Besides the text model, a connection can hold an **image**, **speech** and **transcription** model. **Test** draws a tiny picture or says a sentence so you know it works.' },
      { type: 'heading', text: 'Secrets' },
      { type: 'text', text: 'Keys go to the secret store (OS keychain in the desktop app), never into definitions or exports. Use them anywhere as `{{secret.name}}`.' },
      { type: 'tip', text: 'Cloud logins are referenced, not copied. Run `aws sso login` or `gcloud auth application-default login` again and Kalibra just picks it up.' },
      { type: 'gotcha', text: 'Thinking models can spend a tiny token budget on thinking and reply with nothing. Give judges room to answer.' },
      { type: 'links', links: [{ to: '/connections', label: 'Open Connections', primary: true }] },
    ],
    next: 'agents',
  },
  {
    slug: 'agents',
    title: 'Coding agents (MCP)',
    promise: 'Let Claude Code do the boring parts. You stay in charge.',
    group: 'Connect',
    icon: 'Bot',
    minutes: 3,
    image: '/docs/agents.jpg',
    blocks: [
      { type: 'lead', text: 'Your coding agent can do anything the UI can: fill datasets, write targets, tweak suites, run and explain.' },
      { type: 'demo', name: 'mcp' },
      {
        type: 'steps',
        items: [
          { text: 'Copy the setup command for your agent.', link: { to: '/agents', label: 'Coding agents' } },
          { text: 'Ask in plain words: "Create 50 rows for Support questions, cover refusals too."' },
          { text: 'The agent reads the schema, submits rows, fixes rejected ones, and they appear here live.' },
          { text: 'Approve them in the review queue.' },
        ],
      },
      { type: 'tip', text: 'Built-in prompts: `/kalibra:generate-rows`, `/kalibra:run-and-report`, `/kalibra:setup-target`.' },
      { type: 'note', title: 'Why Kalibra never runs your agent', text: 'You type the prompt, in your own agent, on your own plan. Kalibra only answers. Clean, safe, no surprise bills.' },
      { type: 'gotcha', text: 'Agents never see secret values, and destructive tools ask before they act. Everything they touch is labeled with their name.' },
    ],
    next: 'cli',
  },
  {
    slug: 'cli',
    title: 'CLI & CI',
    promise: 'Fail the build when quality drops.',
    group: 'Connect',
    icon: 'Terminal',
    minutes: 2,
    blocks: [
      { type: 'lead', text: 'Everything in the app is also one command away. Perfect for CI.' },
      {
        type: 'code',
        label: 'In your pipeline',
        code: 'kalibra run --dataset "Voice commands" \\\n  --target "STT staging" --suite "STT checks" \\\n  --min-pass 0.9',
      },
      {
        type: 'defs',
        items: [
          { term: 'kalibra serve', text: 'Engine + UI. Add `--open` to launch the browser.' },
          { term: 'kalibra run', text: 'Exit code 1 if the run fails or the pass rate is below `--min-pass`.' },
          { term: 'kalibra ops / op', text: 'List or call any operation with JSON. Same power as the UI.' },
          { term: 'kalibra mcp', text: 'The MCP bridge your coding agent talks to.' },
        ],
      },
      { type: 'tip', text: 'Add `--json` to `run` and pipe the summary into your PR comment bot.' },
      { type: 'gotcha', text: 'CI needs the target reachable from the runner. Point `{{vars.base_url}}` at staging, not localhost.' },
    ],
    next: 'escape-hatches',
  },

  // ── Recipes ────────────────────────────────────────────────────────────────
  {
    slug: 'recipe-stt',
    title: 'Test my speech-to-text in 5 minutes',
    promise: 'Recordings in, WER and latency out.',
    group: 'Recipes',
    icon: 'Mic',
    minutes: 5,
    blocks: [
      { type: 'lead', text: 'From a folder of WAVs to a defensible accuracy number before your coffee cools.' },
      {
        type: 'steps',
        items: [
          { text: 'New dataset → template **Speech-to-text**.', link: { to: '/datasets', label: 'Datasets' } },
          { text: '**Upload files**: your recordings + a CSV with `file,reference`.' },
          { text: 'New target: HTTP with multipart (`file = {{audio}}`), or WebSocket for streaming.', link: { to: '/targets', label: 'Targets' } },
          { text: 'New suite → template **Speech-to-text** (WER ≤ 15%, keywords, latency).', link: { to: '/suites', label: 'Suites' } },
          { text: 'Start a run. Read **Corpus WER**, then the worst rows.', link: { to: '/runs', label: 'Runs' } },
        ],
      },
      { type: 'tip', text: 'Tag clips by accent or device, then compare slices. Averages hide the accent you fail on.' },
    ],
    next: 'recipe-noisy',
  },
  {
    slug: 'recipe-noisy',
    title: 'Stress my STT with noisy audio',
    promise: 'Find out what happens in a café, a car, a phone call.',
    group: 'Recipes',
    icon: 'Waves',
    minutes: 3,
    blocks: [
      { type: 'lead', text: 'Your users don\'t record in a studio. Simulate the mess before they do.' },
      {
        type: 'steps',
        items: [
          { text: 'Open your audio dataset → **Add rows** → **Audio variants**.' },
          { text: 'Pick effects: noise at 10 dB, phone line, echo, quieter, faster.' },
          { text: 'Run the same suite. Filter by tag (e.g. `aug:noise`) to see each condition.' },
        ],
      },
      { type: 'demo', name: 'variants' },
      { type: 'gotcha', text: 'Variants keep the original reference transcript. If an effect makes words truly inaudible, that row\'s WER is not your app\'s fault.' },
    ],
    next: 'recipe-judge',
  },
  {
    slug: 'recipe-judge',
    title: 'Make an LLM judge you can trust',
    promise: 'Binary questions, a different model family, calibrated against you.',
    group: 'Recipes',
    icon: 'Gavel',
    minutes: 4,
    blocks: [
      { type: 'lead', text: 'A vague judge gives vague numbers. A sharp one is as good as a careful reviewer.' },
      {
        type: 'steps',
        items: [
          { text: 'Ask **one pass/fail question per check**. "Is every number in the answer present in the reference?" beats "Rate quality 1–10".' },
          { text: 'Add the reference answer when you have one.' },
          { text: 'Use a judge from a **different model family** than the app (models go easy on themselves).' },
          { text: 'Set repetitions to 3 for borderline rubrics; Kalibra takes the majority vote.' },
          { text: 'Calibrate on 50+ labeled rows before you report its numbers.', link: { to: '/docs/calibration', label: 'How to calibrate' } },
        ],
      },
      { type: 'tip', text: 'Put the judge behind gates (status, schema) so it only grades real answers.' },
    ],
    next: 'recipe-byo',
  },
  {
    slug: 'recipe-byo',
    title: 'Score outputs from my own pipeline',
    promise: 'Export, run anywhere, import, score.',
    group: 'Recipes',
    icon: 'ArrowLeftRight',
    minutes: 3,
    blocks: [
      { type: 'lead', text: 'Your pipeline, your infra, Kalibra\'s scoring.' },
      {
        type: 'steps',
        items: [
          { text: 'Export the dataset as JSONL.' },
          { text: 'Loop over it in your notebook; write `{"row_id": …, "output": …}` per line.' },
          { text: '**Score outputs from a file**, pick a suite. Compare with any other run.', link: { to: '/runs', label: 'Runs' } },
        ],
      },
      { type: 'code', label: 'Python', code: 'import json\nfor line in open("dataset.jsonl"):\n    row = json.loads(line)\n    out = my_app(row["question"])\n    print(json.dumps({"row_id": row["row_id"], "output": out}))' },
    ],
    next: 'recipe-images',
  },
  {
    slug: 'recipe-images',
    title: 'Generate an image dataset',
    promise: 'From a list of ideas to a folder of test images.',
    group: 'Recipes',
    icon: 'Image',
    minutes: 3,
    blocks: [
      { type: 'lead', text: 'Testing a vision app? Make the exact images you need instead of hunting for them.' },
      {
        type: 'steps',
        items: [
          { text: 'Add an image model to a connection (e.g. a GPT Image model).', link: { to: '/connections', label: 'Connections' } },
          { text: 'Create a dataset with a `description` text column and an `image` column.' },
          { text: 'Generate descriptions with a model or an agent ("40 receipts: blurry, rotated, faded…").' },
          { text: '**Add rows** → **Generate images** with the template `{{description}}`.' },
          { text: 'Judge outputs with an **LLM judge** that has the image attached.' },
        ],
      },
      { type: 'tip', text: 'For text-heavy images (receipts, forms), exact ground truth matters. Render them from data when you can; diffusion models garble small text.' },
    ],
    next: 'recipe-agent-fill',
  },
  {
    slug: 'recipe-agent-fill',
    title: 'Let Claude Code fill my dataset',
    promise: 'Free, fast, reviewable test data from your own agent.',
    group: 'Recipes',
    icon: 'Bot',
    minutes: 2,
    blocks: [
      { type: 'lead', text: 'You already pay for a coding agent. Put it to work on test data.' },
      {
        type: 'steps',
        items: [
          { text: 'Write good column descriptions and instructions on the dataset.' },
          { text: 'In your terminal: "Create 100 synthetic rows for the Kalibra dataset Support questions."' },
          { text: 'Watch rows arrive live; rejected ones come back to the agent with reasons.' },
          { text: 'Review and approve. Done.' },
        ],
      },
      { type: 'code', label: 'One-time setup (Claude Code)', code: 'claude mcp add kalibra -- npx kalibra mcp' },
      { type: 'tip', text: 'Ask for coverage, not volume: "10 each of polite, angry, confused, and 20% that must be refused".' },
    ],
    next: 'escape-hatches',
  },

  // ── Reference ──────────────────────────────────────────────────────────────
  {
    slug: 'escape-hatches',
    title: 'Escape hatches',
    promise: 'When the form doesn\'t fit, write the code.',
    group: 'Reference',
    icon: 'Code2',
    minutes: 2,
    blocks: [
      { type: 'lead', text: 'Evals have no standard shape, so Kalibra never boxes you in. Every step has a script door.' },
      {
        type: 'defs',
        items: [
          { term: 'Before request', text: 'Sign requests, add timestamps, reshape bodies.' },
          { term: 'After response', text: 'Pull out any field, decode anything.' },
          { term: 'WebSocket onMessage / session', text: 'Run the conversation yourself.' },
          { term: 'Custom script target', text: 'Call your app with `fetch`, a WebSocket, anything.' },
          { term: 'Script & expression checks', text: 'Your scoring rule, in JS.' },
        ],
      },
      { type: 'code', label: 'A script check', code: 'const words = String(output).split(/\\s+/).length;\nreturn { pass: words <= 60, value: words, reason: `${words} words` };' },
      { type: 'gotcha', text: 'Scripts run with your user\'s permissions, like npm scripts. Only run scripts you trust.' },
    ],
    next: 'privacy',
  },
  {
    slug: 'privacy',
    title: 'Privacy & your data',
    promise: 'Where everything lives, and what leaves your machine.',
    group: 'Reference',
    icon: 'ShieldCheck',
    minutes: 1,
    blocks: [
      { type: 'lead', text: 'Kalibra only talks to what you point it at: your app, and the model providers you add.' },
      {
        type: 'defs',
        items: [
          { term: 'Data', text: 'SQLite + files in your workspace folder.' },
          { term: 'Secrets', text: 'Encrypted with your OS keychain in the desktop app. Never in exports or MCP.' },
          { term: 'Telemetry', text: 'None.' },
          { term: 'Local judges', text: 'Point a connection at Ollama and nothing leaves the laptop.' },
        ],
      },
      { type: 'gotcha', text: 'Cloud judges and generators see the rows you send them. Use a local model for sensitive data.' },
    ],
    next: 'settings',
  },
  {
    slug: 'settings',
    title: 'Make it yours',
    promise: 'Theme, reading font, text size.',
    group: 'Reference',
    icon: 'SlidersHorizontal',
    minutes: 1,
    blocks: [
      { type: 'lead', text: 'You will read a lot of transcripts here. Make them comfortable.' },
      {
        type: 'defs',
        items: [
          { term: 'Theme', text: 'Light, dark, or follow your system.' },
          { term: 'Reading font', text: 'Atkinson Hyperlegible Next by default: every 0, O, l, 1 and I is unmistakable.' },
          { term: 'Text size', text: 'Scale the whole app up or down.' },
          { term: 'Sidebar', text: 'Collapse it to icons when you need the space.' },
        ],
      },
      { type: 'links', links: [{ to: '/settings', label: 'Open Settings', primary: true }] },
    ],
    next: 'glossary',
  },
  {
    slug: 'glossary',
    title: 'Glossary',
    promise: 'Eval jargon, translated into human.',
    group: 'Reference',
    icon: 'BookA',
    minutes: 2,
    blocks: [
      { type: 'lead', text: 'Every term you will meet here, in one breath each.' },
      {
        type: 'defs',
        items: [
          { term: 'WER', text: 'How many words your app got wrong, per word it should have heard.' },
          { term: 'CER', text: 'Same, but per character. Best for Chinese, Japanese, Thai, and OCR.' },
          { term: 'Normalizer', text: 'Tidies text before comparing, so "15%" and "fifteen percent" match.' },
          { term: 'Corpus WER', text: 'Total errors ÷ total words across all rows. Short clips can\'t skew it.' },
          { term: 'Gate', text: 'A check that must pass before the pricier checks bother.' },
          { term: 'LLM judge', text: 'A model grading answers against your rubric.' },
          { term: 'Kappa', text: 'Agreement between two graders, minus the part luck explains.' },
          { term: 'Confidence interval', text: 'The range the true pass rate probably sits in.' },
          { term: 'p-value', text: 'How surprising a difference would be if nothing had really changed.' },
          { term: 'RTF', text: 'Real-time factor. Below 1 means faster than someone talking.' },
          { term: 'First partial', text: 'How long until streaming STT shows its first guess.' },
          { term: 'Final latency', text: 'Time from the last word spoken to the final transcript.' },
          { term: 'MCP', text: 'The plug that lets coding agents use Kalibra\'s tools.' },
          { term: 'Provenance', text: 'Who or what made a row: you, a model, an import, or an agent.' },
        ],
      },
    ],
    next: 'faq',
  },
  {
    slug: 'faq',
    title: 'FAQ',
    promise: 'The questions everyone asks in week one.',
    group: 'Reference',
    icon: 'MessageCircleQuestion',
    minutes: 2,
    blocks: [
      {
        type: 'qa',
        items: [
          { q: 'Do I need an API key?', a: 'Only for LLM judges and generators. Everything else, and filling data through your coding agent, works without one.' },
          { q: 'Can I test an app that has no API?', a: 'Yes. Export the inputs, run them yourself, import the outputs. See "Score outputs from anywhere".' },
          { q: 'My service speaks a weird protocol.', a: 'Use a WebSocket session script or a custom script target. If you can code it, Kalibra can test it.' },
          { q: 'How many rows do I need?', a: 'For a rough read, 50. To detect a 5-point change with confidence, a few hundred.' },
          { q: 'Can my team share this?', a: 'Today: share the workspace folder or export/import. A self-hosted server mode is on the roadmap.' },
          { q: 'Is it free?', a: 'Yes. MIT-licensed open source.' },
        ],
      },
    ],
  },
];

export const guideBySlug = (slug: string) => GUIDES.find((g) => g.slug === slug);

/** Plain text of a guide, for search. */
export function guideText(g: Guide): string {
  const parts: string[] = [g.title, g.promise];
  for (const b of g.blocks) {
    switch (b.type) {
      case 'lead':
      case 'heading':
      case 'text':
      case 'tip':
      case 'gotcha':
      case 'note':
        parts.push(b.text, 'title' in b ? b.title ?? '' : '');
        break;
      case 'steps':
        parts.push(...b.items.map((i) => i.text));
        break;
      case 'defs':
        parts.push(...b.items.map((i) => `${i.term} ${i.text}`));
        break;
      case 'qa':
        parts.push(...b.items.map((i) => `${i.q} ${i.a}`));
        break;
      case 'code':
        parts.push(b.code);
        break;
      case 'image':
        parts.push(b.alt, b.caption ?? '');
        break;
    }
  }
  return parts.join(' ').replace(/[`*]/g, '');
}
