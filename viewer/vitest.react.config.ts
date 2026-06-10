// Vitest config for React component render tests (viewer/tests/*.test.tsx).
// Kept separate from vitest.config.ts so the existing node-env tests are
// completely unaffected. This config:
//   - adds @vitejs/plugin-react for JSX/TSX transform (esbuild alone is not
//     enough — the react JSX runtime import needs the plugin)
//   - sets the default test environment to happy-dom (individual files can
//     still override with `// @vitest-environment` docblocks)
//   - only includes *.test.tsx files so it never steals .ts tests from the
//     default config when run in isolation

import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import react from './web/node_modules/@vitejs/plugin-react/dist/index.js';

// React (and its jsx-dev-runtime) lives in web/node_modules, not viewer/node_modules.
// Point vite's resolver there so test files that import React components work.
const webModules = resolve(__dirname, 'web/node_modules');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^react\/(.+)$/, replacement: `${webModules}/react/$1` },
      { find: /^react-dom\/(.+)$/, replacement: `${webModules}/react-dom/$1` },
      { find: 'react', replacement: `${webModules}/react` },
      { find: 'react-dom', replacement: `${webModules}/react-dom` },
      { find: '@testing-library/react', replacement: `${webModules}/@testing-library/react` },
      { find: '@testing-library/dom', replacement: `${webModules}/@testing-library/dom` },
    ],
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.tsx'],
  },
});
