import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { CopyButton, ErrorBox, Loading } from '../ui/display';
import { Field, Input } from '../ui/form';
import { Dialog, useConfirm } from '../ui/overlay';
import { SimpleTable } from '../ui/table';
import { toastError } from '../ui/toast';
import { getCurrentUserId, useHubMutation, useHubOp } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { isMissingOp } from '../traces/types';

/*
 * Ingest keys: what an app (SDK, OpenTelemetry exporter, OpenAI proxy client) uses to send traces
 * to one project. A key can only send traces and tool recordings; it can't read anything else.
 * The full key is shown once, right after it is made.
 */

export interface IngestKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  /** User id of whoever made it. */
  createdBy?: string;
  lastUsedAt?: string | null;
}

/** `onKeyChange` gets the key just made (for the snippets), or undefined once that key is revoked. */
export function IngestKeys({ project, canEdit, onKeyChange }: { project: string; canEdit: boolean; onKeyChange: (key?: string) => void }) {
  const keys = useHubOp<IngestKey[]>('list_ingest_keys', { project });
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<{ id?: string; name: string; key: string } | null>(null);
  const confirm = useConfirm();
  const revoke = useHubMutation('revoke_ingest_key', { invalidate: ['list_ingest_keys'] });

  const remove = async (k: IngestKey) => {
    if (!(await confirm.ask(`Revoke “${k.name}”?`, 'Apps using this key stop sending traces. This cannot be undone.', 'Revoke'))) return;
    revoke.mutate(
      { project, id: k.id },
      {
        onSuccess: () => {
          // A revoked key must not stay on screen or in the snippets as if it still worked.
          if (fresh?.id === k.id) {
            setFresh(null);
            onKeyChange(undefined);
          }
        },
        onError: (e) => toastError(e, 'Could not revoke the key'),
      },
    );
  };

  if (keys.isLoading) return <Loading />;
  if (isMissingOp(keys.error)) return <div className="text-[0.8125rem] text-ink-muted">This Kalibra engine has no ingest keys yet. Update Kalibra to send traces from your app.</div>;

  return (
    <div className="flex flex-col gap-3">
      {fresh && (
        <div className="rounded-lg border border-ok/40 bg-ok-soft/40 px-3.5 py-3">
          <div className="text-[0.8125rem] font-medium">Key “{fresh.name}” is ready. Copy it now: it won't be shown again.</div>
          <div className="mt-2 flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5">
            <code className="min-w-0 flex-1 truncate font-mono text-[0.78125rem]">{fresh.key}</code>
            <CopyButton text={fresh.key} />
          </div>
          <div className="mt-1.5 text-[0.75rem] text-ink-muted">The snippets below now use it. Keep it in an environment variable (KALIBRA_KEY), not in your code.</div>
        </div>
      )}
      <ErrorBox error={keys.error} />
      {!keys.error && (
        <SimpleTable<IngestKey>
          rows={keys.data ?? []}
          rowKey={(k) => k.id}
          empty="No keys yet. Create one for each app or environment that sends traces."
          columns={[
            {
              key: 'name',
              header: 'Name',
              width: 'minmax(160px, 1.4fr)',
              render: (k) => (
                <span className="flex min-w-0 items-center gap-2">
                  <KeyRound className="size-3.5 shrink-0 text-ink-faint" />
                  <span className="truncate font-medium">{k.name}</span>
                </span>
              ),
            },
            { key: 'prefix', header: 'Key', width: '140px', render: (k) => <code className="font-mono text-[0.75rem] text-ink-muted">{k.prefix}…</code> },
            { key: 'used', header: 'Last used', width: '110px', render: (k) => <span className="text-ink-muted">{k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'never'}</span> },
            { key: 'created', header: 'Created', width: 'minmax(120px, 1fr)', render: (k) => <span className="truncate text-ink-muted">{timeAgo(k.createdAt)}{k.createdBy === getCurrentUserId() || k.createdBy === 'local' ? ' · by you' : ''}</span> },
            {
              key: 'actions',
              header: '',
              width: '52px',
              align: 'right',
              render: (k) =>
                canEdit ? (
                  <Button variant="ghost" size="icon-sm" aria-label={`Revoke ${k.name}`} onClick={() => remove(k)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
      {canEdit && (
        <div>
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
            New key
          </Button>
        </div>
      )}
      <NewKeyDialog
        open={creating}
        onOpenChange={setCreating}
        project={project}
        onCreated={(id, name, key) => {
          setFresh({ id, name, key });
          onKeyChange(key);
        }}
      />
      {confirm.element}
    </div>
  );
}

function NewKeyDialog({ open, onOpenChange, project, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; project: string; onCreated: (id: string | undefined, name: string, key: string) => void }) {
  const [name, setName] = useState('');
  const create = useHubMutation<{ project: string; name: string }, any>('create_ingest_key', {
    invalidate: ['list_ingest_keys'],
    onSuccess: (res, input) => {
      onOpenChange(false);
      setName('');
      onCreated(res?.id, input.name, String(res?.key ?? ''));
    },
  });
  useEffect(() => {
    if (!open) create.reset();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && !create.isPending) create.mutate({ project, name: name.trim() });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New ingest key"
      description="Lets one app send traces to this project. It can't read anything."
      width="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={submit}>
            Create key
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name" hint="Which app or environment uses it, so you know what to revoke later.">
          <Input autoFocus value={name} maxLength={100} placeholder="e.g. Support bot – local dev" onChange={(e) => setName(e.target.value)} />
        </Field>
        <ErrorBox error={create.error} />
      </form>
    </Dialog>
  );
}
