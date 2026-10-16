import { useEffect, useState } from 'react';
import { BrainCircuit, Download } from 'lucide-react';
import { Badge, Spinner } from '../../ui/display';
import { Button } from '../../ui/button';
import { HelpTip } from '../../ui/overlay';
import { toastError } from '../../ui/toast';
import { op, useOp } from '../../../lib/api';
import { JobPanel, useJob } from '../media-dialogs';
import type { EmbeddingsStatus } from './types';

/** Status of the free local embedding model, with a one-click download. */
export function LocalModelStatus({ compact }: { compact?: boolean }) {
  const status = useOp<EmbeddingsStatus>('embeddings_status', {}, { refetchInterval: (q: any) => (q.state.data?.local === 'downloading' ? 1500 : false) } as any);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ similarity: number; latencyMs: number } | null>(null);

  const download = async () => {
    try {
      const r = await op<{ jobId: string }>('download_embedding_model', {});
      setJobId(r.jobId);
    } catch (e) {
      toastError(e, 'Download failed to start');
    }
  };
  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await op('test_embeddings', {}));
    } catch (e) {
      toastError(e, 'Embedding test failed');
    } finally {
      setTesting(false);
    }
  };

  const jobDone = !!job.data && !['queued', 'running'].includes(job.data.status);
  const refetch = status.refetch;
  useEffect(() => {
    if (jobDone) refetch();
  }, [jobDone, refetch]);

  if (status.isLoading) return <Spinner />;
  const s = status.data;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <BrainCircuit className="size-4 text-ink-faint" />
        <span className="text-[0.84375rem] font-medium">Local embedding model</span>
        {s?.local === 'ready' && <Badge tone="ok" dot>Ready</Badge>}
        {s?.local === 'not_downloaded' && <Badge>Not downloaded</Badge>}
        {s?.local === 'downloading' && <Badge tone="info" dot>Downloading</Badge>}
        {s?.local === 'unavailable' && <Badge tone="warn" dot>Unavailable</Badge>}
        <HelpTip>
          A small model ({s?.model}) that runs on your computer. It powers meaning-based duplicate search and the "Meaning matches" check without any API key. One-time download of about {s?.downloadMb ?? 110} MB.
        </HelpTip>
        <div className="ml-auto flex gap-2">
          {s?.local === 'ready' ? (
            <Button size="sm" onClick={runTest} loading={testing}>
              Test
            </Button>
          ) : (
            s?.local !== 'downloading' &&
            (!jobId || jobDone) && (
              <Button size="sm" variant={compact ? 'secondary' : 'primary'} icon={<Download className="size-3.5" />} onClick={download}>
                Download (~{s?.downloadMb ?? 110} MB)
              </Button>
            )
          )}
        </div>
      </div>
      {s?.local === 'unavailable' && s.detail && <div className="text-[0.78125rem] text-warn">{s.detail}</div>}
      {test && (
        <div className="text-[0.78125rem] text-ink-muted">
          Two sentences with the same meaning scored {test.similarity} in {test.latencyMs} ms (1 = same meaning).
        </div>
      )}
      {job.data && !compact && <JobPanel job={job.data} />}
      {job.data && compact && !jobDone && <div className="text-[0.78125rem] text-ink-muted">{job.data.message || 'Downloading…'}</div>}
    </div>
  );
}
