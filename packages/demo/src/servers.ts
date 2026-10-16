import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { ensureFixtures, pcmHash, toPcm16k, trimTrailingZeros, type FixtureEntry } from './fixtures.js';

/*
 * Mock "apps under test" for trying Kalibra without a real backend:
 *   POST /api/chat          JSON support bot with deterministic quirks (slow, 500s, broken JSON, refusals)
 *   POST /api/chat/stream   the same answers as OpenAI-style SSE deltas
 *   POST /api/chat/session  multi-turn bot with memory: {message, session_id?} → {answer, session_id}
 *   POST /api/stt           batch speech-to-text (multipart: file, language)
 *   WS   /ws/stt            streaming speech-to-text with partial and final results
 *   GET  /api/health
 * Transcripts come from the fixture manifest, with small deterministic errors so WER is realistic.
 */

export interface DemoServers {
  url: string;
  wsUrl: string;
  port: number;
  fixtures: FixtureEntry[];
  close(): Promise<void>;
}

const hashNum = (s: string) => createHash('sha1').update(s).digest().readUInt32BE(0);

// ── Chat bot ────────────────────────────────────────────────────────────────

interface KbEntry {
  match: RegExp;
  answer: string;
  sources: { id: string; title: string }[];
  confidence: number;
  refused?: boolean;
}

const KB: KbEntry[] = [
  {
    match: /password|hack|someone else'?s|steal|bypass|otp of/i,
    answer: "I can't help with that. For your security, never share passwords or one-time codes, and only access your own accounts.",
    sources: [],
    confidence: 0.95,
    refused: true,
  },
  {
    match: /block|lost|stolen/i,
    answer: 'To block your card, open Cards → Block card in the app or call 1800-123-456. The block takes effect immediately and you can order a replacement from the same screen.',
    sources: [{ id: 'kb-cards-01', title: 'Blocking a lost or stolen card' }],
    confidence: 0.92,
  },
  {
    match: /limit/i,
    answer: 'The default daily transfer limit is ₹1,00,000. You can raise it up to ₹5,00,000 under Settings → Limits; changes apply after 24 hours.',
    sources: [{ id: 'kb-limits-02', title: 'Transfer limits' }],
    confidence: 0.88,
  },
  {
    match: /balance|statement/i,
    answer: 'Your balance is shown on the home screen of the app. For a full statement go to Accounts → Statements and pick a date range.',
    sources: [{ id: 'kb-accounts-01', title: 'Balances and statements' }],
    confidence: 0.9,
  },
  {
    match: /loan|interest|emi/i,
    answer: 'Personal loan interest rates start at 10.5% per year. You can check your eligibility and EMI under Loans → Personal loan.',
    sources: [{ id: 'kb-loans-03', title: 'Personal loans' }, { id: 'kb-rates-01', title: 'Current interest rates' }],
    confidence: 0.81,
  },
  {
    match: /hours|open|branch/i,
    answer: 'Branches are open 9:30 am to 4:30 pm, Monday to Saturday, except the second and fourth Saturday.',
    sources: [{ id: 'kb-branches-01', title: 'Branch timings' }],
    confidence: 0.86,
  },
  {
    match: /fraud|scam|unauthori[sz]ed/i,
    answer: 'If you see a transaction you did not make, block your card right away and report it under Help → Report fraud. We respond within 24 hours.',
    sources: [{ id: 'kb-fraud-01', title: 'Reporting fraud' }],
    confidence: 0.9,
  },
];

const FALLBACK: KbEntry = {
  match: /.*/,
  answer: "I'm not sure about that. Please contact support at 1800-123-456 and an agent will help you.",
  sources: [],
  confidence: 0.3,
};

function answerFor(message: string) {
  return KB.find((k) => k.match.test(message)) ?? FALLBACK;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function handleChat(req: IncomingMessage, res: ServerResponse) {
  const raw = (await readBody(req)).toString('utf8');
  let message = '';
  try {
    message = String(JSON.parse(raw).message ?? '');
  } catch {
    return sendJson(res, 400, { error: 'Body must be JSON like {"message": "..."}' });
  }
  if (!message.trim()) return sendJson(res, 422, { error: 'message is required' });
  const h = hashNum(message);
  const quirk = h % 20;
  await delay(80 + (h % 220) + (quirk === 2 || quirk === 3 ? 1500 : 0));
  if (quirk === 0) return sendJson(res, 500, { error: 'internal error', request_id: `req_${h.toString(16)}` });
  const kb = answerFor(message);
  if (quirk === 1) {
    // Broken JSON, as real services sometimes produce under load.
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(`{"answer": ${JSON.stringify(kb.answer)}, "sources": [`);
  }
  const body: Record<string, unknown> = { answer: kb.answer, sources: kb.sources, confidence: kb.confidence };
  if (kb.refused) body.refused = true;
  if (quirk === 4) delete body.sources;
  sendJson(res, 200, body);
}

interface ChatSession {
  name?: string;
  flow?: 'block';
  step?: 'which' | 'confirm';
  card?: 'debit' | 'credit';
}

const sessions = new Map<string, ChatSession>();

/** A tiny stateful bot: remembers your name and walks through blocking a card in three steps. */
function sessionReply(s: ChatSession, message: string): string {
  const m = message.toLowerCase();
  const name = /\bmy name is ([a-z][a-z'-]*)/i.exec(message)?.[1];
  if (name) s.name = name.charAt(0).toUpperCase() + name.slice(1);

  if (s.flow === 'block' && s.step === 'which') {
    const card = /\bcredit\b/.test(m) ? 'credit' : /\bdebit\b/.test(m) ? 'debit' : undefined;
    if (!card) return 'Sorry, which card should I block: your debit card or your credit card?';
    s.card = card;
    s.step = 'confirm';
    return `Please confirm: block your ${card} card ending in 4321? (yes/no)`;
  }
  if (s.flow === 'block' && s.step === 'confirm') {
    const yes = /\b(yes|yeah|yep|confirm|please do)\b/.test(m);
    const no = /\b(no|nope|don'?t|cancel|stop)\b/.test(m);
    if (!yes && !no) return `Please answer yes or no: block your ${s.card} card ending in 4321?`;
    s.flow = undefined;
    s.step = undefined;
    if (yes) return `Done${s.name ? `, ${s.name}` : ''}. Your ${s.card} card is blocked. A replacement will arrive in 5–7 days.`;
    return "Okay, I won't block it. Is there anything else I can help with?";
  }
  if (/\b(block|lost|stolen|freeze)\b/.test(m) && /\bcard\b/.test(m)) {
    s.flow = 'block';
    const card = /\bcredit\b/.test(m) ? 'credit' : /\bdebit\b/.test(m) ? 'debit' : undefined;
    if (card) {
      s.card = card;
      s.step = 'confirm';
      return `I'm sorry to hear that. Please confirm: block your ${card} card ending in 4321? (yes/no)`;
    }
    s.step = 'which';
    return 'I can help block a card. Which card: debit or credit?';
  }
  if (/\b(what'?s my name|who am i|do you know my name)\b/.test(m)) return s.name ? `You told me your name is ${s.name}.` : "I don't know your name yet.";
  if (/\bbalance\b/.test(m)) return 'Your savings balance is ₹42,310.';
  if (name && m.replace(/my name is [a-z'-]+/i, '').replace(/[^a-z]/g, '').length < 6) return `Nice to meet you, ${s.name}. How can I help?`;
  return answerFor(message).answer;
}

async function handleChatSession(req: IncomingMessage, res: ServerResponse) {
  let body: any;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'Body must be JSON like {"message": "...", "session_id": "..."}' });
  }
  const message = String(body?.message ?? '');
  if (!message.trim()) return sendJson(res, 422, { error: 'message is required' });
  const id = typeof body.session_id === 'string' && body.session_id ? body.session_id : `sess_${createHash('sha1').update(`${Date.now()}${Math.random()}`).digest('hex').slice(0, 12)}`;
  let s = sessions.get(id);
  if (!s) {
    s = {};
    sessions.set(id, s);
    if (sessions.size > 5000) sessions.delete(sessions.keys().next().value!);
  }
  await delay(40 + (hashNum(message) % 120));
  sendJson(res, 200, { answer: sessionReply(s, message), session_id: id });
}

async function handleChatStream(req: IncomingMessage, res: ServerResponse) {
  let message = '';
  try {
    message = String(JSON.parse((await readBody(req)).toString('utf8')).message ?? '');
  } catch {
    return sendJson(res, 400, { error: 'Body must be JSON like {"message": "..."}' });
  }
  const kb = answerFor(message);
  const id = `chatcmpl-${hashNum(message).toString(16)}`;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  await delay(120 + (hashNum(message) % 200));
  const words = kb.answer.split(' ');
  for (let i = 0; i < words.length; i++) {
    const content = (i === 0 ? '' : ' ') + words[i];
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content } }] })}\n\n`);
    await delay(20);
  }
  res.write(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

// ── Speech to text ──────────────────────────────────────────────────────────

const HOMOPHONES: Record<string, string> = {
  fifteen: 'fifty',
  four: 'for',
  two: 'to',
  three: 'tree',
  priya: 'pria',
  mehta: 'meta',
  carlos: "carl's",
  fifth: 'fifths',
  groceries: 'grocery',
  premium: 'premiums',
  limit: 'limits',
  balance: 'balanced',
};

/** Deterministic small transcription errors: a substitution, a deletion and/or an insertion. */
export function corrupt(text: string, id: string, mode: 'batch' | 'stream'): string {
  const words = text.split(' ');
  const h = hashNum(`${id}:${mode}`);
  const kind = h % (mode === 'stream' ? 4 : 5);
  if (kind === 0) return text; // perfect transcript
  const out = [...words];
  if (kind === 1 || kind === 3) {
    const idx = out.findIndex((w) => HOMOPHONES[w.toLowerCase()]);
    if (idx >= 0) out[idx] = HOMOPHONES[out[idx].toLowerCase()];
    else out[h % out.length] = out[h % out.length] + 's';
  }
  if (kind === 2 || kind === 3) out.splice(1 + (h % Math.max(1, out.length - 2)), 1);
  if (kind === 4) out.splice(1 + (h % Math.max(1, out.length - 1)), 0, 'uh');
  return out.join(' ');
}

interface LoadedFixture extends FixtureEntry {
  pcm: Buffer;
}

function identify(fixtures: LoadedFixture[], pcm: Buffer, durationMs: number): LoadedFixture | undefined {
  const hash = pcmHash(pcm);
  const exact = fixtures.find((f) => f.pcmHash === hash);
  if (exact) return exact;
  // Different encoding or resampling: fall back to the closest duration within 8%.
  let best: LoadedFixture | undefined;
  let bestDiff = Infinity;
  for (const f of fixtures) {
    const diff = Math.abs(f.durationMs - durationMs) / f.durationMs;
    if (diff < bestDiff) {
      best = f;
      bestDiff = diff;
    }
  }
  return bestDiff <= 0.08 ? best : undefined;
}

function wordsWithTimes(text: string, durationMs: number) {
  const words = text.split(' ').filter(Boolean);
  const step = durationMs / 1000 / Math.max(1, words.length);
  return words.map((w, i) => ({ w, start: Number((i * step).toFixed(2)), end: Number(((i + 1) * step).toFixed(2)) }));
}

async function handleStt(req: IncomingMessage, res: ServerResponse, fixtures: LoadedFixture[]) {
  const body = await readBody(req);
  let form: FormData;
  try {
    form = await new Request('http://local/api/stt', { method: 'POST', headers: req.headers as Record<string, string>, body }).formData();
  } catch {
    return sendJson(res, 400, { error: 'Expected multipart/form-data with a "file" field' });
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return sendJson(res, 400, { error: 'Missing "file" field' });
  const language = String(form.get('language') ?? 'en');
  let pcm: Buffer;
  try {
    pcm = await toPcm16k(new Uint8Array(await file.arrayBuffer()), file.type);
  } catch (e) {
    return sendJson(res, 415, { error: `Could not decode audio: ${(e as Error).message}` });
  }
  const durationMs = (trimTrailingZeros(pcm).byteLength / 2 / 16000) * 1000;
  await delay(120 + durationMs * 0.15);
  const match = identify(fixtures, pcm, durationMs);
  const text = match ? corrupt(match.text, match.id, 'batch') : '';
  sendJson(res, 200, { text, words: wordsWithTimes(text, durationMs), duration: Number((durationMs / 1000).toFixed(2)), language });
}

function handleSttSocket(ws: WebSocket, fixtures: LoadedFixture[]) {
  let sampleRate = 16000;
  let encoding = 'pcm_s16le';
  const chunks: Buffer[] = [];
  let received = 0;
  let lastPartialBytes = 0;
  let candidate: LoadedFixture | undefined;
  let stopped = false;

  const bytesPerMs = () => (sampleRate * (encoding === 'pcm_s16le' ? 2 : encoding === 'pcm_f32le' ? 4 : 1)) / 1000;
  const comparable = () => encoding === 'pcm_s16le' && sampleRate === 16000;
  const send = (msg: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

  const onAudio = (buf: Buffer) => {
    if (stopped) return;
    chunks.push(buf);
    const offset = received;
    received += buf.byteLength;
    if (comparable()) {
      // Clips start with identical silence, so a match counts only once it is unique; trailing silence keeps it.
      if (candidate) {
        const pcm = candidate.pcm;
        const within = pcm.subarray(offset, Math.min(received, pcm.byteLength));
        const extra = buf.subarray(within.byteLength);
        const stillMatches = within.equals(buf.subarray(0, within.byteLength)) && extra.every((b) => b === 0);
        if (!stillMatches) candidate = undefined;
      }
      if (!candidate) {
        const prefix = Buffer.concat(chunks);
        const matches = fixtures.filter((f) => f.pcm.byteLength >= prefix.byteLength && f.pcm.subarray(0, prefix.byteLength).equals(prefix));
        candidate = matches.length === 1 ? matches[0] : undefined;
      }
    }
    if (received - lastPartialBytes >= 300 * bytesPerMs()) {
      lastPartialBytes = received;
      let text = '…';
      if (candidate) {
        const words = corrupt(candidate.text, candidate.id, 'stream').split(' ');
        const fraction = Math.min(1, received / candidate.pcm.byteLength);
        text = words.slice(0, Math.max(1, Math.floor(words.length * fraction))).join(' ');
      }
      send({ type: 'partial', text, is_final: false, audio_ms: Math.round(received / bytesPerMs()) });
    }
  };

  const onStop = async () => {
    if (stopped) return;
    stopped = true;
    const audio = Buffer.concat(chunks);
    const durationMs = audio.byteLength / bytesPerMs();
    await delay(150 + (hashNum(String(audio.byteLength)) % 250));
    const match = comparable() ? identify(fixtures, audio, durationMs) : identify(fixtures, Buffer.alloc(0), durationMs);
    const text = match ? corrupt(match.text, match.id, 'stream') : '';
    send({ type: 'final', text, is_final: true, audio_ms: Math.round(durationMs), ...(match ? {} : { warning: 'unrecognized audio' }) });
  };

  // Without a listener, a client's protocol error (bad frame, oversized message) would crash the demo.
  ws.on('error', () => ws.terminate());
  ws.on('message', (data, isBinary) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (isBinary) return onAudio(buf);
    let msg: any;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      return send({ type: 'error', message: 'Text frames must be JSON' });
    }
    if (msg.type === 'start') {
      sampleRate = Number(msg.sample_rate) || 16000;
      encoding = String(msg.encoding || 'pcm_s16le');
      send({ type: 'ready', sample_rate: sampleRate, encoding });
    } else if (msg.type === 'audio' && typeof msg.data === 'string') {
      onAudio(Buffer.from(msg.data, 'base64'));
    } else if (msg.type === 'stop') {
      void onStop();
    } else {
      send({ type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  });
}

// ── Server ──────────────────────────────────────────────────────────────────

export async function startDemoServers(opts: { port?: number; host?: string } = {}): Promise<DemoServers> {
  const manifest = await ensureFixtures();
  const fixtures: LoadedFixture[] = await Promise.all(
    manifest.map(async (f) => ({ ...f, pcm: trimTrailingZeros(await toPcm16k(readFileSync(f.file), 'audio/wav')) })),
  );

  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0];
      if (req.method === 'GET' && path === '/api/health') return sendJson(res, 200, { ok: true, fixtures: fixtures.length });
      if (req.method === 'POST' && path === '/api/chat') return await handleChat(req, res);
      if (req.method === 'POST' && path === '/api/chat/stream') return await handleChatStream(req, res);
      if (req.method === 'POST' && path === '/api/chat/session') return await handleChatSession(req, res);
      if (req.method === 'POST' && path === '/api/stt') return await handleStt(req, res, fixtures);
      sendJson(res, 404, { error: `No route for ${req.method} ${path}` });
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: (e as Error).message });
      else res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== '/ws/stt') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleSttSocket(ws, fixtures));
  });

  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4400, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://${host}:${port}`,
    wsUrl: `ws://${host}:${port}`,
    port,
    fixtures: manifest,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
