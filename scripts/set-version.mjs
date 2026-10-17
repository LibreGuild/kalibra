// Sets one version on the monorepo and every package (and their references to each other).
//   node scripts/set-version.mjs 0.1.1-beta.1
// Releases run this from the tag (v0.1.1-beta.1), so the tag is the single source of truth.
// Also sets the Python SDK's version, in PEP 440 form (0.1.1-beta.1 → 0.1.1b1).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const version = process.argv[2]?.replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: node scripts/set-version.mjs <semver, e.g. 0.1.1-beta.1>');
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
// The CLI prints its version and tells agents which npm version to run; bundles record it too.
for (const [file, re, line] of [
  ['packages/cli/src/version.ts', /export const VERSION = '[^']*';/, `export const VERSION = '${version}';`],
  ['packages/core/src/sharing/common.ts', /export const APP_VERSION = '[^']*';/, `export const APP_VERSION = '${version}';`],
]) {
  const text = readFileSync(file, 'utf8');
  if (!re.test(text)) {
    console.error(`No version line found in ${file}`);
    process.exit(1);
  }
  writeFileSync(file, text.replace(re, line));
}
// The Python SDK (PyPI) spells pre-releases the PEP 440 way: 1.2.3-beta.4 → 1.2.3b4, -rc.1 → rc1.
const pep440 = version.replace(/-(alpha|beta|rc)\.?(\d+)$/, (_, kind, n) => `${{ alpha: 'a', beta: 'b', rc: 'rc' }[kind]}${n}`);
if (pep440.includes('-')) {
  console.error(`Can't express ${version} for the Python SDK; use -alpha.N, -beta.N or -rc.N`);
  process.exit(1);
}
const py = [
  ['sdks/python/pyproject.toml', /^version = "[^"]*"/m, `version = "${pep440}"`],
  ['sdks/python/src/kalibra/_core.py', /^__version__ = "[^"]*"/m, `__version__ = "${pep440}"`],
];
for (const [file, re, line] of py) {
  const text = readFileSync(file, 'utf8');
  if (!re.test(text)) {
    console.error(`No version line found in ${file}`);
    process.exit(1);
  }
  writeFileSync(file, text.replace(re, line));
}
console.log(`version ${version} set in ${files.length} package.json files, the CLI, bundles and the Python SDK (${pep440})`);
