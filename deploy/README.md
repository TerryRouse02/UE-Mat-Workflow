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
   Docker: start with `BIND_HOST=0.0.0.0`. On a **public** deploy also set
   `ADMIN_USERNAME` / `ADMIN_PASSWORD` so the admin is created at startup before
   the server accepts a request — otherwise the first visitor claims admin via
   the Setup screen (acceptable on a trusted LAN only).
2. Add members in **Config → 團隊 → 使用者管理**.
3. To publish an announcement channel: Agent tab → pick a session → **設為公告**.
   Members see it read-only in their Agent tab, live.

## Docker (LAN / dev)

```bash
docker build -f deploy/Dockerfile -t ue-mat-viewer .
docker compose -f deploy/docker-compose.lan.yml up -d
```

`docker-compose.lan.yml` publishes 5790 directly and is **LAN-only**. For an
internet deployment use the hardened prod stack below, not this file.

The container cannot run UE crawls (no Unreal install inside). Generate node
DB / MF indexes on a workstation and copy `agent-pack/workmf-index.json` in
via the commented volume mount if your team needs project-MF resolution.

## Continuous deployment (GHCR + a VPS)

For a project that keeps evolving, build once in CI and pull on the VPS — the
VPS never compiles, holds no source, and rolls back by tag. Pieces:

- `.github/workflows/deploy.yml` — after **CI** passes on `main`, builds
  `deploy/Dockerfile` and pushes to GHCR as `:latest` and `:sha-<short>`.
- `deploy/docker-compose.prod.yml` — pulls that image and bundles Caddy
  (automatic HTTPS + security headers). Only 80/443 are published; the viewer's
  5790 stays on the internal network. The viewer runs **non-root, read-only, no
  caps**. Named volumes keep accounts / graphs / sessions / LLM config
  **across updates**. Requires `ADMIN_USERNAME` / `ADMIN_PASSWORD` (admin
  pre-seed) — compose refuses to start without them.
- `deploy/update.sh` — `pull` + `up -d` + prune. `deploy/.env` holds the domain,
  the tag, and the admin credentials.

**Prerequisites on the VPS:** Docker Engine + Compose v2
(`curl -fsSL https://get.docker.com | sudo sh`, then re-login so your user is in
the `docker` group), and inbound **80 + 443** reachable from the internet.

> ⚠️ **Open 80/443 at your cloud provider's security group / firewall — not just
> the in-VM `ufw`.** They are independent layers; if the cloud firewall blocks
> port 80, Let's Encrypt's challenge never reaches Caddy and no certificate is
> issued. This is the #1 cause of "containers are Up but HTTPS won't load". Leave
> 5790 closed (it stays on the internal compose network).

One-time VPS setup:

```bash
# DNS: point an A record (e.g. mat.example.com) at the VPS first.
git clone <repo> && cd <repo>          # or just copy the deploy/ dir
cp deploy/.env.example deploy/.env     # set VIEWER_DOMAIN + ADMIN_USERNAME + ADMIN_PASSWORD
# If the GHCR package is private, authenticate once (PAT with read:packages),
# or make the package public in GitHub → Packages:
#   echo "$GHCR_PAT" | docker login ghcr.io -u <github-user> --password-stdin
./deploy/update.sh
```

The admin account is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD` **before**
the server accepts a request, so there is no first-visitor race to win — just
log in with those credentials at `https://<your domain>` and add members.

### Day-2 maintenance

**Ship an update** — three steps:

1. Merge your change to `main`.
2. Wait for GitHub **Actions** to go green (**CI** → **Deploy image**); the new
   image lands on GHCR as `:latest` and `:sha-<commit>`.
3. On the VPS, one line:

   ```bash
   cd <repo> && git pull && ./deploy/update.sh
   ```

`update.sh` does `pull` + `up -d` + image prune — it only swaps the image.
Accounts, graphs, sessions, the LLM key, and Caddy's certs live in named volumes
and **survive every update**. `git pull` is strictly needed only when the
`deploy/` config itself changed (compose / Caddyfile / `update.sh`), but running
it every time is the safe habit — `.env` is gitignored, so it is never clobbered.
(`deploy.yml` must already be on `main` for the post-CI trigger to fire.)

**Roll back** to a known-good build (sha tags are immutable):

```bash
IMAGE_TAG=sha-abc1234 ./deploy/update.sh
```

**Handy alias + common ops** (optional — adjust the path to your clone):

```bash
echo "alias mat='docker compose --env-file ~/<repo>/deploy/.env -f ~/<repo>/deploy/docker-compose.prod.yml'" >> ~/.bashrc && source ~/.bashrc
mat ps                       # are both containers Up?
mat logs -f ue-mat-viewer    # app logs
mat logs -f caddy            # certificate / reverse-proxy logs
mat restart ue-mat-viewer    # restart just the viewer
```

**Health check after an update:**

```bash
mat ps
curl -sI https://<your domain> | head -1   # "HTTP/2 200" = good
```

> Secrets at rest: the LLM key (`local.config.json`) and the auth store live in
> Docker named volumes as plain files on the VPS disk. Password hashes are scrypt
> and tokens are stored only as SHA-256 digests (a stolen `tokens.json` cannot be
> replayed), but the **LLM key is plaintext** — anyone with disk/snapshot access
> to the VPS can read it. Restrict host access and rotate the key if the box is
> ever exposed.

## Bare metal (workstation with UE installed)

Team mode also runs directly on a Windows/macOS workstation — this is the only
setup where the admin can trigger crawls from the Config tab:

```bash
pnpm start          # then: Config → 團隊 → 啟用團隊模式 (no env var needed)
```

### Windows LAN HTTPS helper

On a Windows workstation, prefer the maintained Traditional Chinese helper
instead of editing Caddy, firewall, certificate, and scheduled-task settings by
hand:

```text
Double-click tools\viewer-https\Manage-ViewerHttps.bat
```

The BAT launcher requests administrator access once and keeps the final result
visible. Advanced command-line maintenance remains available through:

```powershell
.\tools\viewer-https\Manage-ViewerHttps.ps1
```

It supports `install`, `status`, `restart`, `update`, `change-address`,
`export-cert`, and `uninstall`. Machine-specific files are stored under
`%ProgramData%\UE-Mat-Caddy`; the CA private key is never written into the repo
or distributed to members.

After a successful install, members visit the existing HTTP team URL. The
viewer displays a Traditional Chinese HTTPS setup page and serves one
`Install-UE-Mat-HTTPS.cmd` file. Running that file with UAC approval installs
the public root certificate, updates the marked `hosts` entry when hostname
mode is used, and opens the HTTPS viewer.

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
