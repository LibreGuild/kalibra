import { ArrowUpRight } from 'lucide-react';
import { buttonClass } from '../components/ui/button';
import { Dialog } from '../components/ui/overlay';
import { SDK_BRIEF } from './content';
import { withBase } from '../lib/base';
import { sdkDocsPath } from './links';
import type { Lang } from './types';

/** Profile menu → SDK docs: what each SDK is for, and its full docs in a new tab. */
export function SdkDocsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width="lg"
      title="SDK docs"
      description="Libraries that show Kalibra what happens inside your app. The docs open in a new tab and are readable without signing in."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {(['js', 'python'] as Lang[]).map((lang) => {
          const sdk = SDK_BRIEF[lang];
          return (
            <div key={lang} className="flex flex-col gap-3 rounded-xl border border-line bg-raised p-4">
              <div>
                <div className="text-[0.9375rem] font-semibold">{sdk.name}</div>
                <p className="mt-1 text-[0.8125rem] text-ink-muted">{sdk.text}</p>
              </div>
              <code className="w-fit rounded-md bg-surface px-2 py-1 font-mono text-[0.75rem] text-ink-muted">{sdk.install}</code>
              <a href={withBase(sdkDocsPath(lang))} target="_blank" rel="noopener noreferrer" className={buttonClass('primary', 'sm', 'mt-auto w-fit')}>
                Documentation
                <ArrowUpRight className="size-3.5" />
              </a>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
