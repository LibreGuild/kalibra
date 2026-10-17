import { useState } from 'react';
import clsx from 'clsx';
import { Check, ChevronsUpDown, FolderPlus, LayoutGrid, Settings2 } from 'lucide-react';
import { DropdownMenu as M } from 'radix-ui';
import { useNavigate } from 'react-router';
import { useHubOp, useProjectId } from '../../lib/api';
import { useProject } from '../../lib/session';
import { ROLE_LABEL, ROLE_TONE } from '../../lib/roles';
import { Badge } from '../ui/display';
import { Tip } from '../ui/overlay';
import { NewProjectDialog } from '../../pages/projects';

/*
 * Top of the sidebar: which project you are in, and a quick way to switch. Everything in the
 * sidebar above the line (datasets, targets, …) belongs to this project.
 */


export function ProjectSwitcher({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const projects = useHubOp<any[]>('list_projects', {}, { staleTime: 30_000 });
  const inProject = useProject();
  const currentId = useProjectId();
  const me = useHubOp<any>('get_me', {}, { staleTime: 60_000 });
  const current = (projects.data ?? []).find((p) => p.id === currentId);
  const name = inProject?.name ?? current?.name ?? 'Projects';
  const [creating, setCreating] = useState(false);

  const trigger = collapsed ? (
    <button
      type="button"
      aria-label={`Project: ${name}. Switch project`}
      className="mx-auto grid size-9 place-items-center rounded-lg border border-line bg-surface text-[0.875rem] font-semibold text-ink shadow-sm hover:bg-hover"
    >
      {name.slice(0, 1).toUpperCase()}
    </button>
  ) : (
    <button
      type="button"
      aria-label={`Project: ${name}. Switch project`}
      className="flex h-10 w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-left shadow-sm transition-colors hover:bg-hover"
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent-soft text-[0.75rem] font-bold text-accent-ink">{name.slice(0, 1).toUpperCase()}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.8125rem] font-semibold leading-tight">{name}</span>
        {inProject && inProject.role !== 'owner' && <span className="block text-[0.6875rem] leading-tight text-ink-faint">{ROLE_LABEL[inProject.role]}</span>}
      </span>
      <ChevronsUpDown className="size-3.5 shrink-0 text-ink-faint" />
    </button>
  );

  return (
    <>
      <M.Root>
        {collapsed ? (
          <Tip content={`${name} — switch project`} side="right">
            <M.Trigger asChild>{trigger}</M.Trigger>
          </Tip>
        ) : (
          <M.Trigger asChild>{trigger}</M.Trigger>
        )}
        <M.Portal>
          <M.Content align="start" side={collapsed ? 'right' : 'bottom'} sideOffset={6} className="z-50 w-64 rounded-lg border border-line bg-surface p-1 shadow-card">
            <div className="px-2.5 pt-1.5 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-ink-faint">Projects</div>
            <div className="max-h-72 overflow-y-auto">
              {(projects.data ?? []).map((p) => (
                <M.Item
                  key={p.id}
                  onSelect={() => navigate(`/p/${encodeURIComponent(p.id)}`)}
                  className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-[0.84375rem] outline-none data-[highlighted]:bg-hover"
                >
                  <Check className={clsx('size-3.5 shrink-0', p.id === currentId ? 'text-accent-ink' : 'invisible')} />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.role !== 'owner' && <Badge tone={ROLE_TONE[p.role]}>{ROLE_LABEL[p.role]}</Badge>}
                </M.Item>
              ))}
              {projects.isLoading && <div className="px-2.5 py-1.5 text-[0.8125rem] text-ink-faint">Loading…</div>}
            </div>
            <M.Separator className="my-1 h-px bg-line" />
            {inProject && (
              <M.Item onSelect={() => navigate(`/p/${encodeURIComponent(inProject.id)}/settings`)} className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[0.84375rem] outline-none data-[highlighted]:bg-hover">
                <Settings2 className="size-4 text-ink-muted" /> Project settings
              </M.Item>
            )}
            <M.Item onSelect={() => navigate('/projects')} className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[0.84375rem] outline-none data-[highlighted]:bg-hover">
              <LayoutGrid className="size-4 text-ink-muted" /> All projects
            </M.Item>
            {me.data?.canCreateProjects && (
              <M.Item onSelect={() => setTimeout(() => setCreating(true), 0)} className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[0.84375rem] outline-none data-[highlighted]:bg-hover">
                <FolderPlus className="size-4 text-ink-muted" /> New project
              </M.Item>
            )}
          </M.Content>
        </M.Portal>
      </M.Root>
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
