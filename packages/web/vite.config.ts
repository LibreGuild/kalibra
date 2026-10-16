import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:4317', changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 2000 },
});
