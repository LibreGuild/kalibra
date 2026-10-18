/**
 * Copies text to the clipboard. Browsers only offer the clipboard API on HTTPS and localhost, so on
 * a plain-HTTP address (a VM's IP, a LAN host) this falls back to the older execCommand('copy'),
 * which still works there because it runs inside the user's click.
 */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Permission denied or document not focused: try the fallback below.
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  // Off screen, but still selectable; keeps the page from scrolling or zooming on iOS.
  Object.assign(area.style, { position: 'fixed', top: '0', left: '-9999px', opacity: '0', fontSize: '16px' });
  const focused = document.activeElement as HTMLElement | null;
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    area.remove();
    focused?.focus?.({ preventScroll: true });
  }
  if (!ok) throw new Error('This browser blocked copying here. Select the text and copy it with your keyboard.');
}
