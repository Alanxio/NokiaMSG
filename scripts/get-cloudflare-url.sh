#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT_DIR/.env"
  set +a
fi

if [ -n "${CLOUDFLARE_TUNNEL_HOSTNAME:-}" ]; then
  echo "https://$CLOUDFLARE_TUNNEL_HOSTNAME"
else
  echo "No configurado — falta CLOUDFLARE_TUNNEL_HOSTNAME en .env" >&2
  exit 1
fi
