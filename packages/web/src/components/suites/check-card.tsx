import { CODE_LOCKED_HINT, useCanWriteCode } from '../../lib/session';
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, ChevronRight, Copy, Plus, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { CodeEditor } from '../ui/code';
import { Badge } from '../ui/display';
import { Field, Input, Select, Switch, TagInput, Textarea } from '../ui/form';
import { Dialog, HelpTip, Tip } from '../ui/overlay';
import { ConnectionPicker } from '../pickers';

/* Shapes returned by list_check_types (see core/src/ops/defs.ts). */
export interface CheckFieldMeta {
  key: string;
  label: string;
  kind: 'template' | 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'code' | 'json' | 'list' | 'connection' | 'model';
  help?: string;
  options?: { value: string; label: string }[];
  placeholder?: string;
  default?: unknown;
}

export interface CheckTypeMeta {
  type: string;
  label: string;
  category: string;
  layer: number;
  description: string;
  fields: CheckFieldMeta[];
  defaults: Record<string, unknown>;
}

export interface LayerMeta {
  id: number;
  name: string;
  hint: string;
}

export interface CheckSpec {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  gate: boolean;
  weight: number;
  applyWhen: string;
  config: Record<string, unknown>;
}

export const newCheckId = () => crypto.randomUUID().slice(0, 8);

export function makeCheck(t: CheckTypeMeta, patch: Partial<CheckSpec> = {}): CheckSpec {
  return {
    id: newCheckId(),
    type: t.type,
    name: '',
    enabled: true,
    gate: t.layer <= 1,
    weight: 1,
    applyWhen: '',
    config: structuredClone(t.defaults ?? {}),
    ...patch,
  };
}

const CATEGORY_LABEL: Record<string, string> = {
  transport: 'Transport',
  structure: 'Structure',
  fields: 'Fields',
  content: 'Content',
  reference: 'Reference metrics',
  judgment: 'Judgment',
};

/** Fields that only matter for some settings stay hidden otherwise, to keep forms short. */
const VISIBLE_WHEN: Record<string, (cfg: Record<string, unknown>) => boolean> = {
  customBase: (c) => c.normalizer === 'custom',
  customRules: (c) => c.normalizer === 'custom',
  substitutions: (c) => c.normalizer === 'custom',
  ignoreSpaces: (c) => c.metric === 'cer',
};

/* One config field, rendered from its metadata. */
function ConfigField({ field, value, onChange }: { field: CheckFieldMeta; value: unknown; onChange: (v: unknown) => void }) {
  const [jsonDraft, setJsonDraft] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);

  if (field.kind === 'boolean') {
    return (
      <Field label={field.label} help={field.help} inline className="rounded-lg border border-line px-3 py-2">
        <Switch checked={!!value} onChange={onChange} label={field.label} />
      </Field>
    );
  }

  let control;
  switch (field.kind) {
    case 'template':
      control = <Input mono value={String(value ?? '')} placeholder={field.placeholder ?? String(field.default ?? '')} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'text':
    case 'model':
      control = <Input value={String(value ?? '')} placeholder={field.placeholder ?? (field.kind === 'model' ? "Connection's default model" : '')} onChange={(e) => onChange(e.target.value)} mono={field.kind === 'text'} />;
      break;
    case 'textarea':
      control = <Textarea rows={4} value={String(value ?? '')} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'number':
      control = (
        <Input
          type="number"
          step="any"
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          className="max-w-48"
        />
      );
      break;
    case 'select':
      control = <Select value={String(value ?? field.default ?? '')} onChange={onChange} options={(field.options ?? []).map((o) => ({ value: o.value, label: o.label }))} />;
      break;
    case 'code':
      control = <CodeEditor language="js" value={String(value ?? '')} onChange={onChange} minHeight={120} />;
      break;
    case 'json': {
      const text = jsonDraft ?? (typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2));
      control = (
        <>
          <CodeEditor
            language="json"
            value={text}
            minHeight={80}
            onChange={(t) => {
              setJsonDraft(t);
              try {
                const parsed = t.trim() === '' ? undefined : JSON.parse(t);
                setJsonError(null);
                // json_schema accepts a string too; keep objects as objects.
                onChange(parsed);
              } catch (e: any) {
                setJsonError(e.message);
              }
            }}
          />
          {jsonError && <div className="text-[0.75rem] text-bad">Invalid JSON: {jsonError}</div>}
        </>
      );
      break;
    }
    case 'list':
      control = <TagInput value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} placeholder="Type and press Enter…" />;
      break;
    case 'connection':
      control = <ConnectionPicker value={String(value ?? '') || undefined} onChange={onChange} placeholder="Choose a connection" />;
      break;
  }
  return (
    <Field label={field.label} help={field.help} className={clsx(['code', 'json', 'textarea'].includes(field.kind) && 'col-span-2')}>
      {control}
    </Field>
  );
}

/** Collapsible editor for one check in a suite. */
export function CheckCard({
  check,
  type,
  onChange,
  onRemove,
  onDuplicate,
  onMove,
  canUp,
  canDown,
  defaultOpen,
}: {
  check: CheckSpec;
  type?: CheckTypeMeta;
  onChange: (c: CheckSpec) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onMove: (dir: -1 | 1) => void;
  canUp: boolean;
  canDown: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const set = (patch: Partial<CheckSpec>) => onChange({ ...check, ...patch });
  const setConfig = (key: string, v: unknown) => set({ config: { ...check.config, [key]: v } });
  const title = check.name || type?.label || check.type;

  return (
    <div className={clsx('rounded-xl border bg-surface transition-colors', check.enabled ? 'border-line' : 'border-line opacity-70')}>
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <Tip content={check.enabled ? 'On. Turn off to keep this check without running it.' : 'Off. This check is skipped.'}>
          <span className="flex">
            <Switch checked={check.enabled} onChange={(v) => set({ enabled: v })} label="Run this check" />
          </span>
        </Tip>
        <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" aria-expanded={open}>
          <ChevronRight className={clsx('size-4 shrink-0 text-ink-faint transition-transform', open && 'rotate-90')} />
          <span className="truncate text-[0.84375rem] font-medium">{title}</span>
          <Badge className="font-mono">{check.type}</Badge>
          {!type && <Badge tone="bad">Unknown type</Badge>}
          {check.applyWhen.trim() && (
            <Tip content={`Only runs when: ${check.applyWhen}`}>
              <span>
                <Badge tone="info">Conditional</Badge>
              </span>
            </Tip>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-3">
          <label className="flex items-center gap-1.5 text-[0.78125rem] text-ink-muted">
            Gate
            <HelpTip>A gate must pass for later layers to run on that row. Use it for cheap must-haves (status, schema) so failures don't pay for slower checks like LLM judges.</HelpTip>
            <Switch checked={check.gate} onChange={(v) => set({ gate: v })} label="Gate" />
          </label>
          <label className="flex items-center gap-1.5 text-[0.78125rem] text-ink-muted">
            <Tip content="Weight in the row score. Only matters with the weighted pass rule.">
              <span>Weight</span>
            </Tip>
            <input
              type="number"
              min={0}
              step="any"
              value={check.weight}
              onChange={(e) => set({ weight: Math.max(0, Number(e.target.value) || 0) })}
              className="h-7 w-14 rounded-md border border-line-strong bg-surface px-1.5 text-[0.78125rem] tabular-nums focus:border-accent focus:outline-none"
              aria-label="Weight"
            />
          </label>
          <div className="flex items-center">
            <Tip content="Move up">
              <Button variant="ghost" size="icon-sm" disabled={!canUp} onClick={() => onMove(-1)} aria-label="Move up">
                <ArrowUp className="size-3.5" />
              </Button>
            </Tip>
            <Tip content="Move down">
              <Button variant="ghost" size="icon-sm" disabled={!canDown} onClick={() => onMove(1)} aria-label="Move down">
                <ArrowDown className="size-3.5" />
              </Button>
            </Tip>
            <Tip content="Duplicate">
              <Button variant="ghost" size="icon-sm" onClick={onDuplicate} aria-label="Duplicate">
                <Copy className="size-3.5" />
              </Button>
            </Tip>
            <Tip content="Remove">
              <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Remove">
                <Trash2 className="size-3.5" />
              </Button>
            </Tip>
          </div>
        </div>
      </div>
      {open && (
        <div className="border-t border-line px-4 py-4">
          {type?.description && <p className="mb-4 text-[0.8125rem] text-ink-muted">{type.description}</p>}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
            <Field label="Name" help="Shown in results. Leave empty to use the check type's name.">
              <Input value={check.name} placeholder={type?.label ?? check.type} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Only run when" help="Optional JavaScript expression. The check runs only when it is true, e.g. expected_behavior === 'refuse'. Row columns, output, outputs, response and metrics are available.">
              <Input mono value={check.applyWhen} placeholder="always" onChange={(e) => set({ applyWhen: e.target.value })} />
            </Field>
            {(type?.fields ?? [])
              .filter((f) => VISIBLE_WHEN[f.key]?.({ ...type?.defaults, ...check.config }) ?? true)
              .map((f) => (
                <ConfigField key={f.key} field={f} value={check.config[f.key] ?? f.default} onChange={(v) => setConfig(f.key, v)} />
              ))}
            {!type && (
              <Field label="Config (JSON)" className="col-span-2" help="This check type is not known to this version of Kalibra; edit its raw config.">
                <CodeEditor language="json" value={JSON.stringify(check.config, null, 2)} onChange={(t) => { try { set({ config: JSON.parse(t) }); } catch { /* keep typing */ } }} />
              </Field>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Picker listing every check type, grouped by category. */
const COMMON_CHECKS = ['status', 'latency', 'json_schema', 'contains', 'equals', 'similarity', 'wer', 'semantic_similarity', 'llm_judge', 'refusal'];

export function AddCheckDialog({ open, onOpenChange, types, onAdd }: { open: boolean; onOpenChange: (o: boolean) => void; types: CheckTypeMeta[]; onAdd: (t: CheckTypeMeta) => void }) {
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);
  const canWriteCode = useCanWriteCode();
  const groups = useMemo(() => {
    const filtered = types.filter((t) => !q || `${t.label} ${t.type} ${t.description}`.toLowerCase().includes(q.toLowerCase()));
    // Most people need a handful of checks; show those first and keep the full catalogue one click away.
    if (!q && !showAll) {
      const common = COMMON_CHECKS.map((type) => filtered.find((t) => t.type === type)).filter(Boolean) as CheckTypeMeta[];
      return [['common', common] as [string, CheckTypeMeta[]]];
    }
    const map = new Map<string, CheckTypeMeta[]>();
    for (const t of filtered) {
      if (!map.has(t.category)) map.set(t.category, []);
      map.get(t.category)!.push(t);
    }
    return [...map.entries()].sort((a, b) => (a[1][0]?.layer ?? 0) - (b[1][0]?.layer ?? 0));
  }, [types, q, showAll]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add a check" description="Checks run layer by layer, cheapest first." width="lg">
      <Input autoFocus placeholder="Search checks…" value={q} onChange={(e) => setQ(e.target.value)} className="mb-4" />
      <div className="flex flex-col gap-5">
        {groups.map(([cat, list]) => (
          <div key={cat}>
            <div className="mb-2 text-[0.75rem] font-semibold uppercase tracking-wide text-ink-faint">
              {cat === 'common' ? 'Most used' : `${CATEGORY_LABEL[cat] ?? cat} · layer ${list[0]?.layer}`}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {list.map((t) => (
                <button
                  key={t.type}
                  type="button"
                  disabled={t.type === 'script' && !canWriteCode}
                  title={t.type === 'script' && !canWriteCode ? CODE_LOCKED_HINT : undefined}
                  onClick={() => {
                    onAdd(t);
                    onOpenChange(false);
                    setQ('');
                  }}
                  className="flex items-start gap-2.5 rounded-lg border border-line px-3 py-2.5 text-left transition-colors hover:border-accent hover:bg-accent-soft/40 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line disabled:hover:bg-transparent"
                >
                  <Plus className="mt-0.5 size-3.5 shrink-0 text-accent" />
                  <div className="min-w-0">
                    <div className="text-[0.84375rem] font-medium">{t.label}</div>
                    <div className="mt-0.5 line-clamp-2 text-[0.78125rem] text-ink-muted">{t.description}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
        {groups.length === 0 && <div className="py-6 text-center text-[0.8125rem] text-ink-muted">No check matches “{q}”.</div>}
        {!q && (
          <button type="button" onClick={() => setShowAll(!showAll)} className="self-start text-[0.8125rem] font-medium text-accent-ink hover:underline">
            {showAll ? 'Show only the most used' : `Show all ${types.length} checks`}
          </button>
        )}
      </div>
    </Dialog>
  );
}
