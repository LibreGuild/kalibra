// Sets one version on the monorepo and every package (and their references to each other).
//   node scripts/set-version.mjs 0.1.0-beta.1
// Releases run this from the tag (v0.1.0-beta.1), so the tag is the single source of truth.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const version = process.argv[2]?.replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: node scripts/set-version.mjs <semver, e.g. 0.1.0-beta.1>');
  process.exit(1);
}

const files = ['package.json', ...readdirSync('packages').map((p) => join('packages', p, 'package.json'))];
const names = new Set(files.map((f) => JSON.parse(readFileSync(f, 'utf8')).name));
for (const file of files) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.version = version;
  for (const field of ['dependencies', 'devDependencies']) {
    for (const dep of Object.keys(pkg[field] ?? {})) if (names.has(dep)) pkg[field][dep] = version;
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}
// The CLI prints its version and tells agents which npm version to run.
const main = 'packages/cli/src/main.ts';
writeFileSync(main, readFileSync(main, 'utf8').replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`));
console.log(`version ${version} set in ${files.length} package.json files and the CLI`);
