import { z } from 'zod';
import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';
import { JSONPath } from 'jsonpath-plus';
import { toText } from '../template.js';
import {
  ACTUAL_FIELD, actualSchema, asJson, deepEqual, defineCheck, errorOutcome, fail, pass, toNumber, value, verdict,
} from './common.js';

/* Layers 1–2: is the response the right shape, and do specific fields hold the right values? */

export const isJsonCheck = defineCheck({
  type: 'is_json',
  label: 'Is JSON',
  category: 'structure',
  layer: 1,
  description: 'Passes when the value is valid JSON.',
  config: z.object({ actual: actualSchema }),
  fields: [ACTUAL_FIELD],
  async run(cfg, ctx) {
    const parsed = asJson(await value(cfg.actual, ctx));
    return parsed.ok ? pass({ reason: 'Valid JSON' }) : fail({ reason: parsed.error });
  },
});

// ajv/ajv-formats are CommonJS; depending on the loader the class sits on `.default` or is the module itself.
const Ajv = ((AjvModule as any).default ?? AjvModule) as typeof AjvModule;
const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as typeof addFormatsModule;
type Validator = ReturnType<InstanceType<typeof Ajv>['compile']>;
const validators = new Map<string, Validator>();

/** One Ajv per schema: a shared instance remembers every $id, so an edited schema keeping its $id would no longer compile. */
function compileSchema(schema: object): Validator {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

export const jsonSchemaCheck = defineCheck({
  type: 'json_schema',
  label: 'JSON Schema',
  category: 'structure',
  layer: 1,
  description: 'Validates the value against a JSON Schema: required fields, types, formats, enums.',
  config: z.object({
    actual: actualSchema,
    schema: z.union([z.string(), z.record(z.string(), z.unknown())]).default('{\n  "type": "object"\n}'),
  }),
  fields: [
    ACTUAL_FIELD,
    {
      key: 'schema',
      label: 'JSON Schema',
      kind: 'json',
      default: '{\n  "type": "object"\n}',
      help: 'Describes the expected shape, e.g. {"type":"object","required":["answer"]}. Any JSON Schema draft-07/2019 keyword works.',
    },
  ],
  async run(cfg, ctx) {
    const schemaText = typeof cfg.schema === 'string' ? cfg.schema : JSON.stringify(cfg.schema);
    let validate = validators.get(schemaText);
    if (!validate) {
      try {
        validate = compileSchema(typeof cfg.schema === 'string' ? JSON.parse(cfg.schema) : cfg.schema);
      } catch (e) {
        return errorOutcome(`Invalid schema: ${(e as Error).message}`);
      }
      validators.set(schemaText, validate);
    }
    const parsed = asJson(await value(cfg.actual, ctx));
    if (!parsed.ok) return fail({ reason: parsed.error });
    if (validate(parsed.value)) return pass({ reason: 'Matches schema' });
    const errors = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
    return fail({ reason: errors.slice(0, 3).join('; '), details: { errors } });
  },
});

const OPERATORS = [
  'exists', 'not_exists', 'equals', 'not_equals', 'contains', 'matches',
  'gt', 'gte', 'lt', 'lte', 'length_eq', 'length_gte', 'length_lte', 'type_is',
] as const;

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function lengthOf(v: unknown): number | undefined {
  if (typeof v === 'string' || Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return undefined;
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (deepEqual(a, b)) return true;
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== undefined && nb !== undefined && typeof a !== 'boolean' && typeof b !== 'boolean') return na === nb;
  if (typeof a === 'object' || typeof b === 'object') return false;
  return toText(a) === toText(b);
}

/** Applies one operator to one matched value. */
function compare(op: (typeof OPERATORS)[number], actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'equals':
      return looseEqual(actual, expected);
    case 'not_equals':
      return !looseEqual(actual, expected);
    case 'contains':
      if (Array.isArray(actual)) return actual.some((x) => looseEqual(x, expected));
      return toText(actual).includes(toText(expected));
    case 'matches':
      return new RegExp(toText(expected)).test(toText(actual));
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toNumber(actual);
      const b = toNumber(expected);
      if (a === undefined || b === undefined) return false;
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
    }
    case 'length_eq':
    case 'length_gte':
    case 'length_lte': {
      const len = lengthOf(actual);
      const b = toNumber(expected);
      if (len === undefined || b === undefined) return false;
      return op === 'length_eq' ? len === b : op === 'length_gte' ? len >= b : len <= b;
    }
    case 'type_is': {
      const want = toText(expected).toLowerCase();
      const t = typeOf(actual);
      return t === want || (want === 'number' && t === 'integer');
    }
    default:
      return false;
  }
}

export const jsonPathCheck = defineCheck({
  type: 'jsonpath',
  label: 'JSON field',
  category: 'fields',
  layer: 2,
  description: 'Selects a field with JSONPath and checks it: exists, equals, greater than, length, type, …',
  config: z.object({
    actual: actualSchema,
    path: z.string().default('$'),
    operator: z.enum(OPERATORS).default('exists'),
    value: z.string().default(''),
    quantifier: z.enum(['first', 'all', 'any']).default('first'),
  }),
  fields: [
    ACTUAL_FIELD,
    { key: 'path', label: 'JSONPath', kind: 'text', default: '$', placeholder: '$.sources[0].id', help: 'Where the field is in the JSON, e.g. $.answer or $.items[*].price. $ is the whole value.' },
    {
      key: 'operator',
      label: 'Condition',
      kind: 'select',
      default: 'exists',
      options: [
        { value: 'exists', label: 'exists' },
        { value: 'not_exists', label: 'does not exist' },
        { value: 'equals', label: 'equals' },
        { value: 'not_equals', label: 'does not equal' },
        { value: 'contains', label: 'contains' },
        { value: 'matches', label: 'matches regex' },
        { value: 'gt', label: '>' },
        { value: 'gte', label: '≥' },
        { value: 'lt', label: '<' },
        { value: 'lte', label: '≤' },
        { value: 'length_eq', label: 'length =' },
        { value: 'length_gte', label: 'length ≥' },
        { value: 'length_lte', label: 'length ≤' },
        { value: 'type_is', label: 'type is' },
      ],
      help: 'How the selected field is compared. Numbers are compared as numbers.',
    },
    { key: 'value', label: 'Compare with', kind: 'template', default: '', help: 'The value to compare against. Can use row columns, e.g. {{expected_id}}. For "type is": string, number, integer, boolean, object, array or null.' },
    {
      key: 'quantifier',
      label: 'When the path matches several values',
      kind: 'select',
      default: 'first',
      options: [
        { value: 'first', label: 'check the first' },
        { value: 'all', label: 'all must pass' },
        { value: 'any', label: 'any may pass' },
      ],
      help: 'Paths with [*] or .. can match many values. Choose whether one or all of them must satisfy the condition.',
    },
  ],
  async run(cfg, ctx) {
    const parsed = asJson(await value(cfg.actual, ctx));
    if (!parsed.ok) return fail({ reason: parsed.error });
    let matches: unknown[];
    try {
      const json = parsed.value as any;
      matches = typeof json === 'object' && json !== null ? (JSONPath({ path: cfg.path, json, wrap: true }) as unknown[]) : cfg.path === '$' ? [json] : [];
    } catch (e) {
      return errorOutcome(`Invalid JSONPath: ${(e as Error).message}`);
    }
    if (cfg.operator === 'exists') return verdict(matches.length > 0, { reason: matches.length ? `${cfg.path} found` : `${cfg.path} not found` });
    if (cfg.operator === 'not_exists') return verdict(matches.length === 0, { reason: matches.length ? `${cfg.path} exists` : `${cfg.path} absent` });
    if (matches.length === 0) return fail({ reason: `${cfg.path} not found` });
    const expected = await value(cfg.value, ctx);
    let regexError: string | undefined;
    const test = (m: unknown) => {
      try {
        return compare(cfg.operator, m, expected);
      } catch (e) {
        regexError = (e as Error).message;
        return false;
      }
    };
    const selected = cfg.quantifier === 'first' ? [matches[0]] : matches;
    const ok = cfg.quantifier === 'any' ? selected.some(test) : selected.every(test);
    if (regexError) return errorOutcome(regexError);
    const shown = selected.length === 1 ? toText(selected[0]) : `${selected.length} values`;
    const n = toNumber(selected[0]);
    return verdict(ok, {
      value: selected.length === 1 && n !== undefined && typeof selected[0] !== 'boolean' ? n : undefined,
      reason: `${cfg.path} = ${shown.slice(0, 120)}${ok ? '' : ` (${cfg.operator} ${toText(expected).slice(0, 80)} failed)`}`,
      details: { matches: matches.slice(0, 50) },
    });
  },
});
