import { build } from 'esbuild';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
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
if (existsSync('../web/dist/index.html')) {
  cpSync('../web/dist', 'dist/web', { recursive: true, filter: (src) => !src.endsWith('.map') });
  precompress('dist/web');
}
cpSync('../../LICENSE', 'LICENSE');
console.log('cli build ready: packages/cli/dist/kalibra.mjs');

/**
 * Writes .br and .gz next to each text file of the UI, which the server sends to browsers that accept
 * them (see serveStatic). Load balancers often don't compress, and this costs no CPU per request.
 */
function precompress(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) precompress(file);
    else if (['.js', '.css', '.html', '.svg', '.json'].includes(extname(file))) {
      const data = readFileSync(file);
      if (data.length < 1024) continue;
      writeFileSync(`${file}.br`, brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }));
      writeFileSync(`${file}.gz`, gzipSync(data, { level: 9 }));
    }
  }
}
