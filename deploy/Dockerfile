# deploy/Dockerfile — team-mode viewer image (platform-agnostic).
#
# Build from the REPO ROOT so the whole workspace is in context:
#   docker build -f deploy/Dockerfile -t ue-mat-viewer .
#
# Notes:
# - The container serves the viewer + agent only. UE crawls need a real
#   Unreal install and therefore run on a workstation, never in this image
#   (the env probe keeps the crawl buttons disabled here).
# - BIND_HOST=0.0.0.0 switches the server into team mode (login + roles).
#   On a public deploy set ADMIN_USERNAME/ADMIN_PASSWORD so the admin is
#   pre-seeded at startup (closes the first-visitor-admin race); otherwise the
#   first visitor creates the admin via the Setup screen (LAN/dev only).
# - Persist the volumes listed in docker-compose.prod.yml or team accounts,
#   agent sessions, and the LLM config vanish with the container.

# ── build stage ──────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY viewer/package.json viewer/package.json
COPY viewer/web/package.json viewer/web/package.json
RUN pnpm install --frozen-lockfile
COPY viewer viewer
COPY agent-pack agent-pack
RUN pnpm build

# ── runtime stage ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0
WORKDIR /app
RUN corepack enable

# Workspace manifests + production deps only (ws, chokidar).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY viewer/package.json viewer/package.json
COPY viewer/web/package.json viewer/web/package.json
RUN pnpm install --frozen-lockfile --prod

# Built server + SPA, and the public agent-pack data.
COPY --from=build /app/viewer/dist viewer/dist
COPY --from=build /app/viewer/web/dist viewer/web/dist
COPY agent-pack agent-pack

# repo-root detection needs tools/node-t3d-metadata to exist; graphs/ is the
# shared team workspace (mount it). local.config.json (LLM key) lives in the
# tools dir — mount that too.
RUN mkdir -p tools/node-t3d-metadata graphs \
    viewer/.auth viewer/.agent-sessions viewer/.agent-checkpoints viewer/.agent-memory

# Run unprivileged. chown only the writable mountpoints so fresh named volumes
# (which inherit the mountpoint's ownership on first mount) stay writable by this
# uid; the rest of the image is root-owned and can be mounted read-only (see
# docker-compose.prod.yml). A popped Node process is then non-root with no caps.
RUN groupadd --system --gid 1001 appgroup \
 && useradd --system --uid 1001 --gid appgroup --no-create-home appuser \
 && chown -R appuser:appgroup tools/node-t3d-metadata graphs \
    viewer/.auth viewer/.agent-sessions viewer/.agent-checkpoints viewer/.agent-memory
USER appuser

EXPOSE 5790
CMD ["node", "viewer/dist/server/index.js"]
