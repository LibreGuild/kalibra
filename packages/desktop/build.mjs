import { build } from 'esbuild';
import { cpSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Paths below are relative to this package, whatever directory the build is started from.
process.chdir(dirname(fileURLToPath(import.meta.url)));

/** Bundles the Electron main process (engine + server inlined) and copies the built UI and CLI next to it. */
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
await build({
  absWorkingDir: process.cwd(),
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'warning',
});
if (!existsSync('../web/dist/index.html')) throw new Error('Build the web UI first: npm run build -w @kalibra/web');
cpSync('../web/dist', 'dist/web', { recursive: true });
if (existsSync('../cli/dist/kalibra.mjs')) cpSync('../cli/dist', 'dist/cli', { recursive: true });
console.log('desktop build ready in packages/desktop/dist');
