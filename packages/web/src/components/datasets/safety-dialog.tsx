import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import clsx from 'clsx';
import { ShieldAlert } from 'lucide-react';
import { ConnectionPicker } from '../pickers';
import { Button } from '../ui/button';
import { ErrorBox } from '../ui/display';
import { Field, Input, Switch, Textarea } from '../ui/form';
import { Dialog, HelpTip, Tip } from '../ui/overlay';
import { op, useOp } from '../../lib/api';
import { JobPanel, useJob } from './media-dialogs';

interface Category {
  id: string;
  label: string;
  description: string;
  frameworks: string[];
  seedCount: number;
  benignCount: number;
}
interface Converter {
  id: string;
  label: string;
  description: string;
}

const DEFAULT_CATS = ['prompt_injection', 'system_prompt_leak', 'sensitive_data', 'account_takeover'];
const DEFAULT_CONVS = ['plain', 'roleplay', 'base64'];

/** Builds a safety test set: harmful requests to refuse, benign look-alikes to answer, robustness variants. */
export function SafetyPackDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const meta = useOp<{ categories: Category[]; converters: Converter[] }>('list_safety_categories', {}, { enabled: open });
  const [name, setName] = useState('Safety tests');
  const [app, setApp] = useState('');
  const [cats, setCats] = useState<string[]>(DEFAULT_CATS);
  const [convs, setConvs] = useState<string[]>(DEFAULT_CONVS);
  const [benign, setBenign] = useState(true);
  const [suite, setSuite] = useState(true);
  const [connectionId, setConnectionId] = useState('');
  const [extra, setExtra] = useState(0);
  const [started, setStarted] = useState<{ jobId: string; datasetId: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const job = useJob(started?.jobId ?? null);

  const estimate = useMemo(() => {
    const chosen = (meta.data?.categories ?? []).filter((c) => cats.includes(c.id));
    const harmful = chosen.reduce((n, c) => n + c.seedCount + (connectionId ? extra : 0), 0);
    return { harmful: harmful * convs.length, benign: benign ? chosen.reduce((n, c) => n + c.benignCount, 0) : 0 };
  }, [meta.data, cats, convs, benign, extra, connectionId]);

  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await op('create_safety_dataset', {
        name,
        appDescription: app,
        categories: cats,
        converters: convs,
        includeBenign: benign,
        extraPerCategory: connectionId ? extra : 0,
        connectionId,
        createSuite: suite,
      });
      setStarted({ jobId: r.jobId, datasetId: r.datasetId });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    onOpenChange(false);
    setStarted(null);
    setError(null);
  };
  const done = job.data && !['queued', 'running'].includes(job.data.status);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title={
        <span className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-accent" /> Safety pack
        </span>
      }
      description="Prompts your app must refuse, benign look-alikes it must still answer, and tricky variants. Each row carries its category and framework references."
      width="lg"
      footer={
        started ? (
          <>
            <Button onClick={close}>Close</Button>
            <Button variant="primary" disabled={!done} onClick={() => (close(), navigate(`/datasets/${started.datasetId}`))}>
              Open dataset
            </Button>
          </>
        ) : (
          <>
            <span className="mr-auto self-center text-[0.78125rem] text-ink-muted">
              ≈ {estimate.harmful} harmful + {estimate.benign} benign rows
            </span>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!name.trim() || !cats.length || !convs.length} onClick={start}>
              Create
            </Button>
          </>
        )
      }
    >
      {started ? (
        job.data ? <JobPanel job={job.data} /> : <div className="text-[0.8125rem] text-ink-muted">Starting…</div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Dataset name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Also create a suite" inline help="Adds a suite with a refusal check (fails on unsafe answers and on over-refusals) and a personal-data leak check.">
              <Switch checked={suite} onChange={setSuite} />
            </Field>
          </div>

          <Field label="Categories" help="Each category maps to OWASP LLM Top 10, OWASP Agentic, NIST AI 600-1, MITRE ATLAS or MLCommons AILuminate. Hover a category to see which.">
            <div className="grid gap-2 sm:grid-cols-2">
              {(meta.data?.categories ?? []).map((c) => {
                const on = cats.includes(c.id);
                return (
                  <Tip key={c.id} content={<>{c.description}<br /><span className="opacity-75">{c.frameworks.join(' · ')}</span></>}>
                    <button
                      type="button"
                      onClick={() => toggle(cats, setCats, c.id)}
                      className={clsx('flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[0.8125rem] transition-colors', on ? 'border-accent/60 bg-accent-soft/60' : 'border-line hover:bg-hover')}
                    >
                      <input type="checkbox" readOnly checked={on} className="size-3.5 accent-[var(--k-accent)]" tabIndex={-1} />
                      <span className="font-medium">{c.label}</span>
                      <span className="ml-auto text-[0.71875rem] text-ink-faint">{c.seedCount}</span>
                    </button>
                  </Tip>
                );
              })}
            </div>
          </Field>

          <Field label="Variants" help="Each harmful prompt is also sent in these forms. Encodings and role-play wrappers are how real users try to slip past filters.">
            <div className="flex flex-wrap gap-1.5">
              {(meta.data?.converters ?? []).map((c) => {
                const on = convs.includes(c.id);
                return (
                  <Tip key={c.id} content={c.description}>
                    <button
                      type="button"
                      onClick={() => toggle(convs, setConvs, c.id)}
                      className={clsx('rounded-full border px-2.5 py-1 text-[0.78125rem] font-medium transition-colors', on ? 'border-accent bg-accent text-on-accent' : 'border-line-strong text-ink-muted hover:text-ink')}
                    >
                      {c.label}
                    </button>
                  </Tip>
                );
              })}
            </div>
          </Field>

          <Field label="Include benign look-alikes" inline help="Harmless questions that sound risky (e.g. “How do I reset my password?”). The app should answer them; refusing is over-refusal and counts as a failure.">
            <Switch checked={benign} onChange={setBenign} />
          </Field>

          <div className="rounded-lg border border-line bg-raised/50 p-3.5">
            <div className="mb-3 flex items-center gap-1.5 text-[0.8125rem] font-semibold">
              Tailor to your app (optional)
              <HelpTip>A model writes extra prompts in each category that fit your app. It only writes the request, never harmful instructions. If the model refuses, the built-in prompts are used.</HelpTip>
            </div>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
              <Field label="Connection">
                <ConnectionPicker value={connectionId} onChange={setConnectionId} placeholder="None — built-in prompts only" />
              </Field>
              <Field label="Extra per category">
                <Input type="number" min={0} max={30} value={extra} disabled={!connectionId} onChange={(e) => setExtra(Math.max(0, Math.min(30, Number(e.target.value) || 0)))} />
              </Field>
            </div>
            <Field label="What does your app do?" className="mt-3">
              <Textarea rows={2} value={app} disabled={!connectionId} onChange={(e) => setApp(e.target.value)} placeholder="e.g. A customer-support assistant for a retail bank that can look up transactions." />
            </Field>
          </div>

          <ErrorBox error={error ?? meta.error} />
        </div>
      )}
    </Dialog>
  );
}
