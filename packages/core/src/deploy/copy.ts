import type { Db, TableInfo } from '../db.js';

/*
 * Copies a whole database (hub or project) into another one with the same schema, in either
 * direction between SQLite and Postgres: `kalibra backup` writes a portable SQLite copy of a Postgres
 * deployment, and moving a data folder into Postgres uses the same code. Tables are copied parents
 * first (foreign keys), in primary-key order, a batch per transaction.
 */

export interface CopyResult {
  tables: number;
  rows: number;
}

/** Parents before the tables that reference them. */
function dependencyOrder(tables: TableInfo[]): TableInfo[] {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const done = new Set<string>();
  const out: TableInfo[] = [];
  const visit = (t: TableInfo, path: Set<string>) => {
    if (done.has(t.name)) return;
    if (path.has(t.name)) throw new Error(`Tables reference each other in a cycle: ${[...path, t.name].join(' → ')}`);
    path.add(t.name);
    for (const ref of t.references) if (ref !== t.name && byName.has(ref)) visit(byName.get(ref)!, path);
    path.delete(t.name);
    done.add(t.name);
    out.push(t);
  };
  for (const t of [...tables].sort((a, b) => a.name.localeCompare(b.name))) visit(t, new Set());
  return out;
}

/** Copies every row of `from` into `to`, which must have the same tables and be empty. */
export async function copyDatabase(from: Db, to: Db, opts: { batch?: number } = {}): Promise<CopyResult> {
  const batch = opts.batch ?? 1000;
  const source = new Map((await from.tables()).map((t) => [t.name, t]));
  const targets = dependencyOrder(await to.tables());
  for (const t of targets) {
    if (await to.get(`SELECT 1 AS x FROM ${t.name} LIMIT 1`)) throw new Error(`The destination already has data in ${t.name}; copy into an empty database`);
  }
  let rows = 0;
  let tables = 0;
  for (const t of targets) {
    const s = source.get(t.name);
    if (!s) continue;
    const cols = t.columns.filter((c) => s.columns.includes(c));
    const key = s.primaryKey;
    if (!key.length) throw new Error(`Table ${t.name} has no primary key, so it can't be copied in batches`);
    const select = `SELECT ${cols.join(', ')} FROM ${t.name}`;
    const order = `ORDER BY ${key.join(', ')} LIMIT ?`;
    // Inserts stay under SQLite's and Postgres' limits on parameters per statement.
    const perInsert = Math.max(1, Math.min(batch, Math.floor(30000 / cols.length)));
    let after: unknown[] | undefined;
    tables++;
    for (;;) {
      const page: Record<string, unknown>[] = after
        ? await from.all(`${select} WHERE (${key.join(', ')}) > (${key.map(() => '?').join(', ')}) ${order}`, ...after, batch)
        : await from.all(`${select} ${order}`, batch);
      if (!page.length) break;
      await to.tx(async () => {
        for (let i = 0; i < page.length; i += perInsert) {
          const part = page.slice(i, i + perInsert);
          await to.run(
            `INSERT INTO ${t.name} (${cols.join(', ')}) VALUES ${part.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')}`,
            ...part.flatMap((r) => cols.map((c) => r[c])),
          );
        }
      });
      rows += page.length;
      const last = page[page.length - 1];
      after = key.map((k) => last[k]);
      if (page.length < batch) break;
    }
    for (const col of t.identity) await (to as Db & { resetIdentity?: (t: string, c: string) => Promise<void> }).resetIdentity?.(t.name, col);
  }
  return { tables, rows };
}
