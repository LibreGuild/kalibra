import { fileUrl, op } from '../../lib/api';
import { bytes } from '../../lib/format';
import { toast, toastError } from '../ui/toast';

export interface BundleResult {
  hash: string;
  name?: string;
  size: number;
  manifest: { secrets: string[]; counts: Record<string, number>; media: { files: number; missing: number }; autoIncluded: string[] };
}

/** Starts a browser download of a stored file. */
export function downloadFile(hash: string, name?: string) {
  const a = document.createElement('a');
  a.href = fileUrl(hash, true);
  if (name) a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Exports a bundle and downloads it, with a toast that says what a teammate will need. */
export async function exportAndDownloadBundle(input: Record<string, unknown>): Promise<BundleResult | undefined> {
  try {
    const r = await op<BundleResult>('export_bundle', input);
    downloadFile(r.hash, r.name);
    const secrets = r.manifest.secrets.length ? ` Teammates need to set: ${r.manifest.secrets.join(', ')}.` : '';
    toast.success('Bundle ready', `${r.name ?? 'bundle'} · ${bytes(r.size)}.${secrets}`);
    return r;
  } catch (e) {
    toastError(e, 'Export failed');
    return undefined;
  }
}
