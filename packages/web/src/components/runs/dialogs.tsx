import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Upload } from 'lucide-react';
import { Button } from '../ui/button';
import { ErrorBox } from '../ui/display';
import { Field, Input, KeyValueEditor, Switch, TagInput, type KV } from '../ui/form';
import { Dialog, HelpTip } from '../ui/overlay';
import { toast } from '../ui/toast';
import { DatasetPicker, SuitePicker, TargetPicker } from '../pickers';
import { op, uploadFile, type UploadedFile } from '../../lib/api';
import { ConversationEditor, OptionSection, VariantsEditor, defaultConversation, newVariant, toConversation, toVariants, useConversationHint, type ConversationDraft, type VariantDraft } from './run-options';
import { bytes } from '../../lib/format';

const STATUSES = [
  { value: 'approved', label: 'Approved' },
  { value: 'needs_review', label: 'Needs review' },
  { value: 'draft', label: 'Draft' },
] as const;

const num = (s: string) => (s.trim() === '' ? undefined : Number(s));

/** Start a run: dataset × target × suite. Optional: compare several variants, multi-turn conversations, execution settings. */
export function NewRunDialog({ open, onOpenChange, initial }: { open: boolean; onOpenChange: (o: boolean) => void; initial?: { dataset?: string; target?: string; suite?: string } }) {
  const navigate = useNavigate();
  const [dataset, setDataset] = useState(initial?.dataset);
  const [target, setTarget] = useState(initial?.target);
  const [suite, setSuite] = useState(initial?.suite);
  const [name, setName] = useState('');
  const [section, setSection] = useState<'variants' | 'conversation' | 'advanced' | null>(null);
  const [compare, setCompare] = useState(false);
  const [variants, setVariants] = useState<VariantDraft[]>(() => [newVariant(initial?.target), newVariant(initial?.target)]);
  const [conversation, setConversation] = useState<ConversationDraft>(defaultConversation);
  const [concurrency, setConcurrency] = useState('4');
  const [retries, setRetries] = useState('2');
  const [repetitions, setRepetitions] = useState('1');
  const [limit, setLimit] = useState('');
  const [delayMs, setDelayMs] = useState('0');
  const [statuses, setStatuses] = useState<string[]>(['approved', 'needs_review', 'draft']);
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const hint = useConversationHint(dataset);
  const toggle = (s: 'variants' | 'conversation' | 'advanced') => setSection(section === s ? null : s);

  const settings = () => ({
    concurrency: num(concurrency) ?? 4,
    retries: num(retries) ?? 2,
    repetitions: num(repetitions) ?? 1,
    limit: num(limit),
    delayMs: num(delayMs) ?? 0,
    includeStatuses: statuses,
    tags: tags.length ? tags : undefined,
    conversation: toConversation(conversation),
  });

  const variantsReady = variants.length >= 2 && variants.every((v) => !!v.target);
  const conversationReady = conversation.mode !== 'simulated' || !!conversation.connectionId;
  const ready = !!dataset && !!suite && statuses.length > 0 && conversationReady && (compare ? variantsReady : !!target);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      if (compare) {
        const c = await op<any>('start_comparison', { dataset, suite, name: name.trim() || undefined, variants: toVariants(variants), settings: settings() });
        onOpenChange(false);
        toast.success(`${c.name} started`, `${c.runs.length} variants running`);
        navigate(`/comparisons/${c.id}`);
      } else {
        const run = await op<any>('start_run', { dataset, target, suite, name: name.trim() || undefined, settings: settings() });
        onOpenChange(false);
        toast.success(`${run.name} started`);
        navigate(`/runs/${run.id}`);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New run"
      description="Sends every row of the dataset to the target and scores each result with the suite. The dataset is versioned automatically."
      width="lg"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={start}>
            {compare ? `Compare ${variants.length} variants` : 'Start run'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Dataset" help="The test rows to send.">
            <DatasetPicker value={dataset} onChange={setDataset} />
          </Field>
          <Field label="Suite" help="The checks that score every result.">
            <SuitePicker value={suite} onChange={setSuite} />
          </Field>
        </div>
        {!compare && (
          <Field label="Target" help="The app under test: where each row is sent.">
            <TargetPicker
              value={target}
              onChange={(v) => {
                setTarget(v);
                setVariants((vs) => vs.map((x) => (x.target ? x : { ...x, target: v })));
              }}
            />
          </Field>
        )}
        <Field label="Name" hint="Optional. Defaults to “Run #n” (or “Comparison #n”).">
          <Input value={name} placeholder="e.g. Baseline before prompt change" onChange={(e) => setName(e.target.value)} />
        </Field>

        <div className="flex flex-col gap-2">
          <OptionSection
            title="Compare variants"
            help="Run the same dataset through 2–8 targets, models or settings at once and get a leaderboard with side-by-side outputs."
            open={section === 'variants'}
            onToggle={() => toggle('variants')}
            on={compare}
            summary={compare ? `${variants.length} variants` : 'Off'}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-[0.8125rem]">Compare several variants instead of one target</span>
              <Switch checked={compare} onChange={setCompare} label="Compare variants" />
            </div>
            {compare && <VariantsEditor drafts={variants} onChange={setVariants} />}
          </OptionSection>

          <OptionSection
            title="Conversation"
            help="Test chatbots and agents over several turns: scripted user messages from a column, or a model playing a user with a goal."
            open={section === 'conversation'}
            onToggle={() => toggle('conversation')}
            on={conversation.mode !== 'off'}
            summary={conversation.mode === 'off' ? (hint.suggested ? 'Suggested for this dataset' : 'Single request') : conversation.mode === 'scripted' ? 'Scripted turns' : 'Simulated user'}
          >
            <ConversationEditor value={conversation} onChange={setConversation} datasetId={dataset} />
          </OptionSection>

          <OptionSection
            title="Advanced settings"
            help="Concurrency, retries, repetitions and which rows to include."
            open={section === 'advanced'}
            onToggle={() => toggle('advanced')}
            on={false}
            summary={`${concurrency || 4} at a time · ${retries || 2} retries${limit ? ` · first ${limit} rows` : ''}`}
          >
            <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
              <Field label="Concurrency" help="How many rows are sent at the same time. Lower it if your app or provider rate-limits you. Each variant of a comparison uses this many.">
                <Input type="number" min={1} max={256} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
              </Field>
              <Field label="Retries" help="Extra attempts for timeouts, 429 rate limits and 5xx errors, with growing waits between them.">
                <Input type="number" min={0} max={10} value={retries} onChange={(e) => setRetries(e.target.value)} />
              </Field>
              <Field label="Repetitions" help="Run each row several times to see how consistent the app is. Results group by row.">
                <Input type="number" min={1} max={20} value={repetitions} onChange={(e) => setRepetitions(e.target.value)} />
              </Field>
              <Field label="Only the first N rows" help="Handy for a quick smoke test before a full run. Leave empty for all rows.">
                <Input type="number" min={1} value={limit} placeholder="All rows" onChange={(e) => setLimit(e.target.value)} />
              </Field>
              <Field label="Delay between rows (ms)" help="Pause each worker after every row, to stay under strict rate limits.">
                <Input type="number" min={0} value={delayMs} onChange={(e) => setDelayMs(e.target.value)} />
              </Field>
              <Field label="Only rows tagged" help="Run only rows that have at least one of these tags. Leave empty for all rows.">
                <TagInput value={tags} onChange={setTags} placeholder="Add tag…" />
              </Field>
              <Field label="Include rows that are" className="col-span-2" help="Rows waiting for review or still drafts can be left out, so only approved test cases count.">
                <div className="flex flex-wrap gap-4">
                  {STATUSES.map((s) => (
                    <label key={s.value} className="flex items-center gap-2 text-[0.84375rem]">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-[var(--k-accent)]"
                        checked={statuses.includes(s.value)}
                        onChange={(e) => setStatuses(e.target.checked ? [...statuses, s.value] : statuses.filter((x) => x !== s.value))}
                      />
                      {s.label}
                    </label>
                  ))}
                </div>
              </Field>
            </div>
          </OptionSection>
        </div>
        {conversation.mode === 'simulated' && !conversation.connectionId && <p className="text-[0.78125rem] text-warn">Pick the model that plays the user (Conversation section).</p>}
        <ErrorBox error={error} />
      </div>
    </Dialog>
  );
}

export function ImportOutputsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [dataset, setDataset] = useState<string>();
  const [suite, setSuite] = useState<string>();
  const [file, setFile] = useState<UploadedFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const [rowIdColumn, setRowIdColumn] = useState('row_id');
  const [outputs, setOutputs] = useState<KV[]>([{ key: 'output', value: 'output', enabled: true }]);
  const [latencyColumn, setLatencyColumn] = useState('latency_ms');
  const [errorColumn, setErrorColumn] = useState('error');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setUploading(true);
    setError(null);
    try {
      setFile(await uploadFile(f));
    } catch (e) {
      setError(e);
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await op<any>('import_outputs', {
        dataset,
        suite,
        blob: file!.hash,
        rowIdColumn,
        outputs: Object.fromEntries(outputs.filter((o) => o.enabled && o.key && o.value).map((o) => [o.key, o.value])),
        latencyColumn,
        errorColumn,
        name: name.trim() || undefined,
      });
      onOpenChange(false);
      toast.success('Scoring imported outputs', `${res.matched} rows matched${res.unmatchedRows ? `, ${res.unmatchedRows} dataset rows had no output` : ''}.`);
      navigate(`/runs/${res.run.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Score outputs from a file"
      description="For apps you run yourself. Export the dataset to get row ids, run your app anywhere, then import a CSV or JSONL with row_id plus your outputs. The suite scores them like a live run."
      width="lg"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!dataset || !suite || !file} onClick={submit}>
            Import and score
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Dataset" help="The dataset whose row ids appear in your file.">
            <DatasetPicker value={dataset} onChange={setDataset} />
          </Field>
          <Field label="Suite" help="The checks used to score the imported outputs. Transport checks like status are skipped when there is no response.">
            <SuitePicker value={suite} onChange={setSuite} />
          </Field>
        </div>
        <Field label="Outputs file" help="CSV, JSONL or JSON. One record per dataset row.">
          <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-line-strong px-4 py-3 hover:bg-hover">
            <Upload className="size-4 text-ink-muted" />
            <span className="text-[0.84375rem]">
              {uploading ? 'Uploading…' : file ? (
                <>
                  <span className="font-medium">{file.name}</span> <span className="text-ink-faint">· {bytes(file.size)}</span>
                </>
              ) : (
                'Choose a file…'
              )}
            </span>
            <input type="file" accept=".csv,.jsonl,.ndjson,.json" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
          </label>
        </Field>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Row id column" help="Column holding the Kalibra row id (row_… values from the dataset export).">
            <Input mono value={rowIdColumn} onChange={(e) => setRowIdColumn(e.target.value)} />
          </Field>
          <Field label="Latency column" help="Optional. Milliseconds per row, if you measured them; latency checks use it.">
            <Input mono value={latencyColumn} onChange={(e) => setLatencyColumn(e.target.value)} />
          </Field>
          <Field label="Error column" help="Optional. A non-empty value marks that row as failed with this error.">
            <Input mono value={errorColumn} onChange={(e) => setErrorColumn(e.target.value)} />
          </Field>
        </div>
        <Field
          label={
            <span className="inline-flex items-center gap-1.5">
              Output fields
              <HelpTip>Left: the output field name checks refer to ({'{{output}}'}, {'{{outputs.name}}'}). Right: the column in your file. “output” is the main one.</HelpTip>
            </span>
          }
        >
          <KeyValueEditor value={outputs} onChange={setOutputs} keyPlaceholder="Output field" valuePlaceholder="File column" addLabel="Add output field" />
        </Field>
        <Field label="Run name" hint="Optional">
          <Input value={name} placeholder={file ? `Imported: ${file.name}` : 'Imported outputs'} onChange={(e) => setName(e.target.value)} />
        </Field>
        <ErrorBox error={error} />
      </div>
    </Dialog>
  );
}
