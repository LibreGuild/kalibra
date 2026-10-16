import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { FileIcon, Pause, Play } from 'lucide-react';
import { fileUrl } from '../../lib/api';
import { preview } from '../../lib/format';
import { Tip } from './overlay';

export interface FileValue {
  blob: string;
  name?: string;
  mime?: string;
  size?: number;
}

export const isFileValue = (v: unknown): v is FileValue => !!v && typeof v === 'object' && typeof (v as any).blob === 'string';

let current: HTMLAudioElement | null = null;

/** Compact play button with progress; only one plays at a time. */
export function AudioPlayer({ file, compact }: { file: FileValue; compact?: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    const onTime = () => setProgress(a.duration ? a.currentTime / a.duration : 0);
    const onEnd = () => setPlaying(false);
    const onMeta = () => setDuration(a.duration);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('ended', onEnd);
    a.addEventListener('pause', onEnd);
    a.addEventListener('loadedmetadata', onMeta);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('ended', onEnd);
      a.removeEventListener('pause', onEnd);
      a.removeEventListener('loadedmetadata', onMeta);
    };
  }, []);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const a = ref.current!;
    if (playing) {
      a.pause();
      return;
    }
    if (current && current !== a) current.pause();
    current = a;
    a.play();
    setPlaying(true);
  };

  return (
    <div className={clsx('inline-flex min-w-0 items-center gap-2', compact ? 'max-w-[220px]' : 'w-full')}>
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Play'}
        className="grid size-6.5 shrink-0 place-items-center rounded-full bg-accent text-on-accent hover:bg-accent-hover"
      >
        {playing ? <Pause className="size-3" /> : <Play className="ml-0.5 size-3" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[0.78125rem] text-ink-muted">{file.name ?? 'audio'}</div>
        <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-raised">
          <div className="h-full bg-accent" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>
      {!compact && duration != null && <span className="text-[0.75rem] tabular-nums text-ink-faint">{duration.toFixed(1)}s</span>}
      <audio ref={ref} src={fileUrl(file.blob)} preload="none" />
    </div>
  );
}

export function ImageThumb({ file, size = 32 }: { file: FileValue; size?: number }) {
  return (
    <Tip content={<img src={fileUrl(file.blob)} alt={file.name ?? ''} className="max-h-64 max-w-64 rounded" />}>
      <img src={fileUrl(file.blob)} alt={file.name ?? ''} style={{ width: size, height: size }} className="rounded border border-line object-cover" />
    </Tip>
  );
}

/** Renders any dataset cell value according to its column type. */
export function CellValue({ value, type, full }: { value: unknown; type?: string; full?: boolean }) {
  if (value === undefined || value === null || value === '') return <span className="text-ink-faint">—</span>;
  if (isFileValue(value)) {
    const mime = value.mime ?? '';
    if (type === 'audio' || mime.startsWith('audio/')) return <AudioPlayer file={value} compact={!full} />;
    if (type === 'image' || mime.startsWith('image/')) {
      if (!full) return <ImageThumb file={value} />;
      // Framed and letterboxed: the image keeps its own aspect ratio whatever the panel width.
      return (
        <a href={fileUrl(value.blob)} target="_blank" rel="noreferrer" title="Open full size" className="flex justify-center overflow-hidden rounded-lg border border-line bg-raised p-2">
          <img src={fileUrl(value.blob)} alt={value.name ?? ''} className="block h-auto max-h-[22rem] w-auto max-w-full rounded object-contain" />
        </a>
      );
    }
    return (
      <a href={fileUrl(value.blob, true)} className="inline-flex items-center gap-1 text-accent-ink hover:underline" onClick={(e) => e.stopPropagation()}>
        <FileIcon className="size-3.5" /> {value.name ?? 'file'}
      </a>
    );
  }
  if (typeof value === 'boolean') return <span className={value ? 'text-ok' : 'text-ink-muted'}>{String(value)}</span>;
  if (typeof value === 'number') return <span className="tabular-nums">{value}</span>;
  if (Array.isArray(value) && value.every((m) => m && typeof m === 'object' && 'role' in m)) {
    if (!full) return <span className="text-ink-muted">{value.length} messages</span>;
    return (
      <div className="flex flex-col gap-1.5">
        {value.map((m: any, i) => (
          <div key={i} className="rounded-lg bg-raised px-2.5 py-1.5">
            <div className="text-[0.71875rem] font-semibold uppercase tracking-wide text-ink-faint">{m.role}</div>
            <div className="whitespace-pre-wrap text-[0.8125rem]">{typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}</div>
          </div>
        ))}
      </div>
    );
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')) {
    return (
      <span className="inline-flex flex-wrap gap-1">
        {value.map((v, i) => (
          <span key={i} className="rounded bg-raised px-1.5 text-[0.75rem]">{v}</span>
        ))}
      </span>
    );
  }
  if (typeof value === 'object') {
    return full ? <pre className="font-mono text-[0.75rem] whitespace-pre-wrap">{JSON.stringify(value, null, 2)}</pre> : <span className="font-mono text-[0.75rem] text-ink-muted">{preview(value, 80)}</span>;
  }
  return full ? <span className="whitespace-pre-wrap">{String(value)}</span> : <span className="line-clamp-2">{String(value)}</span>;
}
