/*
 * Builds kalibra-sdk: ESM (dist/*.js) and CommonJS (dist/*.cjs) bundles with esbuild, and type
 * declarations with tsc. `kalibra-sdk/eval` re-exports from the main entry at runtime (it is not
 * bundled into it), so both share one SDK state.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
rmSync('dist', { recursive: true, force: true });

/** Leaves `./index.js` imports alone (pointing at the right file per format). */
const shareIndex = (ext) => ({
  name: 'share-index',
  setup(b) {
    b.onResolve({ filter: /^\.\/index\.js$/ }, (args) => (args.importer.endsWith('eval.ts') ? { path: `./index.${ext}`, external: true } : undefined));
  },
});

const common = { absWorkingDir: process.cwd(), bundle: true, platform: 'node', target: 'node18', sourcemap: true, logLevel: 'warning', define: { __KALIBRA_SDK_VERSION__: JSON.stringify(version) } };
for (const [format, ext] of [['esm', 'js'], ['cjs', 'cjs']]) {
  await build({ ...common, format, entryPoints: ['src/index.ts'], outfile: `dist/index.${ext}` });
  await build({ ...common, format, entryPoints: ['src/eval.ts'], outfile: `dist/eval.${ext}`, plugins: [shareIndex(ext)] });
}

execFileSync(join('..', '..', 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.build.json'], { stdio: 'inherit' });
copyFileSync(join('..', '..', 'LICENSE'), 'LICENSE');
console.log(`kalibra-sdk ${version} built in packages/sdk/dist`);
