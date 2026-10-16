import { createContext, forwardRef, useContext, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { Select as S, Switch as Sw } from 'radix-ui';
import clsx from 'clsx';
import { Check, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { HelpTip } from './overlay';
import { Button } from './button';

const control =
  'w-full rounded-lg border border-line-strong bg-surface px-2.5 text-[0.84375rem] text-ink placeholder:text-ink-faint transition-colors hover:border-ink-faint focus:border-accent/60 focus:outline-none focus-visible:outline-none focus:ring-[3px] focus:ring-accent/12 disabled:opacity-60';

/** Id of the enclosing Field's label, so controls get an accessible name without wiring ids by hand. */
const FieldLabel = createContext<string | undefined>(undefined);

/** aria-labelledby from the enclosing Field, unless the control is already named. */
function useFieldLabel(props: { 'aria-label'?: string; 'aria-labelledby'?: string }) {
  const labelId = useContext(FieldLabel);
  return props['aria-label'] || props['aria-labelledby'] ? {} : labelId ? { 'aria-labelledby': labelId } : {};
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input({ className, mono, ...rest }, ref) {
  const named = useFieldLabel(rest);
  return <input ref={ref} className={clsx(control, 'h-8.5', mono && 'font-mono text-[0.78125rem]', className)} {...named} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(function Textarea({ className, mono, rows = 3, ...rest }, ref) {
  const named = useFieldLabel(rest);
  return <textarea ref={ref} rows={rows} className={clsx(control, 'py-2 leading-relaxed', mono && 'font-mono text-[0.78125rem]', className)} {...named} {...rest} />;
});

/** Label + optional (?) help + hint + error, wrapped around any control. */
export function Field({
  label,
  help,
  hint,
  error,
  children,
  className,
  inline,
}: {
  label?: ReactNode;
  help?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  inline?: boolean;
}) {
  const labelId = useId();
  return (
    <div className={clsx('min-w-0', inline ? 'flex items-center justify-between gap-4' : 'flex flex-col gap-1.5', className)}>
      {label && (
        <div className="flex items-center gap-1.5 text-[0.8125rem] font-medium text-ink">
          <span id={labelId}>{label}</span>
          {help && <HelpTip>{help}</HelpTip>}
        </div>
      )}
      <FieldLabel.Provider value={label ? labelId : undefined}>{children}</FieldLabel.Provider>
      {hint && !error && <div className="text-[0.75rem] text-ink-faint">{hint}</div>}
      {error && <div className="text-[0.75rem] text-bad">{error}</div>}
    </div>
  );
}

export interface Option {
  value: string;
  label: ReactNode;
  hint?: ReactNode;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  className,
  disabled,
  size = 'md',
}: {
  value: string | undefined;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}) {
  const named = useFieldLabel({});
  return (
    <S.Root value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <S.Trigger {...named} className={clsx(control, 'flex items-center justify-between gap-2 text-left', size === 'sm' ? 'h-7 text-[0.8125rem]' : 'h-8.5', className)}>
        <span className="truncate">
          <S.Value placeholder={<span className="text-ink-faint">{placeholder}</span>} />
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-ink-faint" />
      </S.Trigger>
      <S.Portal>
        <S.Content position="popper" sideOffset={4} className="z-[60] max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-line bg-surface shadow-card">
          <S.Viewport className="p-1">
            {options.map((o) => (
              <S.Item key={o.value} value={o.value} className="relative flex cursor-default items-start rounded-md py-1.5 pr-2 pl-7 text-[0.84375rem] outline-none select-none data-[highlighted]:bg-hover">
                <S.ItemIndicator className="absolute left-2 top-2">
                  <Check className="size-3.5 text-accent" />
                </S.ItemIndicator>
                <div className="min-w-0">
                  <S.ItemText>{o.label}</S.ItemText>
                  {o.hint && <div className="text-[0.75rem] text-ink-faint">{o.hint}</div>}
                </div>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  const named = useFieldLabel({ 'aria-label': label });
  return (
    <Sw.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      {...named}
      className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-line-strong transition-colors data-[state=checked]:bg-accent disabled:opacity-50"
    >
      <Sw.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </Sw.Root>
  );
}

/** Pill-style choice for 2–5 options. */
export function Segmented<T extends string>({ value, onChange, options, size = 'md' }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; size?: 'sm' | 'md' }) {
  return (
    <div className="inline-flex w-fit rounded-lg border border-line bg-raised p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-md px-2.5 font-medium transition-colors',
            size === 'sm' ? 'h-6 text-[0.78125rem]' : 'h-7 text-[0.8125rem]',
            value === o.value ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="text-[0.71875rem] text-ink-faint tabular-nums">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export interface KV {
  key: string;
  value: string;
  enabled: boolean;
}

/** Editable key/value list (headers, query params, variables, form fields). */
export function KeyValueEditor({ value, onChange, keyPlaceholder = 'Name', valuePlaceholder = 'Value', addLabel = 'Add' }: { value: KV[]; onChange: (v: KV[]) => void; keyPlaceholder?: string; valuePlaceholder?: string; addLabel?: string }) {
  const set = (i: number, patch: Partial<KV>) => onChange(value.map((kv, j) => (j === i ? { ...kv, ...patch } : kv)));
  return (
    <div className="flex flex-col gap-1.5">
      {value.map((kv, i) => (
        <div key={i} className="flex items-center gap-2">
          <input type="checkbox" checked={kv.enabled} onChange={(e) => set(i, { enabled: e.target.checked })} className="size-3.5 accent-[var(--k-accent)]" aria-label="Enabled" />
          <div className="min-w-0 flex-[2]">
            <Input mono value={kv.key} placeholder={keyPlaceholder} onChange={(e) => set(i, { key: e.target.value })} />
          </div>
          <div className="min-w-0 flex-[3]">
            <Input mono value={kv.value} placeholder={valuePlaceholder} onChange={(e) => set(i, { value: e.target.value })} />
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Remove" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <div>
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...value, { key: '', value: '', enabled: true }])}>
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

/** Comma/enter separated tags. */
export function TagInput({ value, onChange, placeholder = 'Add tag…' }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  return (
    <div className={clsx(control, 'flex min-h-8.5 flex-wrap items-center gap-1 py-1 focus-within:border-accent/60 focus-within:ring-[3px] focus-within:ring-accent/12')}>
      {value.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-[0.75rem]">
          {t}
          <button type="button" className="text-ink-faint hover:text-ink" onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
            ×
          </button>
        </span>
      ))}
      <input
        className="min-w-24 flex-1 bg-transparent text-[0.8125rem] outline-none"
        placeholder={placeholder}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          if ((e.key === 'Enter' || e.key === ',') && el.value.trim()) {
            e.preventDefault();
            if (!value.includes(el.value.trim())) onChange([...value, el.value.trim()]);
            el.value = '';
          } else if (e.key === 'Backspace' && !el.value && value.length) onChange(value.slice(0, -1));
        }}
      />
    </div>
  );
}
