import { z } from 'zod';
import type { CheckType } from './types.js';
import { latencyCheck, noErrorCheck, statusCheck } from './transport.js';
import { isJsonCheck, jsonPathCheck, jsonSchemaCheck } from './structure.js';
import { containsCheck, equalsCheck, numericCheck, regexCheck, similarityCheck } from './content.js';
import { bleuCheck, chrfCheck, keywordRecallCheck, rougeLCheck, tokenF1Check, werCheck } from './reference.js';
import { expressionCheck, llmJudgeCheck, scriptCheck } from './judgment.js';

export * from './types.js';
export { statusMatches } from './transport.js';
export { DEFAULT_JUDGE_CRITERIA, DEFAULT_JUDGE_PROMPT } from './judgment.js';

/** Every built-in check type, in layer order. */
export const CHECK_TYPES: CheckType[] = [
  statusCheck,
  latencyCheck,
  noErrorCheck,
  isJsonCheck,
  jsonSchemaCheck,
  jsonPathCheck,
  equalsCheck,
  containsCheck,
  regexCheck,
  numericCheck,
  similarityCheck,
  werCheck,
  keywordRecallCheck,
  bleuCheck,
  rougeLCheck,
  chrfCheck,
  tokenF1Check,
  llmJudgeCheck,
  scriptCheck,
  expressionCheck,
];

const byType = new Map(CHECK_TYPES.map((c) => [c.type, c]));

export function getCheckType(type: string): CheckType | undefined {
  return byType.get(type);
}

/** Serializable catalog for the UI, API and MCP: metadata, form fields, defaults and JSON Schema of the config. */
export function describeCheckTypes() {
  return CHECK_TYPES.map((c) => ({
    type: c.type,
    label: c.label,
    category: c.category,
    layer: c.layer,
    description: c.description,
    fields: c.fields,
    defaults: c.config.parse({}),
    configSchema: z.toJSONSchema(c.config, { io: 'input', unrepresentable: 'any' }),
  }));
}
