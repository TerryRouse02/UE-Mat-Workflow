import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startServer } from '../server/http-server';
import { loadHttpsBootstrap, resolveHttpsInstaller } from '../server/https-bootstrap';

const originalHome = process.env.UE_MAT_CADDY_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.UE_MAT_CADDY_HOME;
  else process.env.UE_MAT_CADDY_HOME = originalHome;
});

function makeRoot() {
  const root = mkdtempSync(resolve(tmpdir(), 'ue-mat-https-'));
  mkdirSync(resolve(root, 'client'), { recursive: true });
  return root;
}

describe('HTTPS bootstrap state', () => {
  it('returns an unconfigured public shape when state is absent', async () => {
    const root = makeRoot();
    await expect(loadHttpsBootstrap(root)).resolves.toEqual({
      configured: false,
      downloadAvailable: false,
    });
  });

  it('exposes only public fields from valid state', async () => {
    const root = makeRoot();
    writeFileSync(resolve(root, 'client', 'install.cmd'), '@echo off\r\n');
    writeFileSync(resolve(root, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      configured: true,
      httpsUrl: 'https://ue-mat.local/',
      addressMode: 'hostname',
      ipv4: '192.168.71.92',
      hostname: 'ue-mat.local',
      installerVersion: '20260613-1',
      installerFile: 'client/install.cmd',
      certificateThumbprint: 'SECRETTHUMBPRINT',
      repoRoot: 'D:/secret/repo',
      caddyPath: 'C:/secret/caddy.exe',
    }));

    const status = await loadHttpsBootstrap(root);
    expect(status).toEqual({
      configured: true,
      httpsUrl: 'https://ue-mat.local/',
      installerVersion: '20260613-1',
      downloadAvailable: true,
      downloadUrl: '/api/https-bootstrap/installer',
    });
    expect(JSON.stringify(status)).not.toContain('SECRET');
    expect(JSON.stringify(status)).not.toContain('repo');
  });

  it('accepts the UTF-8 BOM emitted by Windows PowerShell 5.1', async () => {
    const root = makeRoot();
    writeFileSync(resolve(root, 'client', 'install.cmd'), '@echo off\r\n');
    writeFileSync(resolve(root, 'config.json'), `\uFEFF${JSON.stringify({
      configured: true,
      httpsUrl: 'https://ue-mat.local/',
      installerFile: 'client/install.cmd',
    })}`, 'utf8');

    await expect(loadHttpsBootstrap(root)).resolves.toMatchObject({
      configured: true,
      downloadAvailable: true,
    });
  });

  it('rejects an installer path outside the client directory', async () => {
    const root = makeRoot();
    writeFileSync(resolve(root, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      configured: true,
      httpsUrl: 'https://192.168.71.92/',
      installerVersion: '1',
      installerFile: '../private.key',
    }));
    await expect(resolveHttpsInstaller(root)).resolves.toBeNull();
  });
});

describe('HTTPS bootstrap HTTP API', () => {
  it('does not expose bootstrap files in local mode', async () => {
    const root = makeRoot();
    writeFileSync(resolve(root, 'client', 'install.cmd'), '@echo off\r\n');
    writeFileSync(resolve(root, 'config.json'), JSON.stringify({
      configured: true,
      httpsUrl: 'https://ue-mat.local/',
      installerVersion: '1',
      installerFile: 'client/install.cmd',
    }));
    process.env.UE_MAT_CADDY_HOME = root;
    const repo = mkdtempSync(resolve(tmpdir(), 'ue-mat-repo-'));
    mkdirSync(resolve(repo, 'graphs'), { recursive: true });
    const server = await startServer({ repoRoot: repo, port: 0, webDist: '' });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${base}/api/https-bootstrap`)).status).toBe(404);
      expect((await fetch(`${base}/api/https-bootstrap/installer`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('is public before Team authentication and serves protected download headers', async () => {
    const root = makeRoot();
    writeFileSync(resolve(root, 'client', 'install.cmd'), '@echo off\r\necho install\r\n');
    writeFileSync(resolve(root, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      configured: true,
      httpsUrl: 'https://ue-mat.local/',
      installerVersion: '20260613-1',
      installerFile: 'client/install.cmd',
    }));
    process.env.UE_MAT_CADDY_HOME = root;

    const repo = mkdtempSync(resolve(tmpdir(), 'ue-mat-repo-'));
    mkdirSync(resolve(repo, 'graphs'), { recursive: true });
    const server = await startServer({ repoRoot: repo, port: 0, webDist: '', mode: 'team' });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const statusRes = await fetch(`${base}/api/https-bootstrap`);
      expect(statusRes.status).toBe(200);
      expect(await statusRes.json()).toMatchObject({ configured: true, downloadAvailable: true });

      const installerRes = await fetch(`${base}/api/https-bootstrap/installer`);
      expect(installerRes.status).toBe(200);
      expect(installerRes.headers.get('cache-control')).toBe('no-store');
      expect(installerRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(installerRes.headers.get('content-disposition')).toContain('attachment');
      expect(await installerRes.text()).toContain('echo install');
    } finally {
      await server.close();
    }
  });
});
