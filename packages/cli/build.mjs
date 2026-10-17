import { build } from 'esbuild';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Paths below are relative to this package, whatever directory the build is started from.
process.chdir(dirname(fileURLToPath(import.meta.url)));

/** Single-file CLI (engine, server and MCP bridge inlined). Runs on Node 22.13+. */
rmSync('dist', { recursive: true, force: true });
await build({
  absWorkingDir: process.cwd(),
  entryPoints: ['src/main.ts'],
  outfile: 'dist/kalibra.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: "import { createRequire as __kalibraRequire } from 'node:module'; const require = __kalibraRequire(import.meta.url);" },
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});
if (existsSync('../web/dist/index.html')) cpSync('../web/dist', 'dist/web', { recursive: true, filter: (src) => !src.endsWith('.map') });
cpSync('../../LICENSE', 'LICENSE');
console.log('cli build ready: packages/cli/dist/kalibra.mjs');
