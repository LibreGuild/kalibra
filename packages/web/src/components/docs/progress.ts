import { useCallback, useState } from 'react';

/** Which guides this viewer has read. Stored per browser; the docs still work if storage is blocked. */
const KEY = 'kalibra.docs.read';

function load(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

export function useReadGuides() {
  const [read, setRead] = useState<Set<string>>(load);
  const markRead = useCallback((slug: string) => {
    setRead((prev) => {
      if (prev.has(slug)) return prev;
      const next = new Set(prev).add(slug);
      try {
        localStorage.setItem(KEY, JSON.stringify([...next]));
      } catch {
        /* storage blocked: progress lasts for this session */
      }
      return next;
    });
  }, []);
  return { read, markRead };
}
