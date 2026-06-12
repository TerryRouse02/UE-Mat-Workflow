import { resolve } from 'node:path';
import { startServer } from './http-server.js';
import { resolveRepoRoot } from './repo-root.js';
import { resolveMode } from './auth.js';

const BASE_PORT = 5790;
const MAX_ATTEMPTS = 10;

async function main() {
  const repoRoot = resolveRepoRoot();
  const webDist = resolve(repoRoot, 'viewer/web/dist');
  // BIND_HOST unset/loopback → classic local mode (no auth, loopback only).
  // BIND_HOST=0.0.0.0 (or a LAN address) → team mode with login + roles.
  const bindHost = process.env.BIND_HOST;
  const mode = resolveMode(bindHost);
  const secureCookies = process.env.COOKIE_SECURE === '1';

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const port = BASE_PORT + i;
    try {
      const server = await startServer({ repoRoot, port, webDist, bindHost, secureCookies });
      const shownHost = !bindHost || bindHost === '0.0.0.0' || bindHost === '::' ? 'localhost' : bindHost;
      console.log(`ue-mat-viewer listening on http://${shownHost}:${server.port} (${mode} mode)`);
      console.log(`watching: ${resolve(repoRoot, 'graphs')}`);
      if (mode === 'team') {
        console.log('team mode: login required; first visit creates the admin account.');
        if (!secureCookies) console.log('team mode: put an HTTPS reverse proxy (nginx/Caddy) in front for anything beyond a trusted LAN; set COOKIE_SECURE=1 behind TLS.');
      }
      process.on('SIGINT', async () => { await server.close(); process.exit(0); });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') throw e;
      console.log(`port ${port} in use, trying ${port + 1}...`);
    }
  }
  console.error(`failed to bind a port in range ${BASE_PORT}-${BASE_PORT + MAX_ATTEMPTS - 1}`);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
