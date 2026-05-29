import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@db': resolve(__dirname, '../../agent-pack/nodes-ue5.7.json'),
      '@export-meta': resolve(__dirname, '../../agent-pack/nodes-ue5.7.export.json'),
    },
  },
  server: { port: 5791 },
  build: { outDir: 'dist', emptyOutDir: true },
});
