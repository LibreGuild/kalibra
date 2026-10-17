// Applies the saved appearance (theme, reading font, accent, text size) before the app renders, so
// the page never flashes the wrong colours. Kept in sync with src/lib/theme.tsx (defaults included).
(function () {
  try {
    var root = document.documentElement;
    var t = localStorage.getItem('kalibra.theme') || 'system';
    var dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.font = localStorage.getItem('kalibra.font') || 'atkinson';
    root.dataset.accent = localStorage.getItem('kalibra.accent') || 'teal';
    root.style.setProperty('--k-scale', localStorage.getItem('kalibra.scale') || '1');
  } catch (e) {}
})();
