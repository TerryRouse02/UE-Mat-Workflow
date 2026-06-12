# Deploying the viewer in team mode

The viewer has two modes, switched by one environment variable:

| | local mode (default) | team mode |
|---|---|---|
| Trigger | `BIND_HOST` unset / loopback | `BIND_HOST=0.0.0.0` (or a LAN address) |
| Bind | `127.0.0.1` only | the given host |
| Auth | none (single user owns the box) | username/password → 7-day token (HttpOnly cookie; `Authorization: Bearer` also accepted for scripts) |
| Roles | — | `admin` / `user` |

Local behavior is untouched by all of this: with no `BIND_HOST`, no auth store
is created and no login screen ever appears.

## Roles

| Capability | user | admin |
|---|---|---|
| Browse graphs, WS live sync, node explain (深入解說) | ✓ | ✓ |
| Import from UE / export to UE clipboard | ✓ | ✓ |
| Read the public **announcement agent session** | ✓ | ✓ |
| Agent chat, sessions, undo, DB-edit approvals | | ✓ |
| Crawls, UE paths, LLM provider/key (`/api/config`) | | ✓ |
| User management (create/delete/reset password) | | ✓ |

The LLM API key is held by the server (`tools/node-t3d-metadata/local.config.json`)
and is never sent to any browser. Team members spend the shared key only
indirectly — through the admin-driven agent and the node-explain endpoint.

## First boot

1. Start with `BIND_HOST=0.0.0.0` (or run the Docker image).
2. Open the URL — the first visitor creates the **admin** account (Setup screen).
3. Add members in **Config → 使用者管理**.
4. To publish an announcement channel: Agent tab → pick a session → **設為公告**.
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
BIND_HOST=0.0.0.0 pnpm start        # macOS / Linux
$env:BIND_HOST='0.0.0.0'; pnpm start  # Windows PowerShell
```

## HTTPS

TLS is the reverse proxy's job — see `Caddyfile` (automatic certificates) or
`nginx.conf` (note the WebSocket upgrade headers and `proxy_buffering off`
for the agent's SSE stream). Once TLS terminates in front, start the viewer
with `COOKIE_SECURE=1` so the auth cookie is marked `Secure`.

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
