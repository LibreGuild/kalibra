import { Plus, Trash2 } from 'lucide-react';
import { ConnectionPicker } from '../pickers';
import { Button } from '../ui/button';
import { Input } from '../ui/form';
import { Tip } from '../ui/overlay';

/* Building blocks of the playground: model variants and typed-in rows. */

export interface VariantDraft {
  connectionId: string;
  model: string;
  temperature: string;
  label: string;
}

export const emptyVariant = (): VariantDraft => ({ connectionId: '', model: '', temperature: '', label: '' });

/** Root variable names used in templates, ignoring vars./secret./$ helpers. */
export function templateVars(...templates: string[]): string[] {
  const out = new Set<string>();
  for (const t of templates) {
    for (const m of t.matchAll(/\{\{\s*([A-Za-z_][\w]*)/g)) {
      const name = m[1];
      if (!['vars', 'secret', 'row', 'row_id'].includes(name)) out.add(name);
    }
  }
  return [...out];
}

export function VariantsEditor({
  variants,
  onChange,
  defaults,
}: {
  variants: VariantDraft[];
  onChange: (v: VariantDraft[]) => void;
  defaults: Record<string, string>;
}) {
  const set = (i: number, patch: Partial<VariantDraft>) => onChange(variants.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <div className="flex flex-col gap-2">
      {variants.map((v, i) => (
        <div key={i} className="grid grid-cols-[1.25rem_minmax(0,1.3fr)_minmax(0,1fr)_4.5rem_auto] items-center gap-2">
          <span className="text-center text-[0.75rem] font-semibold tabular-nums text-ink-faint">{String.fromCharCode(65 + i)}</span>
          <ConnectionPicker value={v.connectionId} onChange={(id) => set(i, { connectionId: id })} placeholder="Connection" />
          <Input mono value={v.model} onChange={(e) => set(i, { model: e.target.value })} placeholder={defaults[v.connectionId] || 'model'} aria-label="Model" />
          <Tip content="Temperature (empty = model default)">
            <Input type="number" min={0} max={2} step={0.1} value={v.temperature} onChange={(e) => set(i, { temperature: e.target.value })} placeholder="temp" aria-label="Temperature" />
          </Tip>
          <Button variant="ghost" size="icon-sm" aria-label="Remove variant" disabled={variants.length === 1} onClick={() => onChange(variants.filter((_, j) => j !== i))}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      {variants.length < 4 && (
        <div>
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...variants, { ...variants[variants.length - 1], label: '' }])}>
            Add a variant to compare
          </Button>
        </div>
      )}
    </div>
  );
}

export function ValuesEditor({ keys, rows, onChange }: { keys: string[]; rows: Record<string, string>[]; onChange: (rows: Record<string, string>[]) => void }) {
  const cols = keys.length ? keys : ['input'];
  const set = (i: number, k: string, v: string) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid gap-2 text-[0.75rem] font-semibold text-ink-faint" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0,1fr)) 1.75rem` }}>
        {cols.map((k) => (
          <span key={k} className="truncate font-mono">{`{{${k}}}`}</span>
        ))}
        <span />
      </div>
      {rows.map((r, i) => (
        <div key={i} className="grid items-center gap-2" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0,1fr)) 1.75rem` }}>
          {cols.map((k) => (
            <Input key={k} value={r[k] ?? ''} onChange={(e) => set(i, k, e.target.value)} placeholder={k} aria-label={k} />
          ))}
          <Button variant="ghost" size="icon-sm" aria-label="Remove row" disabled={rows.length === 1} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      {rows.length < 25 && (
        <div>
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...rows, {}])}>
            Add row
          </Button>
        </div>
      )}
    </div>
  );
}
