import { deployConfigFrom, migrate, redactUrl, validateDeployConfig, type MigrateReport } from '@kalibra/core';

/*
 * `kalibra migrate`: moves a data folder (SQLite and files on disk) to Postgres and/or a bucket, for
 * the deployment modes in docs/self-hosting.md. The source folder is never changed.
 */

const plural = (n: number, word: string) => `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export async function runMigrate(dir: string, values: Record<string, unknown>) {
  const cfg = deployConfigFrom(process.env, {
    ...(typeof values['database-url'] === 'string' ? { 'database-url': values['database-url'] } : {}),
    ...(typeof values.storage === 'string' ? { storage: values.storage } : {}),
  });
  if (!cfg.databaseUrl && !cfg.storageUrl) {
    throw new Error('Usage: kalibra migrate --dir <data folder> [--database-url postgres://…] [--storage gs://…|s3://…|az://…] [--dry-run] [--force]\nSet at least one target (or KALIBRA_DATABASE_URL / KALIBRA_STORAGE_URL), and KALIBRA_SECRET_KEY.');
  }
  validateDeployConfig({ ...cfg, redisUrl: undefined }); // Redis plays no part in moving data
  const dryRun = !!values['dry-run'];
  const target = [cfg.databaseUrl && `Postgres ${redactUrl(cfg.databaseUrl)}`, cfg.storageUrl].filter(Boolean).join(' + ');
  console.log(`${dryRun ? 'Dry run: would move' : 'Moving'} ${dir}\n  to ${target}${cfg.databaseUrl ? '' : ' (SQLite, synced to the bucket)'}`);
  const started = Date.now();
  const r = await migrate({ source: dir, cfg, force: !!values.force, dryRun, log: (m) => console.log(`  ${m}`) });
  print(r, dir);
  if (!dryRun) {
    console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)} s.${r.verified ? ' Every table has the same number of rows in the target.' : ''}`);
    if (!r.verified) {
      process.exitCode = 1;
      return;
    }
    console.log('Start Kalibra with the same KALIBRA_SECRET_KEY and target settings; everyone signs in again (sessions are not moved).');
    if (!cfg.storageUrl) console.log(`Files stay in ${dir}: run the server with --dir pointing at it (or migrate again with --storage to move them to a bucket).`);
  }
}

function print(r: MigrateReport, dir: string) {
  console.log('');
  for (const d of r.databases) {
    const rows = Object.values(d.rows).reduce((a, n) => a + n, 0);
    const label = d.projectId ? `project ${d.name}${d.deleted ? ' (in the trash)' : ''}` : 'hub (users, projects, settings)';
    const bad = d.mismatches.length ? `  ✗ row counts differ in: ${d.mismatches.join(', ')}` : '';
    console.log(`  ${label.padEnd(44)} ${plural(rows, 'row')}${bad}`);
  }
  const f = r.files;
  if (r.target.files === 'bucket') {
    console.log(`  files                                        ${plural(f.total, 'file')}, ${mb(f.bytes)}${r.dryRun ? '' : ` (${f.uploaded} uploaded, ${f.existing} already there)`}`);
  } else {
    console.log(`  files                                        ${plural(f.total, 'file')}, ${mb(f.bytes)} stay in ${dir}`);
  }
  if (f.missing.length) console.log(`  ! ${plural(f.missing.length, 'file')} referenced by a project ${f.missing.length === 1 ? 'is' : 'are'} missing from the source folder and can't be copied`);
  console.log(`  secrets                                      ${r.secrets.hub} hub, ${r.secrets.projects} project (encrypted; ${r.secrets.fromFiles} from plain files)`);
  if (r.target.hadData.length) console.log(`  ! the target already has data: ${r.target.hadData.join(', ')}${r.dryRun ? ' (migrate refuses unless --force, which deletes it first)' : ' (replaced: --force)'}`);
}
