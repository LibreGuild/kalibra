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
          { text: '**Type them.** **Add rows** → **Add a row**. Great for the weird edge case you just thought of.' },
          { text: '**Import** a CSV, JSONL or JSON file (**Add rows** → **Import a file**). New columns are created for you.' },
          { text: '**Upload files.** **Add rows** → **Upload audio or image files**: drop 200 recordings, plus an optional CSV that maps file names to transcripts.' },
          { text: '**Generate with a model.** **Generate** → **Rows with a model** reads your column descriptions and instructions, then writes varied rows.' },
          { text: '**Ask your coding agent.** **Generate** → **Rows with a coding agent**: Claude Code, Codex and friends fill it through MCP.', link: { to: '/agents', label: 'Set up an agent' } },
        ],
      },
      { type: 'heading', text: 'Review, then freeze' },
      { type: 'text', text: 'Generated and agent rows land as **Needs review**. Approve the good ones. **⋯** → **Save version** freezes a numbered snapshot; every run also snapshots automatically.' },
      { type: 'text', text: 'Then open the **Quality** tab: it flags gaps, copies and rows that all sound the same. Coming from promptfoo or OpenAI Evals? Datasets → **Import** takes their files.' },
      { type: 'tip', text: 'Write the column descriptions and **Instructions** like a brief to a new teammate. Generators and agents read them word for word.' },
      { type: 'gotcha', text: 'Duplicates are rejected on purpose. If an import "loses" rows, check the rejected list.' },
      { type: 'links', links: [{ to: '/datasets', label: 'Open Datasets', primary: true }, { to: '/docs/quality', label: 'Dataset quality' }] },
    ],
    next: 'quality',
  },
  {
    slug: 'quality',
    title: 'Dataset quality',
    promise: 'Find gaps, copies and look-alike rows before they fool you.',
    group: 'Build',
    icon: 'Gauge',
    minutes: 2,
    blocks: [
      { type: 'lead', text: 'Twenty copies of one question make a pass rate look precise and mean nothing. Check the rows before you trust the run.' },
      {
        type: 'steps',
        items: [
          { text: 'Open a dataset → **Quality** tab.', link: { to: '/datasets', label: 'Open Datasets' } },
          { text: 'Read **Worth fixing** first. Each flag says what is off and what to do about it.' },
          { text: '**Coverage** shows how often each value appears in category-like columns (accent, category, language…). **Fill gaps** asks a model for more rows of the rare ones.' },
          { text: '**Duplicates**: pick **Exact**, **Near** or **Meaning**, then **Find duplicates** and **Keep one of each**.' },
        ],
      },
      {
        type: 'defs',
        items: [
          { term: 'Exact', text: 'Same text after ignoring case and spacing.' },
          { term: 'Near', text: 'Small edits and typos.' },
          { term: 'Meaning', text: 'Paraphrases, found with an embedding model (the free local one, or a connection\'s).' },
          { term: 'Variety', text: 'Length spread, new word pairs, overlap between rows, repetition. Low variety means one template wrote everything.' },
        ],
      },
      { type: 'tip', text: 'Generated rows tend to sound alike. Check **Variety** after every big **Generate** batch.' },
      { type: 'gotcha', text: 'Nothing is deleted. Extra copies are marked **Rejected**, and runs skip rejected rows.' },
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
          { term: 'Images', text: 'A prompt template like `A receipt from {{store}}` makes one image per row (or new rows from a list of prompts).' },
          { term: 'Speech (TTS)', text: 'Turns a text column into audio. Rotate voices, add instructions like "speak fast, Indian English".' },
          { term: 'Audio variants', text: 'Copies of your clips with background noise, a phone line, echo, quieter or faster speech.' },
          { term: 'Transcripts from audio', text: 'Draft reference transcripts from audio with a transcription model, then fix them in review.' },
        ],
      },
      { type: 'demo', name: 'variants', caption: 'One clean clip, five harder versions.' },
      {
        type: 'steps',
        title: 'Do this',
        items: [
          { text: 'Add an image, speech or transcription model to a connection.', link: { to: '/connections', label: 'Connections' } },
          { text: 'Open a dataset → **Generate** → pick **Images**, **Speech (TTS)**, **Audio variants** or **Transcripts from audio**.' },
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
    next: 'playground',
  },
  {
    slug: 'playground',
    title: 'Prompt playground',
    promise: 'Try a prompt on a few rows across models, side by side.',
    group: 'Build',
    icon: 'FlaskConical',
    minutes: 2,
    blocks: [
      { type: 'lead', text: 'Before you wire a target and run 500 rows, see how three models answer five of them.' },
      {
        type: 'steps',
        items: [
          { text: 'Write a **Prompt** with `{{placeholders}}`, plus an optional **System prompt**.', link: { to: '/playground', label: 'Open Playground' } },
          { text: '**Rows to try**: **Type values**, or take the first rows **From a dataset** (up to 25).' },
          { text: '**Models**: pick a connection, and optionally a model and temperature. **Add a variant to compare**, up to four.' },
          { text: '**Run** (or Ctrl/⌘ + Enter). Outputs land in a grid with latency and tokens.' },
        ],
      },
      {
        type: 'defs',
        items: [
          { term: 'Score with a suite', text: 'Optional: score every output with the same checks a real run uses.' },
          { term: 'Save as target', text: 'Keep a prompt and model as a model target.' },
          { term: 'Run full eval', text: 'Saves each model as a target and runs the whole dataset: one model is a run, several are a comparison. Needs a dataset and a suite.' },
        ],
      },
      { type: 'tip', text: 'Image and audio columns used in the prompt are attached to the request, so vision and audio prompts work too.' },
      { type: 'gotcha', text: 'Every row is one call per model. Keep it small here and use a run for the real numbers.' },
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
          { term: 'Meaning matches (embeddings)', text: 'Same meaning, different words. Free and offline with the local model, or use a connection\'s embedding model.' },
          { term: 'Goal achieved / Conversation mentions / Number of turns', text: 'For multi-turn conversations.' },
          { term: 'LLM judge', text: 'A model grades against your criteria. Can look at images and audio too.' },
          { term: 'script / expression', text: 'Your own rule in JavaScript.' },
        ],
      },
      { type: 'tip', text: '**Only run when** (applyWhen) keeps checks honest: `expected_behavior === \'refuse\'` runs the refusal check on refusal rows only.' },
      { type: 'note', title: 'Where is check X?', text: '**Add check** shows the **Most used** ones first. **Show all** at the bottom lists every type, by layer.' },
      { type: 'gotcha', text: 'WER without a normalizer punishes "15" vs "fifteen". Pick the **english** normalizer unless formatting matters.' },
      { type: 'links', links: [{ to: '/suites', label: 'Open Suites', primary: true }, { to: '/docs/recipe-judge', label: 'Build a judge you can trust' }] },
    ],
    next: 'safety',
  },
  {
    slug: 'safety',
    title: 'Safety pack',
    promise: 'Will it refuse the bad stuff, and still help with the rest?',
    group: 'Build',
    icon: 'ShieldAlert',
    minutes: 3,
    blocks: [
      { type: 'lead', text: 'A safe assistant does two things: says no to harmful asks, and still says yes to harmless ones that only sound scary.' },
      {
        type: 'steps',
        title: 'Do this',
        items: [
          { text: 'Datasets → **Safety pack**.', link: { to: '/datasets', label: 'Open Datasets' } },
          { text: 'Tick **Categories**: prompt injection, data leaks, fraud, self-harm… Hover one to see its OWASP / NIST / MITRE ATLAS / AILuminate tags.' },
          { text: 'Pick **Variants**: role-play, base64, typos, fake authority… the tricks real users try.' },
          { text: 'Keep **Include benign look-alikes** on, and **Also create a suite**. Then run it against your app.' },
        ],
      },
      {
        type: 'defs',
        items: [
          { term: 'Refuses when it should', text: 'Fails on unsafe answers **and** on over-refusals. Detect refusals by phrase, a response field, or an LLM.' },
          { term: 'No personal data leaked', text: 'Flags emails, phone and card numbers, IDs, API keys, and canary strings you planted.' },
          { term: 'Tailor to your app', text: 'Optional: a model writes extra prompts that fit your product. Request-level only, never harmful how-tos.' },
        ],
      },
      { type: 'tip', text: 'Open the run\'s **Breakdown** and split by `converter`. "Plain is fine, base64 is 0%" is the most common surprise.' },
      { type: 'gotcha', text: 'Your public support number is "personal data" to a regex. Add it to **Allowed values** on the leak check.' },
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
      { type: 'text', text: 'A run page has tabs: **Results**, **Checks**, **Failure themes**, **Breakdown** and **Metrics**.' },
      { type: 'note', title: 'Check before you start', text: 'The **New run** dialog warns when the target sends a `{{column}}` the dataset doesn\'t have, or a `{{vars.x}}` the target doesn\'t set. Those would go out empty on every row.' },
      { type: 'tip', text: 'Click a check in the **Checks** tab to see only the rows it failed.' },
      { type: 'gotcha', text: 'Retries hide flakiness. Set retries to 0 when you are measuring reliability, not just correctness.' },
      { type: 'links', links: [{ to: '/runs', label: 'Open Runs', primary: true }] },
    ],
    next: 'conversations',
  },
  {
    slug: 'conversations',
    title: 'Multi-turn conversations',
    promise: 'Chatbots fail on turn four, not turn one.',
    group: 'Measure',
    icon: 'MessagesSquare',
    minutes: 3,
    blocks: [
      { type: 'lead', text: 'One question, one answer misses forgotten context, loops and dead ends. Test whole conversations.' },
      {
        type: 'defs',
        items: [
          { term: 'Scripted turns', text: 'A list column (say `turns`) holds what the user says, in order. Same conversation every run.' },
          { term: 'Simulated user', text: 'A model plays a **Persona** with a **Goal**, reacts to your app, and stops when the goal is met or clearly won\'t be.' },
        ],
      },
      {
        type: 'steps',
        items: [
          { text: 'Runs → **New run** → **Conversation** → **Scripted turns** or **Simulated user**.', link: { to: '/runs', label: 'Open Runs' } },
          { text: 'Scripted: pick **User messages from column**. Simulated: set **Persona** and **Goal** (usually `{{persona}}` and `{{goal}}`), **Model playing the user** and **Max turns**.' },
          { text: 'In the target, send `{{message}}` each turn. Keep context with `{{session_id}}` (extract a `session_id` output) or send `{{history | json}}`. Model targets get the history automatically.' },
          { text: 'Score with **Goal achieved**, **Conversation mentions** and **Number of turns**. Open a result to read the chat.' },
        ],
      },
      { type: 'tip', text: 'Let a different model family play the user than the one inside your app, so it doesn\'t go easy on itself.' },
      { type: 'gotcha', text: 'Checks run once, on the finished conversation. A check on `output` only sees the last reply; **Conversation mentions** reads them all.' },
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
      { type: 'links', links: [{ to: '/docs/comparisons', label: 'Compare several models at once' }] },
    ],
    next: 'comparisons',
  },
  {
    slug: 'comparisons',
    title: 'Compare models & targets',
    promise: 'Several candidates, the same rows, one winner.',
    group: 'Measure',
    icon: 'Trophy',
    minutes: 3,
    blocks: [
      { type: 'lead', text: 'Which model, which prompt, which build of your service? Run them all on the same rows and let the numbers pick.' },
      {
        type: 'steps',
        items: [
          { text: 'Runs → **New run** → switch on **Compare several variants instead of one target**.', link: { to: '/runs', label: 'Open Runs' } },
          { text: 'Add 2–8 variants. Each is a target, optionally with another **Connection**, **Model** or **Temp.** (model targets), or **Change variables** such as a staging `base_url`.' },
          { text: '**Compare N variants**. Every variant runs on the same dataset version with the same suite.' },
          { text: 'Read the **Leaderboard**, then **Side by side** → **Disagreements**: rows where one variant passed and another failed.' },
        ],
      },
      {
        type: 'defs',
        items: [
          { term: 'Ranking', text: 'Pass rate first, then mean score, then median latency.' },
          { term: 'Clearly worse', text: 'The gap to the best is unlikely to be luck (paired test, p < 0.05).' },
          { term: 'Could be noise', text: 'Maybe worse, maybe chance. Add rows before you decide.' },
          { term: 'Tied / No real difference', text: 'Pick on cost or speed instead.' },
        ],
      },
      { type: 'tip', text: 'The playground\'s **Run full eval** starts a comparison straight from the models you were trying.' },
      { type: 'gotcha', text: 'Variant changes apply to the run, not the target. To keep the winner, save it as its own target.' },
    ],
    next: 'breakdown',
  },
  {
    slug: 'breakdown',
    title: 'Find where it fails',
    promise: 'Split results by accent, category, tag. Spot the weak slice.',
    group: 'Measure',
    icon: 'ChartColumn',
    minutes: 2,
    blocks: [
      { type: 'lead', text: 'An 85% pass rate can hide a 40% one. Slice it and the problem jumps out.' },
      {
        type: 'steps',
        items: [
          { text: 'Open a run → **Breakdown** tab.' },
          { text: '**Split by** tags or any column (`accent`, `category`, `converter`…). Kalibra suggests a good one.' },
          { text: '**Judge by** the whole row, or one check (say, WER).' },
          { text: 'The **Weakest** badge marks the group to fix first. Click a group to filter the results.' },
        ],
      },
      { type: 'heading', text: 'Trends' },
      { type: 'text', text: 'The **Trends** card on Overview charts each suite\'s pass rate run after run. The shaded band is the 95% interval: overlapping bands mean "maybe noise".' },
      { type: 'tip', text: 'For speech-to-text, split by `accent` and judge by the WER check. Corpus WER per accent is the fairest comparison.' },
      { type: 'gotcha', text: 'Tiny groups swing wildly. Look at the row count before you panic about a 0%.' },
      { type: 'links', links: [{ to: '/runs', label: 'Open Runs', primary: true }, { to: '/', label: 'See Trends' }] },
    ],
    next: 'failure-themes',
  },
  {
    slug: 'failure-themes',
    title: 'Failure themes',
    promise: 'Forty failures, three reasons.',
    group: 'Measure',
    icon: 'Layers',
    minutes: 2,
    blocks: [
      { type: 'lead', text: 'Reading failures one by one doesn\'t scale. Group them, fix the biggest group, run again.' },
      {
        type: 'steps',
        items: [
          { text: 'Open a run → **Failure themes** tab.', link: { to: '/runs', label: 'Open Runs' } },
          { text: '**Quick groups** appear instantly, for free: failures grouped by the first check they failed and the shape of the reason.' },
          { text: 'For named themes, **Find themes with AI** with a **Connection** (and an optional **Model**).' },
          { text: 'Each of the **AI themes** has what goes wrong, a likely cause, a suggested fix and a severity. Click one to see its rows.' },
        ],
      },
      { type: 'tip', text: 'With the local embedding model downloaded, failures are clustered by meaning first and the model only names the groups.' },
      { type: 'gotcha', text: 'The cause and fix are a starting point, not a verdict. Open a few rows before you change code.' },
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
          { text: 'Open a run → **Review & calibrate**, or the scales icon next to a check.' },
          { text: 'Label 30–100 rows with **P** (pass) or **F** (fail). **Blind mode** hides the judge\'s verdict so it can\'t sway you. **S** skips, **U** undoes.' },
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
      { type: 'tip', text: 'Keep **Which rows next** on **Balanced**: half the judge\'s passes, half its fails. Switch **Show results for** to **All runs of suite** to pool labels across runs.' },
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
      { type: 'text', text: 'In the **Models** box, a connection can hold a **Text**, **Image**, **Speech**, **Transcription** and **Embedding** model. Each has its own **Test**: it answers, draws a tiny picture, says a sentence you can play back, or compares two sentences.' },
      { type: 'note', title: 'No embedding model? Use the local one', text: 'Meaning checks, meaning duplicates and failure themes can use a free local model instead. Download it once (about 110 MB) from a dataset\'s **Quality** tab → **Meaning-based tools**; after that it works offline.' },
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
    next: 'projects',
  },
  {
    slug: 'projects',
    title: 'Projects & teams',
    promise: 'Keep work apart, and invite people with the right role.',
    group: 'Connect',
    icon: 'Users',
    minutes: 3,
    blocks: [
      { type: 'lead', text: 'A **project** holds its own datasets, targets, suites, runs, connections and secrets. Switch projects from the menu at the top of the sidebar.' },
      {
        type: 'defs',
        items: [
          { term: 'On your computer', text: 'The desktop app and `npx kalibra`: no sign-in, every project is yours.' },
          { term: 'Team server', text: '`kalibra server`: everyone signs in, and each project has members.' },
          { term: 'Viewer', text: 'Sees everything in the project; changes nothing.' },
          { term: 'Editor', text: 'Creates, edits and runs, and uses the project’s connections.' },
          { term: 'Owner', text: 'Also members, connections, secrets and deleting the project.' },
        ],
      },
      {
        type: 'steps',
        title: 'Do this',
        items: [
          { text: 'Project menu → **New project**. Your existing data lives in the first project.', link: { to: '/projects', label: 'All projects' } },
          { text: 'On a team server: **Project settings** → **Members** → **Add people**. Add a whole group at once.', link: { to: '/project-settings', label: 'Project settings' } },
          { text: 'Coding agents: **Your account** → **Access tokens** → **New token**, then connect the agent with `--server` and `--project`.', link: { to: '/agents', label: 'Coding agents' } },
          { text: 'Administrators: **Administration** → **Users**, **Groups**, and **Sign-in** for Google, GitHub (including GitHub Enterprise), company SSO or a login gateway.' },
        ],
      },
      { type: 'code', label: 'Run a team server', code: 'npx kalibra server --public-url https://kalibra.example.com\n# open the setup link it prints to create the first administrator' },
      { type: 'gotcha', text: 'Editors can use the project’s secrets through targets they write. Give the editor role to people you would trust with those keys.' },
    ],
    next: 'sharing',
  },
  {
    slug: 'sharing',
    title: 'Share with your team',
    promise: 'No server: send a file, or keep a folder in Git.',
    group: 'Connect',
    icon: 'Share2',
    minutes: 3,
    blocks: [
      { type: 'lead', text: 'Kalibra is local. Your team isn\'t. Two ways to share, neither needs hosting.' },
      {
        type: 'defs',
        items: [
          { term: 'Bundle (.kalibra)', text: 'One file with datasets (and their audio and images), targets, suites, connections and, if you like, runs.' },
          { term: 'Git folder', text: 'Small, stable text files your team commits. Re-exporting only touches what changed, so diffs stay readable.' },
        ],
      },
      {
        type: 'steps',
        title: 'Do this',
        items: [
          { text: 'Project settings (the project menu at the top of the sidebar) → **Share with your team** → **Send a bundle**: **Everything** or **Choose…**, then **Export bundle**. For one dataset: **Export** → **Bundle (with media)**.', link: { to: '/project-settings', label: 'Open project settings' } },
          { text: 'Your teammate: Datasets → **Import**, drop the file. If something already exists: **Keep both**, **Skip** or **Update mine**.' },
          { text: 'Git: **Sync with a folder (Git)** → an absolute folder path → **Export to folder**. Commit it.' },
          { text: 'After a `git pull`: **Check for changes**, read the list, **Apply changes**.' },
        ],
      },
      { type: 'note', title: 'Secrets stay home', text: 'Bundles and folders hold secret names, never values. The import tells your teammate which ones to set.' },
      { type: 'gotcha', text: '**Also delete what is not in the folder** really deletes. Leave it off unless the folder is the source of truth.' },
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
          { text: '**Add rows** → **Upload audio or image files**: your recordings + a CSV with `file,reference`.' },
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
          { text: 'Open your audio dataset → **Generate** → **Audio variants**.' },
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
          { text: '**Generate** → **Images** with the template `{{description}}`.' },
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
    next: 'recipe-safety',
  },
  {
    slug: 'recipe-safety',
    title: 'Red-team my chatbot in 10 minutes',
    promise: 'Harmful asks, sneaky variants, benign look-alikes. Scored.',
    group: 'Recipes',
    icon: 'ShieldAlert',
    minutes: 3,
    blocks: [
      { type: 'lead', text: 'You will know which tricks get past your bot, and whether it has become too jumpy to be useful.' },
      {
        type: 'steps',
        items: [
          { text: 'Datasets → **Safety pack**. Keep the default categories, add **Role-play** and **Base64** variants.', link: { to: '/datasets', label: 'Open Datasets' } },
          { text: 'Make sure **Also create a suite** is on. Create.' },
          { text: 'Runs → **New run**: the safety dataset, your chat target, the new "Safety checks" suite.', link: { to: '/runs', label: 'Open Runs' } },
          { text: 'In the **Breakdown** tab, split by `converter`, then by `category`.' },
          { text: 'Open a failed row: was it unsafe compliance or over-refusal? The check says which.' },
        ],
      },
      { type: 'tip', text: 'If your app reports refusals itself (e.g. a `refused: true` field), switch the refusal detector to **A field from the response**. Faster and exact.' },
      { type: 'gotcha', text: 'Zero failures on 40 prompts is good news, not proof. Turn on **Tailor to your app** for prompts your users would actually send.' },
    ],
    next: 'recipe-migrate',
  },
  {
    slug: 'recipe-migrate',
    title: 'Bring my tests from promptfoo or OpenAI Evals',
    promise: 'Keep your test cases, switch the tool.',
    group: 'Recipes',
    icon: 'FileInput',
    minutes: 3,
    blocks: [
      { type: 'lead', text: 'Your test cases shouldn\'t be stuck in another tool. Kalibra imports them and tells you exactly what didn\'t map.' },
      {
        type: 'defs',
        items: [
          { term: 'promptfoo', text: '`promptfooconfig.yaml`: tests become a dataset, assertions a suite, http and model providers targets.' },
          { term: 'OpenAI Evals', text: 'A `.jsonl` of samples, plus an optional graders file that becomes a suite.' },
          { term: 'LangSmith', text: 'A dataset export, `.csv` or `.jsonl`.' },
          { term: 'Langfuse', text: 'A dataset export, `.json`.' },
        ],
      },
      {
        type: 'steps',
        items: [
          { text: 'Datasets → **Import** → drop the file. Kalibra detects the format and shows what it found.', link: { to: '/datasets', label: 'Open Datasets' } },
          { text: '**Import**. The report lists what was mapped and what wasn\'t, with reasons.' },
          { text: 'Open the new suite. LLM-graded assertions arrive as **disabled** LLM judges: pick a connection, then switch them on.' },
          { text: 'Run it against your target and compare with the numbers you had before.' },
        ],
      },
      { type: 'gotcha', text: 'Imported model targets have no connection yet. Pick one before the first run.' },
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
          { term: 'Local embeddings', text: 'Downloaded once into `~/Kalibra/models`, then run offline.' },
          { term: 'Sharing', text: 'Bundles and Git folders carry secret names, never values.' },
        ],
      },
      { type: 'gotcha', text: 'Cloud judges and generators see the rows you send them. Use a local model for sensitive data.' },
    ],
    next: 'settings',
  },
  {
    slug: 'settings',
    title: 'Make it yours',
    promise: 'Theme, accent colour, reading font, text size.',
    group: 'Reference',
    icon: 'SlidersHorizontal',
    minutes: 1,
    blocks: [
      { type: 'lead', text: 'You will read a lot of transcripts here. Make them comfortable.' },
      {
        type: 'defs',
        items: [
          { term: 'Theme', text: 'Light, dark, or follow your system.' },
          { term: 'Accent colour', text: 'Clay orange by default, or teal, sky, rose, violet. Pass and fail colours never change.' },
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
          { term: 'Over-refusal', text: 'Saying no to a harmless question that only sounds risky. Counts as a failure.' },
          { term: 'Variant (converter)', text: 'The same prompt in disguise: base64, role-play, typos, look-alike letters.' },
          { term: 'Breakdown', text: 'Results split by a tag or column, so a weak slice can\'t hide in the average.' },
          { term: 'Comparison', text: 'Several targets or models run on the same rows and suite, ranked on a leaderboard.' },
          { term: 'Simulated user', text: 'A model playing a customer with a goal, to test whole conversations.' },
          { term: 'Embedding', text: 'Text turned into numbers so that similar meanings land close together.' },
          { term: 'Failure theme', text: 'A group of failures with one shared cause.' },
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
          { q: 'Can my team share this?', a: 'Yes, without a server: send a .kalibra bundle, or keep a folder in Git (Settings → Share with your team). A self-hosted server mode is on the roadmap.' },
          { q: 'Which model should my app use?', a: 'Try a few in the Playground, then run them all as a comparison on your dataset. The leaderboard says which is best and whether the gap is real.' },
          { q: 'Is it free?', a: 'Yes. MIT-licensed open source.' },
          { q: 'Why is my safety pass rate so low on the demo bot?', a: 'On purpose: the demo bot falls for base64 and role-play. Your app should do better. Check the Breakdown by converter.' },
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
