import { useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Badge, CodeBlock, ErrorBox, Loading, StatusBadge, TabPanel, Tabs } from '../ui/display';
import { Sheet } from '../ui/overlay';
import { CellValue } from '../ui/media';
import { useOp } from '../../lib/api';
import { dateTime, ms } from '../../lib/format';
import { formatMetric } from './format';

export interface CheckResultView {
  id: string;
  type: string;
  name: string;
  layer: number;
  gate: boolean;
  status: 'pass' | 'fail' | 'skip' | 'error';
  score?: number;
  value?: number;
  threshold?: number;
  reason?: string;
  details?: Record<string, any>;
  durationMs?: number;
}

/* ── WER alignment diff ───────────────────────────────────────────────────── */

export function AlignmentDiff({ ops }: { ops: { op: 'equal' | 'sub' | 'del' | 'ins'; ref?: string; hyp?: string }[] }) {
  return (
    <div className="rounded-lg border border-line bg-raised px-3 py-2.5 font-mono text-[12.5px] leading-7">
      {ops.map((o, i) => {
        const sep = i > 0 ? ' ' : '';
        if (o.op === 'equal') return <span key={i}>{sep}{o.ref}</span>;
        if (o.op === 'sub')
          return (
            <span key={i}>
              {sep}
              <span className="rounded bg-bad-soft px-0.5 text-bad line-through">{o.ref}</span>
              <span className="ml-0.5 rounded bg-ok-soft px-0.5 text-ok">{o.hyp}</span>
            </span>
          );
        if (o.op === 'del')
          return (
            <span key={i}>
              {sep}
              <span className="rounded bg-bad-soft px-0.5 text-bad line-through">{o.ref}</span>
            </span>
          );
        return (
          <span key={i}>
            {sep}
            <span className="rounded bg-ok-soft px-0.5 text-ok underline decoration-2 underline-offset-2">{o.hyp}</span>
          </span>
        );
      })}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-3 text-[11.5px] text-ink-faint">
      <span><span className="rounded bg-bad-soft px-1 text-bad line-through">word</span> missing / replaced (reference)</span>
      <span><span className="rounded bg-ok-soft px-1 text-ok">word</span> what the app said instead</span>
      <span><span className="rounded bg-ok-soft px-1 text-ok underline">word</span> extra word</span>
    </div>
  );
}

function CheckDetails({ c }: { c: CheckResultView }) {
  const d = c.details;
  if (!d || Object.keys(d).length === 0) return null;
  if (Array.isArray(d.ops)) {
    return (
      <div className="mt-2.5 flex flex-col gap-2">
        <AlignmentDiff ops={d.ops} />
        <Legend />
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-muted tabular-nums">
          <span>{d.hits ?? 0} correct</span>
          <span>{d.subs ?? 0} substituted</span>
          <span>{d.dels ?? 0} deleted</span>
          <span>{d.ins ?? 0} inserted</span>
          <span>{d.refUnits ?? '–'} reference {d.metric === 'cer' ? 'characters' : 'words'}</span>
          {d.normalizer && <span>normalizer: {d.normalizer}</span>}
          {d.opsTruncated && <span className="text-warn">alignment truncated</span>}
        </div>
        <details className="text-[12.5px]">
          <summary className="cursor-pointer text-ink-muted hover:text-ink">Normalized texts</summary>
          <div className="mt-2 grid gap-2">
            <div><span className="text-ink-faint">Reference: </span><span className="font-mono">{d.normalizedRef}</span></div>
            <div><span className="text-ink-faint">Output: </span><span className="font-mono">{d.normalizedHyp}</span></div>
          </div>
        </details>
      </div>
    );
  }
  if (c.type === 'llm_judge' && (d.reasoning || d.verdicts)) {
    return (
      <div className="mt-2.5 flex flex-col gap-2">
        {d.reasoning && <div className="whitespace-pre-wrap rounded-lg bg-raised px-3 py-2 text-[13px]">{d.reasoning}</div>}
        {Array.isArray(d.verdicts) && d.verdicts.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-muted">
            Votes:
            {d.verdicts.map((v: string, i: number) => (
              <Badge key={i} tone={v === 'pass' ? 'ok' : 'bad'}>{v}</Badge>
            ))}
          </div>
        )}
        {d.usage && (
          <div className="text-[12px] text-ink-faint">
            {d.usage.model} · {d.usage.inputTokens ?? '?'} in / {d.usage.outputTokens ?? '?'} out tokens · {ms(d.usage.latencyMs)}
          </div>
        )}
        {d.prompt && (
          <details className="text-[12.5px]">
            <summary className="cursor-pointer text-ink-muted hover:text-ink">Prompt sent to the judge</summary>
            <CodeBlock value={d.prompt} className="mt-2" maxHeight={260} />
          </details>
        )}
      </div>
    );
  }
  return (
    <details className="mt-2 text-[12.5px]">
      <summary className="cursor-pointer text-ink-muted hover:text-ink">Details</summary>
      <CodeBlock value={d} className="mt-2" maxHeight={260} />
    </details>
  );
}

export function CheckList({ checks }: { checks: CheckResultView[] }) {
  const sorted = [...checks].sort((a, b) => a.layer - b.layer);
  return (
    <div className="flex flex-col gap-2">
      {sorted.map((c) => (
        <div key={c.id} className={clsx('rounded-lg border px-3.5 py-2.5', c.status === 'fail' || c.status === 'error' ? 'border-bad/30' : 'border-line')}>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={c.status} />
            <span className="text-[13.5px] font-medium">{c.name}</span>
            <span className="text-[12px] text-ink-faint">layer {c.layer}{c.gate ? ' · gate' : ''}</span>
            <span className="ml-auto text-[12.5px] tabular-nums text-ink-muted">
              {c.value !== undefined && c.value !== null && <>value {formatMetric(c.type, c.value)}</>}
              {c.threshold !== undefined && c.threshold !== null && <> · limit {formatMetric(c.type, c.threshold)}</>}
              {c.durationMs ? <> · {ms(c.durationMs)}</> : null}
            </span>
          </div>
          {c.reason && <div className="mt-1 text-[13px] text-ink-muted">{c.reason}</div>}
          <CheckDetails c={c} />
        </div>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-faint">{title}</h4>
      {children}
    </section>
  );
}

function KeyValues({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data ?? {});
  if (!entries.length) return <div className="text-[13px] text-ink-faint">None</div>;
  return (
    <div className="divide-y divide-line rounded-lg border border-line">
      {entries.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[140px_1fr] gap-3 px-3 py-2 text-[13px]">
          <div className="truncate font-mono text-[12px] text-ink-muted">{k}</div>
          <div className="min-w-0 break-words">
            <CellValue value={v} full />
          </div>
        </div>
      ))}
    </div>
  );
}

function MessagesTimeline({ messages }: { messages: { t: number; dir: 'in' | 'out'; kind: string; data: unknown }[] }) {
  return (
    <div className="flex flex-col gap-1">
      {messages.map((m, i) => (
        <div key={i} className="grid grid-cols-[64px_32px_1fr] items-start gap-2 text-[12px]">
          <span className="text-right tabular-nums text-ink-faint">{Math.round(m.t)} ms</span>
          <Badge tone={m.dir === 'out' ? 'accent' : 'info'}>{m.dir === 'out' ? '→' : '←'}</Badge>
          <span className="min-w-0 break-all font-mono text-ink">
            <span className="mr-1.5 text-ink-faint">{m.kind}</span>
            {typeof m.data === 'string' ? m.data : JSON.stringify(m.data)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Full detail of one result: inputs, outputs, every check, raw request/response, metrics, logs. */
export function ResultSheet({ resultId, onClose, title }: { resultId: string | null; onClose: () => void; title?: string }) {
  const [tab, setTab] = useState('overview');
  const q = useOp<any>('get_result', { resultId }, { enabled: !!resultId });
  const r = q.data;
  return (
    <Sheet
      open={!!resultId}
      onOpenChange={(o) => !o && onClose()}
      title={title ?? (r ? `Row ${r.seq + 1}${r.rep ? ` · repetition ${r.rep + 1}` : ''}` : 'Result')}
      subtitle={r ? `${r.rowId} · ${r.attempts} attempt${r.attempts === 1 ? '' : 's'} · ${dateTime(r.finishedAt)}` : undefined}
      actions={r && <StatusBadge status={r.passed === null ? r.status : r.passed ? 'pass' : 'fail'} />}
      width={820}
    >
      {q.isLoading || !r ? (
        q.error ? <div className="p-5"><ErrorBox error={q.error} /></div> : <Loading />
      ) : (
        <div className="px-5 py-4">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'overview', label: 'Overview' },
              { value: 'request', label: 'Request' },
              { value: 'response', label: 'Response' },
              { value: 'metrics', label: 'Metrics' },
              { value: 'logs', label: 'Logs', count: r.logs?.length ?? 0 },
            ]}
          >
            <TabPanel value="overview" className="flex flex-col gap-6 pt-4">
              {r.error && <ErrorBox error={{ message: r.error }} />}
              <Section title="Checks">
                {r.checks?.length ? <CheckList checks={r.checks} /> : <div className="text-[13px] text-ink-faint">No checks ran.</div>}
              </Section>
              <Section title="Outputs">
                <KeyValues data={r.outputs ?? {}} />
              </Section>
              <Section title="Inputs (dataset row)">
                <KeyValues data={r.input ?? {}} />
              </Section>
            </TabPanel>
            <TabPanel value="request" className="pt-4">
              <CodeBlock value={r.request ?? 'No request recorded (imported outputs).'} maxHeight={600} />
            </TabPanel>
            <TabPanel value="response" className="flex flex-col gap-4 pt-4">
              {!r.response ? (
                <div className="text-[13px] text-ink-faint">No response recorded.</div>
              ) : (
                <>
                  {r.response.status !== undefined && (
                    <div className="text-[13px]">
                      Status <span className="font-mono font-semibold">{r.response.status}</span>
                    </div>
                  )}
                  {r.response.headers && (
                    <details className="text-[12.5px]">
                      <summary className="cursor-pointer text-ink-muted hover:text-ink">Headers</summary>
                      <CodeBlock value={r.response.headers} className="mt-2" maxHeight={240} />
                    </details>
                  )}
                  {r.response.body !== undefined ? (
                    <CodeBlock value={r.response.body} maxHeight={520} />
                  ) : r.response.text !== undefined ? (
                    <CodeBlock value={r.response.text} maxHeight={520} />
                  ) : null}
                  {Array.isArray(r.response.messages) && r.response.messages.length > 0 && (
                    <Section title={`Messages (${r.response.messages.length})`}>
                      <div className="max-h-[480px] overflow-auto rounded-lg border border-line p-3">
                        <MessagesTimeline messages={r.response.messages} />
                      </div>
                    </Section>
                  )}
                </>
              )}
            </TabPanel>
            <TabPanel value="metrics" className="pt-4">
              <div className="divide-y divide-line rounded-lg border border-line">
                {Object.entries(r.metrics ?? {}).map(([k, v]) => (
                  <div key={k} className="flex justify-between px-3 py-2 text-[13px]">
                    <span className="font-mono text-[12px] text-ink-muted">{k}</span>
                    <span className="tabular-nums">{k.endsWith('_ms') ? ms(v as number) : String(v)}</span>
                  </div>
                ))}
                {Object.keys(r.metrics ?? {}).length === 0 && <div className="px-3 py-4 text-[13px] text-ink-faint">No metrics.</div>}
              </div>
            </TabPanel>
            <TabPanel value="logs" className="pt-4">
              {(r.logs ?? []).length === 0 ? (
                <div className="text-[13px] text-ink-faint">No logs.</div>
              ) : (
                <div className="flex flex-col gap-1 font-mono text-[12px]">
                  {r.logs.map((l: any, i: number) => (
                    <div key={i} className={clsx('break-words', l.level === 'error' ? 'text-bad' : l.level === 'warn' ? 'text-warn' : 'text-ink-muted')}>
                      <span className="mr-2 text-ink-faint">{new Date(l.at).toLocaleTimeString()}</span>
                      {l.message}
                    </div>
                  ))}
                </div>
              )}
            </TabPanel>
          </Tabs>
        </div>
      )}
    </Sheet>
  );
}
