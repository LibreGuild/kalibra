import { useOp } from '../lib/api';
import { Select } from './ui/form';

/** Dropdowns for picking saved items. Values are ids. */

export function DatasetPicker({ value, onChange, placeholder = 'Choose a dataset' }: { value?: string; onChange: (id: string) => void; placeholder?: string }) {
  const q = useOp<any[]>('list_datasets');
  return <Select value={value} onChange={onChange} placeholder={q.isLoading ? 'Loading…' : placeholder} options={(q.data ?? []).map((d) => ({ value: d.id, label: d.name, hint: `${d.rowCount} rows` }))} />;
}

export function DefPicker({ kind, value, onChange, placeholder }: { kind: 'target' | 'suite' | 'connection'; value?: string; onChange: (id: string) => void; placeholder?: string }) {
  const q = useOp<any[]>(`list_${kind}s`);
  const hint = (d: any) =>
    kind === 'target' ? d.spec?.config?.kind : kind === 'suite' ? `${d.spec?.checks?.length ?? 0} checks` : `${d.spec?.provider}${d.spec?.defaultModel ? ` · ${d.spec.defaultModel}` : ''}`;
  return (
    <Select
      value={value}
      onChange={onChange}
      placeholder={q.isLoading ? 'Loading…' : placeholder ?? `Choose a ${kind}`}
      options={(q.data ?? []).map((d) => ({ value: d.id, label: d.name, hint: hint(d) }))}
    />
  );
}

export const TargetPicker = (p: { value?: string; onChange: (id: string) => void }) => <DefPicker kind="target" {...p} />;
export const SuitePicker = (p: { value?: string; onChange: (id: string) => void }) => <DefPicker kind="suite" {...p} />;
export const ConnectionPicker = (p: { value?: string; onChange: (id: string) => void; placeholder?: string }) => <DefPicker kind="connection" {...p} />;
