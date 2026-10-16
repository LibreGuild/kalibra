import clsx from 'clsx';
import { AlertTriangle } from 'lucide-react';
import { Badge, Card, SectionTitle, Spinner } from '../ui/display';
import { HelpTip, Tip } from '../ui/overlay';
import { pct } from '../../lib/format';

/** Shape returned by the judge_agreement operation. */
export interface Agreement {
  scope: 'run' | 'suite';
  runs: number;
  judged: number;
  n: number;
  agreement: number | null;
  kappa: number | null;
  kappaBand: string;
  tpr: number | null;
  tnr: number | null;
  precision: number | null;
  confusion: { tp: number; fp: number; fn: number; tn: number };
  humanPassRate: number | null;
  observedPassRate: number | null;
  correctedPassRate: number | null;
  correctedPassRateCi: [number, number] | null;
  correctionNote: string;
  warnings: string[];
  disagreements: { resultId: string; runId: string; check: 'pass' | 'fail'; human: 'pass' | 'fail'; note: string }[];
}

const kappaTone = (k: number | null) => (k === null ? 'neutral' : k > 0.6 ? 'ok' : k > 0.4 ? 'warn' : 'bad');

function Metric({ label, value, help, sub }: { label: string; value: string; help: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-raised px-3 py-2.5">
      <div className="flex items-center gap-1 text-[0.75rem] font-medium text-ink-muted">
        {label}
        <HelpTip>{help}</HelpTip>
      </div>
      <div className="mt-0.5 text-[1.125rem] font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[0.71875rem] text-ink-faint">{sub}</div>}
    </div>
  );
}

/** 2×2 grid: rows = what you said, columns = what the check said. */
function ConfusionGrid({ c }: { c: Agreement['confusion'] }) {
  const cell = (n: number, agree: boolean, tip: string) => (
    <Tip content={tip}>
      <div className={clsx('flex h-14 flex-col items-center justify-center rounded-lg text-[1.125rem] font-semibold tabular-nums', agree ? 'bg-ok-soft text-ok' : n > 0 ? 'bg-bad-soft text-bad' : 'bg-raised text-ink-faint')}>
        {n}
        <span className="text-[0.65625rem] font-medium uppercase tracking-wide opacity-80">{agree ? 'agree' : 'disagree'}</span>
      </div>
    </Tip>
  );
  return (
    <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-1.5 text-[0.75rem]">
      <div />
      <div className="text-center font-medium text-ink-muted">Check: pass</div>
      <div className="text-center font-medium text-ink-muted">Check: fail</div>
      <div className="pr-1 text-right font-medium text-ink-muted">You: pass</div>
      {cell(c.tp, true, 'You and the check both said pass')}
      {cell(c.fn, false, 'You said pass, the check failed it (the check is too strict here)')}
      <div className="pr-1 text-right font-medium text-ink-muted">You: fail</div>
      {cell(c.fp, false, 'You said fail, the check passed it (the check is too lenient here)')}
      {cell(c.tn, true, 'You and the check both said fail')}
    </div>
  );
}

export function AgreementPanel({
  data,
  loading,
  onOpenDisagreement,
  activeResultId,
}: {
  data: Agreement | undefined;
  loading: boolean;
  onOpenDisagreement: (resultId: string, runId: string) => void;
  activeResultId?: string | null;
}) {
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <SectionTitle
          help="How often your labels match the check. Only your own labels count (labels made by coding agents are excluded)."
          action={loading ? <Spinner /> : data ? <span className="text-[0.75rem] text-ink-faint">{data.n} labeled{data.scope === 'suite' ? ` · ${data.runs} runs` : ''}</span> : null}
        >
          Agreement
        </SectionTitle>
        {!data || data.n === 0 ? (
          <div className="text-[0.8125rem] text-ink-muted">Label a few rows and the numbers appear here. Aim for about 50 passes and 50 fails for a trustworthy picture.</div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2">
              <Metric label="Agreement" value={pct(data.agreement)} help="Share of labeled rows where you and the check gave the same verdict." />
              <div className="rounded-lg bg-raised px-3 py-2.5">
                <div className="flex items-center gap-1 text-[0.75rem] font-medium text-ink-muted">
                  Cohen's kappa
                  <HelpTip>Agreement after removing what you'd expect by pure chance. 1 = perfect, 0 = no better than chance. Above 0.6 is usually good enough to trust a judge.</HelpTip>
                </div>
                <div className="mt-0.5 text-[1.125rem] font-semibold tabular-nums">{data.kappa === null ? '–' : data.kappa.toFixed(2)}</div>
                <Badge tone={kappaTone(data.kappa) as any} className="mt-0.5">{data.kappaBand}</Badge>
              </div>
              <Metric label="Catches passes" value={pct(data.tpr)} help="True positive rate: of the rows you passed, how many the check also passed. Low = the check is too strict." sub="TPR" />
              <Metric label="Catches failures" value={pct(data.tnr)} help="True negative rate: of the rows you failed, how many the check also failed. Low = the check lets bad outputs through." sub="TNR" />
            </div>

            <ConfusionGrid c={data.confusion} />

            <div className="rounded-lg border border-line px-3 py-2.5">
              <div className="flex items-center gap-1 text-[0.75rem] font-medium text-ink-muted">
                Corrected pass rate
                <HelpTip>
                  The check's own pass rate, adjusted for the mistakes it makes on your labels. This is a better estimate of how often outputs are really good.
                </HelpTip>
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-[1.125rem] font-semibold tabular-nums">{pct(data.correctedPassRate)}</span>
                {data.correctedPassRateCi && (
                  <span className="text-[0.75rem] tabular-nums text-ink-faint">
                    95% CI {pct(data.correctedPassRateCi[0])}–{pct(data.correctedPassRateCi[1])}
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-[0.75rem] text-ink-faint">
                Check says {pct(data.observedPassRate)} over {data.judged} rows · you passed {pct(data.humanPassRate)} of your labels
              </div>
              {data.correctionNote && <div className="mt-1 text-[0.75rem] text-warn">{data.correctionNote}</div>}
            </div>

            {data.warnings.map((w) => (
              <div key={w} className="flex gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[0.78125rem] text-warn">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                {w}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle help="Rows where your label and the check disagree. Read a few: they show what to fix in the judge prompt, rubric or check settings.">
          Disagreements {data?.disagreements.length ? <span className="font-normal text-ink-faint">({data.disagreements.length})</span> : null}
        </SectionTitle>
        {!data?.disagreements.length ? (
          <div className="text-[0.8125rem] text-ink-muted">None yet.</div>
        ) : (
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {data.disagreements.map((d) => (
              <li key={d.resultId}>
                <button
                  type="button"
                  onClick={() => onOpenDisagreement(d.resultId, d.runId)}
                  className={clsx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.78125rem] hover:bg-hover', activeResultId === d.resultId && 'bg-accent-soft')}
                >
                  <span className="text-ink-muted">You</span>
                  <Badge tone={d.human === 'pass' ? 'ok' : 'bad'}>{d.human}</Badge>
                  <span className="text-ink-muted">check</span>
                  <Badge tone={d.check === 'pass' ? 'ok' : 'bad'}>{d.check}</Badge>
                  <span className="min-w-0 flex-1 truncate text-ink-faint">{d.note || d.resultId}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
