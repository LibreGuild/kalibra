import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { demoData, materializeRows } from './data.js';
import type { FixtureEntry } from './fixtures.js';

export type Call = <T = any>(name: string, input: unknown) => Promise<T>;

/**
 * Fills a workspace with the demo datasets, targets and suites through engine operations
 * (the same path the UI and agents use). Existing items with the same names are left alone.
 */
export async function seedWorkspace(call: Call, opts: { baseUrl: string; wsUrl: string; fixtures: FixtureEntry[] }) {
  const data = demoData(opts);
  const created = { datasets: 0, rows: 0, targets: 0, suites: 0 };

  const existing = new Set((await call<any[]>('list_datasets', {})).map((d) => d.name));
  for (const ds of data.datasets) {
    if (existing.has(ds.name)) continue;
    await call('create_dataset', { name: ds.name, description: ds.description, columns: ds.columns, instructions: ds.instructions });
    const rows = await materializeRows(ds.rows, async (path) => {
      const bytes = await readFile(path);
      const info = await call<any>('upload_file', { name: basename(path), base64: bytes.toString('base64'), mime: 'audio/wav' });
      return { blob: info.hash, name: info.name, mime: info.mime, size: info.size };
    });
    if (rows.length) {
      const res = await call<any>('add_dataset_rows', { dataset: ds.name, rows });
      created.rows += res.added.length;
    }
    created.datasets++;
  }

  for (const [kind, list] of [['target', data.targets], ['suite', data.suites]] as const) {
    const names = new Set((await call<any[]>(`list_${kind}s`, {})).map((d) => d.name));
    for (const def of list) {
      if (names.has(def.name)) continue;
      await call(`create_${kind}`, { name: def.name, description: def.description, spec: def.spec });
      created[`${kind}s` as 'targets' | 'suites']++;
    }
  }
  return created;
}
