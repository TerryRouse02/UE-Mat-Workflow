import { resolve } from 'node:path';
import { startServer } from './http-server.js';

const BASE_PORT = 5790;
const MAX_ATTEMPTS = 10;

async function main() {
  const repoRoot = process.cwd();
  const webDist = resolve(repoRoot, 'viewer/web/dist');

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const port = BASE_PORT + i;
    try {
      const server = await startServer({ repoRoot, port, webDist });
      console.log(`ue-mat-viewer listening on http://localhost:${server.port}`);
      console.log(`watching: ${resolve(repoRoot, 'graphs')}`);
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
