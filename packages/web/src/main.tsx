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
