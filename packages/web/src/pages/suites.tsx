import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import clsx from 'clsx';
import { ListChecks, Plus, Save, Trash2 } from 'lucide-react';
import { BackLink, Page } from '../components/layout/shell';
import { Button } from '../components/ui/button';
import { Badge, Card, EmptyState, ErrorBox, Loading, SectionTitle } from '../components/ui/display';
import { Field, Input, Segmented, Textarea } from '../components/ui/form';
import { Dialog, HelpTip, Tip, useConfirm } from '../components/ui/overlay';
import { SimpleTable } from '../components/ui/table';
import { toast, toastError } from '../components/ui/toast';
import { op, useOp, useOpMutation, ApiError } from '../lib/api';
import { timeAgo } from '../lib/format';
import { AddCheckDialog, CheckCard, makeCheck, newCheckId, type CheckSpec, type CheckTypeMeta, type LayerMeta } from '../components/suites/check-card';
import { SUITE_TEMPLATES } from '../components/suites/templates';

interface SuiteRecord {
  id: string;
  name: string;
  description: string;
  version: number;
  updatedAt: string;
  spec: { checks: CheckSpec[]; passRule: 'all' | 'weighted'; passThreshold: number };
}

interface CheckCatalog {
  layers: LayerMeta[];
  types: CheckTypeMeta[];
}

const useCatalog = () => useOp<CheckCatalog>('list_check_types', {}, { staleTime: Infinity });

/* ── List ─────────────────────────────────────────────────────────────────── */

export function SuitesPage() {
  const navigate = useNavigate();
  const suites = useOp<SuiteRecord[]>('list_suites');
  const catalog = useCatalog();
  const [creating, setCreating] = useState(false);
  const layerOf = (type: string) => catalog.data?.types.find((t) => t.type === type)?.layer;
  const layerName = (id: number) => catalog.data?.layers.find((l) => l.id === id)?.name ?? `Layer ${id}`;

  return (
    <Page
      title="Suites"
      description="A suite is an ordered set of checks that scores every result: cheap structural gates first, then content, reference metrics and judges."
      actions={
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          New suite
        </Button>
      }
    >
      {suites.isLoading ? (
        <Loading />
      ) : suites.error ? (
        <ErrorBox error={suites.error} />
      ) : (suites.data ?? []).length === 0 ? (
        <EmptyState
          icon={<ListChecks />}
          title="No suites yet"
          action={
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              Create a suite
            </Button>
          }
        >
          Start from a template for HTTP JSON APIs, speech-to-text or LLM output quality, then adjust the checks.
        </EmptyState>
      ) : (
        <SimpleTable
          rows={suites.data ?? []}
          rowKey={(s) => s.id}
          onRowClick={(s) => navigate(`/suites/${s.id}`)}
          columns={[
            {
              key: 'name',
              header: 'Name',
              width: 'minmax(220px, 2fr)',
              render: (s) => (
                <div className="min-w-0">
                  <div className="truncate font-medium">{s.name}</div>
                  {s.description && <div className="truncate text-[0.78125rem] text-ink-muted">{s.description}</div>}
                </div>
              ),
            },
            { key: 'checks', header: 'Checks', width: '90px', render: (s) => <span className="tabular-nums">{s.spec.checks.filter((c) => c.enabled).length}</span> },
            {
              key: 'layers',
              header: 'Layers',
              help: 'Which layers the enabled checks belong to. Layers run in order; a failing gate skips the later ones.',
              width: 'minmax(220px, 2fr)',
              render: (s) => {
                const ids = [...new Set(s.spec.checks.filter((c) => c.enabled).map((c) => layerOf(c.type)).filter((x): x is number => x !== undefined))].sort();
                return (
                  <div className="flex flex-wrap gap-1">
                    {ids.length === 0 ? <span className="text-ink-faint">—</span> : ids.map((id) => <Badge key={id}>{layerName(id)}</Badge>)}
                  </div>
                );
              },
            },
            { key: 'version', header: 'Version', width: '90px', render: (s) => <span className="text-ink-muted tabular-nums">v{s.version}</span> },
            { key: 'updated', header: 'Updated', width: '120px', render: (s) => <span className="text-ink-muted">{timeAgo(s.updatedAt)}</span> },
          ]}
        />
      )}
      <NewSuiteDialog open={creating} onOpenChange={setCreating} />
    </Page>
  );
}

function NewSuiteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState('http_json');
  const create = useOpMutation<any, SuiteRecord>('create_suite', {
    invalidate: ['list_suites'],
    onSuccess: (s) => {
      onOpenChange(false);
      setName('');
      setDescription('');
      navigate(`/suites/${s.id}`);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New suite"
      description="Pick a starting point. You can change every check afterwards."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!name.trim()}
            onClick={() =>
              create.mutate(
                { name: name.trim(), description, spec: { checks: SUITE_TEMPLATES.find((t) => t.id === template)!.build(), passRule: 'all', passThreshold: 1 } },
                { onError: (e) => toastError(e, 'Could not create the suite') },
              )
            }
          >
            Create suite
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input autoFocus value={name} placeholder="e.g. Support bot – quality" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description" hint="Optional">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Template">
          <div className="grid grid-cols-2 gap-2">
            {SUITE_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTemplate(t.id)}
                className={clsx(
                  'rounded-lg border px-3 py-2.5 text-left transition-colors',
                  template === t.id ? 'border-accent bg-accent-soft/50' : 'border-line hover:bg-hover',
                )}
              >
                <div className="text-[0.84375rem] font-medium">{t.label}</div>
                <div className="mt-0.5 text-[0.78125rem] text-ink-muted">{t.description}</div>
              </button>
            ))}
          </div>
        </Field>
      </div>
    </Dialog>
  );
}

/* ── Editor ───────────────────────────────────────────────────────────────── */

export function SuiteEditorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const suite = useOp<SuiteRecord>('get_suite', { id });
  const catalog = useCatalog();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<SuiteRecord | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (suite.data && (!draft || draft.id !== suite.data.id)) setDraft(structuredClone(suite.data));
  }, [suite.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => !!draft && !!suite.data && JSON.stringify({ n: draft.name, d: draft.description, s: draft.spec }) !== JSON.stringify({ n: suite.data.name, d: suite.data.description, s: suite.data.spec }), [draft, suite.data]);

  if (suite.isLoading || !draft) return suite.error ? <Page title="Suite"><ErrorBox error={suite.error} /></Page> : <Loading />;

  const types = catalog.data?.types ?? [];
  const layers = catalog.data?.layers ?? [];
  const typeOf = (t: string) => types.find((x) => x.type === t);
  const checks = draft.spec.checks;
  const setChecks = (next: CheckSpec[]) => setDraft({ ...draft, spec: { ...draft.spec, checks: next } });
  const layerIdOf = (c: CheckSpec) => typeOf(c.type)?.layer ?? 5;

  const save = async () => {
    setSaving(true);
    try {
      const saved = await op<SuiteRecord>('update_suite', { id: draft.id, name: draft.name, description: draft.description, spec: draft.spec, baseVersion: suite.data!.version });
      setDraft(structuredClone(saved));
      await suite.refetch();
      toast.success('Suite saved', `Version ${saved.version}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict') {
        toast.error('This suite was changed elsewhere', 'Reloaded the latest version. Re-apply your edits.');
        const fresh = await suite.refetch();
        if (fresh.data) setDraft(structuredClone(fresh.data));
      } else toastError(e, 'Could not save the suite');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!(await confirm.ask(`Delete “${draft.name}”?`, 'Past runs keep the exact version they used.'))) return;
    try {
      await op('delete_suite', { id: draft.id });
      toast.success('Suite deleted');
      navigate('/suites');
    } catch (e) {
      toastError(e);
    }
  };

  // Move within the flat list, but only among checks of the same layer (order across layers is fixed by layer).
  const move = (idx: number, dir: -1 | 1) => {
    const layer = layerIdOf(checks[idx]);
    let j = idx + dir;
    while (j >= 0 && j < checks.length && layerIdOf(checks[j]) !== layer) j += dir;
    if (j < 0 || j >= checks.length) return;
    const next = [...checks];
    [next[idx], next[j]] = [next[j], next[idx]];
    setChecks(next);
  };

  const presentLayers = layers.filter((l) => checks.some((c) => layerIdOf(c) === l.id));

  return (
    <Page
      back={<BackLink to="/suites">Suites</BackLink>}
      title={draft.name}
      badge={
        <>
          <Badge>v{suite.data!.version}</Badge>
          {dirty && <Badge tone="warn">Unsaved changes</Badge>}
        </>
      }
      description={
        <span className="inline-flex items-center gap-1.5">
          Checks run layer by layer, cheapest first. A failing gate skips the later layers for that row.
          <HelpTip>Layers: transport → structure → fields → content → reference metrics → judgment. Put cheap must-haves (status, JSON schema) early as gates so broken responses never pay for an LLM judge, and the failure reason stays clear.</HelpTip>
        </span>
      }
      actions={
        <>
          <Tip content="Move this suite to the trash">
            <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={remove}>
              Delete
            </Button>
          </Tip>
          <Button variant="primary" icon={<Save className="size-4" />} loading={saving} disabled={!dirty} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <Card>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name">
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="Description">
              <Input value={draft.description} placeholder="Optional" onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>
          </div>
        </Card>

        <div>
          <SectionTitle
            action={
              <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>
                Add check
              </Button>
            }
          >
            Checks <span className="font-normal text-ink-faint">({checks.length})</span>
          </SectionTitle>
          {checks.length === 0 ? (
            <EmptyState
              icon={<ListChecks />}
              title="No checks yet"
              action={
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                  Add check
                </Button>
              }
            >
              Add a status or schema gate first, then the checks that measure quality.
            </EmptyState>
          ) : (
            <div className="flex flex-col gap-5">
              {presentLayers.map((layer) => (
                <section key={layer.id}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="grid size-5 place-items-center rounded-md bg-raised text-[0.6875rem] font-semibold tabular-nums text-ink-muted">{layer.id}</span>
                    <span className="text-[0.8125rem] font-semibold">{layer.name}</span>
                    <span className="text-[0.78125rem] text-ink-faint">{layer.hint}</span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {checks.map((c, idx) =>
                      layerIdOf(c) !== layer.id ? null : (
                        <CheckCard
                          key={c.id}
                          check={c}
                          type={typeOf(c.type)}
                          defaultOpen={openId === c.id}
                          onChange={(next) => setChecks(checks.map((x) => (x.id === c.id ? next : x)))}
                          onRemove={() => setChecks(checks.filter((x) => x.id !== c.id))}
                          onDuplicate={() => {
                            const copy = { ...structuredClone(c), id: newCheckId(), name: c.name ? `${c.name} (copy)` : '' };
                            const next = [...checks];
                            next.splice(idx + 1, 0, copy);
                            setChecks(next);
                          }}
                          onMove={(dir) => move(idx, dir)}
                          canUp={checks.slice(0, idx).some((x) => layerIdOf(x) === layer.id)}
                          canDown={checks.slice(idx + 1).some((x) => layerIdOf(x) === layer.id)}
                        />
                      ),
                    )}
                  </div>
                </section>
              ))}
              {checks.some((c) => !typeOf(c.type)) && (
                <section>
                  <div className="mb-2 text-[0.8125rem] font-semibold text-bad">Unknown check types</div>
                  <div className="flex flex-col gap-2">
                    {checks.map((c, idx) =>
                      typeOf(c.type) ? null : (
                        <CheckCard
                          key={c.id}
                          check={c}
                          onChange={(next) => setChecks(checks.map((x) => (x.id === c.id ? next : x)))}
                          onRemove={() => setChecks(checks.filter((x) => x.id !== c.id))}
                          onDuplicate={() => {}}
                          onMove={(dir) => move(idx, dir)}
                          canUp={false}
                          canDown={false}
                        />
                      ),
                    )}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>

        <Card>
          <SectionTitle help="How a row's overall pass/fail is decided from its checks. Skipped checks (not applicable) don't count against a row.">Pass rule</SectionTitle>
          <div className="flex flex-wrap items-end gap-6">
            <Segmented
              value={draft.spec.passRule}
              onChange={(v) => setDraft({ ...draft, spec: { ...draft.spec, passRule: v } })}
              options={[
                { value: 'all', label: 'Every check must pass' },
                { value: 'weighted', label: 'Weighted score' },
              ]}
            />
            {draft.spec.passRule === 'weighted' && (
              <Field label="Minimum weighted score" help="A row passes when the weighted average of its check scores (0 to 1) reaches this value, and no gate failed.">
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  className="w-32"
                  value={draft.spec.passThreshold}
                  onChange={(e) => setDraft({ ...draft, spec: { ...draft.spec, passThreshold: Math.min(1, Math.max(0, Number(e.target.value) || 0)) } })}
                />
              </Field>
            )}
          </div>
        </Card>
      </div>

      <AddCheckDialog
        open={adding}
        onOpenChange={setAdding}
        types={types}
        onAdd={(t) => {
          const c = makeCheck(t);
          setChecks([...checks, c]);
          setOpenId(c.id);
        }}
      />
      {confirm.element}
    </Page>
  );
}
