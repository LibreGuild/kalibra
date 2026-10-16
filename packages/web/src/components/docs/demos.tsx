import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { ArrowRight, Bot, Crosshair, Database, GitCompare, ListChecks, Play, Terminal } from 'lucide-react';
import type { DemoName } from '../../docs/types';

/*
 * Small, self-contained toys for the docs. They use no engine calls, so they work offline
 * and never touch the workspace.
 */

export function Demo({ name }: { name: DemoName }) {
  switch (name) {
    case 'loop':
      return <LoopDemo />;
    case 'layers':
      return <LayersDemo />;
    case 'wer':
      return <WerDemo />;
    case 'template':
      return <TemplateDemo />;
    case 'passrate':
      return <PassRateDemo />;
    case 'ws-timeline':
      return <WsTimelineDemo />;
    case 'confusion':
      return <ConfusionDemo />;
    case 'mcp':
      return <McpDemo />;
    case 'compare':
      return <CompareDemo />;
    case 'columns':
      return <ColumnsDemo />;
    case 'variants':
      return <VariantsDemo />;
  }
}

const frame = 'rounded-xl border border-line bg-surface p-4';

/* The core loop, with a highlight that walks around it. */
function LoopDemo() {
  const steps = [
    { icon: Database, label: 'Dataset', hint: 'test cases' },
    { icon: Crosshair, label: 'Target', hint: 'your app' },
    { icon: ListChecks, label: 'Suite', hint: 'what good means' },
    { icon: Play, label: 'Run', hint: 'score it all' },
    { icon: GitCompare, label: 'Compare', hint: 'better or worse?' },
  ];
  const [active, setActive] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setActive((a) => (a + 1) % steps.length), 1400);
    return () => clearInterval(t);
  }, [steps.length]);
  return (
    <div className={clsx(frame, 'flex flex-wrap items-center justify-center gap-2')}>
      {steps.map((s, i) => (
        <div key={s.label} className="flex items-center gap-2">
          <div
            className={clsx(
              'flex w-[6.5rem] flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-center transition-all duration-500',
              i === active ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line bg-raised text-ink-muted',
            )}
          >
            <s.icon className="size-4.5" />
            <span className="text-sm font-semibold">{s.label}</span>
            <span className="text-xs text-ink-faint">{s.hint}</span>
          </div>
          {i < steps.length - 1 && <ArrowRight className="size-3.5 text-ink-faint" />}
        </div>
      ))}
    </div>
  );
}

/* Layers with a gate failure that skips the expensive judge. */
function LayersDemo() {
  const [gateFails, setGateFails] = useState(true);
  const layers = [
    { n: 0, name: 'Transport', check: 'HTTP 2xx', cost: 'free' },
    { n: 1, name: 'Structure', check: 'Matches JSON Schema', cost: 'free', gate: true },
    { n: 3, name: 'Content', check: 'Mentions key facts', cost: 'free' },
    { n: 4, name: 'Reference', check: 'Similarity ≥ 0.8', cost: 'cheap' },
    { n: 5, name: 'Judgment', check: 'LLM judge', cost: '$$' },
  ];
  return (
    <div className={frame}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-sm text-ink-muted">One row, top to bottom</span>
        <button
          type="button"
          onClick={() => setGateFails((g) => !g)}
          className="rounded-md border border-line-strong px-2 py-1 text-xs font-medium hover:bg-hover"
        >
          {gateFails ? 'Fix the response' : 'Break the schema'}
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {layers.map((l, i) => {
          const failedHere = gateFails && l.gate;
          const skipped = gateFails && i > 1;
          return (
            <div
              key={l.n}
              className={clsx(
                'flex items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-all duration-300',
                failedHere ? 'border-bad/40 bg-bad-soft' : skipped ? 'border-line bg-raised opacity-50' : 'border-line bg-raised',
              )}
            >
              <span className="w-5 text-center text-xs tabular-nums text-ink-faint">{l.n}</span>
              <span className="w-24 font-medium">{l.name}</span>
              <span className="min-w-0 flex-1 truncate text-ink-muted">{l.check}</span>
              <span className="text-xs text-ink-faint">{l.cost}</span>
              <span
                className={clsx(
                  'w-16 text-right text-xs font-semibold',
                  failedHere ? 'text-bad' : skipped ? 'text-ink-faint' : 'text-ok',
                )}
              >
                {failedHere ? 'gate ✗' : skipped ? 'skipped' : 'pass'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* Live WER on two editable sentences. */
function align(ref: string[], hyp: string[]) {
  const n = ref.length;
  const m = hyp.length;
  const d = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
  const ops: { op: 'eq' | 'sub' | 'del' | 'ins'; r?: string; h?: string }[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      ops.unshift({ op: ref[i - 1] === hyp[j - 1] ? 'eq' : 'sub', r: ref[i - 1], h: hyp[j - 1] });
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.unshift({ op: 'del', r: ref[i - 1] });
      i--;
    } else {
      ops.unshift({ op: 'ins', h: hyp[j - 1] });
      j--;
    }
  }
  return ops;
}
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').split(/\s+/).filter(Boolean);

function WerDemo() {
  const [ref, setRef] = useState('transfer fifteen hundred rupees to Priya on Monday');
  const [hyp, setHyp] = useState('transfer fifty hundred rupees to on Monday');
  const ops = useMemo(() => align(words(ref), words(hyp)), [ref, hyp]);
  const errors = ops.filter((o) => o.op !== 'eq').length;
  const refWords = words(ref).length;
  const wer = refWords ? errors / refWords : 0;
  const input = 'w-full rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-sm focus:border-accent/60 focus:outline-none';
  return (
    <div className={clsx(frame, 'flex flex-col gap-3')}>
      <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
        What was said (reference)
        <input className={input} value={ref} onChange={(e) => setRef(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
        What your app heard
        <input className={input} value={hyp} onChange={(e) => setHyp(e.target.value)} />
      </label>
      <div className="rounded-lg bg-raised px-3 py-2.5 font-mono text-[0.8rem] leading-7">
        {ops.map((o, k) =>
          o.op === 'eq' ? (
            <span key={k}>{o.r} </span>
          ) : o.op === 'sub' ? (
            <span key={k}>
              <s className="rounded bg-bad-soft px-1 text-bad">{o.r}</s> <span className="rounded bg-ok-soft px-1 text-ok">{o.h}</span>{' '}
            </span>
          ) : o.op === 'del' ? (
            <span key={k}>
              <s className="rounded bg-bad-soft px-1 text-bad">{o.r}</s>{' '}
            </span>
          ) : (
            <span key={k}>
              <u className="rounded bg-ok-soft px-1 text-ok">{o.h}</u>{' '}
            </span>
          ),
        )}
      </div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-ink-muted">
          {errors} error{errors === 1 ? '' : 's'} ÷ {refWords} words
        </span>
        <span className={clsx('text-lg font-semibold tabular-nums', wer <= 0.15 ? 'text-ok' : 'text-bad')}>WER {(wer * 100).toFixed(1)}%</span>
      </div>
    </div>
  );
}

/* {{placeholder}} rendering against an editable row. */
function TemplateDemo() {
  const [question, setQuestion] = useState('How do I block my card?');
  const [lang, setLang] = useState('en');
  const tpl = '{\n  "message": "{{question}}",\n  "language": "{{lang}}",\n  "user": "{{vars.user_id}}"\n}';
  const rendered = tpl
    .replace('{{question}}', JSON.stringify(question).slice(1, -1))
    .replace('{{lang}}', lang)
    .replace('{{vars.user_id}}', 'eval-bot');
  const input = 'w-full rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-sm focus:border-accent/60 focus:outline-none';
  return (
    <div className={clsx(frame, 'grid gap-4 md:grid-cols-[1fr_1.2fr]')}>
      <div className="flex flex-col gap-2.5">
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Dataset row</div>
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          question
          <input className={input} value={question} onChange={(e) => setQuestion(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          lang
          <input className={input} value={lang} onChange={(e) => setLang(e.target.value)} />
        </label>
      </div>
      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Template → request body</div>
        <pre className="overflow-x-auto rounded-lg bg-raised p-2.5 font-mono text-[0.75rem] leading-relaxed text-ink-muted">{tpl}</pre>
        <pre className="overflow-x-auto rounded-lg border border-accent/30 bg-accent-soft/50 p-2.5 font-mono text-[0.75rem] leading-relaxed text-ink">{rendered}</pre>
      </div>
    </div>
  );
}

/* Wilson interval narrowing as the number of rows grows. */
function wilson(p: number, n: number) {
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function PassRateDemo() {
  const [n, setN] = useState(20);
  const p = 0.8;
  const [lo, hi] = wilson(p, n);
  return (
    <div className={clsx(frame, 'flex flex-col gap-3')}>
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-ink-muted">Pass rate on {n} rows</span>
        <span className="text-2xl font-semibold tabular-nums text-ok">80%</span>
      </div>
      <div className="relative h-7 rounded-md bg-raised">
        <div className="absolute inset-y-1.5 rounded bg-accent/30 transition-all duration-300" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} />
        <div className="absolute inset-y-0 w-0.5 bg-ok" style={{ left: '80%' }} />
        <span className="absolute left-1 top-1/2 -translate-y-1/2 text-[0.65rem] text-ink-faint">0%</span>
        <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[0.65rem] text-ink-faint">100%</span>
      </div>
      <div className="text-sm text-ink-muted">
        The real pass rate is probably between <strong className="text-ink">{Math.round(lo * 100)}%</strong> and <strong className="text-ink">{Math.round(hi * 100)}%</strong>.
      </div>
      <input type="range" min={10} max={1000} step={10} value={n} onChange={(e) => setN(Number(e.target.value))} className="accent-[var(--k-accent)]" aria-label="Number of rows" />
    </div>
  );
}

/* What one streaming session looks like. */
function WsTimelineDemo() {
  const rows = [
    { t: 0, dir: 'out', text: '{"type":"start","sample_rate":16000}', kind: 'start' },
    { t: 4, dir: 'out', text: '▮▮▮ audio frames, 20 ms each, in real time', kind: 'audio' },
    { t: 286, dir: 'in', text: '{"type":"partial","text":"transfer"}', kind: 'partial', note: 'first partial' },
    { t: 912, dir: 'in', text: '{"type":"partial","text":"transfer fifteen hundred"}', kind: 'partial' },
    { t: 3173, dir: 'out', text: '{"type":"stop"}', kind: 'stop', note: 'last audio sent' },
    { t: 3505, dir: 'in', text: '{"type":"final","text":"transfer fifteen hundred rupees…","is_final":true}', kind: 'final', note: 'final latency 332 ms' },
  ];
  return (
    <div className={clsx(frame, 'flex flex-col gap-1.5')}>
      {rows.map((r) => (
        <div key={r.t} className="flex items-center gap-3 text-[0.78rem]">
          <span className="w-14 text-right tabular-nums text-ink-faint">{r.t} ms</span>
          <span className={clsx('w-6 text-center font-semibold', r.dir === 'out' ? 'text-accent-ink' : 'text-ok')}>{r.dir === 'out' ? '→' : '←'}</span>
          <span className={clsx('min-w-0 flex-1 truncate font-mono', r.kind === 'final' ? 'text-ink' : 'text-ink-muted')}>{r.text}</span>
          {r.note && <span className="shrink-0 rounded-md bg-accent-soft px-1.5 py-0.5 text-[0.7rem] font-medium text-accent-ink">{r.note}</span>}
        </div>
      ))}
    </div>
  );
}

/* Human vs judge, with kappa computed from the counts. */
function ConfusionDemo() {
  const [c, setC] = useState({ tp: 38, fp: 6, fn: 4, tn: 22 });
  const n = c.tp + c.fp + c.fn + c.tn;
  const agree = (c.tp + c.tn) / n;
  const pe = ((c.tp + c.fp) / n) * ((c.tp + c.fn) / n) + ((c.fn + c.tn) / n) * ((c.fp + c.tn) / n);
  const kappa = (agree - pe) / (1 - pe);
  const cell = (key: keyof typeof c, label: string, good: boolean) => (
    <label className={clsx('flex flex-col items-center gap-1 rounded-lg p-3', good ? 'bg-ok-soft' : 'bg-bad-soft')}>
      <span className="text-xs text-ink-muted">{label}</span>
      <input
        type="number"
        min={0}
        value={c[key]}
        onChange={(e) => setC({ ...c, [key]: Math.max(0, Number(e.target.value) || 0) })}
        className="w-16 rounded-md border border-line-strong bg-surface text-center text-lg font-semibold tabular-nums focus:outline-none"
      />
    </label>
  );
  return (
    <div className={clsx(frame, 'grid gap-4 md:grid-cols-[auto_1fr] md:items-center')}>
      <div className="grid grid-cols-[auto_1fr_1fr] gap-2 text-center">
        <span />
        <span className="text-xs font-semibold text-ink-faint">You: pass</span>
        <span className="text-xs font-semibold text-ink-faint">You: fail</span>
        <span className="self-center text-xs font-semibold text-ink-faint">Judge: pass</span>
        {cell('tp', 'both pass', true)}
        {cell('fp', 'judge too kind', false)}
        <span className="self-center text-xs font-semibold text-ink-faint">Judge: fail</span>
        {cell('fn', 'judge too harsh', false)}
        {cell('tn', 'both fail', true)}
      </div>
      <div className="flex flex-col gap-2 text-sm">
        <div className="flex justify-between">
          <span className="text-ink-muted">Agreement</span>
          <strong className="tabular-nums">{(agree * 100).toFixed(0)}%</strong>
        </div>
        <div className="flex justify-between">
          <span className="text-ink-muted">Kappa</span>
          <strong className={clsx('tabular-nums', kappa >= 0.6 ? 'text-ok' : 'text-warn')}>{Number.isFinite(kappa) ? kappa.toFixed(2) : '–'}</strong>
        </div>
        <div className="text-xs text-ink-faint">{kappa >= 0.8 ? 'Great: trust it.' : kappa >= 0.6 ? 'Good: watch the corners.' : 'Shaky: sharpen the rubric first.'}</div>
      </div>
    </div>
  );
}

/* A coding agent working through MCP. */
function McpDemo() {
  const lines = [
    { who: 'you', text: 'Create 50 rows for "Support questions", 20% should be refusals.' },
    { who: 'tool', text: 'get_dataset_schema → 5 columns, instructions read' },
    { who: 'tool', text: 'add_dataset_rows × 2 → 48 added, 2 rejected (expected_behavior: must be one of answer, refuse)' },
    { who: 'tool', text: 'add_dataset_rows → 2 added' },
    { who: 'agent', text: 'Done: 50 rows are waiting for your review in Kalibra.' },
  ];
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-[var(--k-sidebar)]">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs text-ink-faint">
        <Terminal className="size-3.5" /> your terminal
      </div>
      <div className="flex flex-col gap-1.5 p-3 font-mono text-[0.75rem] leading-relaxed">
        {lines.map((l, i) => (
          <div key={i} className="flex gap-2">
            <span className={clsx('shrink-0', l.who === 'you' ? 'text-accent-ink' : l.who === 'agent' ? 'text-ok' : 'text-ink-faint')}>
              {l.who === 'you' ? '>' : l.who === 'agent' ? <Bot className="inline size-3.5" /> : '⚙'}
            </span>
            <span className={l.who === 'tool' ? 'text-ink-muted' : 'text-ink'}>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* A compare verdict. */
function CompareDemo() {
  const tiles = [
    { label: 'Improved', n: 14, cls: 'text-ok' },
    { label: 'Regressed', n: 3, cls: 'text-bad' },
    { label: 'Same', n: 183, cls: 'text-ink-muted' },
  ];
  return (
    <div className={clsx(frame, 'flex flex-col gap-3')}>
      <div className="grid grid-cols-3 gap-2">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg bg-raised px-3 py-2">
            <div className="text-xs text-ink-faint">{t.label}</div>
            <div className={clsx('text-xl font-semibold tabular-nums', t.cls)}>{t.n}</div>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-ok/30 bg-ok-soft px-3 py-2 text-sm">
        <strong>Likely a real improvement</strong> <span className="text-ink-muted">(p = 0.013, 14 rows flipped to pass vs 3 to fail)</span>
      </div>
    </div>
  );
}

/* Column types at a glance. */
function ColumnsDemo() {
  const cols = [
    { key: 'question', type: 'text', sample: 'How do I block my card?' },
    { key: 'audio', type: 'audio', sample: '▶ u01.wav · 3.2 s' },
    { key: 'photo', type: 'image', sample: 'receipt_04.png · 1024×1536' },
    { key: 'keywords', type: 'list', sample: 'Priya · Monday · 1,500' },
    { key: 'history', type: 'messages', sample: '3 messages' },
    { key: 'amount', type: 'number', sample: '1500' },
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {cols.map((c) => (
        <div key={c.key} className="rounded-lg border border-line bg-surface px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <code className="font-mono text-[0.78rem] font-semibold">{`{{${c.key}}}`}</code>
            <span className="rounded bg-accent-soft px-1.5 text-[0.7rem] font-medium text-accent-ink">{c.type}</span>
          </div>
          <div className="mt-1 truncate text-sm text-ink-muted">{c.sample}</div>
        </div>
      ))}
    </div>
  );
}

/* Audio variants as little waveforms. */
function VariantsDemo() {
  const variants = [
    { name: 'original', amp: 1, noise: 0 },
    { name: 'noise 10 dB', amp: 1, noise: 0.35 },
    { name: 'phone line', amp: 0.8, noise: 0.08, clip: true },
    { name: 'echo', amp: 0.9, noise: 0.05, echo: true },
    { name: 'quiet', amp: 0.35, noise: 0.02 },
    { name: 'fast', amp: 1, noise: 0, fast: true },
  ];
  const bars = (v: (typeof variants)[number]) =>
    Array.from({ length: 40 }, (_, i) => {
      const x = v.fast ? i * 1.6 : i;
      const base = Math.abs(Math.sin(x * 0.45) * Math.sin(x * 0.13 + 1)) * v.amp;
      const echo = v.echo ? Math.abs(Math.sin((x - 3) * 0.45)) * 0.35 : 0;
      const jitter = v.noise * (((i * 7919) % 13) / 13);
      let h = Math.min(1, base + echo + jitter);
      if (v.clip) h = Math.min(h, 0.55);
      return Math.max(0.06, h);
    });
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {variants.map((v) => (
        <div key={v.name} className="rounded-lg border border-line bg-surface px-3 py-2.5">
          <div className="mb-1.5 text-xs font-medium text-ink-muted">{v.name}</div>
          <div className="flex h-8 items-center gap-[2px]">
            {bars(v).map((h, i) => (
              <span key={i} className={clsx('w-[3px] rounded-full', v.name === 'original' ? 'bg-accent' : 'bg-accent/60')} style={{ height: `${h * 100}%` }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
