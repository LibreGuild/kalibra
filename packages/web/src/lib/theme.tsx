import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/* Appearance preferences: theme, reading font and text size. Stored per browser/app install. */

export type ThemeChoice = 'system' | 'light' | 'dark';
export type FontChoice = 'atkinson' | 'inter' | 'plex' | 'system';
export type TextScale = 0.9 | 1 | 1.1 | 1.25;
export type AccentChoice = 'clay' | 'teal' | 'sky' | 'rose' | 'violet';

interface Prefs {
  choice: ThemeChoice;
  resolved: 'light' | 'dark';
  setChoice: (c: ThemeChoice) => void;
  font: FontChoice;
  setFont: (f: FontChoice) => void;
  scale: TextScale;
  setScale: (s: TextScale) => void;
  accent: AccentChoice;
  setAccent: (a: AccentChoice) => void;
}

const Ctx = createContext<Prefs>({
  choice: 'system',
  resolved: 'light',
  setChoice: () => {},
  font: 'atkinson',
  setFont: () => {},
  scale: 1,
  setScale: () => {},
  accent: 'clay',
  setAccent: () => {},
});

function read<T extends string | number>(key: string, fallback: T, parse: (s: string) => T = (s) => s as T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : parse(v);
  } catch {
    return fallback;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode or blocked storage: preference lasts for this session only */
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => read('kalibra.theme', 'system' as ThemeChoice));
  const [font, setFontState] = useState<FontChoice>(() => read('kalibra.font', 'atkinson' as FontChoice));
  const [scale, setScaleState] = useState<TextScale>(() => read('kalibra.scale', 1 as TextScale, (s) => (Number(s) || 1) as TextScale));
  const [accent, setAccentState] = useState<AccentChoice>(() => read('kalibra.accent', 'clay' as AccentChoice));
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const fn = () => setSystemDark(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);

  const resolved = choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.dataset.font = font;
    root.dataset.accent = accent;
    root.style.setProperty('--k-scale', String(scale));
  }, [resolved, font, scale, accent]);

  return (
    <Ctx.Provider
      value={{
        choice,
        resolved,
        setChoice: (c) => (setChoiceState(c), write('kalibra.theme', c)),
        font,
        setFont: (f) => (setFontState(f), write('kalibra.font', f)),
        scale,
        setScale: (s) => (setScaleState(s), write('kalibra.scale', String(s))),
        accent,
        setAccent: (a) => (setAccentState(a), write('kalibra.accent', a)),
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useTheme = () => useContext(Ctx);
