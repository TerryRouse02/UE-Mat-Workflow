// pending-registrations.test.ts — the pre-account registration queue: register,
// collision, lazy + forced expiry, deny-retained-until-expiry. Pure filesystem.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPendingRegistrationStore, PENDING_TTL_MS, MAX_PENDING } from '../server/pending-registrations.js';
import { hashPassword } from '../server/auth.js';

async function tmp() { return mkdtemp(join(tmpdir(), 'pendreg-')); }

describe('pending-registrations store', () => {
  it('registers, hashes the password, never stores plaintext', async () => {
    const dir = await tmp();
    const store = createPendingRegistrationStore(dir);
    const r = await store.register('alice', 'password1', '1.2.3.4');
    expect(r.ok).toBe(true);
    const entry = await store.get('alice');
    expect(entry).toMatchObject({ username: 'alice', ip: '1.2.3.4', status: 'pending' });
    expect(entry!.hashHex).toBe(hashPassword('password1', entry!.saltHex));
    expect(JSON.stringify(entry)).not.toContain('password1');
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects an invalid username/password and a duplicate name', async () => {
    const dir = await tmp();
    const store = createPendingRegistrationStore(dir);
    expect((await store.register('a b', 'password1', 'ip')).ok).toBe(false); // bad charset
    expect((await store.register('alice', 'short', 'ip')).ok).toBe(false);   // too short
    expect((await store.register('alice', 'password1', 'ip')).ok).toBe(true);
    expect((await store.register('alice', 'password1', 'ip')).ok).toBe(false); // dup pending
    await rm(dir, { recursive: true, force: true });
  });

  it('pendingCount honours the queue cap constant', async () => {
    const dir = await tmp();
    const store = createPendingRegistrationStore(dir);
    expect(MAX_PENDING).toBeGreaterThan(0);
    await store.register('alice', 'password1', 'ip');
    expect(await store.pendingCount()).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });

  it('deny keeps the entry until expiry; approveMaterial returns hash + removes', async () => {
    const dir = await tmp();
    const store = createPendingRegistrationStore(dir);
    await store.register('bob', 'password1', 'ip');
    await store.markDenied('bob');
    expect((await store.get('bob'))!.status).toBe('denied'); // retained for login message
    await store.register('carol', 'password1', 'ip');
    const mat = await store.approveMaterial('carol');
    expect(mat).toMatchObject({ saltHex: expect.any(String), hashHex: expect.any(String) });
    expect(await store.get('carol')).toBeNull(); // removed after approval
    await rm(dir, { recursive: true, force: true });
  });

  it('pruneExpired removes pending AND denied entries past their TTL', async () => {
    const dir = await tmp();
    const store = createPendingRegistrationStore(dir);
    await store.register('alice', 'password1', 'ip');
    await store.register('bob', 'password1', 'ip');
    await store.markDenied('bob');
    expect(await store.pruneExpired(Date.now())).toBe(false);      // none expired yet
    const future = Date.now() + PENDING_TTL_MS + 1;
    expect(await store.pruneExpired(future)).toBe(true);
    expect(await store.list()).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });
  });
});
