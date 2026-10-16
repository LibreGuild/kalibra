import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import clsx from 'clsx';
import { useTheme } from '../../lib/theme';

const transparent = EditorView.theme({
  '&': { backgroundColor: 'transparent' },
  '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid var(--k-line)', color: 'var(--k-ink-faint)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-content': { fontFamily: 'var(--font-mono)', padding: '8px 0' },
  '.cm-placeholder': { color: 'var(--k-ink-faint)' },
});

/** Code editor for JSON bodies, templates and user scripts. */
export function CodeEditor({
  value,
  onChange,
  language = 'text',
  minHeight = 80,
  maxHeight = 420,
  placeholder,
  readOnly,
  className,
}: {
  value: string;
  onChange?: (v: string) => void;
  language?: 'js' | 'json' | 'text';
  minHeight?: number;
  maxHeight?: number;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
}) {
  const { resolved } = useTheme();
  const extensions = [transparent, EditorView.lineWrapping, ...(language === 'js' ? [javascript()] : language === 'json' ? [json()] : [])];
  return (
    <div className={clsx('overflow-hidden rounded-lg border border-line-strong bg-surface focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20', className)}>
      <CodeMirror
        value={value}
        onChange={onChange}
        theme={resolved}
        extensions={extensions}
        readOnly={readOnly}
        placeholder={placeholder}
        basicSetup={{ lineNumbers: language !== 'text', foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false, autocompletion: language === 'js' }}
        minHeight={`${minHeight}px`}
        maxHeight={`${maxHeight}px`}
      />
    </div>
  );
}
