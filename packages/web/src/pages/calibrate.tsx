import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Scale } from 'lucide-react';
import { BackLink, Page } from '../components/layout/shell';
import { Card, EmptyState, ErrorBox, Loading } from '../components/ui/display';
import { Field, Segmented, Select, Switch } from '../components/ui/form';
import { HelpTip } from '../components/ui/overlay';
import { toastError } from '../components/ui/toast';
import { AgreementPanel, type Agreement } from '../components/calibrate/agreement';
import { LabelCard, type LabelItem } from '../components/calibrate/label-card';
import { op, useOp } from '../lib/api';

type Strategy = 'balanced' | 'random' | 'unlabeled_failures' | 'disagreements';
const ROW = '__row__'; // UI value for "the whole row" (checkId '')

const STRATEGIES: { value: Strategy; label: string; hint: string }[] = [
  { value: 'balanced', label: 'Balanced', hint: 'Alternate rows the check passed and failed (best for calibration)' },
  { value: 'random', label: 'Random', hint: 'Unbiased sample of unlabeled rows' },
  { value: 'unlabeled_failures', label: 'Failures only', hint: 'Only rows the check failed' },
  { value: 'disagreements', label: 'Disagreements', hint: 'Revisit rows where you and the check differ' },
];

/** Keys belong to the focused control: a text field, or an open dropdown/menu/dialog (typeahead). */
const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || !!el.closest('[role="listbox"],[role="menu"],[role="dialog"]'));

export function CalibratePage() {
  const { id: runId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const run = useOp<any>('get_run', { runId });

  const checks = useMemo(
    () =>
      [...((run.data?.summary?.checks ?? []) as { id: string; name: string; type: string; layer: number }[])].sort(
        (a, b) => b.layer - a.layer || a.name.localeCompare(b.name),
      ),
    [run.data],
  );
  const selected = params.get('check') ?? checks[0]?.id ?? ROW;
  const checkId = selected === ROW ? '' : selected;

  const [scope, setScope] = useState<'run' | 'suite'>('run');
  const [strategy, setStrategy] = useState<Strategy>('balanced');
  const [blind, setBlind] = useState(true);
  const [pointer, setPointer] = useState(0);
  const [revisit, setRevisit] = useState<string | null>(null);
  const [localLabels, setLocalLabels] = useState<Record<string, 'pass' | 'fail' | null>>({});
  const [history, setHistory] = useState<{ resultId: string; prev: 'pass' | 'fail' | null; seq: number; verdict: LabelItem['verdict'] }[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [feedback, setFeedback] = useState<{ agree: boolean; check: 'pass' | 'fail' } | null>(null);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const queue = useOp<{ items: LabelItem[]; remaining: number }>('next_to_label', { runId, checkId, strategy, limit: 300 }, { enabled: !!run.data && checks.length > 0 });
  const agreement = useOp<Agreement>(
    'judge_agreement',
    scope === 'suite' ? { suiteId: run.data?.suiteId, checkId } : { runId, checkId },
    { enabled: !!run.data && checks.length > 0 },
  );

  // A new check or strategy starts a fresh pass through the queue.
  useEffect(() => {
    setPointer(0);
    setRevisit(null);
    setHistory([]);
    setLocalLabels({});
    setFeedback(null);
    setRevealed(false);
  }, [checkId, strategy]);

  const items = queue.data?.items ?? [];
  const queued = items[pointer] ? { ...items[pointer], label: localLabels[items[pointer].resultId] ?? items[pointer].label } : null;
  const revisitItem = useMemo<LabelItem | null>(() => {
    if (!revisit) return null;
    const d = agreement.data?.disagreements.find((x) => x.resultId === revisit);
    const fromQueue = items.find((x) => x.resultId === revisit);
    const h = history.find((x) => x.resultId === revisit);
    return {
      resultId: revisit,
      seq: fromQueue?.seq ?? h?.seq ?? 0,
      verdict: fromQueue?.verdict ?? d?.check ?? h?.verdict ?? null,
      label: revisit in localLabels ? localLabels[revisit] : d?.human ?? fromQueue?.label ?? null,
    };
  }, [revisit, agreement.data, items, history, localLabels]);
  const item = revisitItem ?? queued;

  const result = useOp<any>('get_result', { resultId: item?.resultId }, { enabled: !!item?.resultId });
  const seqFromResult = result.data?.seq;
  const shown = item && seqFromResult !== undefined && item.resultId === result.data?.id ? { ...item, seq: seqFromResult } : item;

  const finishAdvance = useCallback(() => {
    clearTimeout(advanceTimer.current);
    advanceTimer.current = undefined;
    setFeedback(null);
    setRevealed(false);
    setNote('');
    if (revisit) setRevisit(null);
    else setPointer((p) => p + 1);
  }, [revisit]);

  const label = useCallback(
    async (value: 'pass' | 'fail') => {
      if (!item || busy) return;
      // Still showing feedback for the last label: this press only moves on, it doesn't label that row again.
      if (advanceTimer.current) return finishAdvance();
      setBusy(true);
      try {
        await op('label_result', { resultId: item.resultId, checkId, label: value, note });
        setHistory((h) => [...h, { resultId: item.resultId, prev: item.label, seq: item.seq, verdict: item.verdict }]);
        setLocalLabels((l) => ({ ...l, [item.resultId]: value }));
        qc.invalidateQueries({ queryKey: ['judge_agreement'] });
        if (item.verdict) setFeedback({ agree: item.verdict === value, check: item.verdict });
        setRevealed(true);
        advanceTimer.current = setTimeout(finishAdvance, blind ? 1100 : 450);
      } catch (e) {
        toastError(e, 'Could not save the label');
      } finally {
        setBusy(false);
      }
    },
    [item, busy, checkId, note, blind, finishAdvance, qc],
  );

  const skip = useCallback(() => {
    if (advanceTimer.current) return finishAdvance();
    setNote('');
    setRevealed(false);
    if (revisit) setRevisit(null);
    else setPointer((p) => p + 1);
  }, [revisit, finishAdvance]);

  const undo = useCallback(async () => {
    const last = history[history.length - 1];
    if (!last || busy) return;
    clearTimeout(advanceTimer.current);
    advanceTimer.current = undefined;
    setBusy(true);
    try {
      await op('label_result', { resultId: last.resultId, checkId, label: last.prev });
      setHistory((h) => h.slice(0, -1));
      setLocalLabels((l) => ({ ...l, [last.resultId]: last.prev }));
      qc.invalidateQueries({ queryKey: ['judge_agreement'] });
      setFeedback(null);
      setRevealed(false);
      setRevisit(last.resultId);
    } catch (e) {
      toastError(e, 'Could not undo');
    } finally {
      setBusy(false);
    }
  }, [history, busy, checkId, qc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'p') label('pass');
      else if (k === 'f') label('fail');
      else if (k === 's') skip();
      else if (k === 'u') undo();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [label, skip, undo]);

  useEffect(() => () => clearTimeout(advanceTimer.current), []);

  if (run.isLoading) return <Loading />;
  if (run.error) return <Page title="Calibrate checks"><ErrorBox error={run.error} /></Page>;
  const r = run.data;
  const labeledHere = Object.values(localLabels).filter(Boolean).length;
  const toGo = Math.max(0, (queue.data?.remaining ?? 0) - pointer);

  return (
    <Page
      width="wide"
      back={<BackLink to={`/runs/${runId}`}>{r.name}</BackLink>}
      title="Calibrate checks"
      description="Label a sample of results yourself, then see how often a check — especially an LLM judge — agrees with you. Trust a judge once its agreement is high on enough rows."
    >
      {checks.length === 0 ? (
        <EmptyState icon={<Scale />} title="Nothing to calibrate yet">
          This run has no check results. Calibrate once it has finished scoring some rows.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-5">
          <Card>
            <div className="grid gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
              <Field label="Check" help="The check whose verdicts you are verifying. LLM judges and scripts are listed first; any check can be calibrated, or the row's overall pass/fail.">
                <Select
                  value={selected}
                  onChange={(v) => setParams((p) => (p.set('check', v), p), { replace: true })}
                  options={[
                    ...checks.map((c) => ({ value: c.id, label: c.name, hint: `${c.type} · layer ${c.layer}` })),
                    { value: ROW, label: 'Whole row (overall pass/fail)', hint: 'All checks combined' },
                  ]}
                />
              </Field>
              <Field label="Show results for" help="You always label rows from this run. 'All runs of this suite' adds labels you made on earlier runs of the same suite to the agreement numbers.">
                <Segmented
                  value={scope}
                  onChange={setScope}
                  options={[
                    { value: 'run', label: 'This run' },
                    { value: 'suite', label: 'All runs of suite' },
                  ]}
                />
              </Field>
              <Field label="Which rows next" help="Balanced alternates rows the check passed and failed, which measures both kinds of mistakes quickly.">
                <Select value={strategy} onChange={(v) => setStrategy(v as Strategy)} options={STRATEGIES} />
              </Field>
              <Field label={<span className="flex items-center gap-1.5">Blind mode</span>} help="Hides the check's verdict until you've labeled the row, so your label reflects your own judgment instead of the check's (avoids anchoring bias).">
                <div className="flex h-8.5 items-center">
                  <Switch checked={blind} onChange={setBlind} label="Blind mode" />
                </div>
              </Field>
            </div>
          </Card>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex items-center justify-between text-[0.8125rem] text-ink-muted">
                <span>
                  <span className="font-semibold tabular-nums text-ink">{agreement.data?.n ?? 0}</span> labeled
                  {strategy !== 'disagreements' && (
                    <>
                      {' '}· <span className="tabular-nums">{toGo}</span> to go
                    </>
                  )}
                  {labeledHere > 0 && <span className="text-ink-faint"> · {labeledHere} this session</span>}
                </span>
                <span className="flex items-center gap-1 text-[0.75rem] text-ink-faint">
                  Keys: P pass · F fail · S skip · U undo
                  <HelpTip>Shortcuts work whenever you're not typing in the note box.</HelpTip>
                </span>
              </div>
              {queue.isLoading ? (
                <Loading label="Picking rows…" />
              ) : !shown ? (
                <EmptyState icon={<Scale />} title={strategy === 'disagreements' ? 'No disagreements' : 'All caught up'}>
                  {strategy === 'disagreements'
                    ? 'Your labels match the check everywhere so far.'
                    : 'There are no more unlabeled rows for this check with this strategy. Switch strategy, pick another check, or run more rows.'}
                </EmptyState>
              ) : (
                <LabelCard
                  item={shown}
                  result={result.data && result.data.id === shown.resultId ? result.data : undefined}
                  loading={result.isLoading}
                  checkId={checkId}
                  blind={blind}
                  revealed={revealed}
                  feedback={feedback}
                  note={note}
                  onNote={setNote}
                  onLabel={label}
                  onSkip={skip}
                  onUndo={undo}
                  canUndo={history.length > 0}
                  busy={busy}
                />
              )}
            </div>
            <AgreementPanel
              data={agreement.data}
              loading={agreement.isFetching}
              activeResultId={revisit}
              onOpenDisagreement={(resultId) => {
                clearTimeout(advanceTimer.current);
                advanceTimer.current = undefined;
                setFeedback(null);
                setRevealed(false);
                setNote(agreement.data?.disagreements.find((d) => d.resultId === resultId)?.note ?? '');
                setRevisit(resultId);
              }}
            />
          </div>
        </div>
      )}
    </Page>
  );
}
