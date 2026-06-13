// auth.test.ts — team-mode auth primitives: mode resolution, the user/token
// store (scrypt + hashed tokens + expiry), and the login rate limiter.
// Pure filesystem — no server, no network.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  resolveMode, createAuthStore, createLoginLimiter, validateCredentials,
  LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, TOKEN_TTL_MS,
} from '../server/auth.js';

describe('resolveMode', () => {
  it('loopback / unset → local; anything else → team', () => {
    expect(resolveMode(undefined)).toBe('local');
    expect(resolveMode('')).toBe('local');
    expect(resolveMode('127.0.0.1')).toBe('local');
    expect(resolveMode('localhost')).toBe('local');
    expect(resolveMode('::1')).toBe('local');
    expect(resolveMode(' LOCALHOST ')).toBe('local');
    expect(resolveMode('0.0.0.0')).toBe('team');
    expect(resolveMode('192.168.1.20')).toBe('team');
    expect(resolveMode('::')).toBe('team');
  });
});

describe('validateCredentials', () => {
  it('enforces the username charset and password length', () => {
    expect(validateCredentials('alice', 'longenough').ok).toBe(true);
    expect(validateCredentials('a b', 'longenough').ok).toBe(false);   // space
    expect(validateCredentials('', 'longenough').ok).toBe(false);
    expect(validateCredentials('x'.repeat(33), 'longenough').ok).toBe(false);
    expect(validateCredentials('alice', 'short').ok).toBe(false);
    expect(validateCredentials(42, 'longenough').ok).toBe(false);
    expect(validateCredentials('alice', null).ok).toBe(false);
  });
});

describe('AuthStore', () => {
  let tmp: string;

  beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), 'ue-auth-')); });
  afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

  it('create → verify roundtrip; wrong password and unknown user fail', async () => {
    const store = createAuthStore(tmp);
    expect(await store.hasUsers()).toBe(false);
    expect((await store.createUser('alice', 'password1', 'admin')).ok).toBe(true);
    expect(await store.hasUsers()).toBe(true);

    expect(await store.verifyPassword('alice', 'password1')).toEqual({ username: 'alice', role: 'admin' });
    expect(await store.verifyPassword('alice', 'wrong-password')).toBeNull();
    expect(await store.verifyPassword('nobody', 'password1')).toBeNull();
  });

  it('never stores the plaintext password', async () => {
    const store = createAuthStore(tmp);
    await store.createUser('alice', 'sup3r-secret-pw', 'admin');
    const raw = await readFile(join(tmp, '.auth', 'users.json'), 'utf-8');
    expect(raw).not.toContain('sup3r-secret-pw');
  });

  it('rejects duplicates, bad usernames, and short passwords', async () => {
    const store = createAuthStore(tmp);
    expect((await store.createUser('alice', 'password1', 'admin')).ok).toBe(true);
    expect((await store.createUser('alice', 'password2', 'user')).ok).toBe(false);
    expect((await store.createUser('al ice', 'password1', 'user')).ok).toBe(false);
    expect((await store.createUser('bob', 'short', 'user')).ok).toBe(false);
  });

  it('issues tokens that validate, and stores only their sha256 digest', async () => {
    const store = createAuthStore(tmp);
    await store.createUser('alice', 'password1', 'user');
    const token = await store.issueToken('alice');
    expect(await store.validateToken(token)).toEqual({ username: 'alice', role: 'user' });
    expect(await store.validateToken('not-a-token')).toBeNull();

    const raw = await readFile(join(tmp, '.auth', 'tokens.json'), 'utf-8');
    expect(raw).not.toContain(token);
    expect(raw).toContain(createHash('sha256').update(token).digest('hex'));
  });

  it('revoked and expired tokens stop validating', async () => {
    const store = createAuthStore(tmp);
    await store.createUser('alice', 'password1', 'user');
    const token = await store.issueToken('alice');
    await store.revokeToken(token);
    expect(await store.validateToken(token)).toBeNull();

    // Expiry: rewrite the stored entry with a past timestamp.
    const expired = await store.issueToken('alice');
    const path = join(tmp, '.auth', 'tokens.json');
    const f = JSON.parse(await readFile(path, 'utf-8'));
    const digest = createHash('sha256').update(expired).digest('hex');
    expect(f.tokens[digest].expiresAt).toBeGreaterThan(Date.now() + TOKEN_TTL_MS - 60_000);
    f.tokens[digest].expiresAt = Date.now() - 1;
    await writeFile(path, JSON.stringify(f), 'utf-8');
    expect(await store.validateToken(expired)).toBeNull();
  });

  it('deleteUser refuses the last admin and kills the user’s tokens', async () => {
    const store = createAuthStore(tmp);
    await store.createUser('alice', 'password1', 'admin');
    await store.createUser('bob', 'password1', 'user');
    const bobToken = await store.issueToken('bob');

    const lastAdmin = await store.deleteUser('alice');
    expect(lastAdmin.ok).toBe(false);
    if (!lastAdmin.ok) expect(lastAdmin.error).toContain('last admin');

    expect((await store.deleteUser('bob')).ok).toBe(true);
    expect(await store.validateToken(bobToken)).toBeNull();
    expect((await store.deleteUser('bob')).ok).toBe(false); // already gone
  });

  it('setPassword rotates the hash and revokes existing tokens', async () => {
    const store = createAuthStore(tmp);
    await store.createUser('alice', 'password1', 'admin');
    const old = await store.issueToken('alice');
    expect((await store.setPassword('alice', 'password2')).ok).toBe(true);
    expect(await store.verifyPassword('alice', 'password1')).toBeNull();
    expect(await store.verifyPassword('alice', 'password2')).not.toBeNull();
    expect(await store.validateToken(old)).toBeNull();
    expect((await store.setPassword('ghost', 'password2')).ok).toBe(false);
  });

  it('state survives across store instances (plain JSON on disk)', async () => {
    const a = createAuthStore(tmp);
    await a.createUser('alice', 'password1', 'admin');
    const token = await a.issueToken('alice');

    const b = createAuthStore(tmp);
    expect(await b.verifyPassword('alice', 'password1')).not.toBeNull();
    expect(await b.validateToken(token)).toEqual({ username: 'alice', role: 'admin' });
    expect(await b.listUsers()).toEqual([
      expect.objectContaining({ username: 'alice', role: 'admin' }),
    ]);
  });
});

describe('createLoginLimiter', () => {
  it('blocks after the failure budget, forgets outside the window, resets on success', () => {
    let now = 1_000_000;
    const limiter = createLoginLimiter(() => now);

    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      expect(limiter.blocked('1.2.3.4')).toBe(false);
      limiter.fail('1.2.3.4');
    }
    expect(limiter.blocked('1.2.3.4')).toBe(true);
    expect(limiter.blocked('5.6.7.8')).toBe(false); // per-key

    now += LOGIN_WINDOW_MS + 1; // window slides past the failures
    expect(limiter.blocked('1.2.3.4')).toBe(false);

    limiter.fail('1.2.3.4');
    limiter.succeed('1.2.3.4'); // a successful login clears the count
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) limiter.fail('1.2.3.4');
    expect(limiter.blocked('1.2.3.4')).toBe(false);
  });
});
