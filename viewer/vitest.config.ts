import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// The node-env suite also exercises web/src modules that translate user-facing
// strings via the shared i18next instance (web/src/i18n.ts). That module pulls in
// react-i18next + react, which live in web/node_modules (not viewer/node_modules),
// so we alias them here exactly as vitest.react.config.ts does, and initialize
// i18next once via setupFiles. With happy-dom absent, resolveInitialLang() falls
// back to 'zh-Hant', so t() returns the original Traditional-Chinese catalog values
// and every existing Chinese-output assertion stays valid.
const webModules = resolve(__dirname, 'web/node_modules');

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react\/(.+)$/, replacement: `${webModules}/react/$1` },
      { find: 'react', replacement: `${webModules}/react` },
      { find: /^react-dom\/(.+)$/, replacement: `${webModules}/react-dom/$1` },
      { find: 'react-dom', replacement: `${webModules}/react-dom` },
      { find: 'react-i18next', replacement: `${webModules}/react-i18next` },
      { find: 'i18next', replacement: `${webModules}/i18next` },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts', 'web/src/**/*.test.ts'],
    setupFiles: ['./web/src/i18n.ts'],
  },
});
