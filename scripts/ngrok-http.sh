#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

NGROK_BIN="$ROOT_DIR/bin/ngrok"
APP_PORT="${PORT:-8080}"
NGROK_API="http://127.0.0.1:4040/api/tunnels"
POLICY_FILE="$ROOT_DIR/ngrok-policy.yml"

if [ ! -x "$NGROK_BIN" ]; then
  echo "No existe el binario de ngrok en $NGROK_BIN" >&2
  exit 1
fi

if [ -z "${NGROK_AUTHTOKEN:-}" ]; then
  echo "Falta NGROK_AUTHTOKEN en .env o en el entorno." >&2
  exit 1
fi

ARGS=(http "$APP_PORT" --authtoken "$NGROK_AUTHTOKEN" --log stdout)

if [ -f "$POLICY_FILE" ]; then
  ARGS+=(--traffic-policy-file "$POLICY_FILE")
fi

if [ -n "${NGROK_HTTP_URL:-}" ]; then
  ARGS+=(--url "$NGROK_HTTP_URL")
fi

"$NGROK_BIN" "${ARGS[@]}" &
NGROK_PID=$!

# Esperar a que ngrok abra su API local
for i in $(seq 1 30); do
  if curl -s "$NGROK_API" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Obtener la URL pública del túnel
TUNNEL_URL=$(curl -s "$NGROK_API" | grep -oP '"public_url"\s*:\s*"\K[^"]+' | head -1 || true)

if [ -n "$TUNNEL_URL" ]; then
  echo "$TUNNEL_URL" > "$ROOT_DIR/.ngrok-url"
  echo "[ngrok] Túnel activo: $TUNNEL_URL" >&2
  echo "[ngrok] URL guardada en .ngrok-url" >&2
else
  echo "[ngrok] No se pudo obtener la URL del túnel automáticamente." >&2
  if [ -n "${NGROK_HTTP_URL:-}" ]; then
    echo "[ngrok] Usando NGROK_HTTP_URL de .env: $NGROK_HTTP_URL" >&2
    echo "$NGROK_HTTP_URL" > "$ROOT_DIR/.ngrok-url"
  fi
fi

wait "$NGROK_PID"
