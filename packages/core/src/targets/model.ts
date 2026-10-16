import { render, renderValue } from '../template.js';
import type { ModelTargetConfig, TargetSpec } from '../specs.js';
import type { TargetCallContext, TargetCallResult } from './types.js';
import type { ChatMessage } from '../providers/types.js';
import { failure, isFileValue, makeLogger, now, requestScope } from './common.js';

/*
 * Model target: test a model connection directly. Tasks:
 *   text          – prompt → text
 *   image         – prompt → generated image (stored as a file output)
 *   speech        – prompt (text to speak) → audio file output
 *   transcription – audio column → text, e.g. to compare a provider's STT with your own service
 */
export async function executeModel(spec: TargetSpec, ctx: TargetCallContext): Promise<TargetCallResult> {
  const cfg = spec.config as ModelTargetConfig;
  const task = cfg.task ?? 'text';
  const { logs, log } = makeLogger(ctx);
  if (!cfg.connectionId) return failure('Choose a connection for this model target', logs);
  const scope = requestScope(ctx);
  const started = now();
  const base = { connectionId: cfg.connectionId, model: cfg.model || undefined, signal: ctx.signal };
  try {
    if (task === 'image') {
      const prompt = await render(cfg.prompt, scope, ctx.env);
      const res = await ctx.llm.image({
        ...base,
        prompt,
        size: cfg.size || undefined,
        aspectRatio: cfg.aspectRatio || undefined,
        options: cfg.quality ? { quality: cfg.quality } : undefined,
      });
      if (!res.images.length) throw new Error('The model returned no image');
      const img = res.images[0];
      const info = await ctx.blobs.put(Buffer.from(img.data), { mime: img.mime, name: `${ctx.rowId}.${img.mime.split('/')[1] ?? 'png'}` });
      const file = { blob: info.hash, name: info.name, mime: info.mime, size: info.size };
      const metrics = { latency_ms: Math.round(now() - started) };
      log('info', `Image from ${res.model} in ${metrics.latency_ms} ms`);
      return { ok: true, request: { task, connectionId: cfg.connectionId, model: res.model, prompt, size: cfg.size, quality: cfg.quality }, response: { body: { image: file } }, outputs: { output: file, prompt }, metrics, logs };
    }

    if (task === 'speech') {
      const text = await render(cfg.prompt, scope, ctx.env);
      const instructions = cfg.instructions ? await render(cfg.instructions, scope, ctx.env) : undefined;
      const res = await ctx.llm.speech({ ...base, text, voice: cfg.voice || undefined, instructions, format: 'wav' });
      const info = await ctx.blobs.put(Buffer.from(res.audio.data), { mime: res.audio.mime, name: `${ctx.rowId}.${res.audio.mime.includes('mpeg') ? 'mp3' : 'wav'}` });
      const file = { blob: info.hash, name: info.name, mime: info.mime, size: info.size };
      const metrics = { latency_ms: Math.round(now() - started) };
      log('info', `Speech from ${res.model} in ${metrics.latency_ms} ms`);
      return { ok: true, request: { task, connectionId: cfg.connectionId, model: res.model, text, voice: cfg.voice, instructions }, response: { body: { audio: file } }, outputs: { output: file, text }, metrics, logs };
    }

    if (task === 'transcription') {
      const audio = await renderValue(cfg.audio || '{{audio}}', scope, ctx.env);
      if (!isFileValue(audio)) return failure(`"${cfg.audio}" did not resolve to an audio file`, logs, { metrics: { latency_ms: 0 } });
      const bytes = await ctx.blobs.get(audio.blob);
      const mime = audio.mime || ctx.blobs.info(audio.blob)?.mime || 'audio/wav';
      const res = await ctx.llm.transcribe({ ...base, audio: { data: bytes, mime } });
      const metrics: Record<string, number> = { latency_ms: Math.round(now() - started) };
      if (res.durationSeconds) {
        metrics.audio_ms = Math.round(res.durationSeconds * 1000);
        metrics.rtf = Math.round((metrics.latency_ms / metrics.audio_ms) * 1000) / 1000;
      }
      log('info', `Transcribed by ${res.model} in ${metrics.latency_ms} ms`);
      return {
        ok: true,
        request: { task, connectionId: cfg.connectionId, model: res.model, audio: { name: audio.name, mime, size: bytes.byteLength } },
        response: { body: { text: res.text, segments: res.segments, language: res.language }, text: res.text },
        outputs: { output: res.text, segments: res.segments, language: res.language },
        metrics,
        logs,
      };
    }

    const system = cfg.system ? await render(cfg.system, scope, ctx.env) : undefined;
    // In a conversation run the row carries `history` and the current `message`. Earlier turns are
    // replayed as chat messages; the prompt template is used for the new turn only when it refers
    // to {{message}}, otherwise the user's message is sent as is.
    const history = conversationHistory(ctx.row);
    const prompt =
      history && typeof ctx.row.message === 'string' && !/\{\{\s*message\b/.test(cfg.prompt)
        ? (ctx.row.message as string)
        : await render(cfg.prompt, scope, ctx.env);
    const res = await ctx.llm.text({ ...base, system, prompt, messages: history, temperature: cfg.temperature, maxOutputTokens: cfg.maxOutputTokens });
    const metrics: Record<string, number> = { latency_ms: Math.round(now() - started) };
    if (res.inputTokens !== undefined) metrics.input_tokens = res.inputTokens;
    if (res.outputTokens !== undefined) metrics.output_tokens = res.outputTokens;
    log('info', `Model ${res.model} answered in ${metrics.latency_ms} ms`);
    return {
      ok: true,
      request: { connectionId: cfg.connectionId, model: res.model, system, prompt, ...(history ? { history: history.length } : {}) },
      response: { text: res.text },
      outputs: { output: res.text },
      metrics,
      logs,
    };
  } catch (e) {
    const message = (e as Error).message;
    const status = (e as any).statusCode ?? (e as any).status;
    return failure(message, logs, {
      metrics: { latency_ms: Math.round(now() - started) },
      retryable: status ? status === 429 || status >= 500 : !ctx.signal.aborted,
    });
  }
}

function conversationHistory(row: Record<string, unknown>): ChatMessage[] | undefined {
  const h = row.history;
  if (!Array.isArray(h)) return undefined;
  return h
    .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && m.content != null)
    .map((m: any) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
}
