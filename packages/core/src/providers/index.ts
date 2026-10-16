import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { experimental_generateSpeech, experimental_transcribe, generateImage, generateText, jsonSchema, Output, type LanguageModel, type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAzure } from '@ai-sdk/azure';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createVertex } from '@ai-sdk/google-vertex';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { ConnectionSpec } from '../specs.js';
import type { SecretStore } from '../storage.js';
import { invalid } from '../util.js';
import type { LlmClient, LlmRequest, ModelKind } from './types.js';

const run = promisify(execFile);

/*
 * Connections reference credential *sources* instead of copying credentials:
 * an API key secret, an AWS profile / SSO session, gcloud ADC, a service-account file, or the az CLI.
 * Everything resolves at call time, so rotating a key or re-running `aws sso login` just works.
 * One connection can serve text, image, speech and transcription models of the same provider.
 */

export const PROVIDERS = [
  { id: 'openai', label: 'OpenAI', hint: 'GPT text, GPT Image, TTS and transcription models', defaultModel: '', media: ['image', 'speech', 'transcription'] },
  { id: 'anthropic', label: 'Anthropic', hint: 'Claude models', defaultModel: '', media: [] },
  { id: 'google', label: 'Google Gemini API', hint: 'Gemini and Imagen with an AI Studio key', defaultModel: '', media: ['image', 'speech', 'transcription'] },
  { id: 'vertex', label: 'Google Vertex AI', hint: 'Gemini, Imagen and Claude on Google Cloud', defaultModel: '', media: ['image', 'speech', 'transcription'] },
  { id: 'azure', label: 'Azure OpenAI / Foundry', hint: 'Your Azure deployments', defaultModel: '', media: ['image', 'speech', 'transcription'] },
  { id: 'bedrock', label: 'AWS Bedrock', hint: 'Claude, Llama, Nova and more on AWS', defaultModel: '', media: ['image'] },
  { id: 'openai_compatible', label: 'OpenAI-compatible', hint: 'Ollama, vLLM, LM Studio, OpenRouter, xAI, Groq, LiteLLM…', defaultModel: '', media: ['image'] },
] as const;

/** Guesses what a model id is for, so tests and pickers call the right API. */
export function inferModelKind(model: string): ModelKind {
  const m = model.toLowerCase();
  if (/(^|[-_/])(gpt-image|dall-e|imagen|flux|stable-diffusion|sdxl|nova-canvas|titan-image)|image-(generation|preview)|-image$/.test(m)) return 'image';
  if (/transcri|whisper|(^|[-_])stt([-_]|$)|speech-to-text|chirp/.test(m)) return 'transcription';
  if (/(^|[-_])tts([-_]|$)|text-to-speech|-tts-|speech/.test(m)) return 'speech';
  return 'text';
}

type Opt = Record<string, any>;

const azCliTokens = new Map<string, { token: string; expires: number }>();
/** Access token from the Azure CLI (`az login`), cached per scope until shortly before it expires. */
export async function azureCliToken(scope: string): Promise<string> {
  const cached = azCliTokens.get(scope);
  if (cached && cached.expires - Date.now() > 120_000) return cached.token;
  // On Windows `az` is a .cmd script that only runs through a shell, and specs can come from shared
  // bundles, so the scope is limited to URL characters.
  if (!/^[\w.:/~-]+$/.test(scope)) throw invalid(`Invalid Azure token scope "${scope}"`);
  const win = process.platform === 'win32';
  const { stdout } = await run(win ? 'az.cmd' : 'az', ['account', 'get-access-token', '--scope', scope, '-o', 'json'], { shell: win });
  const parsed = JSON.parse(stdout);
  const token = { token: parsed.accessToken as string, expires: Date.parse(parsed.expiresOn ?? parsed.expires_on) || Date.now() + 600_000 };
  azCliTokens.set(scope, token);
  return token.token;
}

/** A named secret's value; a name that is set on the connection but missing in the store is an error, not "no credentials". */
export async function secretValue(secrets: SecretStore, name: string | undefined): Promise<string | undefined> {
  if (!name) return undefined;
  const v = await secrets.get(name);
  if (v === undefined) throw invalid(`Secret "${name}" is not set`);
  return v;
}

const headerRecord = (spec: ConnectionSpec) =>
  Object.fromEntries(spec.headers.filter((h) => h.enabled && h.key).map((h) => [h.key, h.value]));

/** A provider instance with whatever model factories it supports. */
interface ProviderHandle {
  language(model: string): LanguageModel;
  image?(model: string): any;
  speech?(model: string): any;
  transcription?(model: string): any;
}

async function providerFor(spec: ConnectionSpec, secrets: SecretStore, model: string): Promise<ProviderHandle> {
  const o = spec.options as Opt;
  const apiKey = await secretValue(secrets, spec.apiKeySecret);
  const headers = headerRecord(spec);
  const baseURL = spec.baseUrl || undefined;

  switch (spec.provider) {
    case 'openai': {
      const p = createOpenAI({ apiKey, baseURL, headers, organization: o.organization || undefined, project: o.project || undefined });
      return { language: (m) => p(m), image: (m) => p.image(m), speech: (m) => p.speech(m), transcription: (m) => p.transcription(m) };
    }
    case 'anthropic': {
      const p = createAnthropic({ apiKey, baseURL, headers });
      return { language: (m) => p(m) };
    }
    case 'google': {
      const p = createGoogleGenerativeAI({ apiKey, baseURL, headers });
      return { language: (m) => p(m), image: (m) => p.image(m), speech: (m) => p.speech(m), transcription: (m) => p.transcription(m) };
    }
    case 'openai_compatible': {
      if (!baseURL) throw invalid('Base URL is required for OpenAI-compatible connections');
      const p = createOpenAICompatible({ name: o.name || 'custom', baseURL, apiKey, headers });
      return { language: (m) => p.chatModel(m), image: (m) => p.imageModel(m) };
    }
    case 'azure': {
      const useCli = o.authMode === 'az_cli';
      const p = createAzure({
        resourceName: o.resourceName || undefined,
        baseURL,
        apiKey: useCli ? undefined : apiKey,
        tokenProvider: useCli ? () => azureCliToken(o.tokenScope || 'https://cognitiveservices.azure.com/.default') : undefined,
        apiVersion: o.apiVersion || undefined,
        useDeploymentBasedUrls: !!o.useDeploymentBasedUrls,
        headers,
      });
      return { language: (m) => p(m), image: (m) => p.image(m), speech: (m) => (p as any).speech?.(m), transcription: (m) => (p as any).transcription?.(m) };
    }
    case 'bedrock': {
      const region = o.region || 'us-east-1';
      const p =
        o.authMode === 'api_key'
          ? createAmazonBedrock({ region, apiKey, headers })
          : o.authMode === 'access_keys'
            ? createAmazonBedrock({
                region,
                accessKeyId: await secretValue(secrets, o.accessKeyIdSecret),
                secretAccessKey: await secretValue(secrets, o.secretAccessKeySecret),
                sessionToken: await secretValue(secrets, o.sessionTokenSecret),
                headers,
              })
            : // Default: the standard AWS chain (env, ~/.aws profiles incl. SSO, credential_process, ...).
              createAmazonBedrock({ region, credentialProvider: fromNodeProviderChain(o.profile ? { profile: o.profile } : {}), headers });
      return { language: (m) => p(m), image: (m) => p.image(m) };
    }
    case 'vertex': {
      const common = { project: o.project || undefined, location: o.location || 'us-central1', headers };
      const googleAuthOptions = o.keyFile ? { keyFilename: o.keyFile } : undefined;
      if (/^claude/.test(model)) {
        const a = createVertexAnthropic({ ...common, googleAuthOptions });
        return { language: (m) => a(m) };
      }
      const p = o.authMode === 'express' ? createVertex({ apiKey, headers }) : createVertex({ ...common, googleAuthOptions });
      return { language: (m) => p(m), image: (m) => p.image(m), speech: (m) => p.speech(m), transcription: (m) => p.transcription(m) };
    }
  }
}

export async function resolveModel(spec: ConnectionSpec, model: string, secrets: SecretStore): Promise<LanguageModel> {
  if (!model) throw invalid('No model selected for this connection');
  return (await providerFor(spec, secrets, model)).language(model);
}

/**
 * OpenAI-style strict structured outputs need every property listed in `required` and
 * `additionalProperties: false`. Optional properties become nullable instead. Other providers
 * accept the stricter schema too, so it is applied everywhere.
 */
export function strictSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(strictSchema);
  const out: any = { ...schema };
  const isObject = out.type === 'object' || (Array.isArray(out.type) && out.type.includes('object'));
  if (isObject && out.properties) {
    const required = new Set<string>(out.required ?? []);
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([k, v]: [string, any]) => {
        const s = strictSchema(v);
        if (required.has(k)) return [k, s];
        const t = s.type;
        return [k, t && !Array.isArray(t) ? { ...s, type: [t, 'null'] } : s.anyOf ? s : { anyOf: [s, { type: 'null' }] }];
      }),
    );
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  if (out.items) out.items = strictSchema(out.items);
  if (out.anyOf) out.anyOf = out.anyOf.map(strictSchema);
  return out;
}

const dropNulls = (v: any): any =>
  Array.isArray(v) ? v.map(dropNulls) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)])) : v;

function promptOrMessages(req: LlmRequest): { prompt: string } | { messages: ModelMessage[] } {
  if (!req.files?.length && !req.messages?.length) return { prompt: req.prompt };
  const history: ModelMessage[] = (req.messages ?? [])
    // System text goes through the separate `system` option; only user/assistant turns are replayed.
    .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: m.content }) as ModelMessage);
  const current: ModelMessage = req.files?.length
    ? {
        role: 'user',
        content: [
          { type: 'text', text: req.prompt },
          ...req.files.map((f) => ({ type: 'file' as const, data: f.data, mediaType: f.mime })),
        ],
      }
    : { role: 'user', content: req.prompt };
  return { messages: [...history, current] };
}

export function createLlmClient(getConnection: (id: string) => ConnectionSpec, secrets: SecretStore): LlmClient {
  async function prepare(connectionId: string, model: string | undefined, kind: ModelKind) {
    const spec = getConnection(connectionId);
    const modelId =
      model ||
      (kind === 'image' ? spec.imageModel : kind === 'speech' ? spec.speechModel : kind === 'transcription' ? spec.transcriptionModel : '') ||
      (inferModelKind(spec.defaultModel) === kind ? spec.defaultModel : '');
    if (!modelId) throw invalid(`This connection has no ${kind === 'text' ? '' : `${kind} `}model set. Pick one in the connection or the step that uses it.`);
    const provider = await providerFor(spec, secrets, modelId);
    return { spec, provider, modelId };
  }

  const unsupported = (kind: string, provider: string) => invalid(`${provider} connections do not support ${kind} models in Kalibra yet`);

  return {
    async text(req) {
      const { provider, modelId } = await prepare(req.connectionId, req.model, 'text');
      const started = Date.now();
      const res = await generateText({
        model: provider.language(modelId),
        system: req.system || undefined,
        ...promptOrMessages(req),
        temperature: req.temperature,
        maxOutputTokens: req.maxOutputTokens,
        abortSignal: req.signal,
      });
      return { text: res.text, latencyMs: Date.now() - started, model: modelId, inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens };
    },

    async json(req) {
      const { provider, modelId } = await prepare(req.connectionId, req.model, 'text');
      const started = Date.now();
      const res = await generateText({
        model: provider.language(modelId),
        system: req.system || undefined,
        ...promptOrMessages(req),
        temperature: req.temperature,
        maxOutputTokens: req.maxOutputTokens,
        abortSignal: req.signal,
        output: Output.object({ schema: jsonSchema(strictSchema(req.schema)), name: req.schemaName }),
      });
      return { value: dropNulls(res.output), latencyMs: Date.now() - started, model: modelId, inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens };
    },

    async image(req) {
      const { spec, provider, modelId } = await prepare(req.connectionId, req.model, 'image');
      if (!provider.image) throw unsupported('image', spec.provider);
      const started = Date.now();
      const providerKey = spec.provider === 'openai_compatible' ? (spec.options as Opt).name || 'custom' : spec.provider === 'vertex' ? 'vertex' : spec.provider;
      const res = await generateImage({
        model: provider.image(modelId),
        prompt: req.images?.length ? { text: req.prompt, images: req.images.map((i) => i.data) } : req.prompt,
        n: req.n ?? 1,
        size: (req.size || undefined) as any,
        aspectRatio: (req.aspectRatio || undefined) as any,
        seed: req.seed,
        providerOptions: req.options && Object.keys(req.options).length ? { [providerKey]: req.options as any } : undefined,
        abortSignal: req.signal,
      });
      return { images: res.images.map((i) => ({ data: i.uint8Array, mime: i.mediaType || 'image/png' })), latencyMs: Date.now() - started, model: modelId };
    },

    async speech(req) {
      const { spec, provider, modelId } = await prepare(req.connectionId, req.model, 'speech');
      const m = provider.speech?.(modelId);
      if (!m) throw unsupported('text-to-speech', spec.provider);
      const started = Date.now();
      const res = await experimental_generateSpeech({
        model: m,
        text: req.text,
        voice: req.voice || undefined,
        instructions: req.instructions || undefined,
        speed: req.speed,
        language: req.language || undefined,
        outputFormat: req.format || 'wav',
        providerOptions: req.options && Object.keys(req.options).length ? { [spec.provider]: req.options as any } : undefined,
        abortSignal: req.signal,
      });
      return { audio: { data: res.audio.uint8Array, mime: res.audio.mediaType || 'audio/wav' }, latencyMs: Date.now() - started, model: modelId };
    },

    async transcribe(req) {
      const { spec, provider, modelId } = await prepare(req.connectionId, req.model, 'transcription');
      const m = provider.transcription?.(modelId);
      if (!m) throw unsupported('transcription', spec.provider);
      const started = Date.now();
      const res = await experimental_transcribe({
        model: m,
        audio: req.audio.data,
        providerOptions: req.options && Object.keys(req.options).length ? { [spec.provider]: req.options as any } : undefined,
        abortSignal: req.signal,
      });
      return {
        text: res.text,
        segments: res.segments?.map((s) => ({ text: s.text, startSecond: s.startSecond, endSecond: s.endSecond })),
        language: res.language,
        durationSeconds: res.durationInSeconds,
        latencyMs: Date.now() - started,
        model: modelId,
      };
    },
  };
}

/** Lists models when the provider exposes an OpenAI-style /models endpoint. */
export async function listModels(spec: ConnectionSpec, secrets: SecretStore): Promise<string[]> {
  const apiKey = spec.apiKeySecret ? await secrets.get(spec.apiKeySecret) : undefined;
  const base =
    spec.provider === 'openai' ? spec.baseUrl || 'https://api.openai.com/v1'
    : spec.provider === 'openai_compatible' ? spec.baseUrl
    : spec.provider === 'anthropic' ? spec.baseUrl || 'https://api.anthropic.com/v1'
    : spec.provider === 'google' ? spec.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai'
    : '';
  if (!base) return spec.models;
  const headers: Record<string, string> = { ...headerRecord(spec) };
  if (apiKey) {
    if (spec.provider === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else headers.authorization = `Bearer ${apiKey}`;
  }
  const res = await fetch(`${base.replace(/\/$/, '')}/models`, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Listing models failed: HTTP ${res.status}`);
  const body: any = await res.json();
  return (body.data ?? body.models ?? []).map((m: any) => String(m.id ?? m.name).replace(/^models\//, '')).filter(Boolean).sort();
}
