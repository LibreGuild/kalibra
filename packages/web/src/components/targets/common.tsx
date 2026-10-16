import { useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Braces, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useOp } from '../../lib/api';
import { Button } from '../ui/button';
import { CodeEditor } from '../ui/code';
import { CopyButton } from '../ui/display';
import { Field, Input, Select } from '../ui/form';
import { HelpTip, Popover } from '../ui/overlay';
import type { Auth, Extractor, WsMessage } from './model';

/** A titled card; collapsible sections start closed and show a summary instead. */
export function Section({
  title,
  help,
  children,
  collapsible,
  defaultOpen = true,
  summary,
  action,
}: {
  title: ReactNode;
  help?: ReactNode;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  summary?: ReactNode;
  action?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shown = !collapsible || open;
  return (
    <section className="rounded-xl border border-line bg-surface">
      <div className={clsx('flex items-center justify-between gap-3 px-5', shown ? 'pt-4 pb-3' : 'py-3.5')}>
        <div className="flex min-w-0 items-center gap-1.5">
          {collapsible ? (
            <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-[0.84375rem] font-semibold text-ink" aria-expanded={open}>
              <ChevronRight className={clsx('size-4 text-ink-faint transition-transform', open && 'rotate-90')} />
              {title}
            </button>
          ) : (
            <h3 className="text-[0.84375rem] font-semibold text-ink">{title}</h3>
          )}
          {help && <HelpTip>{help}</HelpTip>}
          {!shown && summary && <span className="ml-1 truncate text-[0.78125rem] text-ink-faint">{summary}</span>}
        </div>
        {action}
      </div>
      {shown && <div className="flex flex-col gap-4 px-5 pb-5">{children}</div>}
    </section>
  );
}

export function NumberInput({ value, onChange, min, step, placeholder }: { value: number | undefined; onChange: (v: number | undefined) => void; min?: number; step?: number; placeholder?: string }) {
  return (
    <Input
      type="number"
      value={value ?? ''}
      min={min}
      step={step}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      className="tabular-nums"
    />
  );
}

/* Auth ───────────────────────────────────────────────────────────────────── */

export function AuthEditor({ value, onChange }: { value: Auth; onChange: (a: Auth) => void }) {
  const set = (type: Auth['type']) => {
    if (type === 'none') onChange({ type });
    if (type === 'bearer') onChange({ type, token: '{{secret.api_key}}' });
    if (type === 'api_key') onChange({ type, name: 'x-api-key', value: '{{secret.api_key}}', in: 'header' });
    if (type === 'basic') onChange({ type, username: '', password: '{{secret.password}}' });
  };
  return (
    <div className="flex flex-col gap-4">
      <Field label="Type" help="How the app under test checks who is calling. Put credentials in secrets and reference them as {{secret.name}}, so they never land in the target definition.">
        <Select
          value={value.type}
          onChange={(v) => set(v as Auth['type'])}
          options={[
            { value: 'none', label: 'None' },
            { value: 'bearer', label: 'Bearer token', hint: 'Authorization: Bearer …' },
            { value: 'api_key', label: 'API key', hint: 'A header or query parameter' },
            { value: 'basic', label: 'Basic auth', hint: 'Username and password' },
          ]}
        />
      </Field>
      {value.type === 'bearer' && (
        <Field label="Token" help="Template for the token, e.g. {{secret.my_api_key}}.">
          <Input mono value={value.token} onChange={(e) => onChange({ ...value, token: e.target.value })} />
        </Field>
      )}
      {value.type === 'api_key' && (
        <div className="grid grid-cols-[1fr_1fr_140px] gap-3">
          <Field label="Name" help="Header or query parameter name, e.g. x-api-key.">
            <Input mono value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} />
          </Field>
          <Field label="Value">
            <Input mono value={value.value} onChange={(e) => onChange({ ...value, value: e.target.value })} />
          </Field>
          <Field label="Send in">
            <Select
              value={value.in}
              onChange={(v) => onChange({ ...value, in: v as 'header' | 'query' })}
              options={[
                { value: 'header', label: 'Header' },
                { value: 'query', label: 'Query string' },
              ]}
            />
          </Field>
        </div>
      )}
      {value.type === 'basic' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Username">
            <Input mono value={value.username} onChange={(e) => onChange({ ...value, username: e.target.value })} />
          </Field>
          <Field label="Password">
            <Input mono value={value.password} onChange={(e) => onChange({ ...value, password: e.target.value })} />
          </Field>
        </div>
      )}
    </div>
  );
}

/* Outputs (extractors) ───────────────────────────────────────────────────── */

const FROM_OPTIONS: { value: Extractor['from']; label: string; hint: string; placeholder: string }[] = [
  { value: 'json', label: 'JSONPath', hint: 'A field inside a JSON body', placeholder: '$.answer' },
  { value: 'text', label: 'Whole body', hint: 'The raw response text', placeholder: '' },
  { value: 'header', label: 'Header', hint: 'A response header', placeholder: 'x-request-id' },
  { value: 'status', label: 'Status code', hint: 'The HTTP status number', placeholder: '' },
  { value: 'regex', label: 'Regex', hint: 'First capture group of a pattern', placeholder: 'answer: (.*)' },
  { value: 'expression', label: 'JS expression', hint: 'Any expression over the response', placeholder: 'body.items.map(i => i.text).join(" ")' },
];

export function ExtractorsEditor({ value, onChange, expressionScope }: { value: Extractor[]; onChange: (v: Extractor[]) => void; expressionScope: string }) {
  const set = (i: number, patch: Partial<Extractor>) => onChange(value.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <div className="grid grid-cols-[150px_150px_1fr_32px] gap-2 text-[0.75rem] font-medium text-ink-faint">
          <span>Field name</span>
          <span>Taken from</span>
          <span className="flex items-center gap-1">
            Path / expression
            <HelpTip>{`JS expressions can use ${expressionScope}.`}</HelpTip>
          </span>
          <span />
        </div>
      )}
      {value.map((x, i) => {
        const from = FROM_OPTIONS.find((o) => o.value === x.from);
        const needsPath = x.from !== 'text' && x.from !== 'status';
        return (
          <div key={i} className="grid grid-cols-[150px_150px_1fr_32px] items-center gap-2">
            <Input mono value={x.name} placeholder="output" onChange={(e) => set(i, { name: e.target.value.replace(/[^A-Za-z0-9_]/g, '_') })} />
            <Select value={x.from} onChange={(v) => set(i, { from: v as Extractor['from'] })} options={FROM_OPTIONS.map((o) => ({ value: o.value, label: o.label, hint: o.hint }))} />
            {needsPath ? <Input mono value={x.path} placeholder={from?.placeholder} onChange={(e) => set(i, { path: e.target.value })} /> : <span className="text-[0.78125rem] text-ink-faint">No path needed</span>}
            <Button variant="ghost" size="icon-sm" aria-label="Remove output" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        );
      })}
      <div>
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus className="size-3.5" />}
          onClick={() => onChange([...value, { name: value.some((v) => v.name === 'output') ? `field_${value.length + 1}` : 'output', from: 'json', path: '$' }])}
        >
          Add output field
        </Button>
      </div>
    </div>
  );
}

/* WebSocket message lists ────────────────────────────────────────────────── */

export function MessagesEditor({ value, onChange, addLabel = 'Add message', emptyHint }: { value: WsMessage[]; onChange: (v: WsMessage[]) => void; addLabel?: string; emptyHint?: string }) {
  const set = (i: number, patch: Partial<WsMessage>) => onChange(value.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const move = (i: number, d: number) => {
    const next = [...value];
    const [m] = next.splice(i, 1);
    next.splice(i + d, 0, m);
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3">
      {value.length === 0 && emptyHint && <div className="text-[0.78125rem] text-ink-faint">{emptyHint}</div>}
      {value.map((m, i) => (
        <div key={i} className="rounded-lg border border-line bg-raised/50 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[0.75rem] font-medium text-ink-faint">#{i + 1}</span>
            <div className="w-40">
              <Select
                size="sm"
                value={m.type}
                onChange={(v) => set(i, { type: v as WsMessage['type'] })}
                options={[
                  { value: 'json', label: 'JSON', hint: 'Text frame; {{var}} inside quotes is escaped' },
                  { value: 'text', label: 'Text', hint: 'Text frame sent as written' },
                  { value: 'binary_base64', label: 'Binary (base64)', hint: 'Decoded from base64 and sent as a binary frame' },
                ]}
              />
            </div>
            <div className="flex items-center gap-1.5 text-[0.78125rem] text-ink-muted">
              <span>Wait before</span>
              <input
                type="number"
                min={0}
                value={m.delayMs}
                onChange={(e) => set(i, { delayMs: Number(e.target.value) || 0 })}
                className="h-7 w-20 rounded-md border border-line-strong bg-surface px-2 text-[0.78125rem] tabular-nums focus:border-accent focus:outline-none"
                aria-label="Delay in milliseconds"
              />
              <span>ms</span>
            </div>
            <div className="ml-auto flex items-center">
              <Button variant="ghost" size="icon-sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Move down" disabled={i === value.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Remove message" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
          <CodeEditor value={m.content} onChange={(v) => set(i, { content: v })} language={m.type === 'json' ? 'json' : 'text'} minHeight={40} maxHeight={200} />
        </div>
      ))}
      <div>
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...value, { type: 'json', content: '{}', delayMs: 0 }])}>
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

/* Template help ──────────────────────────────────────────────────────────── */

const SYNTAX: [string, string][] = [
  ['{{question}}', 'A dataset column (also {{row.question}})'],
  ['{{vars.base_url}}', 'A target variable'],
  ['{{secret.api_key}}', 'A stored secret (set on the Connections page)'],
  ['{{row_id}}', 'The row id'],
  ['{{$uuid}}  {{$timestamp}}', 'Fresh values per call'],
  ['{{messages | json}}', 'Insert as raw JSON (objects, arrays, numbers)'],
  ['{{audio | base64}}', 'File contents as base64 (also dataurl)'],
  ['{{q | urlencode}}', 'URL-encode text'],
  ["{{name | default('n/a')}}", 'Fallback when empty'],
  ["{{tags | join(', ')}}", 'Join a list'],
];

export function TemplateHelp() {
  const secrets = useOp<string[]>('list_secrets');
  return (
    <Popover
      align="end"
      className="w-[420px]"
      trigger={
        <Button size="sm" variant="ghost" icon={<Braces className="size-3.5" />}>
          Template help
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <div className="mb-1.5 text-[0.8125rem] font-semibold">Placeholders</div>
          <div className="flex flex-col gap-1">
            {SYNTAX.map(([code, text]) => (
              <div key={code} className="grid grid-cols-[180px_1fr] gap-2 text-[0.78125rem]">
                <code className="truncate font-mono text-accent-ink">{code}</code>
                <span className="text-ink-muted">{text}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[0.75rem] text-ink-faint">In JSON bodies and messages, {'{{var}}'} inside quotes is escaped for you.</div>
        </div>
        <div className="border-t border-line pt-3">
          <div className="mb-1.5 text-[0.8125rem] font-semibold">Secrets</div>
          {(secrets.data ?? []).length === 0 ? (
            <div className="text-[0.78125rem] text-ink-faint">No secrets yet. Add them on the Connections page; values never leave this machine.</div>
          ) : (
            <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
              {secrets.data!.map((s) => (
                <div key={s} className="flex items-center justify-between gap-2">
                  <code className="truncate font-mono text-[0.78125rem]">{`{{secret.${s}}}`}</code>
                  <CopyButton text={`{{secret.${s}}}`} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Popover>
  );
}

/** Small reference list shown next to script editors. */
export function ScriptDocs({ items, returns }: { items: [string, string][]; returns?: ReactNode }) {
  return (
    <div className="rounded-lg bg-raised px-3 py-2.5 text-[0.78125rem]">
      <div className="mb-1 font-medium text-ink-muted">Available in the script</div>
      <div className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-0.5">
        {items.map(([k, v]) => (
          <div key={k} className="contents">
            <code className="font-mono text-accent-ink">{k}</code>
            <span className="text-ink-muted">{v}</span>
          </div>
        ))}
      </div>
      {returns && <div className="mt-1.5 text-ink-muted">{returns}</div>}
    </div>
  );
}
