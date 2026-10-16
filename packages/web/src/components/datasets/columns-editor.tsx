import { useState } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Input, Select, Switch, TagInput } from '../ui/form';
import { HelpTip, Tip } from '../ui/overlay';
import type { ColumnDef, ColumnType } from './types';

export const COLUMN_TYPES: { value: ColumnType; label: string; hint: string }[] = [
  { value: 'text', label: 'Text', hint: 'Questions, answers, transcripts' },
  { value: 'number', label: 'Number', hint: 'Scores, amounts, expected values' },
  { value: 'boolean', label: 'Yes / no', hint: 'true or false' },
  { value: 'list', label: 'List', hint: 'Keywords, labels, ids' },
  { value: 'json', label: 'JSON', hint: 'Any structured value' },
  { value: 'messages', label: 'Messages', hint: 'A chat: [{ role, content }]' },
  { value: 'audio', label: 'Audio file', hint: 'WAV, MP3, … for speech apps' },
  { value: 'image', label: 'Image file', hint: 'PNG, JPEG, … for vision apps' },
  { value: 'file', label: 'Other file', hint: 'PDFs or any other upload' },
];

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Problems that block saving: bad names or duplicates. */
export function columnErrors(cols: ColumnDef[]): Record<number, string> {
  const errors: Record<number, string> = {};
  const seen = new Map<string, number>();
  cols.forEach((c, i) => {
    if (!c.key) errors[i] = 'Name is required';
    else if (!KEY_RE.test(c.key)) errors[i] = 'Use letters, digits and _ (not starting with a digit)';
    else if (seen.has(c.key)) errors[i] = 'Duplicate name';
    seen.set(c.key, i);
  });
  return errors;
}

export const TEMPLATES: { id: string; label: string; hint: string; columns: ColumnDef[] }[] = [
  {
    id: 'qa',
    label: 'Question & answer',
    hint: 'An input and the answer you expect',
    columns: [
      { key: 'input', type: 'text', description: 'The question or input sent to your app', required: true },
      { key: 'expected', type: 'text', description: 'The ideal or reference answer', required: false },
    ],
  },
  {
    id: 'stt',
    label: 'Speech-to-text',
    hint: 'Recordings and their correct transcripts',
    columns: [
      { key: 'audio', type: 'audio', description: 'The recording to transcribe', required: true },
      { key: 'reference', type: 'text', description: 'The correct transcript', required: false },
      { key: 'keywords', type: 'list', description: 'Words that must come out right (names, numbers)', required: false },
    ],
  },
  {
    id: 'chat',
    label: 'Chat',
    hint: 'A conversation and the reply you expect',
    columns: [
      { key: 'messages', type: 'messages', description: 'The conversation so far, as [{ role, content }]', required: true },
      { key: 'expected', type: 'text', description: 'The ideal next reply', required: false },
    ],
  },
  { id: 'blank', label: 'Blank', hint: 'Start with no columns', columns: [] },
];

/** Edit dataset columns: name, type, description, required, allowed values, order. */
export function ColumnsEditor({ value, onChange }: { value: ColumnDef[]; onChange: (v: ColumnDef[]) => void }) {
  const [showEnum, setShowEnum] = useState<Set<number>>(() => new Set(value.map((c, i) => (c.enum?.length ? i : -1)).filter((i) => i >= 0)));
  const errors = columnErrors(value);
  const set = (i: number, patch: Partial<ColumnDef>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <div className="grid grid-cols-[160px_150px_minmax(0,1fr)_86px_92px] gap-2 px-1 text-[12px] font-medium text-ink-faint">
          <span className="flex items-center gap-1">
            Name <HelpTip>Used in templates as {'{{name}}'}, for example in a request body or a check.</HelpTip>
          </span>
          <span>Type</span>
          <span className="flex items-center gap-1">
            Description <HelpTip>Explains the column to teammates, to model generators and to coding agents filling the data.</HelpTip>
          </span>
          <span className="flex items-center gap-1">
            Required <HelpTip>Rows without a value here are rejected.</HelpTip>
          </span>
          <span />
        </div>
      )}
      {value.map((c, i) => (
        <div key={i} className="rounded-lg border border-line bg-surface p-2">
          <div className="grid grid-cols-[160px_150px_minmax(0,1fr)_86px_92px] items-center gap-2">
            <Input mono value={c.key} placeholder="column_name" onChange={(e) => set(i, { key: e.target.value })} className={clsx(errors[i] && 'border-bad')} aria-label="Column name" />
            <Select value={c.type} onChange={(v) => set(i, { type: v as ColumnType })} options={COLUMN_TYPES} />
            <Input value={c.description} placeholder="What this column holds" onChange={(e) => set(i, { description: e.target.value })} aria-label="Description" />
            <div className="flex justify-center">
              <Switch checked={c.required} onChange={(v) => set(i, { required: v })} label="Required" />
            </div>
            <div className="flex justify-end gap-0.5">
              <Tip content="Move up">
                <Button variant="ghost" size="icon-sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp className="size-3.5" />
                </Button>
              </Tip>
              <Tip content="Move down">
                <Button variant="ghost" size="icon-sm" aria-label="Move down" disabled={i === value.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown className="size-3.5" />
                </Button>
              </Tip>
              <Tip content="Remove column">
                <Button variant="ghost" size="icon-sm" aria-label="Remove column" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                  <Trash2 className="size-3.5" />
                </Button>
              </Tip>
            </div>
          </div>
          {errors[i] && <div className="mt-1 px-1 text-[12px] text-bad">{errors[i]}</div>}
          {c.type === 'text' &&
            (showEnum.has(i) ? (
              <div className="mt-2 flex items-center gap-2">
                <span className="flex w-[160px] shrink-0 items-center gap-1 px-1 text-[12px] text-ink-muted">
                  Allowed values <HelpTip>Limit this column to a fixed set of values, such as labels or categories. Leave empty for free text.</HelpTip>
                </span>
                <div className="flex-1">
                  <TagInput value={c.enum ?? []} onChange={(v) => set(i, { enum: v.length ? v : undefined })} placeholder="Type a value and press Enter" />
                </div>
              </div>
            ) : (
              <button type="button" className="mt-1 px-1 text-[12px] text-ink-faint hover:text-accent-ink" onClick={() => setShowEnum(new Set([...showEnum, i]))}>
                + Limit to allowed values
              </button>
            ))}
        </div>
      ))}
      <div>
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus className="size-3.5" />}
          onClick={() => onChange([...value, { key: '', type: 'text', description: '', required: false }])}
        >
          Add column
        </Button>
      </div>
    </div>
  );
}
