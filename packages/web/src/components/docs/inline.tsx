import { Fragment, type ReactNode } from 'react';
import { Link } from '../../lib/nav';

/** Tiny inline markup for docs text: `code`, **bold** and [label](/route). */
export function Inline({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>);
    if (m[1] !== undefined) {
      out.push(
        <code key={k++} className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-[0.85em] text-ink">
          {m[1]}
        </code>,
      );
    } else if (m[2] !== undefined) {
      out.push(
        <strong key={k++} className="font-semibold text-ink">
          {m[2]}
        </strong>,
      );
    } else {
      out.push(
        <Link key={k++} to={m[4]} className="font-medium text-accent-ink underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
          {m[3]}
        </Link>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return <>{out}</>;
}
