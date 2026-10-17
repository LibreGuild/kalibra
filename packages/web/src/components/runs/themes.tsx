import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CircleStop, Sparkles } from 'lucide-react';
import { ConnectionPicker } from '../pickers';
import { Button } from '../ui/button';
import { Badge, EmptyState, ErrorBox, Loading, Progress, SectionTitle } from '../ui/display';
import { Field, Input } from '../ui/form';
import { HelpTip, Popover, Tip } from '../ui/overlay';
import { toastError } from '../ui/toast';
import { op, useOp } from '../../lib/api';
import { CanEdit } from '../../lib/session';
import { pct, timeAgo } from '../../lib/format';
import { useJob } from '../datasets/media-dialogs';

/*
 * Failure themes for a run: quick groups (free, instant) and AI themes (named clusters with a
 * likely cause and a fix). Clicking a group or theme filters the results grid to those rows.
 */

interface Example {
  resultId: string;
  input: string;
  output: string;
  reason: string;
}
interface FreeGroup {
  key: string;
  checkName: string;
  pattern: string;
  count: number;
  share: number;
  resultIds: string[];
  examples: Example[];
}
interface Theme {
  id: string;
  title: string;
  explanation: string;
  cause: string;
  fix: string;
  severity: 'low' | 'medium' | 'high';
  count: number;
  resultIds: string[];
  examples: Example[];
}
interface ThemesResp {
  totalFailures: number;
  groups: FreeGroup[];
  ai: null | { createdAt: string; method: 'embeddings' | 'llm'; model: string; analyzed: number; totalFailures: number; truncated: boolean; embeddingNote?: string; themes: Theme[] };
}

const SEVERITY_TONE = { high: 'bad', medium: 'warn', low: 'neutral' } as const;
const CONN_KEY = 'kalibra.themes.connection';

const readConn = () => {
  try {
    return localStorage.getItem(CONN_KEY) ?? '';
  } catch {
    return '';
  }
};

function ShareBar({ share }: { share: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
      <div className="h-full rounded-full bg-bad/70" style={{ width: `${Math.max(2, share * 100)}%` }} />
    </div>
  );
}

function FindThemesButton({ runId, onStarted, busy }: { runId: string; onStarted: (jobId: string) => void; busy: boolean }) {
  const [connectionId, setConnectionId] = useState(readConn);
  const [model, setModel] = useState('');
  const [starting, setStarting] = useState(false);
  const start = async () => {
    setStarting(true);
    try {
      try {
        localStorage.setItem(CONN_KEY, connectionId);
      } catch {
        /* remember only for this session */
      }
      const r = await op<{ jobId: string }>('cluster_failures', { runId, connectionId, model });
      onStarted(r.jobId);
    } catch (e) {
      toastError(e, 'Could not start');
    } finally {
      setStarting(false);
    }
  };
  return (
    <Popover
      align="end"
      className="w-80"
      trigger={
        <Button variant="primary" size="sm" icon={<Sparkles className="size-3.5" />} disabled={busy}>
          Find themes with AI
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="text-[0.8125rem] text-ink-muted">A model reads the failures, groups them into themes and suggests a likely cause and fix for each. It makes a few small calls.</div>
        <Field label="Connection">
          <ConnectionPicker value={connectionId} onChange={setConnectionId} placeholder="Choose a model connection" />
        </Field>
        <Field label="Model" help="Leave empty to use the connection's default text model.">
          <Input mono value={model} onChange={(e) => setModel(e.target.value)} placeholder="default" />
        </Field>
        <Button variant="primary" loading={starting} disabled={!connectionId} onClick={start}>
          Start
        </Button>
      </div>
    </Popover>
  );
}

export function ThemesPanel({ runId, onFilter }: { runId: string; onFilter?: (resultIds: string[], title: string) => void }) {
  const qc = useQueryClient();
  const q = useOp<ThemesResp>('get_failure_themes', { runId });
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const running = job.data && (job.data.status === 'queued' || job.data.status === 'running');
  const result: any = job.data?.result;

  useEffect(() => {
    if (job.data && !running) qc.invalidateQueries({ queryKey: ['get_failure_themes'] });
  }, [job.data?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const data = q.data!;
  if (data.totalFailures === 0) {
    return <EmptyState title="No failures in this run">Every row passed, so there is nothing to group. Themes appear here when rows fail.</EmptyState>;
  }

  const filter = (ids: string[], title: string) => onFilter?.(ids, title);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[0.875rem] text-ink-muted">
          <span className="font-semibold text-ink">{data.totalFailures}</span> failed {data.totalFailures === 1 ? 'row' : 'rows'}
          {onFilter && <span> · click a group to see its rows</span>}
        </div>
        {/* Asks a model, so it needs the editor role. */}
        <CanEdit>
          <FindThemesButton runId={runId} onStarted={setJobId} busy={!!running} />
        </CanEdit>
      </div>

      {running && job.data && (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3.5">
          <div className="flex items-center justify-between gap-3 text-[0.8125rem]">
            <span className="text-ink-muted">{job.data.message || 'Reading failures…'}</span>
            <Button size="sm" variant="ghost" icon={<CircleStop className="size-3.5" />} onClick={() => op('cancel_job', { jobId: job.data!.id }).catch(toastError)}>
              Stop
            </Button>
          </div>
          <Progress value={job.data.total ? job.data.done / job.data.total : 0.05} />
        </div>
      )}
      {!running && job.data?.status === 'failed' && <ErrorBox error={new Error(job.data.error ?? 'Finding themes failed')} />}
      {!running && result?.fallback && (
        <div className="rounded-lg border border-warn/40 bg-warn-soft/50 px-3.5 py-2.5 text-[0.8125rem]">
          The model could not group these failures ({result.error}). The quick groups below still work.
        </div>
      )}

      {data.ai && data.ai.themes.length > 0 && (
        <section>
          <SectionTitle
            help="Failures clustered by meaning and named by a model. Treat the cause and fix as a starting point to check, not a verdict."
            action={
              <span className="text-[0.75rem] text-ink-faint">
                {data.ai.model} · {timeAgo(data.ai.createdAt)}
                {data.ai.truncated && ` · first ${data.ai.analyzed} of ${data.ai.totalFailures}`}
              </span>
            }
          >
            AI themes
          </SectionTitle>
          {data.ai.embeddingNote && <div className="mb-3 text-[0.75rem] text-ink-faint">{data.ai.embeddingNote}</div>}
          <div className="grid gap-3 md:grid-cols-2">
            {data.ai.themes.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => filter(t.resultIds, t.title)}
                className={clsx('flex flex-col gap-2 rounded-xl border border-line bg-surface p-4 text-left transition-colors', onFilter && 'hover:border-line-strong hover:bg-hover')}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="text-[0.9375rem] font-semibold leading-snug">{t.title}</div>
                  <Badge tone={SEVERITY_TONE[t.severity]}>{t.severity}</Badge>
                </div>
                <div className="flex items-center gap-2 text-[0.75rem] text-ink-muted">
                  <span className="shrink-0 tabular-nums">
                    {t.count} {t.count === 1 ? 'row' : 'rows'} · {pct(t.count / (data.ai!.analyzed || 1), 0)}
                  </span>
                  <ShareBar share={t.count / (data.ai!.analyzed || 1)} />
                </div>
                {t.explanation && <p className="text-[0.84375rem] leading-relaxed">{t.explanation}</p>}
                {(t.cause || t.fix) && (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.8125rem]">
                    {t.cause && (
                      <>
                        <dt className="text-ink-faint">Likely cause</dt>
                        <dd className="text-ink-muted">{t.cause}</dd>
                      </>
                    )}
                    {t.fix && (
                      <>
                        <dt className="text-ink-faint">Try</dt>
                        <dd className="text-ink-muted">{t.fix}</dd>
                      </>
                    )}
                  </dl>
                )}
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionTitle help="Instant and free: failures grouped by the first check they failed and the shape of the reason (numbers and quoted values ignored).">Quick groups</SectionTitle>
        <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {data.groups.map((g) => (
            <button
              key={g.key}
              type="button"
              onClick={() => filter(g.resultIds, `${g.checkName}: ${g.pattern}`)}
              className={clsx('grid w-full grid-cols-[minmax(0,1fr)_7rem] items-start gap-4 px-4 py-3 text-left', onFilter && 'hover:bg-hover')}
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge className="shrink-0">{g.checkName}</Badge>
                  <span className="truncate text-[0.84375rem]">{g.pattern}</span>
                </div>
                {g.examples[0] && (
                  <Tip
                    content={
                      <div className="flex flex-col gap-1.5">
                        {g.examples.map((e) => (
                          <div key={e.resultId}>
                            <div className="opacity-75">{e.input}</div>
                            <div>→ {e.output || '(no output)'}</div>
                          </div>
                        ))}
                      </div>
                    }
                  >
                    <div className="mt-1 truncate text-[0.78125rem] text-ink-faint">
                      e.g. {g.examples[0].input} → {g.examples[0].output || '(no output)'}
                    </div>
                  </Tip>
                )}
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <span className="text-[0.8125rem] tabular-nums">
                  {g.count} · {pct(g.share, 0)}
                </span>
                <ShareBar share={g.share} />
              </div>
            </button>
          ))}
        </div>
      </section>
      {!data.ai && !running && (
        <div className="flex items-center gap-1.5 text-[0.78125rem] text-ink-faint">
          Want named themes with likely causes? Use “Find themes with AI”.
          <HelpTip>Clusters failures with local text embeddings when available, then a model names each cluster. Without embeddings, the model groups them directly.</HelpTip>
        </div>
      )}
    </div>
  );
}
