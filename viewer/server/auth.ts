// server/auth.ts — team-mode authentication (BIND_HOST != loopback).
//
// Local mode (the default, loopback bind) never touches this module's stores:
// http-server.ts only constructs an AuthStore when the resolved mode is
// 'team', so single-user behavior is byte-for-byte unchanged.
//
// Storage lives under viewer/.auth/ (gitignored, like .agent-sessions/):
//   users.json   { users: { [name]: { saltHex, hashHex, role, createdAt } } }
//   tokens.json  { tokens: { [sha256(token)]: { username, expiresAt } } }
//
// Security posture:
//   - passwords: scrypt (N=16384) with a per-user 16-byte salt, compared via
//     timingSafeEqual — plaintext is never stored or logged.
//   - tokens: 32 random bytes (base64url) handed to the client once; only the
//     sha256 hex digest is persisted, so a leaked tokens.json cannot be replayed.
//   - 7-day expiry; expired entries are pruned on every issue/validate.
//   - all mutations are serialized through a promise queue and written
//     atomically (tmp + rename), mirroring session-store.ts.
//   - TLS is the reverse proxy's job (nginx/Caddy); without one, team mode is
//     documented as trusted-LAN only.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export type ServerMode = 'local' | 'team';

/** Loopback (or unset) BIND_HOST keeps the viewer in single-user local mode. */
export function resolveMode(bindHost: string | undefined): ServerMode {
  const h = (bindHost ?? '').trim().toLowerCase();
  if (h === '' || h === '127.0.0.1' || h === 'localhost' || h === '::1') return 'local';
  return 'team';
}

export type Role = 'admin' | 'user';

export interface AuthUser {
  username: string;
  role: Role;
}

export interface UserInfo {
  username: string;
  role: Role;
  createdAt: string;
}

export const USERNAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
export const MIN_PASSWORD_LEN = 8;
export const MAX_PASSWORD_LEN = 256;
export const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const SCRYPT_KEYLEN = 32;

interface StoredUser {
  saltHex: string;
  hashHex: string;
  role: Role;
  createdAt: string;
}

interface UsersFile { users: Record<string, StoredUser>; }
interface TokensFile { tokens: Record<string, { username: string; expiresAt: number }>; }

export type AuthResult = { ok: true } | { ok: false; error: string };

export interface AuthStore {
  hasUsers(): Promise<boolean>;
  createUser(username: string, password: string, role: Role): Promise<AuthResult>;
  verifyPassword(username: string, password: string): Promise<AuthUser | null>;
  /** Returns the RAW token (shown to the client once); only its hash is stored. */
  issueToken(username: string): Promise<string>;
  validateToken(raw: string): Promise<AuthUser | null>;
  revokeToken(raw: string): Promise<void>;
  listUsers(): Promise<UserInfo[]>;
  /** Refuses to remove the last admin. Revokes the user's tokens. */
  deleteUser(username: string): Promise<AuthResult>;
  /** Revokes the user's existing tokens (forces re-login everywhere). */
  setPassword(username: string, newPassword: string): Promise<AuthResult>;
}

export function validateCredentials(username: unknown, password: unknown): AuthResult {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return { ok: false, error: 'invalid username (1-32 chars: letters, digits, _ . -)' };
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN) {
    return { ok: false, error: `invalid password (${MIN_PASSWORD_LEN}-${MAX_PASSWORD_LEN} chars)` };
  }
  return { ok: true };
}

export function createAuthStore(viewerRoot: string): AuthStore {
  const dir = join(viewerRoot, '.auth');
  const usersPath = join(dir, 'users.json');
  const tokensPath = join(dir, 'tokens.json');

  // Serialize every mutation so two concurrent requests (e.g. a setup race)
  // cannot interleave read-modify-write cycles.
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  }

  async function readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(path, 'utf-8')) as T;
    } catch {
      return fallback;
    }
  }

  async function writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dir, { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
    await rename(tmp, path);
  }

  const loadUsers = () => readJson<UsersFile>(usersPath, { users: {} });
  const loadTokens = () => readJson<TokensFile>(tokensPath, { tokens: {} });

  function hashPassword(password: string, saltHex: string): string {
    return scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN).toString('hex');
  }

  function tokenDigest(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  function pruneExpired(tokens: TokensFile, now: number): boolean {
    let changed = false;
    for (const [digest, t] of Object.entries(tokens.tokens)) {
      if (t.expiresAt <= now) { delete tokens.tokens[digest]; changed = true; }
    }
    return changed;
  }

  async function hasUsers(): Promise<boolean> {
    const f = await loadUsers();
    return Object.keys(f.users).length > 0;
  }

  function createUser(username: string, password: string, role: Role): Promise<AuthResult> {
    return enqueue(async () => {
      const v = validateCredentials(username, password);
      if (!v.ok) return v;
      if (role !== 'admin' && role !== 'user') return { ok: false, error: 'invalid role' };
      const f = await loadUsers();
      if (f.users[username]) return { ok: false, error: 'user already exists' };
      const saltHex = randomBytes(16).toString('hex');
      f.users[username] = {
        saltHex,
        hashHex: hashPassword(password, saltHex),
        role,
        createdAt: new Date().toISOString(),
      };
      await writeJson(usersPath, f);
      return { ok: true };
    });
  }

  async function verifyPassword(username: string, password: string): Promise<AuthUser | null> {
    if (typeof username !== 'string' || typeof password !== 'string') return null;
    if (!USERNAME_RE.test(username) || password.length > MAX_PASSWORD_LEN) return null;
    const f = await loadUsers();
    const u = f.users[username];
    // Burn a scrypt round even for unknown users so the response time does not
    // reveal which usernames exist.
    const saltHex = u?.saltHex ?? randomBytes(16).toString('hex');
    const candidate = Buffer.from(hashPassword(password, saltHex), 'hex');
    const expected = u ? Buffer.from(u.hashHex, 'hex') : randomBytes(SCRYPT_KEYLEN);
    const match = candidate.length === expected.length && timingSafeEqual(candidate, expected);
    return u && match ? { username, role: u.role } : null;
  }

  function issueToken(username: string): Promise<string> {
    return enqueue(async () => {
      const raw = randomBytes(32).toString('base64url');
      const f = await loadTokens();
      pruneExpired(f, Date.now());
      f.tokens[tokenDigest(raw)] = { username, expiresAt: Date.now() + TOKEN_TTL_MS };
      await writeJson(tokensPath, f);
      return raw;
    });
  }

  async function validateToken(raw: string): Promise<AuthUser | null> {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128) return null;
    const f = await loadTokens();
    const entry = f.tokens[tokenDigest(raw)];
    if (!entry || entry.expiresAt <= Date.now()) return null;
    const users = await loadUsers();
    const u = users.users[entry.username];
    if (!u) return null; // user was deleted — token is dead
    return { username: entry.username, role: u.role };
  }

  function revokeToken(raw: string): Promise<void> {
    return enqueue(async () => {
      const f = await loadTokens();
      const changed = delete f.tokens[tokenDigest(raw)];
      if (pruneExpired(f, Date.now()) || changed) await writeJson(tokensPath, f);
    });
  }

  async function listUsers(): Promise<UserInfo[]> {
    const f = await loadUsers();
    return Object.entries(f.users)
      .map(([username, u]) => ({ username, role: u.role, createdAt: u.createdAt }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async function revokeUserTokens(username: string): Promise<void> {
    const f = await loadTokens();
    let changed = pruneExpired(f, Date.now());
    for (const [digest, t] of Object.entries(f.tokens)) {
      if (t.username === username) { delete f.tokens[digest]; changed = true; }
    }
    if (changed) await writeJson(tokensPath, f);
  }

  function deleteUser(username: string): Promise<AuthResult> {
    return enqueue(async () => {
      const f = await loadUsers();
      const u = f.users[username];
      if (!u) return { ok: false, error: 'no such user' };
      if (u.role === 'admin') {
        const admins = Object.values(f.users).filter((x) => x.role === 'admin').length;
        if (admins <= 1) return { ok: false, error: 'cannot delete the last admin' };
      }
      delete f.users[username];
      await writeJson(usersPath, f);
      await revokeUserTokens(username);
      return { ok: true };
    });
  }

  function setPassword(username: string, newPassword: string): Promise<AuthResult> {
    return enqueue(async () => {
      const v = validateCredentials(username, newPassword);
      if (!v.ok) return v;
      const f = await loadUsers();
      const u = f.users[username];
      if (!u) return { ok: false, error: 'no such user' };
      u.saltHex = randomBytes(16).toString('hex');
      u.hashHex = hashPassword(newPassword, u.saltHex);
      await writeJson(usersPath, f);
      await revokeUserTokens(username);
      return { ok: true };
    });
  }

  return {
    hasUsers, createUser, verifyPassword, issueToken, validateToken,
    revokeToken, listUsers, deleteUser, setPassword,
  };
}

// ───────────────────────── login rate limiting ──────────────────────────────

export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 10 * 60 * 1000;

export interface LoginLimiter {
  /** True when this key has exhausted its failure budget. */
  blocked(key: string): boolean;
  fail(key: string): void;
  succeed(key: string): void;
}

/** In-memory per-key (IP) sliding-window failure counter. */
export function createLoginLimiter(now: () => number = Date.now): LoginLimiter {
  const failures = new Map<string, number[]>();
  return {
    blocked(key) {
      const cutoff = now() - LOGIN_WINDOW_MS;
      const recent = (failures.get(key) ?? []).filter((t) => t > cutoff);
      failures.set(key, recent);
      return recent.length >= LOGIN_MAX_FAILURES;
    },
    fail(key) {
      const list = failures.get(key) ?? [];
      list.push(now());
      failures.set(key, list);
    },
    succeed(key) {
      failures.delete(key);
    },
  };
}
