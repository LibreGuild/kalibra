import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import './styles.css';
import { queryClient } from './lib/api';
import { ThemeProvider } from './lib/theme';
import { TooltipProvider } from './components/ui/overlay';
import { Toaster } from './components/ui/toast';
import { router } from './routes';

// Radix moves focus in code (tabs, menus, dialogs), which Chrome then treats as keyboard focus and
// outlines. Track how the user is actually interacting so focus rings show for keyboard users only.
const root = document.documentElement;
addEventListener('pointerdown', () => (root.dataset.input = 'pointer'), true);
addEventListener('keydown', (e) => { if (!e.metaKey && !e.ctrlKey && !e.altKey) root.dataset.input = 'keyboard'; }, true);
// When a mouse user switches to another app, the browser restores focus to the last clicked link or
// button on return, which made it look hovered (and opened its tooltip). Mouse users don't rely on
// that focus, so let it go; fields keep theirs so typing can continue, and keyboard users keep theirs.
addEventListener('blur', (e) => {
  if (e.target !== window || root.dataset.input === 'keyboard') return;
  const el = document.activeElement as HTMLElement | null;
  if (el?.matches('a, button, [role="button"], [role="tab"], [role="menuitem"], [role="radio"], summary')) el.blur();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
