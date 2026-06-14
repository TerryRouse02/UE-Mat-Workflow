# Self-Registration + Admin Approval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Team-mode visitor self-register (username + password) from the login screen; the request waits in an admin approval queue, expires after 24h if unhandled, and on approval creates a `role='user'` account with a default 50,000 token/day quota.

**Architecture:** A new focused `pending-registrations` store (mirroring `auth.ts` / `proposal-store.ts`) holds scrypt-hashed pending entries under `viewer/.auth/`. A public `POST /api/auth/register` (rate-limited, queue-capped, gated by a `Team.allowRegistration` switch defaulting OFF) writes pending entries; admin-only `GET/POST /api/auth/registrations*` list and resolve them, rendered in the existing `ProposalInboxSection`. Approval lands the pre-computed hash into `users.json` via a new `createUserPrehashed`.

**Tech Stack:** TypeScript (native Node http server + React/Vite web), vitest (node + react configs), scrypt auth, JSON file stores with atomic writes.

**Spec:** `docs/superpowers/specs/2026-06-14-self-register-approval-design.md`

---

## File structure

**Create:**
- `viewer/server/pending-registrations.ts` — the pending-registration store (register / list / approve-material / deny / expire). One responsibility: the pre-account lifecycle.
- `viewer/tests/pending-registrations.test.ts` — store unit tests.
- `viewer/tests/register-http.test.ts` — register + registrations endpoint integration tests.

**Modify:**
- `viewer/server/auth.ts` — export `hashPassword`; add `createUserPrehashed` to `AuthStore`.
- `viewer/tests/auth.test.ts` — tests for `createUserPrehashed` + `hashPassword`.
- `viewer/server/http-server.ts` — `TeamConfig.allowRegistration`; instantiate store + register limiter + `MAX_PENDING`; sweep interval + cleanup; `/api/auth/register`, `/api/auth/registrations`, `/api/auth/registrations/:username`; pending check in login; `allowRegistration` in status + team get/post; `isAdminOnly`; combined pending broadcast.
- `viewer/web/src/store.tsx` — `AuthStatus.allowRegistration`; `register` action.
- `viewer/web/src/Login.tsx` — Login/Register tab + register form.
- `viewer/web/src/ProposalInbox.tsx` — merge registration rows + resolve.
- `viewer/web/src/TeamPanel.tsx` — `allowRegistration` checkbox.
- `viewer/web/src/locales/zh-Hant.json` + `en.json` — new UI strings.

**Conventions to follow (verified in-repo):**
- Stores live under `viewer/.auth/` (gitignored), use a serialized `enqueue` queue + atomic `tmp+rename` writes.
- Endpoints: `sendJson(res, code, obj)`, `readBody(req, 64_000)`, `sameOrigin(req)`, `clientIp(req)`. Public auth endpoints are routed BEFORE the team gate (line ~2673); admin endpoints AFTER it.
- Run node tests: `cd viewer && corepack pnpm exec vitest run <file>`. React tests: `corepack pnpm exec vitest run --config vitest.react.config.ts <file>`. Build: `corepack pnpm --filter ./viewer/web build`. (`pnpm` is only on PATH via `corepack`.)

---

## Task 1: auth.ts — export `hashPassword`, add `createUserPrehashed`

**Files:**
- Modify: `viewer/server/auth.ts`
- Test: `viewer/tests/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `viewer/tests/auth.test.ts` (inside the file, after the existing store tests; mirror the existing `mkdtemp`/`createAuthStore` usage already in that file):

```ts
import { createAuthStore as _mkStore, hashPassword } from '../server/auth.js';

describe('hashPassword (shared scrypt)', () => {
  it('is deterministic for the same password+salt and differs across salts', () => {
    const a = hashPassword('correct horse', 'aa'.repeat(16));
    const b = hashPassword('correct horse', 'aa'.repeat(16));
    const c = hashPassword('correct horse', 'bb'.repeat(16));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // 32-byte key, hex
  });
});

describe('createUserPrehashed', () => {
  it('lands a precomputed hash so the user can then log in', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'auth-prehash-'));
    const store = _mkStore(dir);
    const saltHex = 'cd'.repeat(16);
    const hashHex = hashPassword('s3cret-pw', saltHex);
    const r = await store.createUserPrehashed('bob', saltHex, hashHex, 'user');
    expect(r.ok).toBe(true);
    expect(await store.verifyPassword('bob', 's3cret-pw')).toEqual({ username: 'bob', role: 'user' });
    // rejects a duplicate
    expect((await store.createUserPrehashed('bob', saltHex, hashHex, 'user')).ok).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd viewer && corepack pnpm exec vitest run tests/auth.test.ts`
Expected: FAIL — `hashPassword` is not exported / `createUserPrehashed` is not a function.

- [ ] **Step 3: Implement in `viewer/server/auth.ts`**

3a. Promote the private `hashPassword` to a module-level export. DELETE the inner `function hashPassword(...)` defined inside `createAuthStore` (around line 124) and add this module-level function near the top, just below the `SCRYPT_KEYLEN` constant (line ~53):

```ts
const SCRYPT_KEYLEN = 32;

/** scrypt(password, salt) → hex. The single source of truth for the auth
 *  hash parameters; shared by the user store and the pending-registration store. */
export function hashPassword(password: string, saltHex: string): string {
  return scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN).toString('hex');
}
```

(The inner usages in `createAuthStore` — `hashPassword(password, saltHex)` in `createUser`, `verifyPassword`, `setPassword` — now resolve to this module-level function unchanged.)

3b. Add `createUserPrehashed` to the `AuthStore` interface (after `createUser`, line ~69):

```ts
  /** Land a PRE-COMPUTED scrypt hash directly (used by registration approval —
   *  the plaintext was hashed at register time and never reaches this call). */
  createUserPrehashed(username: string, saltHex: string, hashHex: string, role: Role): Promise<AuthResult>;
```

3c. Implement it inside `createAuthStore`, right after the `createUser` function (line ~162):

```ts
  function createUserPrehashed(username: string, saltHex: string, hashHex: string, role: Role): Promise<AuthResult> {
    return enqueue(async () => {
      if (!USERNAME_RE.test(username)) return { ok: false, error: 'invalid username' };
      if (!/^[0-9a-f]{32}$/.test(saltHex) || !/^[0-9a-f]{64}$/.test(hashHex)) return { ok: false, error: 'invalid credential material' };
      if (role !== 'admin' && role !== 'user') return { ok: false, error: 'invalid role' };
      const f = await loadUsers();
      if (f.users[username]) return { ok: false, error: 'user already exists' };
      f.users[username] = { saltHex, hashHex, role, createdAt: new Date().toISOString() };
      await writeJson(usersPath, f);
      return { ok: true };
    });
  }
```

3d. Add `createUserPrehashed` to the returned object (line ~255):

```ts
  return {
    hasUsers, createUser, createUserPrehashed, verifyPassword, issueToken, validateToken,
    revokeToken, listUsers, deleteUser, setPassword,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd viewer && corepack pnpm exec vitest run tests/auth.test.ts`
Expected: PASS (existing tests + the two new describes).

- [ ] **Step 5: Commit**

```bash
git add viewer/server/auth.ts viewer/tests/auth.test.ts
git commit -m "feat(auth): export hashPassword + add createUserPrehashed for registration approval"
```

---

## Task 2: pending-registrations store

**Files:**
- Create: `viewer/server/pending-registrations.ts`
- Test: `viewer/tests/pending-registrations.test.ts`

- [ ] **Step 1: Write the failing test**

Create `viewer/tests/pending-registrations.test.ts`:

```ts
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

  it('pendingCount honours the queue cap', async () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd viewer && corepack pnpm exec vitest run tests/pending-registrations.test.ts`
Expected: FAIL — cannot find module `../server/pending-registrations.js`.

- [ ] **Step 3: Create `viewer/server/pending-registrations.ts`**

```ts
// server/pending-registrations.ts — the self-service registration queue. A
// visitor's POST /api/auth/register lands here (NOT in users.json — they cannot
// log in yet); the admin approves/denies from Config → 團隊, and approval lands
// the pre-computed scrypt hash into the real user store via createUserPrehashed.
//
// One JSON under viewer/.auth/ (team-private, gitignored, like users.json):
//   pending-registrations.json  { pending: { [username]: PendingRegistration } }
//
// Lifecycle: pending --approve--> (removed; user created)   24h TTL on both
//            pending --deny-----> denied (kept until TTL so login can say so)

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateCredentials, hashPassword, USERNAME_RE } from './auth.js';

export const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const MAX_PENDING = 200;                    // queue hard cap (anti-flood)

export type PendingStatus = 'pending' | 'denied';

export interface PendingRegistration {
  username: string;
  saltHex: string;
  hashHex: string;
  requestedAt: string;
  expiresAt: number; // epoch ms
  ip: string;
  status: PendingStatus;
}

export type RegResult = { ok: true } | { ok: false; error: string };

export interface PendingRegistrationStore {
  register(username: string, password: string, ip: string): Promise<RegResult>;
  list(): Promise<PendingRegistration[]>;
  pendingCount(): Promise<number>;
  get(username: string): Promise<PendingRegistration | null>;
  markDenied(username: string): Promise<void>;
  /** Returns the stored salt/hash for landing into users.json, then removes the entry. */
  approveMaterial(username: string): Promise<{ saltHex: string; hashHex: string } | null>;
  remove(username: string): Promise<void>;
  /** Drops entries past expiresAt (pending OR denied). Returns whether anything changed. */
  pruneExpired(now?: number): Promise<boolean>;
}

interface PendingFile { pending: Record<string, PendingRegistration>; }

export function createPendingRegistrationStore(viewerRoot: string): PendingRegistrationStore {
  const dir = join(viewerRoot, '.auth');
  const path = join(dir, 'pending-registrations.json');

  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  }

  async function load(): Promise<PendingFile> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as PendingFile;
      return parsed && typeof parsed === 'object' && parsed.pending ? parsed : { pending: {} };
    } catch { return { pending: {} }; }
  }

  async function persist(f: PendingFile): Promise<void> {
    await mkdir(dir, { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, JSON.stringify(f, null, 2) + '\n', 'utf-8');
    await rename(tmp, path);
  }

  function prune(f: PendingFile, now: number): boolean {
    let changed = false;
    for (const [name, e] of Object.entries(f.pending)) {
      if (e.expiresAt <= now) { delete f.pending[name]; changed = true; }
    }
    return changed;
  }

  return {
    register(username, password, ip) {
      return enqueue(async () => {
        const v = validateCredentials(username, password);
        if (!v.ok) return v;
        const f = await load();
        prune(f, Date.now());
        if (f.pending[username]) return { ok: false, error: 'a registration for this name is already pending' };
        if (Object.keys(f.pending).length >= MAX_PENDING) return { ok: false, error: 'registration queue is full — try again later' };
        const saltHex = randomBytes(16).toString('hex');
        f.pending[username] = {
          username,
          saltHex,
          hashHex: hashPassword(password, saltHex),
          requestedAt: new Date().toISOString(),
          expiresAt: Date.now() + PENDING_TTL_MS,
          ip,
          status: 'pending',
        };
        await persist(f);
        return { ok: true };
      });
    },
    async list() {
      const f = await load();
      if (prune(f, Date.now())) await persist(f);
      return Object.values(f.pending).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    },
    async pendingCount() {
      return (await this.list()).filter((e) => e.status === 'pending').length;
    },
    async get(username) {
      if (!USERNAME_RE.test(username)) return null;
      const f = await load();
      if (prune(f, Date.now())) await persist(f);
      return f.pending[username] ?? null;
    },
    markDenied(username) {
      return enqueue(async () => {
        const f = await load();
        const e = f.pending[username];
        if (e) { e.status = 'denied'; await persist(f); }
      });
    },
    approveMaterial(username) {
      return enqueue(async () => {
        const f = await load();
        const e = f.pending[username];
        if (!e) return null;
        const material = { saltHex: e.saltHex, hashHex: e.hashHex };
        delete f.pending[username];
        await persist(f);
        return material;
      });
    },
    remove(username) {
      return enqueue(async () => {
        const f = await load();
        if (f.pending[username]) { delete f.pending[username]; await persist(f); }
      });
    },
    pruneExpired(now = Date.now()) {
      return enqueue(async () => {
        const f = await load();
        const changed = prune(f, now);
        if (changed) await persist(f);
        return changed;
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd viewer && corepack pnpm exec vitest run tests/pending-registrations.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add viewer/server/pending-registrations.ts viewer/tests/pending-registrations.test.ts
git commit -m "feat(auth): pending-registrations store (register/approve/deny/expire)"
```

---

## Task 3: Server wiring — config flag, store, limiter, sweep, broadcast

**Files:**
- Modify: `viewer/server/http-server.ts`

No new test here (exercised by Tasks 4–7). This is pure wiring; verify the build compiles.

- [ ] **Step 1: Add `allowRegistration` to `TeamConfig`**

Line 161, extend the interface:

```ts
  interface TeamConfig { enabled?: boolean; bindHost?: string; secureCookies?: boolean; memberAgent?: boolean; quotas?: Record<string, number>; memberLock?: MemberLock | null; language?: 'zh-Hant' | 'en'; allowRegistration?: boolean }
```

- [ ] **Step 2: Add runtime state + store + limiter near the other Team state**

After the `teamLanguage` declaration (line ~210) and the `proposalStore` line (~214), add:

```ts
  // Self-service registration: OFF by default — on a public deploy, opening
  // registration must be a deliberate admin action, not automatic on team enable.
  let allowRegistration: boolean = savedTeam.allowRegistration === true;
  const pendingRegStore = createPendingRegistrationStore(resolve(opts.repoRoot, 'viewer'));
  const registerLimiter = createLoginLimiter(); // reuse the sliding-window shape, per-IP
```

Add the import at the top of the file (next to the `createProposalStore` import):

```ts
import { createPendingRegistrationStore } from './pending-registrations.js';
```

- [ ] **Step 3: Make the pending badge count include registrations**

Find `broadcastProposals` (line ~279). Change its `pending` source to the combined total:

```ts
  async function broadcastProposals(): Promise<void> {
    try {
      const pending = (await proposalStore.pendingCount()) + (await pendingRegStore.pendingCount());
      const msg: ServerMessage = { kind: 'proposals', pending };
      for (const ws of wss.clients) safeSend(ws, msg);
    } catch (e) { console.error('proposals broadcast failed:', e); }
  }
```

Also update the initial per-socket send (line ~3229) to the same combined total:

```ts
      if (mode === 'team') send(ws, { kind: 'proposals', pending: (await proposalStore.pendingCount()) + (await pendingRegStore.pendingCount()) });
```

- [ ] **Step 4: Add the expiry sweep with cleanup**

After the server `http` is created and before `http.listen` (near the `openSockets` block, line ~2669), add a periodic sweep. Place the interval next to other long-lived timers and ensure it is cleared on shutdown:

```ts
  // Expire stale registrations (24h) without waiting for a read; broadcast so the
  // admin inbox badge decays live. unref() so it never keeps the process alive.
  const regSweep = setInterval(() => {
    void pendingRegStore.pruneExpired().then((changed) => { if (changed) void broadcastProposals(); });
  }, 10 * 60 * 1000);
  regSweep.unref();
```

In the shutdown path (the `close` implementation that calls `await watcher.close()`, line ~3290 and ~3301/3313), add `clearInterval(regSweep);` alongside the watcher close. Add it in BOTH the error path and the normal `close()`:

```ts
    clearInterval(regSweep);
    await watcher.close();
```

- [ ] **Step 5: Verify the build compiles**

Run: `cd viewer && corepack pnpm exec tsc -p tsconfig.json`
Expected: no errors. (Routes/handlers are added in Tasks 4–7; nothing references them yet, so this compiles clean.)

- [ ] **Step 6: Commit**

```bash
git add viewer/server/http-server.ts
git commit -m "feat(server): wire pending-registration store, register limiter, expiry sweep, combined pending badge"
```

---

## Task 4: `POST /api/auth/register` endpoint (public, gated, rate-limited)

**Files:**
- Modify: `viewer/server/http-server.ts`
- Test: `viewer/tests/register-http.test.ts`

- [ ] **Step 1: Write the failing test**

Create `viewer/tests/register-http.test.ts` (mirror the `withTeamServer` / `setupAdmin` helpers from `auth-http.test.ts`):

```ts
// register-http.test.ts — self-registration + admin approval HTTP flow.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startServer, type RunningServer } from '../server/http-server.js';

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '..', '..');

function makeTmpRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'register-http-'));
  mkdirSync(resolve(root, 'graphs'), { recursive: true });
  mkdirSync(resolve(root, 'tools', 'node-t3d-metadata'), { recursive: true });
  mkdirSync(resolve(root, 'viewer'), { recursive: true });
  try { symlinkSync(resolve(REPO_ROOT, 'agent-pack'), resolve(root, 'agent-pack'), 'dir'); } catch { /* exists */ }
  return root;
}

async function withTeamServer(fn: (base: string, server: RunningServer) => Promise<void>) {
  const root = makeTmpRoot();
  const server = await startServer({ repoRoot: root, port: 0, webDist: '', mode: 'team' });
  try { await fn(`http://localhost:${server.port}`, server); }
  finally { await server.close(); await rm(root, { recursive: true, force: true }); }
}

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function cookieOf(res: Response): string {
  const m = (res.headers.get('set-cookie') ?? '').match(/uemw_token=[^;]*/);
  return m![0];
}
async function setupAdmin(base: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/setup`, json({ username: 'admin', password: 'password1' }));
  expect(res.status).toBe(200);
  return cookieOf(res);
}
async function openRegistration(base: string, cookie: string) {
  const r = await fetch(`${base}/api/team`, { ...json({ allowRegistration: true }), headers: { 'content-type': 'application/json', cookie } });
  expect(r.status).toBe(200);
}

describe('POST /api/auth/register', () => {
  it('403s when allowRegistration is off (the default)', async () => {
    await withTeamServer(async (base) => {
      await setupAdmin(base);
      const r = await fetch(`${base}/api/auth/register`, json({ username: 'alice', password: 'password1' }));
      expect(r.status).toBe(403);
    });
  });

  it('accepts a registration once opened; rejects a duplicate name and a too-short password', async () => {
    await withTeamServer(async (base) => {
      const cookie = await setupAdmin(base);
      await openRegistration(base, cookie);
      expect((await fetch(`${base}/api/auth/register`, json({ username: 'alice', password: 'password1' }))).status).toBe(200);
      expect((await fetch(`${base}/api/auth/register`, json({ username: 'alice', password: 'password1' }))).status).toBe(400);
      expect((await fetch(`${base}/api/auth/register`, json({ username: 'eve', password: 'short' }))).status).toBe(400);
      // a pending user cannot log in yet — transparent status
      const login = await fetch(`${base}/api/auth/login`, json({ username: 'alice', password: 'password1' }));
      expect(login.status).toBe(403);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd viewer && corepack pnpm exec vitest run tests/register-http.test.ts`
Expected: FAIL — register returns 404 (route not wired); login returns 401 not 403.

- [ ] **Step 3: Add the handler**

Add `handleAuthRegister` next to `handleAuthLogin` (line ~2599):

```ts
  async function handleAuthRegister(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!authStore) { sendJson(res, 404, { error: 'not available in local mode' }); return; }
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '跨來源請求已拒絕' }); return; }
    if (!allowRegistration) { sendJson(res, 403, { error: '管理員尚未開放自助註冊' }); return; }
    const ip = clientIp(req);
    if (registerLimiter.blocked(ip)) { sendJson(res, 429, { error: '註冊嘗試過於頻繁，請稍後再試' }); return; }
    let body: { username?: unknown; password?: unknown };
    try { body = JSON.parse(await readBody(req, 64_000)); }
    catch (e) { sendJson(res, 400, { error: `bad request body: ${(e as Error).message}` }); return; }
    const username = String(body.username ?? '');
    // Name must not collide with an EXISTING user either (not only a pending one).
    if (USERNAME_RE.test(username) && await authStore.verifyExists(username)) {
      registerLimiter.fail(ip);
      sendJson(res, 400, { error: '此使用者名稱已被使用' });
      return;
    }
    const r = await pendingRegStore.register(username, String(body.password ?? ''), ip);
    if (!r.ok) { registerLimiter.fail(ip); sendJson(res, 400, { error: r.error }); return; }
    await broadcastProposals(); // bump the admin inbox badge
    sendJson(res, 200, { ok: true });
  }
```

This needs a cheap existence check on the auth store. Add `verifyExists` to `AuthStore` in `viewer/server/auth.ts` (interface near `hasUsers`, and implementation + return object):

Interface (after `hasUsers`):
```ts
  /** True if a user with this exact name exists (no timing guarantees — name-only). */
  verifyExists(username: string): Promise<boolean>;
```
Implementation (after `hasUsers` function, ~line 143):
```ts
  async function verifyExists(username: string): Promise<boolean> {
    const f = await loadUsers();
    return Object.prototype.hasOwnProperty.call(f.users, username);
  }
```
Return object: add `verifyExists` to the list.

- [ ] **Step 4: Route it BEFORE the team gate**

In the public auth section (after the `/api/auth/login` route, line ~2688), add:

```ts
    if (req.method === 'POST' && urlPath === '/api/auth/register') {
      try { await handleAuthRegister(req, res); }
      catch (e) { console.error('auth register error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
```

- [ ] **Step 5: Make a pending/denied login transparent**

In `handleAuthLogin`, right AFTER the rate-limit block and BEFORE `verifyPassword` (line ~2584), insert the pending check:

```ts
    const pend = await pendingRegStore.get(String(body.username ?? ''));
    if (pend) {
      sendJson(res, 403, { error: pend.status === 'denied' ? '你的註冊申請已被拒絕' : '帳號審核中，請等待管理員批准' });
      return;
    }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd viewer && corepack pnpm exec vitest run tests/register-http.test.ts`
Expected: the two `register` tests PASS. (Add the `auth.test.ts` `verifyExists` is exercised indirectly; run `tests/auth.test.ts` too — still green.)

- [ ] **Step 7: Commit**

```bash
git add viewer/server/http-server.ts viewer/server/auth.ts viewer/tests/register-http.test.ts
git commit -m "feat(server): POST /api/auth/register + transparent pending/denied login"
```

---

## Task 5: `GET/POST /api/auth/registrations*` (admin approve/deny) + gate

**Files:**
- Modify: `viewer/server/http-server.ts`
- Test: `viewer/tests/register-http.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `viewer/tests/register-http.test.ts`:

```ts
describe('admin approval', () => {
  it('approve creates a user with the 50K quota and lets them log in; deny blocks with a message', async () => {
    await withTeamServer(async (base) => {
      const cookie = await setupAdmin(base);
      await openRegistration(base, cookie);
      await fetch(`${base}/api/auth/register`, json({ username: 'alice', password: 'password1' }));
      await fetch(`${base}/api/auth/register`, json({ username: 'mallory', password: 'password1' }));

      const authed = { 'content-type': 'application/json', cookie };
      const list = await (await fetch(`${base}/api/auth/registrations`, { headers: { cookie } })).json();
      expect(list.registrations.map((p: { username: string }) => p.username).sort()).toEqual(['alice', 'mallory']);

      // approve alice
      const ap = await fetch(`${base}/api/auth/registrations/alice`, { method: 'POST', headers: authed, body: JSON.stringify({ action: 'approve' }) });
      expect(ap.status).toBe(200);
      const team = await (await fetch(`${base}/api/team`, { headers: { cookie } })).json();
      expect(team.quotas?.alice).toBe(50000);
      const login = await fetch(`${base}/api/auth/login`, json({ username: 'alice', password: 'password1' }));
      expect(login.status).toBe(200);

      // deny mallory → kept as denied → login says so
      const dn = await fetch(`${base}/api/auth/registrations/mallory`, { method: 'POST', headers: authed, body: JSON.stringify({ action: 'deny' }) });
      expect(dn.status).toBe(200);
      const ml = await fetch(`${base}/api/auth/login`, json({ username: 'mallory', password: 'password1' }));
      expect(ml.status).toBe(403);
      expect((await ml.json()).error).toContain('拒絕');
    });
  });

  it('registrations endpoints are admin-only (401 without a token)', async () => {
    await withTeamServer(async (base) => {
      await setupAdmin(base);
      expect((await fetch(`${base}/api/auth/registrations`)).status).toBe(401);
      expect((await fetch(`${base}/api/auth/registrations/x`, json({ action: 'approve' }))).status).toBe(401);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd viewer && corepack pnpm exec vitest run tests/register-http.test.ts`
Expected: FAIL — `/api/auth/registrations` returns 401 (gate) but the list/resolve handlers don't exist, and the admin-authed calls 404.

- [ ] **Step 3: Add the handlers**

Add a `DEFAULT_REGISTRATION_QUOTA` constant near the other Team state (Task 3 area):

```ts
  const DEFAULT_REGISTRATION_QUOTA = 50_000; // tokens/day seeded on approval
```

Add the handlers next to `handleProposalResolve` (line ~1815, after the db-edit branch ends) — or anywhere among the auth handlers; place them with the other `/api/auth/*` handlers (after `handleAuthSelfPassword`, line ~2663):

```ts
  async function handleRegistrationsList(res: import('node:http').ServerResponse) {
    if (!authStore) { sendJson(res, 404, { error: 'not available in local mode' }); return; }
    sendJson(res, 200, { registrations: await pendingRegStore.list() });
  }

  async function handleRegistrationResolve(username: string, req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!authStore) { sendJson(res, 404, { error: 'not available in local mode' }); return; }
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '跨來源請求已拒絕' }); return; }
    let body: { action?: unknown };
    try { body = JSON.parse(await readBody(req, 64_000)); }
    catch (e) { sendJson(res, 400, { error: `bad request body: ${(e as Error).message}` }); return; }
    const entry = await pendingRegStore.get(username);
    if (!entry || entry.status !== 'pending') { sendJson(res, 404, { error: '註冊申請不存在或已處理' }); return; }

    if (body.action === 'deny') {
      await pendingRegStore.markDenied(username);
      await broadcastProposals();
      sendJson(res, 200, { ok: true, status: 'denied' });
      return;
    }
    if (body.action !== 'approve') { sendJson(res, 400, { error: 'action must be approve | deny' }); return; }

    const material = await pendingRegStore.approveMaterial(username);
    if (!material) { sendJson(res, 404, { error: '註冊申請不存在或已處理' }); return; }
    const created = await authStore.createUserPrehashed(username, material.saltHex, material.hashHex, 'user');
    if (!created.ok) { sendJson(res, 409, { error: created.error }); return; }
    quotas = { ...quotas, [username]: DEFAULT_REGISTRATION_QUOTA };
    await saveTeamConfig({ quotas });
    await broadcastProposals();
    sendJson(res, 200, { ok: true, status: 'approved' });
  }
```

- [ ] **Step 4: Route them AFTER the gate + mark admin-only**

In `isAdminOnly` (line ~251), add near the `/api/auth/users` line:

```ts
    if (urlPath.startsWith('/api/auth/registrations')) return true;
```

(`/api/auth/register` singular does not start with `/api/auth/registrations`, so it stays public.)

Add routing AFTER the gate, next to the users-management block (line ~2768, after the users regex block):

```ts
    if (urlPath === '/api/auth/registrations' && req.method === 'GET') {
      try { await handleRegistrationsList(res); }
      catch (e) { console.error('registrations list error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    {
      const m = urlPath.match(/^\/api\/auth\/registrations\/([A-Za-z0-9_.-]{1,32})$/);
      if (m && req.method === 'POST' && USERNAME_RE.test(m[1])) {
        try { await handleRegistrationResolve(m[1], req, res); }
        catch (e) { console.error('registration resolve error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
        return;
      }
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd viewer && corepack pnpm exec vitest run tests/register-http.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 6: Commit**

```bash
git add viewer/server/http-server.ts
git commit -m "feat(server): admin approve/deny registrations (creates user + seeds 50K quota)"
```

---

## Task 6: Expose `allowRegistration` in status + team config

**Files:**
- Modify: `viewer/server/http-server.ts`
- Test: `viewer/tests/register-http.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `viewer/tests/register-http.test.ts`:

```ts
describe('allowRegistration config', () => {
  it('defaults off, is echoed by status + team, and toggles via POST /api/team', async () => {
    await withTeamServer(async (base) => {
      const cookie = await setupAdmin(base);
      const s0 = await (await fetch(`${base}/api/auth/status`, { headers: { cookie } })).json();
      expect(s0.allowRegistration).toBe(false);
      await openRegistration(base, cookie); // POST /api/team { allowRegistration: true }
      const s1 = await (await fetch(`${base}/api/auth/status`, { headers: { cookie } })).json();
      expect(s1.allowRegistration).toBe(true);
      const team = await (await fetch(`${base}/api/team`, { headers: { cookie } })).json();
      expect(team.allowRegistration).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd viewer && corepack pnpm exec vitest run tests/register-http.test.ts`
Expected: FAIL — `allowRegistration` is `undefined` in status/team; POST /api/team ignores it.

- [ ] **Step 3: Surface it in `handleAuthStatus`**

In `handleAuthStatus` (line ~2534), add to the returned object (always present so the login screen can read it pre-auth):

```ts
      allowRegistration,
```

- [ ] **Step 4: Echo + accept it in team get/post**

In `handleTeamGet` (the object around line ~2410), add `allowRegistration` to the response. In `handleTeamPost` (after the `memberAgent` handling, line ~2439), add:

```ts
      if (typeof body.allowRegistration === 'boolean' && body.allowRegistration !== allowRegistration) {
        allowRegistration = body.allowRegistration;
        await saveTeamConfig({ allowRegistration });
      }
```

Also add `allowRegistration?: unknown` to the `body` destructure type in `handleTeamPost` (line ~2424).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd viewer && corepack pnpm exec vitest run tests/register-http.test.ts`
Expected: PASS (all 5 describes).

- [ ] **Step 6: Commit**

```bash
git add viewer/server/http-server.ts
git commit -m "feat(server): expose + toggle Team.allowRegistration (status + /api/team)"
```

---

## Task 7: Frontend store — `register` action + `allowRegistration`

**Files:**
- Modify: `viewer/web/src/store.tsx`

(UI tasks are verified via the React test in Task 9/10 + the final build. No standalone unit test here.)

- [ ] **Step 1: Add `allowRegistration` to `AuthStatus`**

In `AuthStatus` (line ~78), add:

```ts
  /** Team mode: admin has opened self-service registration on the login screen. */
  allowRegistration?: boolean;
```

- [ ] **Step 2: Add a `register` action**

After `setupAdmin` (line ~487), add a register call that does NOT auto-login:

```ts
  const register = useCallback(async (username: string, password: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const r = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      return r.ok ? { ok: true } : { ok: false, error: data.error || `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }, []);
```

- [ ] **Step 3: Export it on the context value**

Add `register` to BOTH the `useMemo` value object and its dependency array (line ~549). Also add `register` to the context type interface where `setupAdmin` is declared (line ~241):

```ts
  register(username: string, password: string): Promise<{ ok: boolean; error?: string }>;
```

- [ ] **Step 4: Verify it compiles**

Run: `cd viewer && corepack pnpm exec tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add viewer/web/src/store.tsx
git commit -m "feat(web): store register action + AuthStatus.allowRegistration"
```

---

## Task 8: i18n strings

**Files:**
- Modify: `viewer/web/src/locales/zh-Hant.json`, `viewer/web/src/locales/en.json`

- [ ] **Step 1: Add login + inbox + team keys to `zh-Hant.json`**

Add to the `login` object:
```json
    "tabLogin": "登入",
    "tabRegister": "註冊",
    "titleRegister": "註冊新帳號",
    "registerSub": "送出後需管理員批准，24 小時內未處理將自動失效。",
    "confirmRegisterLabel": "確認密碼",
    "submitRegister": "送出註冊",
    "registerSubmitted": "註冊已送出，等待管理員批准（24 小時內）。獲准後即可用此帳密登入。",
    "errRegisterFailed": "註冊失敗"
```
Add to the `proposalInbox` object:
```json
    "kindRegistration": "註冊",
    "summaryRegistration": "使用者「{{username}}」申請帳號"
```
Add to the `teamPanel` object:
```json
    "allowRegistration": "開放自助註冊（訪客可在登入頁註冊，需在此審批；預設每日 50K token 配額）"
```

- [ ] **Step 2: Add the parallel keys to `en.json`**

`login`:
```json
    "tabLogin": "Sign in",
    "tabRegister": "Register",
    "titleRegister": "Create an account",
    "registerSub": "Your request needs admin approval; it expires after 24h if unhandled.",
    "confirmRegisterLabel": "Confirm password",
    "submitRegister": "Submit registration",
    "registerSubmitted": "Registration submitted — waiting for admin approval (within 24h). Once approved, sign in with this username and password.",
    "errRegisterFailed": "Registration failed"
```
`proposalInbox`:
```json
    "kindRegistration": "Sign-up",
    "summaryRegistration": "User \"{{username}}\" requests an account"
```
`teamPanel`:
```json
    "allowRegistration": "Allow self-registration (visitors can register on the login page; approve here. Default 50K tokens/day)"
```

- [ ] **Step 3: Verify key parity**

Run:
```bash
cd viewer/web/src/locales && node -e 'const z=require("./zh-Hant.json"),e=require("./en.json");const f=(o,p="")=>Object.entries(o).flatMap(([k,v])=>v&&typeof v==="object"?f(v,p+k+"."):[p+k]);const zk=new Set(f(z)),ek=new Set(f(e));const only=(a,b)=>[...a].filter(x=>!b.has(x));console.log("zh-only:",only(zk,ek));console.log("en-only:",only(ek,zk));'
```
Expected: `zh-only: []` and `en-only: []`.

- [ ] **Step 4: Commit**

```bash
git add viewer/web/src/locales/zh-Hant.json viewer/web/src/locales/en.json
git commit -m "i18n: registration + approval strings (zh-Hant + en)"
```

---

## Task 9: Login.tsx — Register tab

**Files:**
- Modify: `viewer/web/src/Login.tsx`
- Test: `viewer/tests/login-register.test.tsx` (new; mirror `team-ui.test.tsx`)

- [ ] **Step 1: Write the failing test**

Create `viewer/tests/login-register.test.tsx`. Mirror the render+provider harness used in `viewer/tests/team-ui.test.tsx` (import that file first to copy its store-mocking/render setup). The behavioral assertions:

```ts
// login-register.test.tsx — the login screen shows a Register tab only when the
// admin has opened registration, and submitting calls store.register.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../web/src/i18n';
import { Login } from '../web/src/Login';
// NOTE: reuse the exact StoreProvider mock pattern from team-ui.test.tsx.
// Provide auth = { mode:'team', needsSetup:false, authed:false, allowRegistration:true }
// and a register spy that resolves { ok: true }.

// ...harness from team-ui.test.tsx...

describe('Login register tab', () => {
  it('shows the Register tab when allowRegistration is true and submits via store.register', async () => {
    const register = vi.fn().mockResolvedValue({ ok: true });
    renderLogin({ allowRegistration: true, register }); // helper from the harness
    fireEvent.click(screen.getByRole('button', { name: /註冊|Register/ }));
    fireEvent.change(screen.getByLabelText(/使用者名稱|Username/i), { target: { value: 'alice' } });
    const pws = screen.getAllByLabelText(/密碼|password/i);
    fireEvent.change(pws[0], { target: { value: 'password1' } });
    fireEvent.change(pws[1], { target: { value: 'password1' } });
    fireEvent.click(screen.getByRole('button', { name: /送出註冊|Submit registration/ }));
    await waitFor(() => expect(register).toHaveBeenCalledWith('alice', 'password1'));
    expect(await screen.findByText(/等待管理員批准|waiting for admin approval/i)).toBeTruthy();
  });

  it('hides the Register tab when allowRegistration is false', () => {
    renderLogin({ allowRegistration: false, register: vi.fn() });
    expect(screen.queryByRole('button', { name: /^註冊$|^Register$/ })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd viewer && corepack pnpm exec vitest run --config vitest.react.config.ts tests/login-register.test.tsx`
Expected: FAIL — no Register tab / `register` not on the store.

- [ ] **Step 3: Implement the Register tab in `Login.tsx`**

Replace the component body to add a mode toggle and a register branch. Key changes:

```tsx
export function Login() {
  const { t } = useTranslation();
  const { state, login, setupAdmin, register } = useStore();
  const needsSetup = state.auth?.needsSetup === true;
  const allowRegistration = state.auth?.allowRegistration === true;

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false); // registration sent, awaiting approval

  const isRegister = !needsSetup && mode === 'register';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if ((needsSetup || isRegister) && password !== confirm) {
      setError(t('login.errPasswordMismatch'));
      return;
    }
    setBusy(true);
    if (isRegister) {
      const r = await register(username, password);
      setBusy(false);
      if (r.ok) { setSubmitted(true); setPassword(''); setConfirm(''); }
      else setError(r.error ?? t('login.errRegisterFailed'));
      return;
    }
    const r = needsSetup ? await setupAdmin(username, password) : await login(username, password);
    setBusy(false);
    if (!r.ok) setError(r.error ?? t('login.errLoginFailed'));
  };

  if (submitted) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="login-logo"><span className="mark">M</span><span className="t">UE·MAT workflow</span></div>
          <div className="login-sub" role="status">{t('login.registerSubmitted')}</div>
          <button className="login-submit" onClick={() => { setSubmitted(false); setMode('login'); }}>
            {t('login.tabLogin')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo"><span className="mark">M</span><span className="t">UE·MAT workflow</span></div>

        {!needsSetup && allowRegistration && (
          <div className="login-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'login'}
              className={'login-tab' + (mode === 'login' ? ' on' : '')} onClick={() => { setMode('login'); setError(null); }}>
              {t('login.tabLogin')}
            </button>
            <button type="button" role="tab" aria-selected={mode === 'register'}
              className={'login-tab' + (mode === 'register' ? ' on' : '')} onClick={() => { setMode('register'); setError(null); }}>
              {t('login.tabRegister')}
            </button>
          </div>
        )}

        <div className="login-title">
          {needsSetup ? t('login.titleSetup') : isRegister ? t('login.titleRegister') : t('login.titleLogin')}
        </div>
        {needsSetup && <div className="login-sub">{t('login.setupSub')}</div>}
        {isRegister && <div className="login-sub">{t('login.registerSub')}</div>}

        <label className="login-field">
          <span>{t('login.usernameLabel')}</span>
          <input autoFocus value={username} onChange={e => setUsername(e.target.value)}
            autoComplete="username" placeholder={t('login.usernamePlaceholder')} />
        </label>
        <label className="login-field">
          <span>{t('login.passwordLabel')}</span>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)}
            autoComplete={needsSetup || isRegister ? 'new-password' : 'current-password'}
            placeholder={t('login.passwordPlaceholder')} />
        </label>
        {(needsSetup || isRegister) && (
          <label className="login-field">
            <span>{isRegister ? t('login.confirmRegisterLabel') : t('login.confirmLabel')}</span>
            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
          </label>
        )}
        {error && <div className="login-error" role="alert">{error}</div>}
        <button className="login-submit" type="submit" disabled={busy || !username || !password}>
          {busy ? t('login.submitBusy') : needsSetup ? t('login.submitSetup') : isRegister ? t('login.submitRegister') : t('login.submitLogin')}
        </button>
        <div className="login-foot"><Icon name="settings" size={11} /> {t('login.foot')}</div>
      </form>
    </div>
  );
}
```

Add minimal styling to `viewer/web/src/login.css` (mirror `.cfg-tabs`/`.cfg-tab`):

```css
.login-tabs { display: flex; gap: 2px; padding: 2px; background: var(--bg-panel-2); border: 1px solid var(--border); border-radius: var(--chip-radius); margin-bottom: 12px; }
.login-tab { flex: 1; padding: 6px 0; font-size: 13px; color: var(--text-dim); background: none; border: none; border-radius: 4px; cursor: pointer; }
.login-tab.on { background: var(--bg-elev); color: var(--text); font-weight: 600; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd viewer && corepack pnpm exec vitest run --config vitest.react.config.ts tests/login-register.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add viewer/web/src/Login.tsx viewer/web/src/login.css viewer/tests/login-register.test.tsx
git commit -m "feat(web): login-screen Register tab (admin-opened, awaits approval)"
```

---

## Task 10: ProposalInbox.tsx — merge registration rows

**Files:**
- Modify: `viewer/web/src/ProposalInbox.tsx`

- [ ] **Step 1: Add a registrations fetch + state**

Add a parallel registrations type + fetch alongside the proposals fetch. After the `Proposal` interface (line ~20):

```tsx
interface PendingRegistration {
  username: string;
  requestedAt: string;
  ip: string;
  status: 'pending' | 'denied';
}
```

Add state + extend `refresh` to fetch both (line ~43–56):

```tsx
  const [registrations, setRegistrations] = useState<PendingRegistration[]>([]);
```

In `refresh`, after the proposals fetch:

```tsx
      const rr = await fetch('/api/auth/registrations', { cache: 'no-store' });
      if (rr.ok) setRegistrations(((await rr.json()) as { registrations: PendingRegistration[] }).registrations);
```

- [ ] **Step 2: Add a registration resolver**

Next to `resolve` (line ~61), add:

```tsx
  const resolveReg = async (username: string, action: 'approve' | 'deny') => {
    setBusyId('reg:' + username);
    setError(null);
    try {
      const r = await fetch(`/api/auth/registrations/${username}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!r.ok) { const e = (await r.json().catch(() => ({}))) as { error?: string }; setError(e.error || `HTTP ${r.status}`); }
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusyId(null); }
  };
```

- [ ] **Step 3: Render pending registrations above the agent proposals**

In the `pinbox-list`, before the `pending.map(...)`, add:

```tsx
        {registrations.filter(r => r.status === 'pending').map(r => (
          <div key={'reg:' + r.username} className="pinbox-row">
            <div className="pinbox-main">
              <span className="pinbox-kind">{t('proposalInbox.kindRegistration')}</span>
              <span className="pinbox-summary">{t('proposalInbox.summaryRegistration', { username: r.username })}</span>
              <span className="pinbox-who">{r.ip}</span>
            </div>
            <div className="pinbox-actions">
              <button className="ua-btn primary" disabled={busyId === 'reg:' + r.username} onClick={() => void resolveReg(r.username, 'approve')}>
                {busyId === 'reg:' + r.username ? t('proposalInbox.processing') : t('proposalInbox.approve')}
              </button>
              <button className="ua-btn danger" disabled={busyId === 'reg:' + r.username} onClick={() => void resolveReg(r.username, 'deny')}>
                {t('proposalInbox.deny')}
              </button>
            </div>
          </div>
        ))}
```

Also include registrations in the header pending count: change the `pending.length` used in the section header (line ~91) to `(pending.length + registrations.filter(r => r.status === 'pending').length)`, and the empty-state guard (line ~97) to `proposals.length === 0 && registrations.length === 0`.

- [ ] **Step 4: Verify build**

Run: `cd viewer && corepack pnpm exec tsc -b && corepack pnpm --filter ./viewer/web build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add viewer/web/src/ProposalInbox.tsx
git commit -m "feat(web): show + approve/deny registrations in the proposal inbox"
```

---

## Task 11: TeamPanel.tsx — allowRegistration checkbox

**Files:**
- Modify: `viewer/web/src/TeamPanel.tsx`

- [ ] **Step 1: Extend `TeamInfo`**

Add to the `TeamInfo` interface (line ~15):

```tsx
  /** Admin switch: visitors may self-register on the login page. */
  allowRegistration?: boolean;
```

- [ ] **Step 2: Add the checkbox**

In the team-mode branch, next to the `memberAgent` checkbox (line ~168), add:

```tsx
          <label className="team-check">
            <input
              type="checkbox"
              checked={info.allowRegistration === true}
              disabled={busy}
              onChange={e => { void post({ allowRegistration: e.target.checked }); }}
            />
            {t('teamPanel.allowRegistration')}
          </label>
```

(The existing `post(...)` helper already calls `POST /api/team` then `load()`, so the checkbox reflects server state after the round-trip — same pattern as `memberAgent`.)

- [ ] **Step 3: Verify build**

Run: `cd viewer && corepack pnpm exec tsc -b && corepack pnpm --filter ./viewer/web build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add viewer/web/src/TeamPanel.tsx
git commit -m "feat(web): Team tab toggle to open self-registration"
```

---

## Task 12: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full node test suite**

Run: `cd viewer && corepack pnpm exec vitest run`
Expected: all pass, including `auth.test.ts`, `pending-registrations.test.ts`, `register-http.test.ts`.

- [ ] **Step 2: Run the full React test suite**

Run: `cd viewer && corepack pnpm exec vitest run --config vitest.react.config.ts`
Expected: all pass, including `login-register.test.tsx`.

- [ ] **Step 3: Run the tools test suite (unchanged, sanity)**

Run: `node --test "tools/node-t3d-metadata/tests/**/*.test.js"`
Expected: all pass (unaffected by this change).

- [ ] **Step 4: Production web build**

Run: `corepack pnpm --filter ./viewer/web build`
Expected: `tsc -b && vite build` both succeed.

- [ ] **Step 5: Confirm the gitignore covers the new store file**

Run: `cd viewer && git check-ignore .auth/pending-registrations.json`
Expected: prints the path (it is ignored — `.auth/` is gitignored). If it prints nothing, ADD `.auth/` coverage to `viewer/.gitignore` before continuing (Hard Invariant #7 — auth data must never be committed).

- [ ] **Step 6: Commit any final touch-ups**

```bash
git add -A
git commit -m "test: full suite green for self-register + approval"
```

---

## Self-review notes (resolved)

- **Spec coverage:** register endpoint (Task 4), approval+50K quota (Task 5), 24h expiry (Task 2 store + Task 3 sweep), transparent pending/denied login (Task 4 step 5), inbox integration (Task 10), `allowRegistration` default-off switch (Tasks 3/6/11), per-IP limit + queue cap (Task 2 `MAX_PENDING` + Task 4 `registerLimiter`), i18n parity (Task 8), `.auth` gitignore (Task 12 step 5). All covered.
- **Type consistency:** `createUserPrehashed`, `verifyExists`, `register`, `approveMaterial`, `markDenied`, `pruneExpired`, `allowRegistration`, `DEFAULT_REGISTRATION_QUOTA`, `PENDING_TTL_MS`, `MAX_PENDING` are used with identical signatures across tasks.
- **No CAPTCHA / device-fingerprint** in scope (spec non-goal); anti-abuse is per-IP limit + queue cap + the human approval gate, as chosen.
