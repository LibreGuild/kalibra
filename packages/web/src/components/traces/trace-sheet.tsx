import { useState } from 'react';
import { DatabaseZap, ExternalLink } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge, CodeBlock, ErrorBox, Loading, TabPanel, Tabs } from '../ui/display';
import { Sheet } from '../ui/overlay';
import { CanEdit } from '../../lib/session';
import { Link } from '../../lib/nav';
import { useOp } from '../../lib/api';
import { dateTime, ms } from '../../lib/format';
import { SourcesList, SpanTree, ToolCallsList } from './span-tree';
import { stepsDigest, type Trace } from './types';

/*
 * One trace in detail: what came in, what went out, and every step in between. From here a trace
 * can become a dataset row (so a real conversation turns into a test case), and a trace that came
 * from an eval run links back to its run row.
 */

export const SOURCE_LABEL: Record<string, string> = { sdk: 'SDK', otel: 'OpenTelemetry', proxy: 'OpenAI proxy' };

export function TraceSheet({ traceId, onClose, onAddToDataset }: { traceId: string | null; onClose: () => void; onAddToDataset?: (ids: string[]) => void }) {
  const [tab, setTab] = useState('steps');
  const q = useOp<Trace>('get_trace', { id: traceId }, { enabled: !!traceId });
  const t = q.data;
  const spans = t?.spans ?? [];
  const { sources, toolCalls } = stepsDigest(spans, (t?.output && typeof t.output === 'object' ? t.output : undefined) as any);
  const meta = Object.entries(t?.metadata ?? {});

  return (
    <Sheet
      open={!!traceId}
      onOpenChange={(o) => !o && onClose()}
      title={t?.name ?? 'Trace'}
      subtitle={t ? [SOURCE_LABEL[t.source] ?? t.source, dateTime(t.startedAt), ms(t.durationMs)].join(' · ') : undefined}
      actions={
        t && (
          <>
            <Badge tone={t.status === 'error' ? 'bad' : 'ok'} dot>
              {t.status === 'error' ? 'Error' : 'OK'}
            </Badge>
            {onAddToDataset && (
              <CanEdit>
                <Button size="sm" icon={<DatabaseZap className="size-3.5" />} onClick={() => onAddToDataset([t.id])}>
                  Add to dataset
                </Button>
              </CanEdit>
            )}
          </>
        )
      }
      width={860}
    >
      {q.isLoading || !t ? (
        q.error ? (
          <div className="p-5">
            <ErrorBox error={q.error} />
          </div>
        ) : (
          <Loading />
        )
      ) : (
        <div className="px-5 py-4">
          {t.error && (
            <div className="mb-4">
              <ErrorBox error={{ message: t.error }} />
            </div>
          )}
          {t.runId && (
            <div className="mb-4 flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-[0.8125rem] text-ink-muted">
              This call came from an eval run.
              <Link to={`/runs/${t.runId}${t.resultId ? `?result=${encodeURIComponent(t.resultId)}` : ''}`} className="inline-flex items-center gap-1 font-medium text-accent-ink hover:underline">
                Open the run row <ExternalLink className="size-3.5" />
              </Link>
            </div>
          )}
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'steps', label: 'Steps', count: spans.length },
              { value: 'io', label: 'Input & output' },
              { value: 'meta', label: 'Details', count: meta.length + (t.tags?.length ?? 0) },
            ]}
          >
            <TabPanel value="steps" className="flex flex-col gap-5 pt-4">
              {(sources.length > 0 || toolCalls.length > 0) && (
                <div className="grid gap-4 md:grid-cols-2">
                  {toolCalls.length > 0 && (
                    <div>
                      <div className="mb-1.5 text-[0.75rem] font-semibold uppercase tracking-wide text-ink-faint">Tool calls ({toolCalls.length})</div>
                      <ToolCallsList calls={toolCalls} />
                    </div>
                  )}
                  {sources.length > 0 && (
                    <div>
                      <div className="mb-1.5 text-[0.75rem] font-semibold uppercase tracking-wide text-ink-faint">Retrieved ({sources.length})</div>
                      <SourcesList sources={sources} />
                    </div>
                  )}
                </div>
              )}
              <SpanTree spans={spans} empty="This trace has no steps: only its input and output were recorded." />
            </TabPanel>
            <TabPanel value="io" className="flex flex-col gap-4 pt-4">
              <div>
                <div className="mb-1.5 text-[0.75rem] font-semibold uppercase tracking-wide text-ink-faint">Input</div>
                <CodeBlock value={t.input ?? '—'} maxHeight={320} />
              </div>
              <div>
                <div className="mb-1.5 text-[0.75rem] font-semibold uppercase tracking-wide text-ink-faint">Output</div>
                <CodeBlock value={t.output ?? '—'} maxHeight={420} />
              </div>
            </TabPanel>
            <TabPanel value="meta" className="flex flex-col gap-4 pt-4">
              {t.tags && t.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {t.tags.map((tag) => (
                    <Badge key={tag}>{tag}</Badge>
                  ))}
                </div>
              )}
              <div className="divide-y divide-line rounded-lg border border-line">
                {[['Trace id', t.id] as const, ['Source', SOURCE_LABEL[t.source] ?? t.source] as const, ...meta].map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[160px_1fr] gap-3 px-3 py-2 text-[0.8125rem]">
                    <span className="truncate font-mono text-[0.75rem] text-ink-muted">{k}</span>
                    <span className="min-w-0 break-words font-mono text-[0.78125rem]">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
                  </div>
                ))}
              </div>
            </TabPanel>
          </Tabs>
        </div>
      )}
    </Sheet>
  );
}
