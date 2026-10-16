import { build } from 'esbuild';
import { cpSync, existsSync, rmSync, mkdirSync } from 'node:fs';

/** Bundles the Electron main process (engine + server inlined) and copies the built UI and CLI next to it. */
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
await build({
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
