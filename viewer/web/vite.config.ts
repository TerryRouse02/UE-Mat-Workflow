import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  // The node DBs are auto-discovered at build time by dbRegistry.ts via
  // import.meta.glob('../../../agent-pack/nodes-ue*.json'); no aliases needed.
  server: { port: 5791 },
  build: { outDir: 'dist', emptyOutDir: true },
});
