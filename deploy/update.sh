#!/usr/bin/env bash
# Pull the latest CI-built image from GHCR and (re)start the prod stack.
# Data volumes (accounts, graphs, sessions, LLM config, Caddy certs) persist —
# an update only swaps the image.
#
#   ./deploy/update.sh                       # follow :latest
#   IMAGE_TAG=sha-abc1234 ./deploy/update.sh # pin / roll back to a build
#
# Requires deploy/.env (copy from deploy/.env.example) with VIEWER_DOMAIN set.
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE="deploy/.env"
COMPOSE_FILE="deploy/docker-compose.prod.yml"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE — copy deploy/.env.example to deploy/.env and set VIEWER_DOMAIN" >&2
  exit 1
fi

compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

compose pull
compose up -d
docker image prune -f
compose ps
