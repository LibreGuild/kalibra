import { Link } from '../lib/nav';
import clsx from 'clsx';
import { ArrowRight, Bot, CheckCircle2, Circle, Crosshair, Database, ListChecks, Play, Terminal, User } from 'lucide-react';
import { Page } from '../components/layout/shell';
import { buttonClass } from '../components/ui/button';
import { Badge, Card, CodeBlock, Loading, SectionTitle, StatusBadge } from '../components/ui/display';
import { TrendsCard } from '../components/trends';
import { useMeta, useOp } from '../lib/api';
import { useSession } from '../lib/session';
import { actorLabel, pct, timeAgo } from '../lib/format';

const STEPS = [
  { key: 'datasets', icon: Database, title: 'Add test data', body: 'Create a dataset: type rows, import CSV/JSONL, upload audio, generate with a model, or let your coding agent fill it.', to: '/datasets', cta: 'Datasets' },
  { key: 'targets', icon: Crosshair, title: 'Point at your app', body: 'Describe how to call it: an HTTP API, a WebSocket stream, a model + prompt, or your own script.', to: '/targets', cta: 'Targets' },
  { key: 'suites', icon: ListChecks, title: 'Decide what "good" means', body: 'Stack checks in layers: status and schema first, then WER, similarity or an LLM judge.', to: '/suites', cta: 'Suites' },
  { key: 'runs', icon: Play, title: 'Run and compare', body: 'Run the dataset through your app, read the failures, and compare against the last run.', to: '/runs', cta: 'Runs' },
] as const;

export function OverviewPage() {
  const ws = useOp<any>('get_workspace');
  const runs = useOp<{ runs: any[] }>('list_runs', { limit: 6 });
  const activity = useOp<any[]>('list_activity', { limit: 8 });
  const datasets = useOp<any[]>('list_datasets');
  const review = (datasets.data ?? []).filter((d) => d.reviewCount > 0);

  if (ws.isLoading) return <Loading />;
  const counts = ws.data ?? {};
  const { isServer } = useSession();
  const meta = useMeta();
  const done = STEPS.filter((s) => counts[s.key] > 0).length;

  return (
    <Page title="Overview" description={isServer ? 'Evaluate your AI applications together: your data, your app, your checks.' : 'Evaluate your AI applications locally: your data, your app, your checks.'}>
      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-6">
          {done < STEPS.length && (
            <Card>
              <SectionTitle action={<span className="text-[0.78125rem] text-ink-faint">{done} of {STEPS.length} done</span>}>Get started</SectionTitle>
              <ol className="flex flex-col divide-y divide-line">
                {STEPS.map((s) => {
                  const ok = counts[s.key] > 0;
                  return (
                    <li key={s.key} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                      {ok ? <CheckCircle2 className="mt-0.5 size-4.5 shrink-0 text-ok" /> : <Circle className="mt-0.5 size-4.5 shrink-0 text-ink-faint" />}
                      <div className="min-w-0 flex-1">
                        <div className={clsx('text-[0.875rem] font-medium', ok && 'text-ink-muted line-through decoration-ink-faint/50')}>{s.title}</div>
                        <div className="text-[0.8125rem] text-ink-muted">{s.body}</div>
                      </div>
                      <Link to={s.to} className={buttonClass(ok ? 'ghost' : 'secondary', 'sm')}>
                        {s.cta} <ArrowRight className="size-3.5" />
                      </Link>
                    </li>
                  );
                })}
              </ol>
              {/* The demo apps ship with the source code, so the hint only makes sense in development. */}
              {counts.datasets === 0 && meta.data?.mode === 'dev' && (
                <div className="mt-4 rounded-lg bg-raised p-3.5 text-[0.8125rem] text-ink-muted">
                  <div className="mb-2 font-medium text-ink">Want to look around first?</div>
                  Start the demo apps (a support chatbot and a speech-to-text service, batch and streaming) and fill this workspace with sample data:
                  <CodeBlock className="mt-2" value="npm run demo -- --seed" />
                </div>
              )}
            </Card>
          )}

          {review.length > 0 && (
            <Card className="border-warn/40 bg-warn-soft/40">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-[0.875rem] font-medium">Rows waiting for review</div>
                  <div className="text-[0.8125rem] text-ink-muted">Rows added by generators or coding agents start as "needs review" so a person can approve them.</div>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  {review.map((d) => (
                    <Link key={d.id} to={`/datasets/${d.id}?status=needs_review`} className={buttonClass('secondary', 'sm')}>
                      {d.name} <Badge tone="warn">{d.reviewCount}</Badge>
                    </Link>
                  ))}
                </div>
              </div>
            </Card>
          )}

          <Card padded={false}>
            <div className="px-5 pt-4">
              <SectionTitle action={<Link to="/runs" className="text-[0.78125rem] text-accent-ink hover:underline">All runs</Link>}>Recent runs</SectionTitle>
            </div>
            {(runs.data?.runs ?? []).length === 0 ? (
              <div className="px-5 pb-5 text-[0.8125rem] text-ink-muted">No runs yet.</div>
            ) : (
              <div className="divide-y divide-line border-t border-line">
                {runs.data!.runs.map((r) => (
                  <Link key={r.id} to={`/runs/${r.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-hover">
                    <span className="w-10 text-[0.78125rem] tabular-nums text-ink-faint">#{r.number}</span>
                    <span className="min-w-0 flex-1 truncate text-[0.84375rem] font-medium">{r.name}</span>
                    <StatusBadge status={r.status} />
                    <span className="w-20 text-right text-[0.84375rem] font-medium tabular-nums">{pct(r.summary?.passRate)}</span>
                    <span className="w-24 text-right text-[0.78125rem] text-ink-faint">{timeAgo(r.createdAt)}</span>
                  </Link>
                ))}
              </div>
            )}
          </Card>

          <TrendsCard />
        </div>

        <Card className="h-fit">
          <SectionTitle help="Every change is recorded with who made it: you, a coding agent over MCP, or the CLI.">Activity</SectionTitle>
          {(activity.data ?? []).length === 0 ? (
            <div className="text-[0.8125rem] text-ink-muted">Nothing yet.</div>
          ) : (
            <ul className="flex flex-col gap-3">
              {activity.data!.map((a) => {
                const Icon = a.actor?.kind === 'agent' ? Bot : a.actor?.kind === 'cli' ? Terminal : User;
                return (
                  <li key={a.id} className="flex gap-2.5">
                    <Icon className={clsx('mt-0.5 size-3.5 shrink-0', a.actor?.kind === 'agent' ? 'text-accent' : 'text-ink-faint')} />
                    <div className="min-w-0">
                      <div className="truncate text-[0.8125rem]">{a.summary}</div>
                      <div className="text-[0.75rem] text-ink-faint">
                        {actorLabel(a.actor)} · {timeAgo(a.at)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  );
}
