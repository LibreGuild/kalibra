import { render } from '../template.js';
import type { ModelTargetConfig, TargetSpec } from '../specs.js';
import type { TargetCallContext, TargetCallResult } from './types.js';
import { failure, makeLogger, now, requestScope } from './common.js';

/** Model target: test a prompt directly against a configured model connection. */
export async function executeModel(spec: TargetSpec, ctx: TargetCallContext): Promise<TargetCallResult> {
  const cfg = spec.config as ModelTargetConfig;
  const { logs, log } = makeLogger(ctx);
  if (!cfg.connectionId) return failure('Choose a connection for this model target', logs);
  const scope = requestScope(ctx);
  const started = now();
  try {
    const system = cfg.system ? await render(cfg.system, scope, ctx.env) : undefined;
    const prompt = await render(cfg.prompt, scope, ctx.env);
    const res = await ctx.llm.text({
      connectionId: cfg.connectionId,
      model: cfg.model || undefined,
      system,
      prompt,
      temperature: cfg.temperature,
      maxOutputTokens: cfg.maxOutputTokens,
      signal: ctx.signal,
    });
    const metrics: Record<string, number> = { latency_ms: Math.round(now() - started) };
    if (res.inputTokens !== undefined) metrics.input_tokens = res.inputTokens;
    if (res.outputTokens !== undefined) metrics.output_tokens = res.outputTokens;
    log('info', `Model ${res.model} answered in ${metrics.latency_ms} ms`);
    return {
      ok: true,
      request: { connectionId: cfg.connectionId, model: res.model, system, prompt },
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
