import { randomBytes } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip, gunzipSync, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { sqliteControl, type Db, type SqliteControl } from '../db.js';
import type { ObjectStore } from './objects.js';

/*
 * Keeps SQLite databases in a bucket (deployment mode "single + bucket").
 *
 * The databases stay on local disk (fast, safe); every few seconds each changed database ships the
 * pages its write-ahead log (WAL) collected since the last sync, as one gzip object. Kalibra does
 * all checkpointing itself (wal_autocheckpoint=0), and only after the WAL's pages are shipped, so
 * no change reaches the main file unseen. A full snapshot starts each "generation"; a new machine
 * restores the latest snapshot and applies that generation's page sets in order.
 *
 *   <prefix>/sqlite/<db>/manifest.json                       the current generation
 *   <prefix>/sqlite/<db>/generations/<gen>/snapshot.db.gz    full copy at the start of the generation
 *   <prefix>/sqlite/<db>/generations/<gen>/pages/<seq>.gz    pages changed since the previous sync
 *
 * Anything unexpected (a WAL reset by another process, a failed upload) falls back to a new
 * snapshot, which is always correct. Next to each database, `<file>.sync.json` remembers which
 * generation and sequence the local file matches, so a restart knows whether the local copy or the
 * bucket is newer.
 */

const WAL_HEADER = 32;
const FRAME_HEADER = 24;
const DELTA_MAGIC = 'KLWD';
/** A new snapshot once the page sets of a generation add up to more than this share of the snapshot (or a day passes). */
const MAX_DELTA_RATIO = 1;
const MAX_GENERATION_AGE_MS = 24 * 3600_000;

interface WalPos {
  salt1: number;
  salt2: number;
  ckpt: number;
  /** Frames already shipped from this WAL. */
  frames: number;
  c1: number;
  c2: number;
}

/** What the next WAL read should expect: a fresh WAL (we just reset it), or more frames after `pos`. */
type WalState = { kind: 'fresh'; after?: { salt1: number; ckpt: number } } | { kind: 'at'; pos: WalPos };

type WalRead =
  | { kind: 'none' }
  | { kind: 'gap'; reason: string }
  | { kind: 'pages'; pageSize: number; dbSize: number; pages: Map<number, Buffer>; end: WalPos; frames: number };

function checksum(buf: Buffer, start: number, end: number, bigEndian: boolean, s1: number, s2: number): [number, number] {
  for (let i = start; i < end; i += 8) {
    const x0 = bigEndian ? buf.readUInt32BE(i) : buf.readUInt32LE(i);
    const x1 = bigEndian ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4);
    s1 = (s1 + x0 + s2) >>> 0;
    s2 = (s2 + x1 + s1) >>> 0;
  }
  return [s1, s2];
}

/**
 * Reads the committed frames of a WAL that follow what was already shipped. Must run while no
 * transaction can write (under the database's write lock), so the WAL can't change meanwhile.
 */
export function readWal(walFile: string, state: WalState): WalRead {
  if (!existsSync(walFile)) return { kind: 'none' };
  const buf = readFileSync(walFile);
  if (buf.length < WAL_HEADER) return state.kind === 'at' ? { kind: 'gap', reason: 'the WAL was reset' } : { kind: 'none' };
  const magic = buf.readUInt32BE(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return { kind: 'gap', reason: 'not a WAL file' };
  const bigEndian = (magic & 1) === 1;
  const pageSize = buf.readUInt32BE(8);
  const ckpt = buf.readUInt32BE(12);
  const salt1 = buf.readUInt32BE(16);
  const salt2 = buf.readUInt32BE(20);
  const [h1, h2] = checksum(buf, 0, 24, bigEndian, 0, 0);
  if (h1 !== buf.readUInt32BE(24) || h2 !== buf.readUInt32BE(28)) return { kind: 'gap', reason: 'the WAL header is damaged' };

  let start = 0;
  let s1 = h1;
  let s2 = h2;
  if (state.kind === 'at') {
    if (state.pos.salt1 !== salt1 || state.pos.salt2 !== salt2) return { kind: 'gap', reason: 'the WAL was reset by someone else' };
    start = state.pos.frames;
    s1 = state.pos.c1;
    s2 = state.pos.c2;
  } else if (state.after && (salt1 !== ((state.after.salt1 + 1) >>> 0) || ckpt !== ((state.after.ckpt + 1) >>> 0))) {
    // Our own reset bumps salt-1 and the checkpoint counter by one; anything else means another
    // process checkpointed (and so moved changes we never saw into the main file).
    return { kind: 'gap', reason: 'the WAL was restarted by someone else' };
  }

  const frameSize = FRAME_HEADER + pageSize;
  const total = Math.floor((buf.length - WAL_HEADER) / frameSize);
  if (state.kind === 'at' && total < start) return { kind: 'gap', reason: 'the WAL shrank' };
  const pages = new Map<number, Buffer>();
  let pending = new Map<number, Buffer>();
  let committed: WalPos | undefined;
  let dbSize = 0;
  for (let i = start; i < total; i++) {
    const off = WAL_HEADER + i * frameSize;
    if (buf.readUInt32BE(off + 8) !== salt1 || buf.readUInt32BE(off + 12) !== salt2) break;
    [s1, s2] = checksum(buf, off, off + 8, bigEndian, s1, s2);
    [s1, s2] = checksum(buf, off + FRAME_HEADER, off + frameSize, bigEndian, s1, s2);
    if (s1 !== buf.readUInt32BE(off + 16) || s2 !== buf.readUInt32BE(off + 20)) break;
    pending.set(buf.readUInt32BE(off), buf.subarray(off + FRAME_HEADER, off + frameSize));
    const commit = buf.readUInt32BE(off + 4);
    if (commit) {
      for (const [p, data] of pending) pages.set(p, data);
      pending = new Map();
      dbSize = commit;
      committed = { salt1, salt2, ckpt, frames: i + 1, c1: s1, c2: s2 };
    }
  }
  if (!committed) return { kind: 'none' };
  return { kind: 'pages', pageSize, dbSize, pages, end: committed, frames: committed.frames - start };
}

const gzipAsync = promisify(gzip);

/**
 * One page set: the database size after it and the changed pages. Compressed off the event loop: a
 * burst of writes can make a page set 100 MB, which takes ~200 ms to gzip.
 */
export async function encodeDelta(pageSize: number, dbSize: number, pages: Map<number, Buffer>): Promise<Buffer> {
  const head = Buffer.alloc(16);
  head.write(DELTA_MAGIC, 0, 'latin1');
  head.writeUInt32BE(pageSize, 4);
  head.writeUInt32BE(dbSize, 8);
  head.writeUInt32BE(pages.size, 12);
  const parts: Buffer[] = [head];
  for (const [pgno, data] of [...pages].sort((a, b) => a[0] - b[0])) {
    const n = Buffer.alloc(4);
    n.writeUInt32BE(pgno);
    parts.push(n, data);
  }
  return gzipAsync(Buffer.concat(parts), { level: 6 });
}

export function decodeDelta(gz: Buffer): { pageSize: number; dbSize: number; pages: [number, Buffer][] } {
  const buf = gunzipSync(gz);
  if (buf.toString('latin1', 0, 4) !== DELTA_MAGIC) throw new Error('Not a Kalibra page set');
  const pageSize = buf.readUInt32BE(4);
  const dbSize = buf.readUInt32BE(8);
  const count = buf.readUInt32BE(12);
  const pages: [number, Buffer][] = [];
  let off = 16;
  for (let i = 0; i < count; i++) {
    pages.push([buf.readUInt32BE(off), buf.subarray(off + 4, off + 4 + pageSize)]);
    off += 4 + pageSize;
  }
  if (off !== buf.length) throw new Error('A page set is damaged');
  return { pageSize, dbSize, pages };
}

interface Manifest {
  format: 1;
  generation: string;
  createdAt: string;
  snapshotBytes: number;
  dbBytes: number;
}

interface Marker {
  generation: string;
  seq: number;
  /** Written at a clean close, after the last sync: the local file then matches the bucket exactly. */
  clean: boolean;
  size?: number;
  mtimeMs?: number;
}

export interface DbSyncStatus {
  name: string;
  generation?: string;
  seq: number;
  lastSyncAt?: string;
  lastUploadAt?: string;
  lastError?: string;
  /** Seconds since the last successful sync (0 when nothing changed since). */
  lagSeconds: number;
  bytesUploaded: number;
  uploads: number;
}

const newGeneration = () => `${Date.now().toString(36).padStart(9, '0')}-${randomBytes(3).toString('hex')}`;
const seqName = (seq: number) => String(seq).padStart(9, '0');
const markerPath = (file: string) => `${file}.sync.json`;

function readMarker(file: string): Marker | undefined {
  try {
    return JSON.parse(readFileSync(markerPath(file), 'utf8'));
  } catch {
    return undefined;
  }
}

function writeMarker(file: string, m: Marker) {
  const tmp = `${markerPath(file)}.tmp`;
  writeFileSync(tmp, JSON.stringify(m));
  renameSync(tmp, markerPath(file));
}

/** `PRAGMA wal_checkpoint(TRUNCATE)`: true when every frame moved into the main file and the WAL was emptied. */
function truncateWal(raw: DatabaseSync): boolean {
  const r = raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as any;
  return Number(r?.busy ?? 1) === 0;
}

function walHeader(walFile: string): { salt1: number; ckpt: number } | undefined {
  try {
    const fd = openSync(walFile, 'r');
    try {
      const b = Buffer.alloc(WAL_HEADER);
      const n = readSync(fd, b, 0, WAL_HEADER, 0);
      return n === WAL_HEADER ? { salt1: b.readUInt32BE(16), ckpt: b.readUInt32BE(12) } : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** Checks a database file (read-only) and throws unless SQLite finds it intact. */
function verify(file: string, quick = false) {
  const { DatabaseSync: Sqlite } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  // Opening a WAL-mode copy creates -wal/-shm files a read-only connection can't remove: we do.
  const sidecars = ['-wal', '-shm'].map((ext) => file + ext).filter((f) => !existsSync(f));
  const db = new Sqlite(file, { readOnly: true });
  try {
    const r = db.prepare(quick ? 'PRAGMA quick_check' : 'PRAGMA integrity_check').all() as any[];
    const msg = r.map((x) => Object.values(x)[0]).join('; ');
    if (msg !== 'ok') throw new Error(`database check failed: ${msg.slice(0, 300)}`);
  } finally {
    db.close();
    for (const f of sidecars) rmSync(f, { force: true });
  }
}

function moveAside(file: string, why: string) {
  if (!existsSync(file)) return;
  const bak = `${file}.${why}-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  renameSync(file, bak);
  for (const ext of ['-wal', '-shm']) rmSync(file + ext, { force: true });
  return bak;
}

/** One database's sync state. */
class DbSync {
  generation?: string;
  seq = 0;
  private wal: WalState = { kind: 'fresh' };
  needsSnapshot = false;
  private snapshotBytes = 0;
  private deltaBytes = 0;
  private generationStarted = 0;
  private busy: Promise<void> = Promise.resolve();
  private failures = 0;
  private retryAt = 0;
  stopped = false;
  readonly status: DbSyncStatus;

  constructor(
    readonly name: string,
    readonly file: string,
    readonly ctrl: SqliteControl,
    private objects: ObjectStore,
    private log: (msg: string) => void,
  ) {
    this.status = { name, seq: 0, lagSeconds: 0, bytesUploaded: 0, uploads: 0 };
  }

  private key(...parts: string[]) {
    return ['sqlite', this.name, ...parts].join('/');
  }

  /** Continues a generation the local file matches exactly (clean restart), else plans a snapshot. */
  begin(plan: { generation: string; seq: number; createdAt: number; snapshotBytes: number } | undefined) {
    if (plan) {
      this.generation = plan.generation;
      this.seq = plan.seq;
      this.generationStarted = plan.createdAt;
      this.snapshotBytes = plan.snapshotBytes;
      this.status.generation = plan.generation;
      this.status.seq = plan.seq;
      // After a clean close the WAL is gone; if one is left, it is still unshipped work: snapshot.
      if (existsSync(`${this.file}-wal`) && statSync(`${this.file}-wal`).size > 0) this.needsSnapshot = true;
    } else this.needsSnapshot = true;
  }

  /** Runs one sync (serialised with others of this database). */
  sync(): Promise<void> {
    const run = this.busy.then(() => (this.stopped ? undefined : this.syncOnce()));
    this.busy = run.catch(() => {});
    return run;
  }

  private async syncOnce() {
    if (Date.now() < this.retryAt) return;
    try {
      if (this.needsSnapshot || this.dueForNewGeneration()) await this.snapshot();
      else await this.shipPages();
      this.failures = 0;
      this.status.lastError = undefined;
      this.status.lastSyncAt = new Date().toISOString();
    } catch (e: any) {
      // A failed upload: the pages are already checkpointed (or the snapshot is incomplete), so the
      // next attempt starts a new generation. Back off while the bucket keeps failing.
      this.needsSnapshot = true;
      this.failures++;
      this.retryAt = Date.now() + Math.min(5 * 60_000, 2000 * 2 ** Math.min(this.failures, 8));
      this.status.lastError = String(e?.message ?? e).slice(0, 300);
      this.log(`sync of ${this.name} failed (${this.status.lastError}); retrying with a full snapshot`);
    }
  }

  private dueForNewGeneration() {
    return !!this.generation && (this.deltaBytes > Math.max(this.snapshotBytes * MAX_DELTA_RATIO, 1 << 20) || Date.now() - this.generationStarted > MAX_GENERATION_AGE_MS);
  }

  private async shipPages() {
    const wal = `${this.file}-wal`;
    const read = await this.ctrl.exclusive((raw) => {
      const r = readWal(wal, this.wal);
      if (r.kind !== 'pages') return r;
      // Shipped below; move the pages into the main file now so the WAL starts over.
      const before = walHeader(wal);
      if (truncateWal(raw)) this.wal = { kind: 'fresh', ...(before ? { after: before } : {}) };
      else this.wal = { kind: 'at', pos: r.end };
      return r;
    });
    if (read.kind === 'none') return;
    if (read.kind === 'gap') {
      this.log(`${this.name}: ${read.reason}; taking a full snapshot`);
      return this.snapshot();
    }
    const body = await encodeDelta(read.pageSize, read.dbSize, read.pages);
    const seq = this.seq + 1;
    await this.objects.put(this.key('generations', this.generation!, 'pages', `${seqName(seq)}.gz`), body, { contentType: 'application/gzip' });
    this.seq = seq;
    this.deltaBytes += body.length;
    this.uploaded(body.length);
    writeMarker(this.file, { generation: this.generation!, seq, clean: false });
  }

  /** Starts a new generation: a full, checked copy of the database, then the manifest pointing at it. */
  async snapshot() {
    const wal = `${this.file}-wal`;
    const tmp = `${this.file}.snapshot.tmp`;
    const gz = `${tmp}.gz`;
    try {
      // Empty the WAL into the main file; from then on only our own (serialised) checkpoints change
      // that file, so it can be copied while writes carry on into the new WAL.
      const before = await this.ctrl.exclusive((raw) => {
        const header = walHeader(wal);
        if (!truncateWal(raw)) throw new Error('the database is busy (another process is reading it); will retry');
        return header;
      });
      this.wal = { kind: 'fresh', ...(before ? { after: before } : {}) };
      copyFileSync(this.file, tmp);
      verify(tmp, true);
      const dbBytes = statSync(tmp).size;
      await pipeline(createReadStream(tmp), createGzip({ level: 6 }), createWriteStream(gz));
      const snapshotBytes = statSync(gz).size;
      const generation = newGeneration();
      await this.objects.putFile(this.key('generations', generation, 'snapshot.db.gz'), gz, { contentType: 'application/gzip' });
      const manifest: Manifest = { format: 1, generation, createdAt: new Date().toISOString(), snapshotBytes, dbBytes };
      await this.objects.put(this.key('manifest.json'), Buffer.from(JSON.stringify(manifest)), { contentType: 'application/json' });
      const previous = this.generation;
      this.generation = generation;
      this.seq = 0;
      this.snapshotBytes = snapshotBytes;
      this.deltaBytes = 0;
      this.generationStarted = Date.now();
      this.needsSnapshot = false;
      this.status.generation = generation;
      this.uploaded(snapshotBytes);
      writeMarker(this.file, { generation, seq: 0, clean: false });
      this.prune(generation, previous).catch((e) => this.log(`cleaning old generations of ${this.name} failed: ${e?.message ?? e}`));
    } finally {
      rmSync(tmp, { force: true });
      rmSync(gz, { force: true });
    }
  }

  /** Keeps the current and the previous generation. */
  private async prune(current: string, previous?: string) {
    const keys = await this.objects.list(this.key('generations') + '/');
    for (const k of keys) {
      const gen = k.slice(this.key('generations').length + 1).split('/')[0];
      if (gen !== current && gen !== previous) await this.objects.delete(k);
    }
  }

  private uploaded(bytes: number) {
    this.status.seq = this.seq;
    this.status.uploads++;
    this.status.bytesUploaded += bytes;
    this.status.lastUploadAt = new Date().toISOString();
  }

  /** The last sync before the database closes; then the marker says the file matches the bucket. */
  async finish() {
    await this.sync();
    this.stopped = true;
  }

  markClean() {
    if (!this.generation || this.needsSnapshot || this.status.lastError) return;
    const st = statSync(this.file);
    writeMarker(this.file, { generation: this.generation, seq: this.seq, clean: true, size: st.size, mtimeMs: st.mtimeMs });
  }
}

/** Every synced database of this Kalibra, with one timer. */
export class SqliteSync {
  private dbs = new Map<string, DbSync>();
  private plans = new Map<string, { generation: string; seq: number; createdAt: number; snapshotBytes: number } | undefined>();
  private timer?: NodeJS.Timeout;

  constructor(
    private objects: ObjectStore,
    private opts: { root: string; intervalSeconds: number; log?: (msg: string) => void },
  ) {}

  private log(msg: string) {
    (this.opts.log ?? ((m) => console.log(`[sync] ${m}`)))(msg);
  }

  /** The database's name in the bucket: its path inside the data folder. */
  nameOf(file: string) {
    const rel = relative(this.opts.root, file);
    if (rel.startsWith('..') || rel === '') throw new Error(`${file} is outside the data folder`);
    return rel.split(sep).join('/');
  }

  /**
   * Before a database is opened: restores it from the bucket when it is missing locally or behind,
   * and decides whether syncing can continue the bucket's generation or needs a new snapshot.
   */
  async prepare(file: string) {
    const name = this.nameOf(file);
    const raw = await this.objects.get(`sqlite/${name}/manifest.json`);
    const manifest: Manifest | undefined = raw ? JSON.parse(raw.data.toString('utf8')) : undefined;
    if (!manifest) {
      this.plans.set(file, undefined); // nothing in the bucket yet: the first sync uploads a snapshot
      return;
    }
    const seqs = await this.listSeqs(name, manifest.generation);
    const head = seqs.length;
    const plan = { generation: manifest.generation, seq: head, createdAt: Date.parse(manifest.createdAt), snapshotBytes: manifest.snapshotBytes };
    const local = existsSync(file);
    const marker = local ? readMarker(file) : undefined;
    if (!local) {
      await this.restore(file, name, manifest, seqs);
      this.plans.set(file, plan);
      return;
    }
    if (!marker || marker.generation < manifest.generation || (marker.generation === manifest.generation && marker.seq < head)) {
      // The bucket is newer (another machine wrote it), or this file was never synced with it.
      const bak = moveAside(file, marker ? 'behind-bucket' : 'unsynced');
      this.log(`${name}: the bucket has newer data; restoring it (the local copy is kept as ${bak})`);
      await this.restore(file, name, manifest, seqs);
      this.plans.set(file, plan);
      return;
    }
    const st = statSync(file);
    const untouched = marker.clean && marker.generation === manifest.generation && marker.seq === head && marker.size === st.size && marker.mtimeMs === st.mtimeMs;
    // Local is the same as the bucket (continue), or ahead of it (a crash or changes made while not
    // syncing): a new snapshot then captures everything.
    this.plans.set(file, untouched ? plan : undefined);
  }

  private async listSeqs(name: string, generation: string): Promise<string[]> {
    const prefix = `sqlite/${name}/generations/${generation}/pages/`;
    const keys = (await this.objects.list(prefix)).filter((k) => /\/\d{9}\.gz$/.test(k)).sort();
    // Only a contiguous run from 1 counts (an upload that failed midway leaves no gap behind it).
    const out: string[] = [];
    for (const k of keys) {
      if (Number(k.slice(-12, -3)) !== out.length + 1) break;
      out.push(k);
    }
    return out;
  }

  private async restore(file: string, name: string, manifest: Manifest, seqs: string[]) {
    const started = Date.now();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.restore.tmp`;
    rmSync(tmp, { force: true });
    try {
      const snap = await this.objects.stream(`sqlite/${name}/generations/${manifest.generation}/snapshot.db.gz`);
      await pipeline(snap, createGunzip(), createWriteStream(tmp));
      // Page sets download several at a time (a bucket round trip each) but apply strictly in order.
      const fetches = new Map<number, Promise<Buffer>>();
      const fetchAt = (i: number) => {
        if (i < seqs.length && !fetches.has(i)) {
          fetches.set(i, this.objects.get(seqs[i]).then((o) => {
            if (!o) throw new Error(`page set ${seqs[i]} disappeared`);
            return o.data;
          }));
          fetches.get(i)!.catch(() => {}); // awaited below; don't let an early failure go unhandled
        }
      };
      const fd = openSync(tmp, 'r+');
      try {
        for (let i = 0; i < seqs.length; i++) {
          for (let j = i; j < i + 16; j++) fetchAt(j);
          const d = decodeDelta(await fetches.get(i)!);
          fetches.delete(i);
          for (const [pgno, data] of d.pages) writeSync(fd, data, 0, d.pageSize, (pgno - 1) * d.pageSize);
          ftruncateSync(fd, d.dbSize * d.pageSize);
        }
      } finally {
        closeSync(fd);
      }
      verify(tmp);
      for (const ext of ['-wal', '-shm']) rmSync(file + ext, { force: true });
      renameSync(tmp, file);
      const st = statSync(file);
      writeMarker(file, { generation: manifest.generation, seq: seqs.length, clean: true, size: st.size, mtimeMs: st.mtimeMs });
      this.log(`${name}: restored from the bucket (generation ${manifest.generation}, ${seqs.length} page sets, ${Math.round(st.size / 1024)} KB) in ${Date.now() - started} ms`);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw new Error(`Restoring ${name} from ${this.objects.url} failed: ${(e as Error).message}`);
    }
  }

  /** After a database is opened: starts syncing it. */
  attach(file: string, db: Db) {
    const ctrl = sqliteControl(db);
    if (!ctrl) throw new Error('Only SQLite databases are synced to a bucket');
    const s = new DbSync(this.nameOf(file), file, ctrl, this.objects, (m) => this.log(m));
    s.begin(this.plans.get(file));
    this.plans.delete(file);
    this.dbs.set(file, s);
    // The first sync right away: a snapshot when the bucket has nothing (or older data) for it yet.
    s.sync().catch(() => {});
    this.timer ??= setInterval(() => void this.syncAll(), this.opts.intervalSeconds * 1000).unref();
  }

  /** Before a database closes: a final sync. */
  async detach(file: string) {
    const s = this.dbs.get(file);
    if (s) await s.finish();
  }

  /** After a database closed (its WAL is now in the main file): remember that the file matches the bucket. */
  closed(file: string) {
    const s = this.dbs.get(file);
    this.dbs.delete(file);
    s?.markClean();
  }

  async syncAll() {
    await Promise.all([...this.dbs.values()].map((s) => s.sync()));
  }

  status(): DbSyncStatus[] {
    const now = Date.now();
    // Lag: how long ago the last successful sync was, while syncing fails (else 0).
    return [...this.dbs.values()].map((s) => ({ ...s.status, lagSeconds: s.status.lastError && s.status.lastSyncAt ? Math.round((now - Date.parse(s.status.lastSyncAt)) / 1000) : 0 }));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Wraps an opened database so closing it runs the final sync first and marks it clean afterwards. */
export function syncedClose(db: Db, sync: SqliteSync, file: string): Db {
  const close = async () => {
    await sync.detach(file);
    await db.close();
    sync.closed(file);
  };
  // Everything else is the database itself (methods bound to it).
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'close') return close;
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
