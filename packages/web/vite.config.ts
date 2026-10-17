import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The app version (scripts/set-version.mjs keeps every package on the same one), shown in the UI
// when the server does not report it.
const version = JSON.parse(readFileSync(new URL('../cli/package.json', import.meta.url), 'utf8')).version as string;

// Kalibra serves everything under /kalibra (BASE_PATH in packages/core/src/base-path.ts), so a load
// balancer can route on the path: the UI is /kalibra/, the API /kalibra/api/….
const base = '/kalibra/';

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    proxy: { [`${base}api`]: { target: 'http://127.0.0.1:4317', changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 2000 },
});
