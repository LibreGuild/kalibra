import clsx from 'clsx';
import { Check, EyeOff, SkipForward, Undo2, X } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge, Card, Kbd, Loading } from '../ui/display';
import { Textarea } from '../ui/form';
import { CellValue } from '../ui/media';
import { CheckList, type CheckResultView } from '../runs/result-sheet';

export interface LabelItem {
  resultId: string;
  seq: number;
  verdict: 'pass' | 'fail' | null;
  label: 'pass' | 'fail' | null;
}

function Values({ data, emphasize }: { data: Record<string, unknown>; emphasize?: string }) {
  const entries = Object.entries(data ?? {}).sort(([a], [b]) => (a === emphasize ? -1 : b === emphasize ? 1 : 0));
  if (!entries.length) return <div className="text-[0.8125rem] text-ink-faint">None</div>;
  return (
    <div className="divide-y divide-line rounded-lg border border-line">
      {entries.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[130px_minmax(0,1fr)] gap-3 px-3 py-2 text-[0.84375rem]">
          <div className={clsx('truncate pt-0.5 font-mono text-[0.75rem]', k === emphasize ? 'font-semibold text-ink' : 'text-ink-muted')}>{k}</div>
          <div className="min-w-0 break-words leading-relaxed">
            <CellValue value={v} full />
          </div>
        </div>
      ))}
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h4 className="mb-2 text-[0.75rem] font-semibold uppercase tracking-wide text-ink-faint">{children}</h4>;
}

/**
 * One result to label. In blind mode the check's verdict stays hidden until you decide,
 * so the label reflects your judgment rather than the check's.
 */
export function LabelCard({
  item,
  result,
  loading,
  checkId,
  blind,
  revealed,
  feedback,
  note,
  onNote,
  onLabel,
  onSkip,
  onUndo,
  canUndo,
  busy,
}: {
  item: LabelItem | null;
  result: any;
  loading: boolean;
  checkId: string;
  blind: boolean;
  revealed: boolean;
  feedback: { agree: boolean; check: 'pass' | 'fail' } | null;
  note: string;
  onNote: (v: string) => void;
  onLabel: (label: 'pass' | 'fail') => void;
  onSkip: () => void;
  onUndo: () => void;
  canUndo: boolean;
  busy: boolean;
}) {
  if (!item) return null;
  const check: CheckResultView | undefined = result?.checks?.find((c: any) => c.id === checkId);
  const showVerdict = !blind || revealed || !!item.label;

  return (
    <Card className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[0.9375rem] font-semibold">Row {item.seq + 1}</span>
          {result?.rep > 0 && <Badge>repeat {result.rep + 1}</Badge>}
          {item.label && (
            <Badge tone={item.label === 'pass' ? 'ok' : 'bad'} dot>
              You said {item.label}
            </Badge>
          )}
        </div>
        <span className="font-mono text-[0.71875rem] text-ink-faint">{item.resultId}</span>
      </div>

      {loading || !result ? (
        <Loading label="Loading result…" />
      ) : (
        <>
          <section>
            <Heading>Input</Heading>
            <Values data={result.input} />
          </section>
          <section>
            <Heading>Output</Heading>
            {result.error && <div className="mb-2 rounded-lg bg-bad-soft px-3 py-2 text-[0.8125rem] text-bad">{result.error}</div>}
            <Values data={result.outputs} emphasize="output" />
          </section>
          <section>
            <Heading>What the check decided</Heading>
            {!check ? (
              <div className="text-[0.8125rem] text-ink-faint">This check did not run on this row.</div>
            ) : showVerdict ? (
              <CheckList checks={[check]} />
            ) : (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-line-strong px-3 py-3 text-[0.8125rem] text-ink-muted">
                <EyeOff className="size-4 text-ink-faint" />
                Hidden until you decide (blind mode), so the check's answer doesn't sway yours.
              </div>
            )}
          </section>
        </>
      )}

      {feedback && (
        <div className={clsx('rounded-lg px-3 py-2 text-[0.8125rem] font-medium', feedback.agree ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn')}>
          {feedback.agree ? 'You agree with the check.' : `You disagree — the check said ${feedback.check}. Add a note to remember why.`}
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <Textarea rows={2} value={note} onChange={(e) => onNote(e.target.value)} placeholder="Optional note: why is this a pass or a fail?" />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="md"
            disabled={busy || !result}
            onClick={() => onLabel('pass')}
            className={clsx('h-10 min-w-32 justify-center border-ok/40 text-ok hover:bg-ok-soft', item.label === 'pass' && 'bg-ok-soft')}
            icon={<Check className="size-4" />}
          >
            Pass <Kbd>P</Kbd>
          </Button>
          <Button
            size="md"
            disabled={busy || !result}
            onClick={() => onLabel('fail')}
            className={clsx('h-10 min-w-32 justify-center border-bad/40 text-bad hover:bg-bad-soft', item.label === 'fail' && 'bg-bad-soft')}
            icon={<X className="size-4" />}
          >
            Fail <Kbd>F</Kbd>
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" onClick={onSkip} disabled={busy} icon={<SkipForward className="size-4" />}>
            Skip <Kbd>S</Kbd>
          </Button>
          <Button variant="ghost" onClick={onUndo} disabled={busy || !canUndo} icon={<Undo2 className="size-4" />}>
            Undo <Kbd>U</Kbd>
          </Button>
        </div>
      </div>
    </Card>
  );
}
