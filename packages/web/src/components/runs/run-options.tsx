import { useEffect, useMemo, type ReactNode } from 'react';
import clsx from 'clsx';
import { ChevronRight, Plus, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/display';
import { Field, Input, KeyValueEditor, Segmented, Select, type KV } from '../ui/form';
import { HelpTip } from '../ui/overlay';
import { ConnectionPicker, TargetPicker } from '../pickers';
import { useOp } from '../../lib/api';

/* Optional sections of the New run dialog: compare variants, and multi-turn conversations. */

/** A collapsible block with a title, an "on" badge and a one-line summary when closed. */
export function OptionSection({ title, help, open, onToggle, on, summary, children }: { title: string; help: ReactNode; open: boolean; onToggle: () => void; on: boolean; summary?: ReactNode; children: ReactNode }) {
  return (
    <div className={clsx('rounded-lg border', on ? 'border-accent/40 bg-accent-soft/20' : 'border-line')}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left" aria-expanded={open}>
        <ChevronRight className={clsx('size-4 shrink-0 text-ink-faint transition-transform', open && 'rotate-90')} />
        <span className="text-[0.84375rem] font-medium">{title}</span>
        <HelpTip>{help}</HelpTip>
        {on && <Badge tone="accent">On</Badge>}
        {!open && summary && <span className="ml-auto truncate text-[0.78125rem] text-ink-muted">{summary}</span>}
      </button>
      {open && <div className="border-t border-line px-3.5 py-3.5">{children}</div>}
    </div>
  );
}

/* ── Variants ─────────────────────────────────────────────────────────────── */

export interface VariantDraft {
  key: number;
  target?: string;
  label: string;
  connectionId: string;
  model: string;
  temperature: string;
  vars: KV[];
}

let nextKey = 1;
export const newVariant = (target?: string): VariantDraft => ({ key: nextKey++, target, label: '', connectionId: '', model: '', temperature: '', vars: [] });

/** Turns UI drafts into start_comparison variants (only fields the user filled in become overrides). */
export function toVariants(drafts: VariantDraft[]) {
  return drafts.map((v) => {
    const vars = Object.fromEntries(v.vars.filter((kv) => kv.enabled && kv.key.trim()).map((kv) => [kv.key.trim(), kv.value]));
    const t = v.temperature.trim() === '' ? undefined : Number(v.temperature);
    const model = v.connectionId || v.model || t !== undefined ? { connectionId: v.connectionId, model: v.model.trim(), ...(t !== undefined && !Number.isNaN(t) ? { temperature: t } : {}) } : undefined;
    const overrides = Object.keys(vars).length || model ? { vars, ...(model ? { model } : {}) } : undefined;
    return { target: v.target!, label: v.label.trim(), ...(overrides ? { overrides } : {}) };
  });
}

export function VariantsEditor({ drafts, onChange }: { drafts: VariantDraft[]; onChange: (d: VariantDraft[]) => void }) {
  const targets = useOp<any[]>('list_targets');
  const kindOf = (id?: string) => targets.data?.find((t) => t.id === id)?.spec?.config?.kind;
  const set = (key: number, patch: Partial<VariantDraft>) => onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[0.78125rem] text-ink-muted">
        Every variant runs the same dataset and suite. Use different targets, or the same target with another model, temperature or variable (like a base URL).
      </p>
      {drafts.map((d, i) => {
        const isModel = kindOf(d.target) === 'model';
        return (
          <div key={d.key} className="rounded-lg border border-line bg-surface p-3">
            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-[0.75rem] font-semibold uppercase tracking-wide text-ink-faint">Variant {i + 1}</span>
              <Button variant="ghost" size="icon-sm" aria-label={`Remove variant ${i + 1}`} disabled={drafts.length <= 2} onClick={() => onChange(drafts.filter((x) => x.key !== d.key))}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <Field label="Target">
                <TargetPicker value={d.target} onChange={(v) => set(d.key, { target: v })} />
              </Field>
              <Field label="Label" help="Name shown in the leaderboard. Left empty, Kalibra builds one from the target and what you changed.">
                <Input value={d.label} placeholder="e.g. gpt-6-luna, temp 0" onChange={(e) => set(d.key, { label: e.target.value })} />
              </Field>
            </div>
            {isModel && (
              <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_96px]">
                <Field label="Connection" help="Leave empty to keep the target's own connection.">
                  <ConnectionPicker value={d.connectionId} onChange={(v) => set(d.key, { connectionId: v })} placeholder="Target's connection" />
                </Field>
                <Field label="Model" help="Leave empty to keep the target's model.">
                  <Input mono value={d.model} placeholder="same as target" onChange={(e) => set(d.key, { model: e.target.value })} />
                </Field>
                <Field label="Temp." help="Sampling temperature, 0 to 2. Leave empty to keep the target's setting.">
                  <Input type="number" min={0} max={2} step={0.1} value={d.temperature} placeholder="—" onChange={(e) => set(d.key, { temperature: e.target.value })} />
                </Field>
              </div>
            )}
            <details className="mt-2.5" open={d.vars.length > 0}>
              <summary className="cursor-pointer text-[0.78125rem] font-medium text-ink-muted hover:text-ink">Change variables</summary>
              <div className="mt-2">
                <KeyValueEditor value={d.vars} onChange={(vars) => set(d.key, { vars })} keyPlaceholder="variable (e.g. base_url)" valuePlaceholder="value for this variant" addLabel="Add variable" />
              </div>
            </details>
          </div>
        );
      })}
      <div>
        <Button size="sm" icon={<Plus className="size-3.5" />} disabled={drafts.length >= 8} onClick={() => onChange([...drafts, newVariant(drafts[drafts.length - 1]?.target)])}>
          Add variant
        </Button>
      </div>
    </div>
  );
}

/* ── Conversation ─────────────────────────────────────────────────────────── */

export interface ConversationDraft {
  mode: 'off' | 'scripted' | 'simulated';
  turnsColumn: string;
  personaTemplate: string;
  goalTemplate: string;
  connectionId: string;
  model: string;
  maxTurns: string;
  stopPhrase: string;
}

export const defaultConversation = (): ConversationDraft => ({
  mode: 'off',
  turnsColumn: 'turns',
  personaTemplate: '{{persona}}',
  goalTemplate: '{{goal}}',
  connectionId: '',
  model: '',
  maxTurns: '6',
  stopPhrase: '',
});

export function toConversation(c: ConversationDraft) {
  if (c.mode === 'off') return undefined;
  return {
    mode: c.mode,
    turnsColumn: c.turnsColumn || 'turns',
    personaTemplate: c.personaTemplate,
    goalTemplate: c.goalTemplate,
    connectionId: c.connectionId,
    model: c.model.trim(),
    maxTurns: Math.max(1, Math.min(30, Number(c.maxTurns) || 6)),
    stopPhrase: c.stopPhrase,
  };
}

/** What a dataset looks like it was made for: scripted turns, simulated users, or neither. */
export function useConversationHint(datasetId?: string) {
  const schema = useOp<any>('get_dataset_schema', { dataset: datasetId, sampleRows: 0 }, { enabled: !!datasetId });
  return useMemo(() => {
    const cols: { key: string; type: string }[] = schema.data?.columns ?? [];
    const listCols = cols.filter((c) => c.type === 'list' || c.type === 'messages').map((c) => c.key);
    const hasTurns = cols.some((c) => c.key === 'turns');
    const hasSim = cols.some((c) => c.key === 'persona' || c.key === 'goal');
    return { listCols, hasTurns, hasSim, suggested: hasTurns ? ('scripted' as const) : hasSim ? ('simulated' as const) : null };
  }, [schema.data]);
}

export function ConversationEditor({ value, onChange, datasetId }: { value: ConversationDraft; onChange: (c: ConversationDraft) => void; datasetId?: string }) {
  const hint = useConversationHint(datasetId);
  const set = (patch: Partial<ConversationDraft>) => onChange({ ...value, ...patch });
  useEffect(() => {
    if (hint.listCols.length && !hint.listCols.includes(value.turnsColumn)) set({ turnsColumn: hint.listCols[0] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hint.listCols.join(',')]);

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<ConversationDraft['mode']>
          value={value.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: 'off', label: 'Single request' },
            { value: 'scripted', label: 'Scripted turns' },
            { value: 'simulated', label: 'Simulated user' },
          ]}
        />
        {hint.suggested && value.mode === 'off' && (
          <button type="button" className="text-[0.78125rem] font-medium text-accent-ink hover:underline" onClick={() => set({ mode: hint.suggested! })}>
            This dataset looks like {hint.suggested === 'scripted' ? 'scripted conversations' : 'simulated users'} — use it
          </button>
        )}
      </div>
      {value.mode === 'off' && <p className="text-[0.78125rem] text-ink-muted">Each row is sent once. Pick a conversation mode to test chatbots and agents over several turns.</p>}
      {value.mode !== 'off' && (
        <p className="text-[0.78125rem] text-ink-muted">
          The target is called once per turn. In its request use <code className="font-mono">{'{{message}}'}</code> for the current user message, <code className="font-mono">{'{{history}}'}</code> for earlier turns
          and <code className="font-mono">{'{{session_id}}'}</code> (from an output named session_id). Checks score the final reply and the whole transcript.
        </p>
      )}
      {value.mode === 'scripted' && (
        <Field label="User messages from column" help="A list column with what the user says, one message per turn, in order.">
          {hint.listCols.length ? (
            <Select value={value.turnsColumn} onChange={(v) => set({ turnsColumn: v })} options={hint.listCols.map((c) => ({ value: c, label: c }))} />
          ) : (
            <Input mono value={value.turnsColumn} onChange={(e) => set({ turnsColumn: e.target.value })} placeholder="turns" />
          )}
        </Field>
      )}
      {value.mode === 'simulated' && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Persona" help="Who the simulated user is. Usually a column, e.g. {{persona}}.">
              <Input mono value={value.personaTemplate} onChange={(e) => set({ personaTemplate: e.target.value })} />
            </Field>
            <Field label="Goal" help="What the user is trying to get done. The simulated user stops when it's achieved (or clearly won't be).">
              <Input mono value={value.goalTemplate} onChange={(e) => set({ goalTemplate: e.target.value })} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_96px]">
            <Field label="Model playing the user" help="A model connection writes the user's messages. Pick a different model family from your app to avoid it going easy on itself.">
              <ConnectionPicker value={value.connectionId} onChange={(v) => set({ connectionId: v })} />
            </Field>
            <Field label="Model">
              <Input mono value={value.model} placeholder="connection default" onChange={(e) => set({ model: e.target.value })} />
            </Field>
            <Field label="Max turns" help="The conversation ends after this many user messages at most.">
              <Input type="number" min={1} max={30} value={value.maxTurns} onChange={(e) => set({ maxTurns: e.target.value })} />
            </Field>
          </div>
        </>
      )}
      {value.mode !== 'off' && (
        <Field label="Stop when the app says (optional)" help="End the conversation as soon as a reply contains this text, e.g. “Goodbye”.">
          <Input value={value.stopPhrase} onChange={(e) => set({ stopPhrase: e.target.value })} placeholder="e.g. Is there anything else" />
        </Field>
      )}
    </div>
  );
}
