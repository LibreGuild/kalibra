import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateText, jsonSchema, Output, type LanguageModel } from 'ai';
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
import type { LlmClient, LlmRequest } from './types.js';

const run = promisify(execFile);

/*
 * Connections reference credential *sources* instead of copying credentials:
 * an API key secret, an AWS profile / SSO session, gcloud ADC, a service-account file, or the az CLI.
 * Everything resolves at call time, so rotating a key or re-running `aws sso login` just works.
 */

export const PROVIDERS = [
  { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5-mini' },
  { id: 'anthropic', label: 'Anthropic', defaultModel: 'claude-sonnet-5-5' },
  { id: 'google', label: 'Google Gemini API', defaultModel: 'gemini-2.5-flash' },
  { id: 'openai_compatible', label: 'OpenAI-compatible (Ollama, vLLM, LM Studio, OpenRouter, xAI, Groq, LiteLLM, ...)', defaultModel: '' },
  { id: 'azure', label: 'Azure OpenAI / Microsoft Foundry', defaultModel: '' },
  { id: 'bedrock', label: 'AWS Bedrock', defaultModel: '' },
  { id: 'vertex', label: 'Google Vertex AI', defaultModel: 'gemini-2.5-flash' },
] as const;

type Opt = Record<string, any>;

let azCliToken: { token: string; expires: number } | undefined;
async function azureCliToken(scope: string): Promise<string> {
  if (azCliToken && azCliToken.expires - Date.now() > 120_000) return azCliToken.token;
  const { stdout } = await run('az', ['account', 'get-access-token', '--scope', scope, '-o', 'json']);
  const parsed = JSON.parse(stdout);
  azCliToken = { token: parsed.accessToken, expires: Date.parse(parsed.expiresOn ?? parsed.expires_on) || Date.now() + 600_000 };
  return azCliToken.token;
}

const headerRecord = (spec: ConnectionSpec) =>
  Object.fromEntries(spec.headers.filter((h) => h.enabled && h.key).map((h) => [h.key, h.value]));

export async function resolveModel(spec: ConnectionSpec, model: string, secrets: SecretStore): Promise<LanguageModel> {
  const o = spec.options as Opt;
  const apiKey = spec.apiKeySecret ? await secrets.get(spec.apiKeySecret) : undefined;
  if (spec.apiKeySecret && apiKey === undefined) throw invalid(`Secret "${spec.apiKeySecret}" is not set`);
  const headers = headerRecord(spec);
  const baseURL = spec.baseUrl || undefined;
  if (!model) throw invalid('No model selected for this connection');

  switch (spec.provider) {
    case 'openai':
      return createOpenAI({ apiKey, baseURL, headers, organization: o.organization || undefined, project: o.project || undefined })(model);
    case 'anthropic':
      return createAnthropic({ apiKey, baseURL, headers })(model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey, baseURL, headers })(model);
    case 'openai_compatible':
      if (!baseURL) throw invalid('Base URL is required for OpenAI-compatible connections');
      return createOpenAICompatible({ name: o.name || 'custom', baseURL, apiKey, headers }).chatModel(model);
    case 'azure': {
      const useCli = o.authMode === 'az_cli';
      return createAzure({
        resourceName: o.resourceName || undefined,
        baseURL,
        apiKey: useCli ? undefined : apiKey,
        tokenProvider: useCli ? () => azureCliToken(o.tokenScope || 'https://cognitiveservices.azure.com/.default') : undefined,
        apiVersion: o.apiVersion || undefined,
        useDeploymentBasedUrls: !!o.useDeploymentBasedUrls,
        headers,
      })(model);
    }
    case 'bedrock': {
      const region = o.region || 'us-east-1';
      if (o.authMode === 'api_key') return createAmazonBedrock({ region, apiKey, headers })(model);
      if (o.authMode === 'access_keys') {
        return createAmazonBedrock({
          region,
          accessKeyId: o.accessKeyIdSecret ? await secrets.get(o.accessKeyIdSecret) : undefined,
          secretAccessKey: o.secretAccessKeySecret ? await secrets.get(o.secretAccessKeySecret) : undefined,
          sessionToken: o.sessionTokenSecret ? await secrets.get(o.sessionTokenSecret) : undefined,
          headers,
        })(model);
      }
      // Default: the standard AWS chain (env, ~/.aws profiles incl. SSO, credential_process, ...).
      return createAmazonBedrock({ region, credentialProvider: fromNodeProviderChain(o.profile ? { profile: o.profile } : {}), headers })(model);
    }
    case 'vertex': {
      const common = { project: o.project || undefined, location: o.location || 'us-central1', headers };
      const googleAuthOptions = o.keyFile ? { keyFilename: o.keyFile } : undefined;
      if (/^claude/.test(model)) return createVertexAnthropic({ ...common, googleAuthOptions })(model);
      if (o.authMode === 'express') return createVertex({ apiKey, headers })(model);
      return createVertex({ ...common, googleAuthOptions })(model);
    }
  }
}

export function createLlmClient(
  getConnection: (id: string) => ConnectionSpec,
  secrets: SecretStore,
): LlmClient {
  async function prepare(req: LlmRequest) {
    const spec = getConnection(req.connectionId);
    const modelId = req.model || spec.defaultModel;
    return { model: await resolveModel(spec, modelId, secrets), modelId };
  }

  return {
    async text(req) {
      const { model, modelId } = await prepare(req);
      const started = Date.now();
      const res = await generateText({
        model,
        system: req.system || undefined,
        prompt: req.prompt,
        temperature: req.temperature,
        maxOutputTokens: req.maxOutputTokens,
        abortSignal: req.signal,
      });
      return {
        text: res.text,
        latencyMs: Date.now() - started,
        model: modelId,
        inputTokens: res.usage?.inputTokens,
        outputTokens: res.usage?.outputTokens,
      };
    },
    async json(req) {
      const { model, modelId } = await prepare(req);
      const started = Date.now();
      const res = await generateText({
        model,
        system: req.system || undefined,
        prompt: req.prompt,
        temperature: req.temperature,
        maxOutputTokens: req.maxOutputTokens,
        abortSignal: req.signal,
        output: Output.object({ schema: jsonSchema(req.schema as any), name: req.schemaName }),
      });
      return {
        value: res.output as any,
        latencyMs: Date.now() - started,
        model: modelId,
        inputTokens: res.usage?.inputTokens,
        outputTokens: res.usage?.outputTokens,
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
  return (body.data ?? body.models ?? []).map((m: any) => m.id ?? m.name).filter(Boolean).sort();
}
