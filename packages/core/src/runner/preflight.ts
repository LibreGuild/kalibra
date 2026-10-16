import { placeholders } from '../template.js';
import type { ConversationSettings, DatasetSchema, TargetSpec } from '../specs.js';

/*
 * Catches the most common setup mistake before a run spends time and money: the target refers to
 * a {{column}} the dataset doesn't have, so every request goes out with an empty value.
 */

/** Names every template can use that are not dataset columns. */
const BUILT_IN = new Set([
  'vars', 'secret', 'row', 'row_id', 'env',
  // conversations
  'message', 'history', 'turn', 'conversation_id', 'session_id',
  // websocket audio frames
  'chunk_base64', 'seq', 'offset_ms', 'is_last',
]);

const SKIP_KEYS = new Set(['scripts', 'code', 'onMessage', 'session', 'beforeRequest', 'afterResponse', 'ignoreWhen', 'isFinal', 'doneWhen', 'doneExpression', 'waitForOpenAck', 'textPath', 'path']);

function collect(value: unknown, out: Set<string>, key = '') {
  if (SKIP_KEYS.has(key)) return;
  if (typeof value === 'string') {
    for (const name of placeholders(value)) out.add(name);
  } else if (Array.isArray(value)) {
    for (const v of value) collect(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collect(v, out, k);
  }
}

export interface PreflightWarning {
  kind: 'missing_column' | 'missing_variable' | 'conversation_column';
  message: string;
  name: string;
}

export function preflight(target: TargetSpec, schema: DatasetSchema, conversation?: ConversationSettings): PreflightWarning[] {
  const columns = new Set(schema.columns.map((c) => c.key));
  const used = new Set<string>();
  collect(target.config, used);
  const warnings: PreflightWarning[] = [];
  for (const name of [...used].sort()) {
    if (name.startsWith('$') || BUILT_IN.has(name) || columns.has(name)) continue;
    warnings.push({
      kind: 'missing_column',
      name,
      message: `The target uses {{${name}}}, but the dataset has no "${name}" column, so it will be empty. Columns: ${[...columns].join(', ') || 'none'}.`,
    });
  }
  // {{vars.x}} must exist on the target.
  const vars = new Set(target.variables.filter((v) => v.enabled).map((v) => v.key));
  const varRefs = new Set<string>();
  const scan = (v: unknown, key = ''): void => {
    if (SKIP_KEYS.has(key)) return;
    if (typeof v === 'string') for (const m of v.matchAll(/\{\{\s*vars\.([A-Za-z_][\w]*)/g)) varRefs.add(m[1]);
    else if (Array.isArray(v)) v.forEach((x) => scan(x));
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => scan(x, k));
  };
  scan(target.config);
  for (const name of [...varRefs].sort()) {
    if (!vars.has(name)) warnings.push({ kind: 'missing_variable', name, message: `The target uses {{vars.${name}}}, but no variable "${name}" is set on it.` });
  }
  if (conversation?.mode === 'scripted' && !columns.has(conversation.turnsColumn)) {
    warnings.push({ kind: 'conversation_column', name: conversation.turnsColumn, message: `Scripted conversations read turns from "${conversation.turnsColumn}", which this dataset doesn't have.` });
  }
  return warnings;
}
