# Deploying the viewer in team mode

The viewer has two modes:

| | local mode (default) | team mode |
|---|---|---|
| Bind | `127.0.0.1` only | a non-loopback host (e.g. `0.0.0.0`) |
| Auth | none (single user owns the box) | username/password → 7-day token (HttpOnly cookie; `Authorization: Bearer` also accepted for scripts) |
| Roles | — | `admin` / `user` |

**The normal way to switch is in the browser**: Config tab → 團隊 sub-tab →
啟用團隊模式. The form creates the admin account in the same request (so the
server is never exposed unauthenticated), live re-binds the listener on the
same port — no restart, no terminal — and shows the URLs to share with the
team. Disabling re-binds back to loopback and keeps the accounts for next time.

`BIND_HOST` (and `COOKIE_SECURE=1`) still work as environment variables for
Docker/scripted deployments; when set, the mode is **locked** and the web
switch is disabled. The web-saved settings persist as the `Team` object in
`tools/node-t3d-metadata/local.config.json`.

Local behavior is untouched by all of this: while in local mode, no auth store
is active and no login screen ever appears.

## Roles

| Capability | user | admin |
|---|---|---|
| Browse graphs, WS live sync, node explain (深入解說) | ✓ | ✓ |
| Import from UE / export to UE clipboard | ✓ | ✓ |
| Read the public **announcement agent session** | ✓ | ✓ |
| Change own password (Config → 我的帳號) | ✓ | ✓ |
| Own private agent sessions | opt-in¹ | ✓ |
| Crawl / DB-edit approvals, announce a session | | ✓ |
| Crawls, UE paths, LLM provider/key (`/api/config`) | | ✓ |
| User management (create/delete/reset password) | | ✓ |

¹ Config → 團隊 → 「允許成員使用 AI 助手」(default off — member chats spend
the shared key; per-user daily token quotas live in 使用者管理). Member
sessions are owner-isolated (admins read all of them, with per-session token
totals and a usage dashboard); member crawl/DB-edit proposals divert into the
admin **approval inbox** (Config → 團隊) and the outcome is reported back into
the member's session. Sessions stream **in parallel**.

**Personal workspaces**: `graphs/users/<username>/` is each member's own area
— other members never see it (admins do); imports can target it, and a
member's agent cannot write into someone else's. Everything else under
`graphs/` stays the shared team workspace.

**系統主Agent**: the admin designates one session (Agent tab → 設為主Agent);
every member watches it live (delta streaming) read-only in their Agent tab.
The 團隊 panel also shows who is online.

The LLM API key is held by the server (`tools/node-t3d-metadata/local.config.json`)
and is never sent to any browser. Team members spend the shared key only
indirectly — through the admin-driven agent and the node-explain endpoint.

## First boot

1. Desktop: enable from **Config → 團隊** (creates the admin inline).
   Docker: start with `BIND_HOST=0.0.0.0` — the first visitor then creates the
   admin via the Setup screen.
2. Add members in **Config → 團隊 → 使用者管理**.
3. To publish an announcement channel: Agent tab → pick a session → **設為公告**.
   Members see it read-only in their Agent tab, live.

## Docker

```bash
docker build -f deploy/Dockerfile -t ue-mat-viewer .
docker compose -f deploy/docker-compose.yml up -d
```

The container cannot run UE crawls (no Unreal install inside). Generate node
DB / MF indexes on a workstation and copy `agent-pack/workmf-index.json` in
via the commented volume mount if your team needs project-MF resolution.

## Bare metal (workstation with UE installed)

Team mode also runs directly on a Windows/macOS workstation — this is the only
setup where the admin can trigger crawls from the Config tab:

```bash
pnpm start          # then: Config → 團隊 → 啟用團隊模式 (no env var needed)
```

## HTTPS

TLS is the reverse proxy's job — see `Caddyfile` (automatic certificates) or
`nginx.conf` (note the WebSocket upgrade headers and `proxy_buffering off`
for the agent's SSE stream). Once TLS terminates in front, start the viewer
with `COOKIE_SECURE=1` (or tick the Secure-cookie box in Config → 團隊) so the
auth cookie is marked `Secure`.

Without a proxy, plain-HTTP team mode is acceptable **only on a trusted LAN**:
the login password and cookie travel unencrypted.

## What is stored where

| Path | Contents | Commit-safe? |
|---|---|---|
| `viewer/.auth/users.json` | usernames, scrypt password hashes, roles | gitignored — never commit |
| `viewer/.auth/tokens.json` | sha256 digests of active tokens + expiry | gitignored — never commit |
| `viewer/.agent-sessions/` | agent conversations (+ `.public-session.json` pointer) | gitignored |
| `tools/node-t3d-metadata/local.config.json` | UE paths + LLM key | gitignored |
| `graphs/` | the shared team workspace | yours to manage |

Rate limiting: 10 failed logins per IP per 10 minutes → `429`. Deleting a user
or resetting a password revokes that user's tokens immediately.
