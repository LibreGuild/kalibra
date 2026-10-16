import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Search } from 'lucide-react';
import { Badge, Card, ErrorBox, SectionTitle } from '../../ui/display';
import { Button } from '../../ui/button';
import { Field, Segmented, Select } from '../../ui/form';
import { HelpTip } from '../../ui/overlay';
import { toast, toastError } from '../../ui/toast';
import { op } from '../../../lib/api';
import { LocalModelStatus } from './semantic-tools';
import type { DuplicateGroup } from './types';

type Method = 'exact' | 'near' | 'semantic';

const STRICTNESS: Record<Method, { value: string; label: string }[]> = {
  exact: [],
  near: [
    { value: '0.9', label: 'Very close (≥ 90% overlap)' },
    { value: '0.8', label: 'Close (≥ 80%)' },
    { value: '0.65', label: 'Loose (≥ 65%)' },
  ],
  semantic: [
    { value: '0.95', label: 'Same meaning, almost same words' },
    { value: '0.92', label: 'Same meaning (recommended)' },
    { value: '0.85', label: 'Similar meaning (more matches)' },
  ],
};

/** Find copies, look at them, and keep one of each. Nothing is deleted: extras are marked rejected. */
export function DuplicatesSection({ datasetId, onChanged }: { datasetId: string; onChanged: () => void }) {
  const qc = useQueryClient();
  const [method, setMethod] = useState<Method>('near');
  const [threshold, setThreshold] = useState<Record<Method, string>>({ exact: '1', near: '0.8', semantic: '0.92' });
  const [keep, setKeep] = useState<'first' | 'longest'>('first');
  const [result, setResult] = useState<{ groups: DuplicateGroup[]; duplicates: number; note?: string; rowsChecked: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const find = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await op('find_duplicates', { dataset: datasetId, method, threshold: method === 'exact' ? undefined : Number(threshold[method]) }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (groups: DuplicateGroup[]) => {
    setResolving(true);
    try {
      const r = await op<{ rejected: number; kept: number }>('resolve_duplicates', { dataset: datasetId, groups: groups.map((g) => g.rowIds), keep });
      toast.success(`Kept ${r.kept}, rejected ${r.rejected}`, 'Rejected rows stay in the dataset but are skipped by runs.');
      setResult((cur) => (cur ? { ...cur, groups: cur.groups.filter((g) => !groups.includes(g)), duplicates: cur.duplicates - r.rejected } : cur));
      qc.invalidateQueries({ queryKey: ['list_rows'] });
      onChanged();
    } catch (e) {
      toastError(e);
    } finally {
      setResolving(false);
    }
  };

  return (
    <Card>
      <SectionTitle help="Copies count the same case twice and make pass rates look better (or worse) than they are. Exact ignores case and spacing; Near also catches small edits and typos; Meaning catches paraphrases using an embedding model.">
        Duplicates
      </SectionTitle>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Match">
          <Segmented<Method>
            value={method}
            onChange={(m) => {
              setMethod(m);
              setResult(null);
            }}
            options={[
              { value: 'exact', label: 'Exact' },
              { value: 'near', label: 'Near' },
              { value: 'semantic', label: 'Meaning' },
            ]}
          />
        </Field>
        {method !== 'exact' && (
          <Field label="How strict" className="w-64">
            <Select value={threshold[method]} onChange={(v) => setThreshold((t) => ({ ...t, [method]: v }))} options={STRICTNESS[method]} />
          </Field>
        )}
        <Button icon={<Search className="size-4" />} onClick={find} loading={busy}>
          Find duplicates
        </Button>
      </div>
      {method === 'semantic' && (
        <div className="mt-4 rounded-lg border border-line bg-raised/50 p-3">
          <LocalModelStatus compact />
        </div>
      )}
      <ErrorBox error={error} />

      {result && (
        <div className="mt-5 flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[0.84375rem]">
              {result.groups.length ? (
                <>
                  <span className="font-semibold">{result.duplicates}</span> extra cop{result.duplicates === 1 ? 'y' : 'ies'} in {result.groups.length} group{result.groups.length === 1 ? '' : 's'}
                </>
              ) : (
                <span className="text-ink-muted">No duplicates in {result.rowsChecked} rows.</span>
              )}
              {result.note && <span className="ml-2 text-[0.78125rem] text-ink-faint">{result.note}</span>}
            </div>
            {result.groups.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1 text-[0.78125rem] text-ink-muted">
                  Keep
                  <HelpTip>Which row of each group stays. The others are marked rejected (not deleted) and runs skip them.</HelpTip>
                </span>
                <Segmented<'first' | 'longest'>
                  size="sm"
                  value={keep}
                  onChange={setKeep}
                  options={[
                    { value: 'first', label: 'Oldest' },
                    { value: 'longest', label: 'Most detailed' },
                  ]}
                />
                <Button size="sm" variant="primary" loading={resolving} onClick={() => resolve(result.groups)}>
                  Keep one of each
                </Button>
              </div>
            )}
          </div>
          {result.groups.slice(0, 50).map((g, gi) => (
            <div key={gi} className="rounded-lg border border-line">
              <div className="flex items-center justify-between gap-3 border-b border-line bg-raised/60 px-3 py-1.5">
                <span className="flex items-center gap-2 text-[0.78125rem] text-ink-muted">
                  <Copy className="size-3.5" /> {g.rowIds.length} rows
                  {method !== 'exact' && <Badge>{Math.round(g.similarity * 100)}% alike</Badge>}
                </span>
                <Button size="sm" variant="ghost" disabled={resolving} onClick={() => resolve([g])}>
                  Keep one
                </Button>
              </div>
              <ul className="divide-y divide-line/70">
                {g.previews.map((p, i) => (
                  <li key={g.rowIds[i]} className="flex gap-3 px-3 py-2 text-[0.8125rem]">
                    <span className="w-20 shrink-0 truncate font-mono text-[0.71875rem] text-ink-faint" title={g.rowIds[i]}>
                      {i === 0 ? 'oldest' : `+${i}`}
                    </span>
                    <span className="min-w-0 flex-1 line-clamp-2">{p.replaceAll('␞', '·') || <span className="text-ink-faint">(empty)</span>}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {result.groups.length > 50 && <div className="text-[0.78125rem] text-ink-faint">Showing the first 50 groups. "Keep one of each" applies to all {result.groups.length}.</div>}
        </div>
      )}
    </Card>
  );
}
