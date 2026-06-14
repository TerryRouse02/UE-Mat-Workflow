# Self-Registration + Admin Approval — Design

**Date:** 2026-06-14
**Status:** Approved (design); pending implementation plan
**Scope:** Team mode only. Adds a self-service registration path to the login
screen, gated by admin approval, so the admin no longer has to hand-create an
account for every visitor who wants to try the tool. Runs on the live public
site (uemat.xyz), so abuse control and auth-data hygiene are first-class.

This **replaces** the earlier anonymous "Free mode" idea — named accounts with a
per-user daily quota and an approval gate are far more controllable than an
anonymous shared-bucket guest mode.

## Goals

- A visitor can self-register (username + password) from the Team-mode login
  screen without an admin pre-creating the account.
- New registrations land in a **pending queue** and cannot log in until approved.
- Admin approves/denies from the existing **成員提案審批** section
  (`ProposalInboxSection`, Config → 團隊).
- On approval: a `role='user'` account is created with a **default daily quota
  of 50,000 tokens**.
- Unhandled registrations **expire and are removed after 24 hours**.
- Abuse control sized to the real threat (queue flooding, not impersonation —
  the human approval gate already stops a bot from getting in).

## Non-goals

- No email/out-of-band notification (no mail infra). The user learns their status
  by attempting to log in.
- No true device/"machine ID" fingerprinting — unavailable/unreliable in the
  browser (see "Anti-abuse" rationale). Not pursued.
- No CAPTCHA in this iteration (can be added later if per-IP limiting proves
  insufficient).
- Local mode is untouched (no auth store exists there).

## Key decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Anti-bot strength | **per-IP rate limit + pending-queue hard cap** | Admin approval is the real gate; this layer only prevents queue flooding. No external deps, no privacy concerns. |
| Status transparency | **Transparent** | Registrant sees 審核中 / 已拒絕 / 已過期 on login attempt. Judgment is the admin's; transparency is friendly and safe. |
| Data model | **Separate `pending-registrations` store** | Password hash + expiry lifecycle stay in the auth domain, isolated from the agent proposal store. Each store keeps one purpose. |
| `Team.allowRegistration` default | **OFF** | On a public site, opening self-registration must be a deliberate admin action, not automatic on team-mode enable. |
| Denied-record retention | **Keep until 24h expiry, then prune** | Lets login show "已拒絕"; aligns with the transparency choice. |
| Default quota | **50,000 tokens/day**, admin-adjustable afterward | Seeded into `Team.quotas[username]` on approval; the existing UserAdmin quota editor can change it later. |

## Architecture

### New: `viewer/server/pending-registrations.ts`

Mirrors the `auth.ts` / `proposal-store.ts` pattern: a focused store with a
serialized mutation queue and atomic (tmp + rename) writes, persisting to
`viewer/.auth/pending-registrations.json` (gitignored — Hard Invariant #7).

```
{ pending: { [username]: {
    saltHex, hashHex,          // scrypt hash computed at register time; plaintext never stored
    requestedAt, expiresAt,    // expiresAt = requestedAt + 24h
    ip,                        // source IP (audit + abuse signal)
    status                     // 'pending' | 'denied'
} } }
```

Interface:
- `register(username, password, ip): Promise<AuthResult>` — validates, computes
  the scrypt hash, writes a pending entry. Caller pre-checks collisions/cap/limit.
- `list(): Promise<PendingRegistration[]>` — for the admin inbox (lazy-prunes expired first).
- `pendingCount(): Promise<number>`
- `get(username): Promise<PendingRegistration | null>`
- `remove(username): Promise<void>` — drops the entry; called after **approve** (the account now lives in `users.json`).
- `markDenied(username): Promise<void>` — flips status to `'denied'`; the entry is **kept until its 24h expiry** so login can report "已拒絕", then `pruneExpired` clears it.
- `pruneExpired(now): Promise<boolean>` — removes entries past `expiresAt` (pending OR denied); returns whether anything changed.

Expiry runs **lazily** (on every `list`/`get`/`register`) **and** via a light
`setInterval` sweep (~10 min) that broadcasts the queue count so the admin inbox
count decays without a manual refresh.

### Reused/extended: `viewer/server/auth.ts`

- **Extract `hashPassword(password, saltHex)` to a module-level export** (single
  source of truth for the scrypt parameters) so the pending store and the auth
  store hash identically.
- **Add `createUserPrehashed(username, saltHex, hashHex, role)`** to `AuthStore`
  — approval lands the pending entry's existing hash directly into `users.json`
  without re-prompting for the password (plaintext left the system at register
  time and never returns).
- **Add `createRegisterLimiter`** — reuse the `createLoginLimiter` sliding-window
  shape, keyed by IP, for per-IP registration throttling.

### Server config: `Team`

- Add `allowRegistration?: boolean` (default `false`) to `TeamConfig`, persisted
  in `local.config.json` like the other Team flags; togglable from the 團隊 tab.

## Endpoints (`http-server.ts`)

| Method + path | Auth | Behavior |
|---|---|---|
| `POST /api/auth/register` | public (team-only, same-origin, body-size-limited, **rate-limited**) | If `!allowRegistration` → 403. Validate username/password; reject if name collides with an existing user **or** a pending entry; reject if pending count ≥ `MAX_PENDING` (≈200); per-IP limiter; else write pending → `{ ok: true }`. |
| `POST /api/auth/registrations/:username` | **admin-only** | `{action:'approve'}` → `createUserPrehashed(...)` + `quotas[username]=50000` + `saveTeamConfig` + remove pending; `{action:'deny'}` → `markDenied`. Broadcast queue count. |
| `GET /api/auth/registrations` | **admin-only** | List pending (+ recently-denied) for the inbox. (May be folded into the inbox's existing fetch.) |

- `isAdminOnly`: add `/api/auth/registrations` (and `/.../:username`) → admin-only.
  `/api/auth/register` (singular) stays public. The two paths do not prefix-collide
  with each other or with the existing admin-only `/api/auth/users`.
- **Login handler**: on a failed `verifyPassword`, look up the username in the
  pending store and, if found, return a friendly status — `審核中` (pending) or
  `已拒絕` (denied). If absent and the client just registered, "已過期/請重新註冊"
  is the natural fallback. (Transparency was the chosen posture.)

## Frontend

### `Login.tsx`

- When `needsSetup` (first-boot admin creation) → unchanged.
- Otherwise, and when `auth.allowRegistration` is true → show a **Login / Register**
  segmented toggle.
- Register form: username + password + confirm → `POST /api/auth/register`.
  - Success → "註冊已送出,等待管理員批准(24 小時內)"; does **not** auto-login.
  - Failure → inline error (name taken / password too short / rate-limited /
    queue full / registration closed).
- Login failure where the name is pending → show 審核中 / 已拒絕 message.
- `GET /api/auth/status` gains an `allowRegistration` flag so the client knows
  whether to render the Register tab.

### `ProposalInbox.tsx`

- The section fetches agent proposals **and** registrations and renders them
  merged. A registration row: kind chip "註冊", summary "使用者 X 申請帳號",
  requester = username, approve/deny buttons hitting the registrations endpoint.
- Reuse the existing `proposals` WS bump; the pending badge counts agent
  proposals + registrations, and the inbox re-fetches both on bump.

### `TeamPanel.tsx`

- Add an **"開放自助註冊"** checkbox (next to the existing member toggles) wired
  to `Team.allowRegistration` via the existing `POST /api/team` flow.

## Anti-abuse

- **per-IP rate limit** on `/api/auth/register` (`createRegisterLimiter`).
- **Pending-queue hard cap** (`MAX_PENDING` ≈ 200) → reject new registrations
  when full (prevents `pending-registrations.json` from growing unbounded).
- **same-origin + body-size limit**, matching the existing process-spawning /
  config POST protections.
- **`Team.allowRegistration` kill-switch** (default off) so the admin can close
  registration instantly if flooded.
- Honest limitation: a browser has no reliable machine ID. "One machine, one
  registration" is best-effort (per-IP + the human approval gate), not a hard
  guarantee — NAT would make a true per-device rule misfire on real users.

## i18n

- All new UI strings added to both `locales/zh-Hant.json` and `locales/en.json`,
  keeping the catalogs at full key parity (the project's i18n invariant).

## Testing

- **node** (`vitest`): pending store (register / name collision / lazy + swept
  expiry / approve→createUser+quota / deny→retained-until-expiry); register
  endpoint (rate limit / queue cap / `allowRegistration` off); login surfacing
  pending/denied status; approved user can then log in; `createUserPrehashed`
  lands the same hash; `hashPassword` extraction parity.
- **react** (`vitest.react.config.ts`): Login Register tab (submit, success/closed
  states), inbox registration row approve/deny.
- Both vitest configs stay green.

## Hard-invariant compliance

- `pending-registrations.json` lives under `viewer/.auth/` (gitignored) — Invariant #7.
- Plaintext passwords never persisted (hash at register time; `createUserPrehashed`
  lands the hash on approval).
- Team-only: local mode constructs no auth store and is byte-for-byte unchanged.

## Open implementation notes (for the plan)

- Decide whether `GET /api/auth/registrations` is a distinct endpoint or folded
  into the inbox's existing data fetch (minor; either renders identically).
- The `setInterval` sweep must be cleared on server shutdown alongside the other
  timers.
- `verifyPassword` already burns a scrypt round for unknown users (timing); the
  pending lookup for the friendly login message must run **after** that, and must
  not change the timing profile for the "no such account anywhere" case.
