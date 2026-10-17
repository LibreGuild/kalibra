import WebSocket from 'ws';
import { render, renderValue, toText } from '../template.js';
import { evalExpression, runScript } from '../script.js';
import { sleep } from '../util.js';
import { bytesPerSample, durationMs as audioDuration, prepareAudio } from '../audio/convert.js';
import { decodeWav, isWav } from '../audio/wav.js';
import type { TargetSpec, WsTargetConfig } from '../specs.js';
import { withTraceHeaders, type TargetCallContext, type TargetCallResult } from './types.js';
import {
  applyExtractors,
  describeError,
  failure,
  isFileValue,
  isRetryableStatus,
  jsonPathValue,
  makeLogger,
  MASK,
  now,
  requestScope,
  trackSecrets,
  tryParseJson,
} from './common.js';

/*
 * WebSocket target. Covers streaming speech-to-text (send audio frames, collect partial/final
 * transcripts, measure latency) as well as message-based chat apps. Every protocol detail is
 * configurable; `scripts.onMessage` and `scripts.session` take over when settings are not enough.
 *
 * When is a session done? (incoming.doneWhen)
 *   final_after_audio – the first final result received after all audio and closing messages were sent
 *   close             – when the server closes the socket
 *   expression        – when doneExpression (JS on msg, state, finals, partials) becomes true
 *   idle              – no message for idleMs after audio ended
 * The socket closing always ends the session, and timeoutMs bounds the whole call.
 */

type WsLog = { t: number; dir: 'in' | 'out'; kind: string; data: unknown };
const MAX_MESSAGES = 1000;
const MAX_PARTIALS = 200;

export async function executeWebSocket(spec: TargetSpec, ctx: TargetCallContext): Promise<TargetCallResult> {
  const cfg = spec.config as WsTargetConfig;
  const secrets = trackSecrets(ctx.env);
  const { logs, log } = makeLogger(secrets.mask);
  const env = secrets.env;
  const scope = requestScope(ctx);
  const t0 = now();
  const rel = () => now() - t0;

  const messages: WsLog[] = [];
  const record = (dir: WsLog['dir'], kind: string, data: unknown) => {
    if (messages.length < MAX_MESSAGES) messages.push({ t: Math.round(rel()), dir, kind, data });
  };

  // ── Connection details ───────────────────────────────────────────────────
  let url: URL;
  const headers: Record<string, string> = {};
  try {
    url = new URL((await render(cfg.url, scope, env)).trim());
    for (const q of cfg.query) if (q.enabled && q.key) url.searchParams.append(await render(q.key, scope, env), await render(q.value, scope, env));
    for (const h of cfg.headers) if (h.enabled && h.key) headers[await render(h.key, scope, env)] = await render(h.value, scope, env);
    const auth = cfg.auth;
    if (auth.type === 'bearer') {
      const token = await render(auth.token, scope, env);
      secrets.add(token);
      headers['Authorization'] = `Bearer ${token}`;
    } else if (auth.type === 'api_key') {
      const value = await render(auth.value, scope, env);
      secrets.add(value);
      if (auth.in === 'query') url.searchParams.set(auth.name, value);
      else headers[auth.name] = value;
    } else if (auth.type === 'basic') {
      const pass = await render(auth.password, scope, env);
      secrets.add(pass);
      const encoded = Buffer.from(`${await render(auth.username, scope, env)}:${pass}`).toString('base64');
      secrets.add(encoded);
      headers['Authorization'] = `Basic ${encoded}`;
    }
    withTraceHeaders(headers, ctx.traceHeaders);
  } catch (e) {
    return failure(`Could not build the connection: ${(e as Error).message}`, logs);
  }

  const request = secrets.maskDeep({
    url: url.toString(),
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, k.toLowerCase() === 'authorization' ? v.replace(/^(\w+)\s+.+$/, `$1 ${MASK}`) : v])),
    subprotocols: cfg.subprotocols,
  });

  // ── Connect ──────────────────────────────────────────────────────────────
  let conn: Connection;
  try {
    conn = await connect(url.toString(), cfg.subprotocols, headers, cfg.connectTimeoutMs, ctx.signal);
  } catch (e) {
    const status = (e as any).status as number | undefined;
    const { message, retryable } = describeError(e, cfg.connectTimeoutMs, ctx.signal);
    return failure(message, logs, {
      request,
      retryable: status ? isRetryableStatus(status) : retryable,
      response: status ? { status } : undefined,
      metrics: { latency_ms: Math.round(rel()) },
    });
  }
  const { ws } = conn;
  const openAt = rel();
  const metrics: Record<string, number> = { connect_ms: Math.round(openAt) };

  // ── Session state ────────────────────────────────────────────────────────
  const st = {
    finals: [] as { text: string; t: number }[],
    partials: [] as { text: string; t: number }[],
    incoming: [] as unknown[],
    state: {} as Record<string, unknown>,
    firstMessageAt: undefined as number | undefined,
    firstTextAt: undefined as number | undefined,
    firstAudioAt: undefined as number | undefined,
    lastAudioAt: undefined as number | undefined,
    inputEndAt: undefined as number | undefined,
    lastFinalAt: undefined as number | undefined,
    audioMs: 0,
    doneReason: undefined as string | undefined,
    error: undefined as string | undefined,
    closeCode: undefined as number | undefined,
  };

  // Session-script inbox: messages not yet read, and scripts waiting for the next one.
  const inbox: unknown[] = [];
  const inboxWaiters: ((msg: unknown) => void)[] = [];

  let resolveDone!: (reason: string) => void;
  const done = new Promise<string>((r) => (resolveDone = r));
  const finish = (reason: string) => {
    if (!st.doneReason) {
      st.doneReason = reason;
      resolveDone(reason);
      // A session script waiting for a message gets `undefined` now instead of after its own timeout.
      for (const w of inboxWaiters.splice(0)) w(undefined);
    }
  };

  const remaining = Math.max(1, cfg.timeoutMs - rel());
  const overallTimer = setTimeout(() => finish('timeout'), remaining);
  const onAbort = () => finish('cancelled');
  ctx.signal.addEventListener('abort', onAbort, { once: true });

  let idleTimer: NodeJS.Timeout | undefined;
  const armIdle = () => {
    if (cfg.incoming.doneWhen !== 'idle' || st.inputEndAt === undefined) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finish('idle'), cfg.incoming.idleMs);
  };

  const warned = new Set<string>();
  const evalSafe = (expr: string, scopeVars: Record<string, unknown>) => {
    try {
      return evalExpression(expr, scopeVars);
    } catch (e) {
      if (!warned.has(expr)) {
        warned.add(expr);
        log('warn', `Expression "${expr}" failed: ${(e as Error).message}`);
      }
      return undefined;
    }
  };

  // Ack waiting (waitForOpenAck). The ack can arrive before the wait starts (a greeting on connect).
  let acked = false;
  let ackWaiter: (() => void) | undefined;
  const sessionMode = cfg.scripts.session.trim() !== '';

  // ── Incoming messages (processed strictly in order) ──────────────────────
  let queue = Promise.resolve();
  const onMessage = (raw: WebSocket.RawData, isBinary: boolean) => {
    queue = queue.then(() => handleMessage(raw, isBinary)).catch((e) => log('error', `Message handling failed: ${(e as Error).message}`));
  };
  // Messages that arrived with the handshake (greetings, "session created", acks) come first.
  conn.stopBuffering();
  for (const [raw, isBinary] of conn.early) onMessage(raw, isBinary);
  ws.on('message', onMessage);
  ws.on('close', (code: number, reason: Buffer) => {
    st.closeCode = code;
    record('in', 'close', { code, reason: reason.toString() });
    // Let queued messages finish before ending.
    queue = queue.then(() => finish('close'));
  });
  ws.on('error', (e: Error) => {
    st.error = e.message;
    log('error', `Socket error: ${e.message}`);
    finish('error');
  });

  async function handleMessage(raw: WebSocket.RawData, isBinary: boolean) {
    const t = rel();
    st.firstMessageAt ??= t;
    const buf = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
    let msg: unknown;
    if (isBinary) {
      msg = buf;
      record('in', 'binary', { size: buf.byteLength });
    } else {
      const text = buf.toString('utf8');
      msg = cfg.incoming.format === 'json' ? (tryParseJson(text) ?? text) : text;
      record('in', 'text', msg);
    }
    if (!isBinary) st.incoming.push(msg);

    if (sessionMode) {
      const w = inboxWaiters.shift();
      if (w) w(msg);
      else inbox.push(msg);
      return;
    }
    if (!acked && cfg.waitForOpenAck.trim() && evalSafe(cfg.waitForOpenAck, { msg, state: st.state })) {
      acked = true;
      ackWaiter?.();
    }
    armIdle();
    if (cfg.incoming.ignoreWhen.trim() && evalSafe(cfg.incoming.ignoreWhen, { msg, state: st.state })) return;

    let scripted: any;
    if (cfg.scripts.onMessage.trim()) {
      try {
        scripted = await runScript(cfg.scripts.onMessage, { msg, state: st.state, log }, {
          log,
          timeoutMs: 5000,
          requireFrom: ctx.workspaceDir,
          filename: 'onMessage.js',
        });
      } catch (e) {
        log('error', `onMessage script failed: ${(e as Error).message}`);
      }
      if (scripted?.ignore) return;
    }

    let text: string | undefined;
    let isFinal: boolean;
    if (scripted && typeof scripted === 'object' && ('final' in scripted || 'partial' in scripted)) {
      isFinal = scripted.final !== undefined && scripted.final !== null;
      text = toText(isFinal ? scripted.final : scripted.partial);
    } else if (isBinary) {
      return;
    } else {
      const v = cfg.incoming.textPath.trim() ? jsonPathValue(cfg.incoming.textPath, msg) : typeof msg === 'string' ? msg : undefined;
      text = v === undefined || v === null ? undefined : toText(v);
      // Without an isFinal rule every text message counts as final (one-shot request/response protocols).
      isFinal = cfg.incoming.isFinal.trim() ? !!evalSafe(cfg.incoming.isFinal, { msg, state: st.state }) : text !== undefined;
    }

    if (text && st.firstTextAt === undefined) st.firstTextAt = t;
    if (isFinal) {
      st.finals.push({ text: text ?? '', t });
      st.lastFinalAt = t;
    } else if (text) {
      if (st.partials.length < MAX_PARTIALS) st.partials.push({ text, t });
      else st.partials[st.partials.length - 1] = { text, t };
    }

    if (scripted?.done) return finish('script');
    if (cfg.incoming.doneWhen === 'expression' && cfg.incoming.doneExpression.trim()) {
      if (evalSafe(cfg.incoming.doneExpression, { msg, state: st.state, finals: st.finals.map((f) => f.text), partials: st.partials.map((p) => p.text) })) {
        return finish('expression');
      }
    }
    if (cfg.incoming.doneWhen === 'final_after_audio' && isFinal && st.inputEndAt !== undefined) finish('final');
  }

  // ── Outgoing helpers ─────────────────────────────────────────────────────
  const isOpen = () => ws.readyState === WebSocket.OPEN && !st.doneReason;

  async function sendMessages(list: WsTargetConfig['onOpen']) {
    for (const m of list) {
      if (!isOpen()) return;
      if (m.delayMs) await sleep(m.delayMs);
      const content = await render(m.content, scope, env, m.type === 'json' ? 'json' : 'text');
      if (m.type === 'binary_base64') {
        const bytes = Buffer.from(content.trim(), 'base64');
        ws.send(bytes);
        record('out', 'binary', { size: bytes.byteLength });
      } else {
        if (m.type === 'json' && tryParseJson(content) === undefined) log('warn', `Message is not valid JSON after rendering: ${content.slice(0, 120)}`);
        ws.send(content);
        record('out', m.type, m.type === 'json' ? (tryParseJson(content) ?? content) : content);
      }
    }
  }

  async function sendAudio(overrides: Partial<WsTargetConfig['audio']> = {}) {
    const a = { ...cfg.audio, ...overrides };
    const fileVal = await renderValue(a.source, scope, env);
    if (!isFileValue(fileVal)) throw new Error(`Audio source ${a.source || '(empty)'} did not resolve to an audio file`);
    const bytes = await env.loadFile!(fileVal);

    let data: Buffer;
    let frameBytes: number;
    let durationMs: number;
    let silence: Buffer | undefined;
    if (a.encoding === 'file') {
      data = Buffer.from(bytes);
      let dur: number | undefined;
      try {
        if (isWav(bytes)) dur = audioDuration(decodeWav(bytes));
      } catch {
        dur = undefined;
      }
      if (dur && dur > 0) {
        frameBytes = Math.max(1, Math.round((data.byteLength / dur) * a.frameMs));
        durationMs = dur;
      } else {
        frameBytes = 3200;
        durationMs = (data.byteLength / frameBytes) * a.frameMs;
        log('info', 'Unknown audio duration: sending 3200-byte chunks, one per frame interval');
      }
    } else {
      const prepared = await prepareAudio(bytes, { mime: fileVal.mime, sampleRate: a.sampleRate, channels: a.channels, encoding: a.encoding });
      data = prepared.data;
      durationMs = prepared.durationMs;
      const align = a.channels * bytesPerSample(a.encoding);
      frameBytes = Math.max(align, Math.round((prepared.bytesPerMs * a.frameMs) / align) * align);
      silence = Buffer.alloc(frameBytes, a.encoding === 'mulaw' ? 0xff : a.encoding === 'alaw' ? 0xd5 : 0);
    }

    const frames: Buffer[] = [];
    for (let off = 0; off < data.byteLength; off += frameBytes) frames.push(data.subarray(off, off + frameBytes));
    const silenceFrames = silence ? Math.ceil(a.trailingSilenceMs / a.frameMs) : 0;
    for (let i = 0; i < silenceFrames; i++) frames.push(silence!);
    const textMode = a.sendAs === 'text';
    const jsonTemplate = /^\s*[[{]/.test(a.textTemplate);

    record('out', 'audio_start', { frames: frames.length, bytes: data.byteLength, encoding: a.encoding, sampleRate: a.sampleRate, frameMs: a.frameMs, durationMs: Math.round(durationMs) });
    const start = now();
    const firstAt = rel();
    st.firstAudioAt ??= firstAt;
    for (let i = 0; i < frames.length; i++) {
      if (!isOpen()) break;
      if (a.pacing === 'realtime') {
        const wait = start + (i * a.frameMs) / a.speed - now();
        if (wait > 1) await sleep(wait);
      } else if (ws.bufferedAmount > 1 << 20) {
        await sleep(5);
      } else if (i % 50 === 49) {
        await new Promise((r) => setImmediate(r));
      }
      if (!isOpen()) break;
      const frame = frames[i];
      if (textMode) {
        const vars = { ...scope, chunk_base64: frame.toString('base64'), seq: i, offset_ms: Math.round(i * a.frameMs), is_last: i === frames.length - 1 };
        ws.send(await render(a.textTemplate, vars, env, jsonTemplate ? 'json' : 'text'));
      } else {
        ws.send(frame);
      }
    }
    const lastAt = rel();
    st.lastAudioAt = lastAt;
    const totalMs = durationMs + silenceFrames * a.frameMs;
    st.audioMs += totalMs;
    record('out', 'audio_end', { framesSent: frames.length, durationMs: Math.round(totalMs) });
    return { frames: frames.length, durationMs: totalMs, firstAt, lastAt };
  }

  // ── Drive the session ────────────────────────────────────────────────────
  let sessionOutputs: Record<string, unknown> | undefined;
  try {
    if (sessionMode) {
      sessionOutputs = await runSessionScript();
      finish('script');
    } else {
      await sendMessages(cfg.onOpen);
      if (cfg.waitForOpenAck.trim() && isOpen() && !acked) {
        const ack = new Promise<void>((r) => (ackWaiter = r));
        // Its own timer, cleared afterwards, so a finished call does not keep the process alive.
        const stopWaiting = new AbortController();
        const r = await Promise.race([ack, done.then(() => 'done'), sleep(cfg.connectTimeoutMs, stopWaiting.signal).then(() => 'timeout', () => 'stopped')]).finally(() => stopWaiting.abort());
        if (r === 'timeout') throw new Error(`No message matched waitForOpenAck within ${cfg.connectTimeoutMs} ms`);
      }
      if (cfg.audio.enabled && isOpen()) await sendAudio();
      await sendMessages(cfg.afterAudio);
      st.inputEndAt = rel();
      armIdle();
      // A final that arrived while the closing messages were being sent still counts.
      if (cfg.incoming.doneWhen === 'final_after_audio' && st.lastFinalAt !== undefined && st.lastFinalAt >= (st.lastAudioAt ?? st.inputEndAt)) finish('final');
      await done;
    }
  } catch (e) {
    st.error = (e as Error).message;
    log('error', st.error);
    finish('error');
  } finally {
    clearTimeout(overallTimer);
    clearTimeout(idleTimer);
    ctx.signal.removeEventListener('abort', onAbort);
    await queue.catch(() => undefined);
    closeSocket(ws);
  }

  // ── Results ──────────────────────────────────────────────────────────────
  const end = rel();
  const finalTexts = st.finals.map((f) => f.text).filter((s) => s !== '');
  const partialTexts = st.partials.map((p) => p.text);
  const sep = cfg.incoming.join === 'newline' ? '\n' : cfg.incoming.join === 'concat' ? '' : ' ';
  const joined = cfg.incoming.join === 'last' ? (finalTexts.at(-1) ?? '') : finalTexts.join(sep);
  const audioStart = st.firstAudioAt ?? openAt;
  const inputEnd = st.lastAudioAt ?? st.inputEndAt;

  metrics.latency_ms = Math.round(end);
  metrics.message_count = st.incoming.length;
  metrics.partial_count = st.partials.length;
  metrics.final_count = st.finals.length;
  if (st.firstMessageAt !== undefined) metrics.first_message_ms = Math.round(st.firstMessageAt - openAt);
  if (st.firstTextAt !== undefined) metrics.first_partial_ms = Math.round(st.firstTextAt - audioStart);
  if (st.lastFinalAt !== undefined && inputEnd !== undefined) metrics.final_latency_ms = Math.round(st.lastFinalAt - inputEnd);
  if (st.audioMs > 0) {
    metrics.audio_ms = Math.round(st.audioMs);
    if (st.firstAudioAt !== undefined && st.lastAudioAt !== undefined) metrics.stream_ms = Math.round(st.lastAudioAt - st.firstAudioAt);
    if (st.lastFinalAt !== undefined && st.firstAudioAt !== undefined) metrics.rtf = Number(((st.lastFinalAt - st.firstAudioAt) / st.audioMs).toFixed(3));
  }

  let outputs: Record<string, unknown>;
  if (sessionOutputs) {
    const { metrics: extraMetrics, ...rest } = sessionOutputs as Record<string, any>;
    if (extraMetrics && typeof extraMetrics === 'object') Object.assign(metrics, extraMetrics);
    outputs = rest;
  } else {
    outputs = {
      output: finalTexts.length ? joined : (partialTexts.at(-1) ?? ''),
      finals: finalTexts,
      partials: partialTexts,
    };
    if (cfg.outputs.length) {
      Object.assign(
        outputs,
        applyExtractors(cfg.outputs, { body: st.incoming, text: toText(outputs.output), messages: st.incoming, state: st.state, finals: finalTexts, partials: partialTexts }, log),
      );
    }
  }

  let error: string | undefined;
  let retryable = false;
  if (st.doneReason === 'timeout') {
    error = st.finals.length
      ? `Timed out after ${cfg.timeoutMs} ms (results so far were kept)`
      : `Timed out after ${cfg.timeoutMs} ms without a final result`;
    retryable = true;
  } else if (st.doneReason === 'cancelled') {
    error = 'Cancelled';
  } else if (st.doneReason === 'error') {
    error = st.error;
    retryable = true;
  } else if (st.doneReason === 'close' && cfg.incoming.doneWhen !== 'close' && st.inputEndAt === undefined && !sessionMode) {
    error = `Server closed the connection early (code ${st.closeCode})`;
    retryable = true;
  }

  return {
    ok: true,
    request,
    response: { messages: secrets.maskDeep(messages) as WsLog[] },
    outputs,
    metrics,
    logs,
    error,
    retryable: error ? retryable : false,
  };

  // Full-control mode: the user's script drives the socket.
  async function runSessionScript() {
    const marks: Record<string, number> = {};
    const helpers = {
      ws,
      row: ctx.row,
      vars: ctx.vars,
      state: st.state,
      messages: st.incoming,
      log,
      /** Sends a string, a Buffer, or an object as JSON. */
      send: (data: unknown) => {
        const payload = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
        ws.send(payload as any);
        record('out', Buffer.isBuffer(data) ? 'binary' : 'text', Buffer.isBuffer(data) ? { size: data.byteLength } : data);
      },
      /** Resolves with the next incoming message, or undefined after timeoutMs. */
      nextMessage: (timeoutMs = 10000) =>
        new Promise<unknown>((resolve) => {
          if (inbox.length) return resolve(inbox.shift());
          if (st.doneReason) return resolve(undefined); // closed, timed out or cancelled: nothing more will come
          const timer = setTimeout(() => {
            const i = inboxWaiters.indexOf(waiter);
            if (i >= 0) inboxWaiters.splice(i, 1);
            resolve(undefined);
          }, timeoutMs);
          const waiter = (m: unknown) => {
            clearTimeout(timer);
            resolve(m);
          };
          inboxWaiters.push(waiter);
        }),
      /** Streams the row's audio using the target's audio settings (overridable). */
      sendAudio,
      render: (template: string, extra: Record<string, unknown> = {}) => render(template, { ...scope, ...extra }, env),
      sleep: (ms: number) => sleep(ms),
      /** Milliseconds since the call started. */
      now: () => Math.round(rel()),
      /** Records a timing metric named `name` (ms since start). */
      mark: (name: string) => (marks[name] = Math.round(rel())),
    };
    const result = await runScript(cfg.scripts.session, helpers, {
      log,
      timeoutMs: cfg.timeoutMs,
      requireFrom: ctx.workspaceDir,
      filename: 'session.js',
    });
    const out: Record<string, unknown> =
      result === undefined || result === null ? {} : typeof result === 'object' && !Array.isArray(result) ? { ...(result as object) } : { output: result };
    out.metrics = { ...marks, ...((out.metrics as object) ?? {}) };
    return out;
  }
}

interface Connection {
  ws: WebSocket;
  /** Messages received before the caller attached its own handler. */
  early: [WebSocket.RawData, boolean][];
  stopBuffering: () => void;
}

function connect(url: string, protocols: string[], headers: Record<string, string>, timeoutMs: number, signal: AbortSignal): Promise<Connection> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Cancelled'));
    const ws = new WebSocket(url, protocols.length ? protocols : undefined, { headers, handshakeTimeout: timeoutMs, perMessageDeflate: false });
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      ws.terminate();
      reject(new Error('Cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // A server can send right after the handshake, in the same packet: 'message' then fires before
    // the caller's handler exists, so keep those messages until it takes over.
    const early: Connection['early'] = [];
    const buffer = (data: WebSocket.RawData, isBinary: boolean) => early.push([data, isBinary]);
    ws.on('message', buffer);
    ws.once('open', () => {
      cleanup();
      resolve({ ws, early, stopBuffering: () => ws.off('message', buffer) });
    });
    ws.once('unexpected-response', (req, res) => {
      cleanup();
      let body = '';
      let settled = false;
      // Read a little of the error body for the message, but never wait on it for long.
      const settle = () => {
        if (settled) return;
        settled = true;
        reject(Object.assign(new Error(`Handshake failed: HTTP ${res.statusCode}${body.trim() ? ` – ${body.trim().slice(0, 200)}` : ''}`), { status: res.statusCode }));
        req.destroy();
      };
      res.on('data', (c: Buffer) => (body += c.toString().slice(0, 500)));
      res.on('end', settle);
      res.on('close', settle);
      res.on('error', settle);
      setTimeout(settle, 500).unref();
    });
    // `on`, not `once`: a failed handshake can emit more than one error and an unhandled one would crash.
    ws.on('error', (e) => {
      cleanup();
      reject(e);
    });
  });
}

function closeSocket(ws: WebSocket) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.close(1000, 'done');
    const t = setTimeout(() => ws.terminate(), 1000);
    t.unref();
    ws.once('close', () => clearTimeout(t));
  } else if (ws.readyState === WebSocket.CONNECTING) {
    ws.terminate();
  }
}
