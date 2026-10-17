import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The app version (scripts/set-version.mjs keeps every package on the same one), shown in the UI
// when the server does not report it.
const version = JSON.parse(readFileSync(new URL('../cli/package.json', import.meta.url), 'utf8')).version as string;

// Kalibra serves everything under /kalibra (BASE_PATH in packages/core/src/base-path.ts), so a load
// balancer can route on the path: the UI is /kalibra/, the API /kalibra/api/….
const base = '/kalibra/';

// Like the server: "/kalibra" without the slash goes to "/kalibra/" (Vite itself only redirects "/").
const baseRedirect: Plugin = {
  name: 'kalibra-base-redirect',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const [path, query] = (req.url ?? '').split(/\?(.*)/s);
      if (path !== base.slice(0, -1)) return next();
      res.writeHead(302, { location: `${base}${query ? `?${query}` : ''}` });
      res.end();
    });
  },
};

export default defineConfig({
  base,
  plugins: [baseRedirect, react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    proxy: { [`${base}api`]: { target: 'http://127.0.0.1:4317', changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 2000 },
});
