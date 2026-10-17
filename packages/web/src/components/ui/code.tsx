import { lazy, Suspense, type ComponentProps } from 'react';
import clsx from 'clsx';

// CodeMirror is about a third of the app's code, so it loads the first time an editor is shown,
// not with every page that might show one.
const Editor = lazy(() => import('./code-editor'));

/** Code editor for JSON bodies, templates and user scripts. */
export function CodeEditor(props: ComponentProps<typeof Editor>) {
  const { value, minHeight = 80, className } = props;
  return (
    <Suspense
      fallback={
        // Same frame and height as the editor, showing the text, so nothing jumps when it loads.
        <div className={clsx('overflow-hidden rounded-lg border border-line-strong bg-surface', className)}>
          <pre className="m-0 overflow-hidden px-3 py-2 font-mono text-[0.8125rem] whitespace-pre-wrap text-ink-muted" style={{ minHeight }}>
            {value}
          </pre>
        </div>
      }
    >
      <Editor {...props} />
    </Suspense>
  );
}
