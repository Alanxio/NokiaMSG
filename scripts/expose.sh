#!/usr/bin/env bash
# El despliegue y la exposición pública de NokiaMSN viven en GateWayNK: Docker Compose
# con Gateway + nokia-tls + resto de servicios, túnel HTTP (ngrok) y HTTPS
# del Nokia 6111 (playit.gg / ngrok TCP). Este script solo redirige allí con los mismos
# argumentos (p. ej. «npm run expose -- --https»).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATEWAYNK_DIR="${GATEWAYNK_DIR:-$ROOT_DIR/../GateWayNK}"
TARGET="$GATEWAYNK_DIR/scripts/expose.sh"

if [ ! -x "$TARGET" ]; then
  echo "No encuentro $TARGET (define GATEWAYNK_DIR si GateWayNK está en otra ruta)." >&2
  exit 1
fi
exec "$TARGET" "$@"
