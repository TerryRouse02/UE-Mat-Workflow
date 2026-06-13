import { access, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export interface HttpsBootstrapPublic {
  configured: boolean;
  httpsUrl?: string;
  installerVersion?: string;
  downloadAvailable: boolean;
  downloadUrl?: string;
}

interface HttpsBootstrapConfig {
  configured?: unknown;
  httpsUrl?: unknown;
  installerVersion?: unknown;
  installerFile?: unknown;
}

export function httpsBootstrapRoot(): string {
  if (process.env.UE_MAT_CADDY_HOME) return resolve(process.env.UE_MAT_CADDY_HOME);
  return resolve(process.env.ProgramData ?? process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'UE-Mat-Caddy');
}

async function readConfig(root: string): Promise<HttpsBootstrapConfig | null> {
  try {
    const text = await readFile(resolve(root, 'config.json'), 'utf-8');
    const value = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
    return value && typeof value === 'object' ? value as HttpsBootstrapConfig : null;
  } catch {
    return null;
  }
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

export async function resolveHttpsInstaller(root = httpsBootstrapRoot()): Promise<string | null> {
  const config = await readConfig(root);
  if (!config || config.configured !== true || typeof config.installerFile !== 'string') return null;
  const clientRoot = resolve(root, 'client');
  const candidate = resolve(root, config.installerFile);
  const rel = relative(clientRoot, candidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || !candidate.toLowerCase().endsWith('.cmd')) return null;
  try { await access(candidate); return candidate; } catch { return null; }
}

export async function loadHttpsBootstrap(root = httpsBootstrapRoot()): Promise<HttpsBootstrapPublic> {
  const config = await readConfig(root);
  if (!config || config.configured !== true || !isHttpsUrl(config.httpsUrl)) {
    return { configured: false, downloadAvailable: false };
  }
  const installer = await resolveHttpsInstaller(root);
  const installerVersion = typeof config.installerVersion === 'string' ? config.installerVersion : undefined;
  return {
    configured: true,
    httpsUrl: config.httpsUrl,
    ...(installerVersion ? { installerVersion } : {}),
    downloadAvailable: installer !== null,
    ...(installer ? { downloadUrl: '/api/https-bootstrap/installer' } : {}),
  };
}

export async function readHttpsInstaller(root = httpsBootstrapRoot()): Promise<Buffer | null> {
  const installer = await resolveHttpsInstaller(root);
  if (!installer) return null;
  try { return await readFile(installer); } catch { return null; }
}
