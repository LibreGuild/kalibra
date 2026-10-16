import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { ArrowDownLeft, ArrowUpRight, Send } from 'lucide-react';
import { op, useOp } from '../../lib/api';
import { ms, preview } from '../../lib/format';
import { DatasetPicker } from '../pickers';
import { Button } from '../ui/button';
import { CodeEditor } from '../ui/code';
import { Badge, CodeBlock, ErrorBox, TabPanel, Tabs } from '../ui/display';
import { Field, Segmented, Select } from '../ui/form';
import { CellValue } from '../ui/media';
import { HelpTip } from '../ui/overlay';
import type { TargetSpec } from './model';

interface TestResult {
  ok: boolean;
  error?: string;
  retryable?: boolean;
  request?: unknown;
  response?: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
    text?: string;
    messages?: { t: number; dir: 'in' | 'out'; kind: string; data: unknown }[];
  };
  outputs: Record<string, unknown>;
  metrics: Record<string, number>;
  logs: { at: number; level: string; message: string }[];
  rowId: string;
  row: Record<string, unknown>;
}

/** Metrics shown as headline numbers, in display order. */
const KEY_METRICS: [string, string, string][] = [
  ['latency_ms', 'Total', 'Time for the whole call.'],
  ['ttfb_ms', 'First byte', 'Time until the response headers arrived.'],
  ['ttft_ms', 'First token', 'Time until the first streamed text arrived.'],
  ['connect_ms', 'Connect', 'Time to open the WebSocket connection.'],
  ['first_partial_ms', 'First partial', 'From the first audio frame sent to the first text received.'],
  ['final_latency_ms', 'Final latency', 'From the last audio frame sent to the last final result.'],
  ['rtf', 'Real-time factor', 'Processing time divided by audio length. Below 1 means faster than real time.'],
];

const LS_KEY = 'kalibra.try';

/** Keyed by target, so moving to another target starts from that target's remembered inputs. */
export function TryPanel({ spec, targetId }: { spec: TargetSpec; targetId: string }) {
  return <TryPanelInner key={targetId} spec={spec} targetId={targetId} />;
}

function TryPanelInner({ spec, targetId }: { spec: TargetSpec; targetId: string }) {
  const saved = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem(`${LS_KEY}.${targetId}`) ?? '{}');
    } catch {
      return {};
    }
  }, [targetId]);
  const [mode, setMode] = useState<'row' | 'custom'>(saved.mode ?? 'row');
  const [dataset, setDataset] = useState<string | undefined>(saved.dataset);
  const [rowId, setRowId] = useState<string | undefined>(saved.rowId);
  const [custom, setCustom] = useState<string>(saved.custom ?? '{\n  "input": "Hello"\n}');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState('outputs');

  useEffect(() => {
    try {
      localStorage.setItem(`${LS_KEY}.${targetId}`, JSON.stringify({ mode, dataset, rowId, custom }));
    } catch {
      /* storage unavailable */
    }
  }, [targetId, mode, dataset, rowId, custom]);

  const rows = useOp<{ rows: { id: string; seq: number; data: Record<string, unknown> }[] }>('list_rows', { dataset, limit: 50 }, { enabled: !!dataset && mode === 'row' });

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      let input: Record<string, unknown> = { spec };
      if (mode === 'custom') {
        let values: unknown;
        try {
          values = JSON.parse(custom);
        } catch {
          throw new Error('Custom values must be a JSON object, e.g. { "input": "Hello" }');
        }
        input = { ...input, values };
      } else {
        if (!dataset) throw new Error('Choose a dataset, or switch to custom values.');
        input = { ...input, dataset, rowId };
      }
      const res = await op<TestResult>('test_target', input);
      setResult(res);
      setTab(res.ok ? 'outputs' : 'response');
    } catch (e) {
      setError(e);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const otherMetrics = result ? Object.entries(result.metrics).filter(([k]) => !KEY_METRICS.some(([m]) => m === k)) : [];
  const messages = result?.response?.messages ?? [];

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[0.84375rem] font-semibold">
          Try it
          <HelpTip>Calls your app once with the settings on the left, even before you save. Nothing is stored.</HelpTip>
        </h3>
        <Segmented
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'row', label: 'Dataset row' },
            { value: 'custom', label: 'Custom values' },
          ]}
        />
      </div>

      {mode === 'row' ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Dataset">
            <DatasetPicker
              value={dataset}
              onChange={(d) => {
                setDataset(d);
                setRowId(undefined);
              }}
            />
          </Field>
          <Field label="Row" help="Defaults to the first row.">
            <Select
              value={rowId}
              onChange={setRowId}
              placeholder={!dataset ? 'Choose a dataset first' : rows.isLoading ? 'Loading…' : 'First row'}
              disabled={!dataset}
              options={(rows.data?.rows ?? []).map((r) => ({ value: r.id, label: `#${r.seq} ${rowPreview(r.data)}` }))}
            />
          </Field>
        </div>
      ) : (
        <Field label="Row values (JSON)" help="Values for the {{placeholders}}, as a JSON object keyed by column name.">
          <CodeEditor value={custom} onChange={setCustom} language="json" minHeight={80} maxHeight={220} />
        </Field>
      )}

      <Button variant="primary" icon={<Send className="size-3.5" />} loading={busy} onClick={send} className="self-start">
        Send
      </Button>

      <ErrorBox error={error} />

      {result && (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-2">
            {result.ok ? <Badge tone="ok" dot>Response received</Badge> : <Badge tone="bad" dot>Call failed</Badge>}
            {result.response?.status !== undefined && (
              <Badge tone={result.response.status < 400 ? 'ok' : 'bad'}>HTTP {result.response.status}</Badge>
            )}
            {result.retryable && <Badge tone="warn">Retryable</Badge>}
            <span className="text-[0.75rem] text-ink-faint">row {result.rowId}</span>
          </div>
          {result.error && <div className="rounded-lg border border-bad/30 bg-bad-soft px-3 py-2 text-[0.8125rem] break-words text-bad">{result.error}</div>}

          <div className="grid grid-cols-3 gap-2">
            {KEY_METRICS.filter(([k]) => result.metrics[k] !== undefined).map(([k, label, help]) => (
              <div key={k} className="rounded-lg bg-raised px-3 py-2">
                <div className="flex items-center gap-1 text-[0.71875rem] font-medium text-ink-muted">
                  {label}
                  <HelpTip>{help}</HelpTip>
                </div>
                <div className="text-[0.9375rem] font-semibold tabular-nums">{k === 'rtf' ? result.metrics[k].toFixed(2) : ms(result.metrics[k])}</div>
              </div>
            ))}
          </div>

          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'outputs', label: 'Outputs', count: Object.keys(result.outputs ?? {}).length },
              { value: 'response', label: 'Response' },
              { value: 'request', label: 'Request' },
              { value: 'logs', label: 'Logs', count: result.logs.length },
            ]}
          >
            <TabPanel value="outputs" className="pt-3">
              {Object.keys(result.outputs ?? {}).length === 0 ? (
                <div className="text-[0.8125rem] text-ink-muted">No outputs. Check the Outputs section: add a field named “output”.</div>
              ) : (
                <div className="flex flex-col gap-3">
                  {Object.entries(result.outputs).map(([k, v]) => (
                    <div key={k}>
                      <div className="mb-1 flex items-center gap-2 text-[0.75rem] font-medium text-ink-muted">
                        <code className="font-mono">{k}</code>
                        {k === 'output' && <Badge tone="accent">main</Badge>}
                      </div>
                      <div className="rounded-lg bg-raised px-3 py-2 text-[0.8125rem] break-words">
                        <CellValue value={v} full />
                      </div>
                    </div>
                  ))}
                  {otherMetrics.length > 0 && (
                    <div>
                      <div className="mb-1 text-[0.75rem] font-medium text-ink-muted">Other metrics</div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[0.78125rem]">
                        {otherMetrics.map(([k, v]) => (
                          <div key={k} className="flex justify-between gap-2">
                            <code className="font-mono text-ink-muted">{k}</code>
                            <span className="tabular-nums">{v}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </TabPanel>
            <TabPanel value="response" className="pt-3">
              <div className="flex flex-col gap-3">
                {messages.length > 0 && <MessageTimeline messages={messages} />}
                {result.response?.headers && Object.keys(result.response.headers).length > 0 && (
                  <div>
                    <div className="mb-1 text-[0.75rem] font-medium text-ink-muted">Headers</div>
                    <CodeBlock value={result.response.headers} maxHeight={160} />
                  </div>
                )}
                {(result.response?.body !== undefined || result.response?.text !== undefined) && (
                  <div>
                    <div className="mb-1 text-[0.75rem] font-medium text-ink-muted">Body</div>
                    <CodeBlock value={result.response.body !== undefined ? result.response.body : result.response.text} />
                  </div>
                )}
                {!result.response && <div className="text-[0.8125rem] text-ink-muted">No response was received.</div>}
              </div>
            </TabPanel>
            <TabPanel value="request" className="pt-3">
              <div className="mb-1 text-[0.75rem] text-ink-faint">Secret values are masked.</div>
              <CodeBlock value={result.request ?? 'No request was recorded.'} />
            </TabPanel>
            <TabPanel value="logs" className="pt-3">
              {result.logs.length === 0 ? (
                <div className="text-[0.8125rem] text-ink-muted">No log lines.</div>
              ) : (
                <div className="flex max-h-80 flex-col gap-0.5 overflow-y-auto rounded-lg bg-raised p-2 font-mono text-[0.75rem]">
                  {result.logs.map((l, i) => (
                    <div key={i} className={clsx('break-words', l.level === 'error' && 'text-bad', l.level === 'warn' && 'text-warn')}>
                      <span className="text-ink-faint">{l.level.padEnd(5)}</span> {l.message}
                    </div>
                  ))}
                </div>
              )}
            </TabPanel>
          </Tabs>
        </div>
      )}
    </div>
  );
}

function rowPreview(data: Record<string, unknown>) {
  const first = Object.values(data).find((v) => typeof v === 'string' && v.trim()) ?? Object.values(data)[0];
  return preview(first, 60);
}

function MessageTimeline({ messages }: { messages: NonNullable<TestResult['response']>['messages'] & {} }) {
  return (
    <div>
      <div className="mb-1 text-[0.75rem] font-medium text-ink-muted">Messages ({messages.length})</div>
      <div className="flex max-h-80 flex-col overflow-y-auto rounded-lg border border-line">
        {messages.map((m, i) => {
          const final = isFinalish(m.data);
          return (
            <div key={i} className="grid grid-cols-[60px_18px_88px_1fr] items-start gap-2 border-b border-line/60 px-2.5 py-1.5 text-[0.75rem] last:border-b-0">
              <span className="tabular-nums text-ink-faint">{m.t} ms</span>
              {m.dir === 'out' ? <ArrowUpRight className="mt-0.5 size-3.5 text-info" aria-label="sent" /> : <ArrowDownLeft className="mt-0.5 size-3.5 text-ok" aria-label="received" />}
              <span className="truncate text-ink-muted">
                {m.kind}
                {final !== undefined && (
                  <span className={clsx('ml-1 rounded px-1 text-[0.6875rem]', final ? 'bg-ok-soft text-ok' : 'bg-raised text-ink-faint')}>{final ? 'final' : 'partial'}</span>
                )}
              </span>
              <span className="min-w-0 truncate font-mono text-ink">{typeof m.data === 'string' ? m.data : JSON.stringify(m.data)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Best-effort partial/final hint for the timeline (the engine decides for real using the target settings). */
function isFinalish(data: unknown): boolean | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.is_final === 'boolean') return d.is_final;
  if (d.type === 'final') return true;
  if (d.type === 'partial') return false;
  return undefined;
}
