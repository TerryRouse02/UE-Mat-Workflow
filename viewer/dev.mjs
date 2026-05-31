// Dev launcher: rebuild the web bundle on every save + run the viewer server,
// so iterating on the UI needs only a browser refresh (F5) — no manual build,
// no manual server restart. Cross-platform (pure node spawn, no shell/.cmd).
//
//   from repo root:  node viewer/dev.mjs       (or: pnpm dev)
//
// The server serves viewer/web/dist; `vite build --watch` keeps that dir fresh.
// The server's HTML entrypoint is sent no-store, so a refresh always picks up
// the newest content-hashed bundle. Backend (server) changes still need a
// restart — this targets the frequent case: frontend/UI edits.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const viewerDir = dirname(fileURLToPath(import.meta.url));   // .../viewer
const repoRoot = resolve(viewerDir, '..');
const webDir = resolve(viewerDir, 'web');

const tscBin = resolve(viewerDir, 'node_modules/typescript/bin/tsc');
const viteBin = resolve(webDir, 'node_modules/vite/bin/vite.js');
const serverEntry = resolve(viewerDir, 'dist/server/index.js');

function run(cmd, args, opts = {}) {
  return spawn(process.execPath, [cmd, ...args], { stdio: 'inherit', ...opts });
}

const children = [];
const shutdown = () => { for (const c of children) { try { c.kill(); } catch {} } process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 1. Build the server once (TypeScript -> viewer/dist/server). One-off; backend
//    edits during a session still need a manual re-run of this launcher.
console.log('[dev] building server (tsc)...');
const tsc = spawn(process.execPath, [tscBin, '-p', resolve(viewerDir, 'tsconfig.json')], { stdio: 'inherit' });
tsc.on('exit', (code) => {
  if (code !== 0 || !existsSync(serverEntry)) {
    console.error(`[dev] server build failed (tsc exit ${code}). Aborting.`);
    process.exit(1);
  }
  console.log('[dev] server built. Starting web watch + server...');

  // 2. Watch-build the web bundle: rebuilds viewer/web/dist on every save.
  const web = run(viteBin, ['build', '--watch'], { cwd: webDir });
  children.push(web);

  // 3. Run the server from the repo root (it serves <cwd>/viewer/web/dist and
  //    watches <cwd>/graphs). Give vite a moment to emit the first build.
  setTimeout(() => {
    const server = run(serverEntry, [], { cwd: repoRoot });
    children.push(server);
    console.log('[dev] ready. Edit UI files, then refresh the browser (F5). Ctrl+C to stop.');
  }, 1500);
});
