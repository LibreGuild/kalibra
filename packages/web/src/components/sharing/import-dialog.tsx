import { useRef, useState } from 'react';
import { Link, useNavigate } from '../../lib/nav';
import clsx from 'clsx';
import { FileUp, KeyRound } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge, ErrorBox, Spinner } from '../ui/display';
import { Field, Input, Segmented } from '../ui/form';
import { Dialog, HelpTip } from '../ui/overlay';
import { op, uploadFile, type UploadedFile } from '../../lib/api';
import { bytes } from '../../lib/format';
import { useQueryClient } from '@tanstack/react-query';

/*
 * One import entry point: drop a file and Kalibra works out what it is — a Kalibra bundle, a
 * promptfoo config, OpenAI Evals JSONL, a LangSmith or Langfuse export, or a plain CSV/JSONL — shows
 * what will be created, then imports and reports what it could and could not map.
 */

const FORMAT_LABEL: Record<string, string> = {
  kalibra_bundle: 'Kalibra bundle',
  promptfoo: 'promptfoo config',
  openai_evals: 'OpenAI Evals data',
  langsmith: 'LangSmith dataset export',
  langfuse: 'Langfuse dataset export',
  plain: 'Plain CSV / JSONL',
};

type Step = { kind: 'pick' } | { kind: 'inspect'; file: UploadedFile; format: string; info: any } | { kind: 'done'; report: any; format: string };

export function ImportExternalDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [dragging, setDragging] = useState(false);
  const [onConflict, setOnConflict] = useState<'rename' | 'skip' | 'new_version'>('rename');
  const [name, setName] = useState('');
  const [graders, setGraders] = useState<UploadedFile | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const gradersInput = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const reset = () => {
    setStep({ kind: 'pick' });
    setError(null);
    setName('');
    setGraders(null);
    setOnConflict('rename');
  };
  const close = () => {
    onOpenChange(false);
    setTimeout(reset, 200);
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      const file = await uploadFile(f);
      const detected = await op('inspect_external', { blob: file.hash });
      const info = detected.format === 'kalibra_bundle' ? await op('inspect_bundle', { blob: file.hash }) : detected;
      setName((file.name ?? f.name).replace(/\.[^.]+$/, ''));
      setStep({ kind: 'inspect', file, format: detected.format, info });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (step.kind !== 'inspect') return;
    setBusy(true);
    setError(null);
    try {
      let report: any;
      if (step.format === 'kalibra_bundle') report = await op('import_bundle', { blob: step.file.hash, onConflict });
      else if (step.format === 'plain') {
        const ds = await op('create_dataset', { name: name || 'Imported dataset' });
        // Don't leave an empty dataset behind when the rows can't be read.
        const r = await op('import_rows', { dataset: ds.id, blob: step.file.hash, createColumns: true }).catch(async (e) => {
          await op('delete_dataset', { dataset: ds.id }).catch(() => {});
          throw e;
        });
        report = { dataset: { id: ds.id, name: ds.name, rows: r.added.length, rejected: r.rejected.length }, targets: [], mappedChecks: [], unsupported: [], skipped: [], warnings: r.rejected.length ? [`${r.rejected.length} rows were rejected`] : [] };
      } else report = await op('import_external', { blob: step.file.hash, name: name || undefined, gradersBlob: graders?.hash });
      for (const k of ['list_datasets', 'list_targets', 'list_suites', 'list_connections', 'list_runs']) qc.invalidateQueries({ queryKey: [k] });
      setStep({ kind: 'done', report, format: step.format });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const footer =
    step.kind === 'inspect' ? (
      <>
        <Button onClick={reset}>Back</Button>
        <Button variant="primary" loading={busy} onClick={doImport}>
          Import
        </Button>
      </>
    ) : step.kind === 'done' ? (
      <Button variant="primary" onClick={close}>
        Done
      </Button>
    ) : (
      <Button onClick={close}>Cancel</Button>
    );

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())} title="Import" description="A Kalibra bundle from a teammate, or files from promptfoo, OpenAI Evals, LangSmith or Langfuse." width="lg" footer={footer}>
      {step.kind === 'pick' && (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (!busy) pick(e.dataTransfer.files[0]);
            }}
            className={clsx('flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors', dragging ? 'border-accent bg-accent-soft/50' : 'border-line-strong hover:bg-hover')}
          >
            {busy ? <Spinner className="size-6" /> : <FileUp className="size-7 text-ink-faint" />}
            <div className="text-[0.875rem] font-medium">{busy ? 'Reading the file…' : 'Drop a file here or click to choose'}</div>
            <div className="text-[0.78125rem] text-ink-muted">.kalibra · promptfooconfig.yaml · OpenAI Evals .jsonl · LangSmith .csv/.jsonl · Langfuse .json</div>
          </button>
          <input
            ref={input}
            type="file"
            className="hidden"
            accept=".kalibra,.zip,.yaml,.yml,.json,.jsonl,.ndjson,.csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              pick(f);
            }}
          />
          <ErrorBox error={error} />
        </div>
      )}

      {step.kind === 'inspect' && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-[0.875rem]">
            <Badge tone="accent">{FORMAT_LABEL[step.format] ?? step.format}</Badge>
            <span className="truncate text-ink-muted">
              {step.file.name} · {bytes(step.file.size)}
            </span>
          </div>

          {step.format === 'kalibra_bundle' ? (
            <>
              <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto rounded-lg border border-line bg-raised/50 p-3 text-[0.8125rem]">
                {step.info.items.map((i: any) => (
                  <li key={`${i.kind}:${i.name}`} className="flex items-center gap-2">
                    <span className="w-20 shrink-0 text-ink-faint">{i.kind}</span>
                    <span className="truncate">{i.name}</span>
                    {i.rows !== undefined && <span className="text-ink-faint">· {i.rows} rows</span>}
                    {i.exists && <Badge tone="warn">exists</Badge>}
                  </li>
                ))}
              </ul>
              {step.info.conflicts > 0 && (
                <Field label="When something already exists" help="Keep both renames the imported copy. Skip keeps yours. Update makes the imported one a new version of yours (datasets get the new rows).">
                  <Segmented
                    value={onConflict}
                    onChange={setOnConflict}
                    options={[
                      { value: 'rename', label: 'Keep both' },
                      { value: 'skip', label: 'Skip' },
                      { value: 'new_version', label: 'Update mine' },
                    ]}
                  />
                </Field>
              )}
              {step.info.code?.length > 0 && (
                <div className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2.5 text-[0.8125rem] text-warn">
                  <div className="mb-1 font-semibold">Contains code that runs on your computer</div>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {step.info.code.map((c: { kind: string; name: string; places: string[] }) => (
                      <li key={`${c.kind}:${c.name}`}>
                        {c.kind} “{c.name}”: <span className="font-mono text-[0.75rem]">{c.places.join(', ')}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-1 text-ink-muted">Only import bundles from people you trust, and review the code before running it.</div>
                </div>
              )}
              {step.info.secretsMissing?.length > 0 && <SecretsNote names={step.info.secretsMissing} />}
            </>
          ) : step.format === 'plain' ? (
            <div className="flex flex-col gap-3">
              <div className="text-[0.8125rem] text-ink-muted">This looks like a plain table. Kalibra will create a new dataset with one column per field.</div>
              <Field label="Dataset name">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="text-[0.8125rem] text-ink-muted">
                {step.info.rows ?? 0} rows
                {step.format === 'promptfoo' && ` · ${step.info.asserts ?? 0} assertions · ${step.info.providers ?? 0} providers`}
                . A dataset is created{step.format === 'promptfoo' || step.format === 'openai_evals' ? ', plus a suite for the assertions/graders' : ''}
                {step.format === 'promptfoo' ? ' and targets for the providers' : ''}.
              </div>
              <Field label="Dataset name">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              {step.format === 'openai_evals' && (
                <Field label="Graders (optional)" help="The eval's testing_criteria / graders JSON. Each grader becomes a check in a new suite.">
                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={() => gradersInput.current?.click()}>
                      {graders ? 'Change file' : 'Choose graders JSON'}
                    </Button>
                    {graders && <span className="truncate text-[0.8125rem] text-ink-muted">{graders.name}</span>}
                    <input
                      ref={gradersInput}
                      type="file"
                      accept=".json"
                      className="hidden"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (!f) return;
                        try {
                          setGraders(await uploadFile(f));
                        } catch (err) {
                          setError(err);
                        }
                      }}
                    />
                  </div>
                </Field>
              )}
            </div>
          )}
          <ErrorBox error={error} />
        </div>
      )}

      {step.kind === 'done' && <ImportReport report={step.report} format={step.format} onOpen={(to) => (close(), navigate(to))} />}
    </Dialog>
  );
}

function SecretsNote({ names }: { names: string[] }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn-soft/50 p-3 text-[0.8125rem]">
      <KeyRound className="mt-0.5 size-4 shrink-0 text-warn" />
      <div>
        Set these secrets on the <Link to="/connections" className="text-accent-ink underline">Connections</Link> page so targets and connections work:{' '}
        <span className="font-mono text-[0.78125rem]">{names.join(', ')}</span>
      </div>
    </div>
  );
}

function ImportReport({ report, format, onOpen }: { report: any; format: string; onOpen: (to: string) => void }) {
  const links: { label: string; to: string; meta?: string }[] =
    format === 'kalibra_bundle'
      ? [...report.created, ...report.updated]
          .filter((c: any) => ['dataset', 'target', 'suite', 'run'].includes(c.kind))
          .map((c: any) => ({ label: `${c.kind}: ${c.name}`, to: `/${c.kind === 'dataset' ? 'datasets' : `${c.kind}s`}/${c.id}`, meta: c.rows !== undefined ? `${c.rows} rows` : undefined }))
      : [
          ...(report.dataset ? [{ label: `dataset: ${report.dataset.name}`, to: `/datasets/${report.dataset.id}`, meta: `${report.dataset.rows} rows` }] : []),
          ...(report.suite ? [{ label: `suite: ${report.suite.name}`, to: `/suites/${report.suite.id}`, meta: `${report.suite.checks} checks` }] : []),
          ...report.targets.map((t: any) => ({ label: `target: ${t.name}`, to: `/targets/${t.id}`, meta: t.note })),
        ];
  const problems: { what: string; reason: string }[] = [...(report.unsupported ?? []), ...(report.skipped ?? [])].map((p: any) => ({ what: p.what ?? `${p.kind} ${p.name}`, reason: p.reason }));
  return (
    <div className="flex flex-col gap-4">
      <div className="text-[0.875rem] font-medium text-ok">Imported.</div>
      <ul className="flex flex-col gap-1.5">
        {links.map((l) => (
          <li key={l.to + l.label} className="flex items-center gap-2 text-[0.84375rem]">
            <button type="button" className="text-accent-ink hover:underline" onClick={() => onOpen(l.to)}>
              {l.label}
            </button>
            {l.meta && <span className="text-[0.78125rem] text-ink-faint">{l.meta}</span>}
          </li>
        ))}
      </ul>
      {report.mappedChecks?.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[0.8125rem] font-medium">
            Mapped checks <HelpTip>Each assertion or grader from the file and the Kalibra check it became. Review notes before running.</HelpTip>
          </div>
          <ul className="flex flex-col gap-0.5 text-[0.78125rem] text-ink-muted">
            {report.mappedChecks.map((m: any, i: number) => (
              <li key={i}>
                <span className="font-mono">{m.from}</span> → <span className="font-mono text-ink">{m.to}</span>
                {m.note && <span className="text-ink-faint"> — {m.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {problems.length > 0 && (
        <div>
          <div className="mb-1 text-[0.8125rem] font-medium">Not imported</div>
          <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto text-[0.78125rem] text-ink-muted">
            {problems.map((p, i) => (
              <li key={i}>
                <span className="font-mono">{p.what}</span> — {p.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(report.renamed ?? []).length > 0 && <div className="text-[0.78125rem] text-ink-muted">Renamed to avoid clashes: {report.renamed.map((r: any) => `${r.from} → ${r.to}`).join(', ')}</div>}
      {report.warnings?.map((w: string) => (
        <div key={w} className="text-[0.78125rem] text-warn">
          {w}
        </div>
      ))}
      {report.secretsToSet?.length > 0 && <SecretsNote names={report.secretsToSet} />}
    </div>
  );
}
