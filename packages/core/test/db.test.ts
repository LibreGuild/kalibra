import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqlite, type Db } from '../src/db.js';

/** The async data layer: transactions run one at a time, and nothing outside one sees its changes early. */
describe('db', () => {
  let dir: string;
  let db: Db;
  const MIGRATIONS = ['CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL);'];
  const tick = () => new Promise((r) => setTimeout(r, 5));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-db-'));
    db = await openSqlite(join(dir, 'test.db'), MIGRATIONS);
  });
  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads, writes and counts changed rows', async () => {
    expect(await db.run('INSERT INTO t (id, n) VALUES (?, ?), (?, ?)', 'a', 1, 'b', 2)).toEqual({ changes: 2 });
    expect(await db.get('SELECT n FROM t WHERE id = ?', 'b')).toEqual({ n: 2 });
    expect(await db.all('SELECT id FROM t ORDER BY id')).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(await db.get('SELECT n FROM t WHERE id = ?', 'zz')).toBeUndefined();
    // A write through get() (RETURNING) goes to the write connection.
    expect(await db.get('UPDATE t SET n = n + 10 WHERE id = ? RETURNING n', 'a')).toEqual({ n: 11 });
  });

  it('keeps uncommitted changes of a transaction invisible to other async flows', async () => {
    let release!: () => void;
    const paused = new Promise<void>((r) => (release = r));
    const tx = db.tx(async () => {
      await db.run('INSERT INTO t (id, n) VALUES (?, ?)', 'x', 1);
      // Inside the transaction, its own write is visible.
      expect(await db.get('SELECT n FROM t WHERE id = ?', 'x')).toEqual({ n: 1 });
      await paused;
    });
    await tick();
    // Outside it, not yet: reads use the last committed state and don't wait for the transaction.
    expect(await db.get('SELECT n FROM t WHERE id = ?', 'x')).toBeUndefined();
    release();
    await tx;
    expect(await db.get('SELECT n FROM t WHERE id = ?', 'x')).toEqual({ n: 1 });
  });

  it('rolls back everything when the function throws', async () => {
    await expect(
      db.tx(async () => {
        await db.run('INSERT INTO t (id, n) VALUES (?, ?)', 'a', 1);
        await db.tx(async () => db.run('INSERT INTO t (id, n) VALUES (?, ?)', 'b', 2));
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(await db.all('SELECT * FROM t')).toEqual([]);
    // The write connection is usable again afterwards.
    await db.run('INSERT INTO t (id, n) VALUES (?, ?)', 'c', 3);
    expect(await db.get('SELECT COUNT(*) AS c FROM t')).toEqual({ c: 1 });
  });

  it('joins nested transactions to the outer one', async () => {
    await db.tx(async () => {
      await db.run('INSERT INTO t (id, n) VALUES (?, ?)', 'a', 1);
      await db.tx(async () => {
        await db.run('UPDATE t SET n = 2 WHERE id = ?', 'a');
        expect(await db.get('SELECT n FROM t WHERE id = ?', 'a')).toEqual({ n: 2 });
      });
      await Promise.all([db.run('INSERT INTO t (id, n) VALUES (?, ?)', 'b', 1), db.run('INSERT INTO t (id, n) VALUES (?, ?)', 'c', 1)]);
    });
    expect(await db.get('SELECT SUM(n) AS s FROM t')).toEqual({ s: 4 });
  });

  it('makes writes outside a transaction wait until it ends, and runs transactions one at a time', async () => {
    const order: string[] = [];
    let release!: () => void;
    const paused = new Promise<void>((r) => (release = r));
    const first = db.tx(async () => {
      order.push('tx1 start');
      await db.run('INSERT INTO t (id, n) VALUES (?, ?)', 'a', 1);
      await paused;
      order.push('tx1 end');
    });
    await tick();
    const write = db.run('INSERT INTO t (id, n) VALUES (?, ?)', 'b', 1);
    const second = db.tx(async () => {
      order.push('tx2 start');
      // Sees tx1's committed row and the write queued before it: nothing overlaps, in arrival order.
      expect(await db.all('SELECT id FROM t ORDER BY id')).toEqual([{ id: 'a' }, { id: 'b' }]);
      order.push('tx2 end');
    });
    await tick();
    expect(order).toEqual(['tx1 start']);
    release();
    await Promise.all([first, write, second]);
    expect(order).toEqual(['tx1 start', 'tx1 end', 'tx2 start', 'tx2 end']);
  });

  it('lets a read-modify-write in a transaction not lose concurrent updates', async () => {
    await db.run('INSERT INTO t (id, n) VALUES (?, ?)', 'c', 0);
    const bump = () =>
      db.tx(async () => {
        const { n } = (await db.get('SELECT n FROM t WHERE id = ?', 'c'))!;
        await tick();
        await db.run('UPDATE t SET n = ? WHERE id = ?', n + 1, 'c');
      });
    await Promise.all(Array.from({ length: 10 }, bump));
    expect(await db.get('SELECT n FROM t WHERE id = ?', 'c')).toEqual({ n: 10 });
  });

  it('does not let work that outlives a transaction slip into the next one', async () => {
    let late: Promise<unknown> | undefined;
    await db.tx(async () => {
      // Started inside, finishes after commit: it must run on its own, not inside another flow's transaction.
      late = tick().then(() => db.run('INSERT INTO t (id, n) VALUES (?, ?)', 'late', 1));
    });
    let release!: () => void;
    const paused = new Promise<void>((r) => (release = r));
    const other = db.tx(async () => {
      await db.run('INSERT INTO t (id, n) VALUES (?, ?)', 'other', 1);
      await paused;
      throw new Error('rolled back');
    });
    await tick();
    await tick();
    release();
    await expect(other).rejects.toThrow('rolled back');
    await late;
    // The late write survived the other transaction's rollback.
    expect((await db.all('SELECT id FROM t ORDER BY id')).map((r) => r.id)).toEqual(['late']);
  });

  it('refuses data from a newer version', async () => {
    await db.close();
    db = await openSqlite(join(dir, 'test.db'), [...MIGRATIONS, 'CREATE TABLE u (id TEXT);']);
    await db.close();
    await expect(openSqlite(join(dir, 'test.db'), MIGRATIONS)).rejects.toThrow(/newer version of Kalibra/);
    db = await openSqlite(join(dir, 'test.db'), [...MIGRATIONS, 'CREATE TABLE u (id TEXT);']);
  });
});
