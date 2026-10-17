import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '../lib/nav';
import { useCanEdit } from '../lib/session';
import { CircleStop, FlaskConical, Play } from 'lucide-react';
import { Page } from '../components/layout/shell';
import { DatasetPicker, SuitePicker } from '../components/pickers';
import { Button } from '../components/ui/button';
import { Card, EmptyState, ErrorBox, Kbd, Progress, SectionTitle } from '../components/ui/display';
import { Field, Input, Segmented } from '../components/ui/form';
import { CodeEditor } from '../components/ui/code';
import { Dialog, HelpTip, Tip } from '../components/ui/overlay';
import { toast, toastError } from '../components/ui/toast';
import { emptyVariant, templateVars, ValuesEditor, VariantsEditor, type VariantDraft } from '../components/playground/editors';
import { PlaygroundGrid, type PlaygroundResult } from '../components/playground/results';
import { useJob } from '../components/datasets/media-dialogs';
import { op, useOp } from '../lib/api';

/*
 * A quick-experiment space: one prompt, a few rows, up to four models side by side.
 * The draft is kept in this browser so it survives reloads. Save a variant as a target to
 * run it on a whole dataset.
 */

interface Draft {
  system: string;
  prompt: string;
  source: 'dataset' | 'values';
  dataset: string;
  limit: number;
  values: Record<string, string>[];
  variants: VariantDraft[];
  suite: string;
}

const DRAFT_KEY = 'kalibra.playground';
const INITIAL: Draft = {
  system: '',
  prompt: 'Answer the customer in two sentences:\n\n{{question}}',
  source: 'values',
  dataset: '',
  limit: 5,
  values: [{ question: 'How do I reset my password?' }],
  variants: [emptyVariant()],
  suite: '',
};

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? { ...INITIAL, ...JSON.parse(raw) } : INITIAL;
  } catch {
    return INITIAL;
  }
}

export function PlaygroundPage() {
  const canEdit = useCanEdit();
  const navigate = useNavigate();
  const [d, setD] = useState<Draft>(loadDraft);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState<number | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  // What the shown results were produced with, so saving uses that even if the form changed since.
  const [ran, setRan] = useState<Pick<Draft, 'system' | 'prompt' | 'variants'> | null>(null);
  const job = useJob(jobId);
  const running = starting || (job.data && (job.data.status === 'queued' || job.data.status === 'running'));

  const connections = useOp<any[]>('list_connections');
  const defaults = useMemo(() => Object.fromEntries((connections.data ?? []).map((c) => [c.id, c.spec?.defaultModel ?? ''])), [connections.data]);
  const schema = useOp<any>('get_dataset_schema', { dataset: d.dataset, sampleRows: 0 }, { enabled: d.source === 'dataset' && !!d.dataset });

  const usedVars = templateVars(d.prompt, d.system);
  const columns: string[] = schema.data?.columns?.map((c: any) => c.key) ?? [];
  const missing = d.source === 'dataset' ? usedVars.filter((v) => columns.length && !columns.includes(v)) : [];

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch {
      /* draft lasts for this session only */
    }
  }, [d]);

  useEffect(() => {
    if (!job.data) return;
    if (job.data.status === 'completed') setResult(job.data.result as PlaygroundResult);
    if (job.data.status === 'failed') setError(new Error(job.data.error ?? 'The playground run failed'));
  }, [job.data?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = !!d.prompt.trim() && d.variants.every((v) => v.connectionId) && (d.source === 'dataset' ? !!d.dataset : d.values.length > 0);

  const run = async () => {
    if (!ready || running) return;
    setStarting(true);
    setError(null);
    setResult(null);
    setJobId(null);
    setRan({ system: d.system, prompt: d.prompt, variants: d.variants });
    try {
      const r = await op<any>('playground_run', {
        system: d.system,
        prompt: d.prompt,
        variants: d.variants.map((v) => ({ connectionId: v.connectionId, model: v.model, temperature: v.temperature === '' ? undefined : Number(v.temperature), label: v.label })),
        ...(d.source === 'dataset' ? { dataset: d.dataset, limit: d.limit } : { values: d.values }),
        suite: d.suite || undefined,
      });
      if (r.result) setResult(r.result);
      else setJobId(r.jobId);
    } catch (e) {
      setError(e);
    } finally {
      setStarting(false);
    }
  };

  // ⌘↵ / Ctrl+↵ runs from anywhere on the page.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not while a dialog (e.g. "Save as a target") is open on top of the page.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !document.querySelector('[role="dialog"]')) {
        e.preventDefault();
        runRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const targetInput = (v: VariantDraft, name: string) => ({
    name,
    system: ran!.system,
    prompt: ran!.prompt,
    connectionId: v.connectionId,
    model: v.model,
    temperature: v.temperature === '' ? undefined : Number(v.temperature),
  });

  /** Saves every variant as a target, then runs them on the whole dataset: one run, or a comparison of several. */
  const fullEval = async () => {
    if (!ran || !result || evaluating) return;
    setEvaluating(true);
    try {
      const stamp = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const targets = [];
      for (const v of result.variants) {
        targets.push(await op<any>('save_playground_target', targetInput(ran.variants[v.index], `Playground ${String.fromCharCode(65 + v.index)} · ${v.label} · ${stamp}`)));
      }
      if (targets.length === 1) {
        const r = await op<any>('start_run', { dataset: d.dataset, target: targets[0].id, suite: d.suite, name: `Playground · ${result.variants[0].label} · ${stamp}` });
        toast.success('Full evaluation started', 'Saved the model as a target');
        navigate(`/runs/${r.id}`);
      } else {
        const r = await op<any>('start_comparison', {
          dataset: d.dataset,
          suite: d.suite,
          name: `Playground comparison · ${stamp}`,
          variants: targets.map((t, i) => ({ target: t.id, label: result.variants[i].label })),
        });
        toast.success('Full evaluation started', `${targets.length} targets saved`);
        navigate(`/comparisons/${r.id}`);
      }
    } catch (e) {
      toastError(e, 'Could not start the full evaluation');
    } finally {
      setEvaluating(false);
    }
  };

  return (
    <Page
      title="Playground"
      description="Try a prompt on a few rows with up to four models side by side. When one works, save it as a target."
      width="wide"
      actions={
        <Tip content={canEdit ? <>Run <Kbd>⌘</Kbd> <Kbd>↵</Kbd></> : 'Running calls models with the project’s keys, so it needs the editor role'}>
          <Button variant="primary" icon={<Play className="size-4" />} loading={!!running} disabled={!ready || !canEdit} onClick={run}>
            Run
          </Button>
        </Tip>
      }
    >
      <div className="flex flex-col gap-6">
        <Card>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-4">
              <Field label="System prompt" help="Optional instructions sent before the prompt, for every row.">
                <CodeEditor value={d.system} onChange={(v) => set({ system: v })} minHeight={64} maxHeight={200} placeholder="You are a helpful support assistant…" />
              </Field>
              <Field
                label="Prompt"
                help="Use {{column}} placeholders for row values. Image or audio columns you reference are attached to the request, so vision and audio models can see or hear them."
              >
                <CodeEditor value={d.prompt} onChange={(v) => set({ prompt: v })} minHeight={130} maxHeight={360} />
              </Field>
              {d.source === 'dataset' && columns.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-[0.75rem] text-ink-faint">
                  Columns:
                  {columns.map((c) => (
                    <Tip key={c} content="Click to copy">
                      <button
                        type="button"
                        onClick={() => navigator.clipboard?.writeText(`{{${c}}}`)}
                        className={usedVars.includes(c) ? 'rounded bg-accent-soft px-1.5 py-0.5 font-mono text-accent-ink' : 'rounded bg-raised px-1.5 py-0.5 font-mono hover:text-ink'}
                      >
                        {`{{${c}}}`}
                      </button>
                    </Tip>
                  ))}
                </div>
              )}
              {missing.length > 0 && <div className="text-[0.78125rem] text-warn">Not a column in this dataset: {missing.map((m) => `{{${m}}}`).join(', ')}</div>}
            </div>

            <div className="flex flex-col gap-5">
              <Field label="Rows to try">
                <Segmented
                  value={d.source}
                  onChange={(v) => set({ source: v })}
                  options={[
                    { value: 'values', label: 'Type values' },
                    { value: 'dataset', label: 'From a dataset' },
                  ]}
                />
              </Field>
              {d.source === 'dataset' ? (
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_6rem]">
                  <Field label="Dataset">
                    <DatasetPicker value={d.dataset} onChange={(id) => set({ dataset: id })} />
                  </Field>
                  <Field label="Rows" help="The first N rows (1–25). Keep it small: every row is one call per model.">
                    <Input type="number" min={1} max={25} value={d.limit} onChange={(e) => set({ limit: Math.max(1, Math.min(25, Number(e.target.value) || 1)) })} />
                  </Field>
                </div>
              ) : (
                <ValuesEditor keys={usedVars} rows={d.values} onChange={(values) => set({ values })} />
              )}

              <div>
                <SectionTitle help="Each variant is a connection + model (+ temperature). Add up to four to compare them on the same rows." className="mb-2">
                  Models
                </SectionTitle>
                <VariantsEditor variants={d.variants} onChange={(variants) => set({ variants })} defaults={defaults} />
              </div>

              <details className="group" open={!!d.suite}>
                <summary className="cursor-pointer text-[0.8125rem] font-medium text-ink-muted hover:text-ink">Score with a suite (optional)</summary>
                <div className="mt-2 flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <SuitePicker value={d.suite} onChange={(id) => set({ suite: id })} />
                  </div>
                  {d.suite && (
                    <Button variant="ghost" size="sm" onClick={() => set({ suite: '' })}>
                      Clear
                    </Button>
                  )}
                  <HelpTip>Runs the suite's checks on each output, exactly like a real run, and shows pass/fail per cell. Use a suite whose checks read {'{{output}}'} and your row columns.</HelpTip>
                </div>
              </details>
            </div>
          </div>
        </Card>

        {running && job.data && (
          <div className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3.5">
            <div className="flex items-center justify-between text-[0.8125rem] text-ink-muted">
              <span>
                {job.data.done} of {job.data.total || '…'} calls done
              </span>
              <Button size="sm" variant="ghost" icon={<CircleStop className="size-3.5" />} onClick={() => op('cancel_job', { jobId: job.data!.id }).catch(toastError)}>
                Stop
              </Button>
            </div>
            <Progress value={job.data.total ? job.data.done / job.data.total : 0.05} />
          </div>
        )}
        <ErrorBox error={error} />

        {result ? (
          <section className="flex flex-col gap-3">
            <SectionTitle
              action={
                <Tip content={!d.dataset || d.source !== 'dataset' ? 'Pick a dataset as the row source to run a full evaluation' : !d.suite ? 'Pick a suite to score the full evaluation' : 'Saves each model as a target and runs them all on the whole dataset'}>
                  <span>
                    <Button size="sm" loading={evaluating} disabled={d.source !== 'dataset' || !d.dataset || !d.suite} onClick={fullEval}>
                      Run full eval
                    </Button>
                  </span>
                </Tip>
              }
            >
              Results
            </SectionTitle>
            <PlaygroundGrid result={result} onSave={setSaving} />
          </section>
        ) : (
          !running && (
            <EmptyState icon={<FlaskConical />} title="Nothing run yet">
              Write a prompt, pick a few rows and one or more models, then press Run. Results appear side by side.
            </EmptyState>
          )
        )}
      </div>

      {saving !== null && result && ran && (
        <SaveTargetDialog
          label={result.variants.find((v) => v.index === saving)?.label ?? ''}
          onClose={() => setSaving(null)}
          onSave={async (name) => {
            const t = await op<any>('save_playground_target', targetInput(ran.variants[saving], name));
            toast.success('Saved as a target', t.name);
            setSaving(null);
            navigate(`/targets/${t.id}`);
          }}
        />
      )}
    </Page>
  );
}

function SaveTargetDialog({ label, onClose, onSave }: { label: string; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(`${label} prompt`);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Save as a target"
      description="Creates a model target with this prompt and model, so you can run it on a whole dataset."
      width="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(name.trim());
              } catch (e) {
                toastError(e, 'Could not save');
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="Target name">
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
    </Dialog>
  );
}
