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
NGROK_PID=""

# ── Parsear argumentos ───────────────────────────────────────────────────────
USE_NGROK=false
USE_CF=false

if [ $# -eq 0 ]; then
  USE_NGROK=true
  USE_CF=true
else
  for arg in "$@"; do
    case "$arg" in
      --ngrok) USE_NGROK=true ;;
      --cf)    USE_CF=true ;;
      *) echo "Uso: $0 [--ngrok] [--cf]" >&2; exit 1 ;;
    esac
  done
fi

# ── Cleanup ──────────────────────────────────────────────────────────────────
cleanup() {
  if [ -n "$NGROK_PID" ] && kill -0 "$NGROK_PID" >/dev/null 2>&1; then
    kill "$NGROK_PID" >/dev/null 2>&1 || true
  fi

  if [ "$USE_CF" = true ]; then
    docker compose stop cloudflared 2>/dev/null || true
  fi

  rm -f "$ROOT_DIR/.ngrok-url" "$ROOT_DIR/.cloudflare-url"
}

trap cleanup EXIT INT TERM

# ── Docker (app + cloudflared si procede) ───────────────────────────
if [ "$USE_CF" = true ]; then
  echo "[expose] Iniciando Docker con cloudflared..."
  docker compose up -d
else
  echo "[expose] Iniciando Docker sin cloudflared..."
  docker compose up -d app
fi

echo "[expose] Esperando a que la app este lista..."
for i in $(seq 1 30); do
  if (echo >/dev/tcp/127.0.0.1/"$APP_PORT") >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! (echo >/dev/tcp/127.0.0.1/"$APP_PORT") >/dev/null 2>&1; then
  echo "[expose] ERROR: La app no respondio en el puerto $APP_PORT." >&2
  exit 1
fi
echo "[expose] App lista en puerto $APP_PORT."

# ── Cloudflare Tunnel (named) ────────────────────────────────────────────────
CF_URL=""
if [ "$USE_CF" = true ]; then
  if [ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ] || [ "$CLOUDFLARE_TUNNEL_TOKEN" = "PON_AQUI_EL_TOKEN_DEL_TUNNEL" ]; then
    echo "[expose] WARNING: Falta CLOUDFLARE_TUNNEL_TOKEN en .env — saltando Cloudflare Tunnel." >&2
    USE_CF=false
  elif [ -z "${CLOUDFLARE_TUNNEL_HOSTNAME:-}" ]; then
    echo "[expose] WARNING: Falta CLOUDFLARE_TUNNEL_HOSTNAME en .env — saltando Cloudflare Tunnel." >&2
    USE_CF=false
  else
    CF_URL="https://$CLOUDFLARE_TUNNEL_HOSTNAME"
    echo "[expose] Cloudflare Tunnel: $CF_URL (named tunnel, URL fija)"
    echo "[expose] Esperando a que cloudflared se conecte..."
    for i in $(seq 1 30); do
      if docker logs cloudflared 2>&1 | grep -q "Registered tunnel connection" 2>/dev/null; then
        echo "[expose] cloudflared conectado."
        break
      fi
      if [ "$i" -eq 30 ]; then
        echo "[expose] WARNING: No se confirmó conexión de cloudflared. Revisa: docker logs cloudflared" >&2
      fi
      sleep 2
    done
    echo "$CF_URL" > "$ROOT_DIR/.cloudflare-url"
  fi
fi

# ── ngrok ────────────────────────────────────────────────────────────────────
if [ "$USE_NGROK" = true ]; then
  if [ ! -x "$NGROK_BIN" ]; then
    echo "[expose] ERROR: No existe ngrok en $NGROK_BIN" >&2
    exit 1
  fi

  if [ -z "${NGROK_AUTHTOKEN:-}" ]; then
    echo "[expose] ERROR: Falta NGROK_AUTHTOKEN en .env" >&2
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

  for i in $(seq 1 30); do
    if curl -s "$NGROK_API" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  TUNNEL_URL=$(curl -s "$NGROK_API" | grep -oP '"public_url"\s*:\s*"\K[^"]+' | head -1 || true)

  if [ -n "$TUNNEL_URL" ]; then
    echo "$TUNNEL_URL" > "$ROOT_DIR/.ngrok-url"
    echo "[expose] ngrok: $TUNNEL_URL"
  elif [ -n "${NGROK_HTTP_URL:-}" ]; then
    echo "$NGROK_HTTP_URL" > "$ROOT_DIR/.ngrok-url"
    echo "[expose] ngrok: $NGROK_HTTP_URL"
  fi
fi

# ── Resumen ──────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "  NokiaMSN expuesto"
echo "═══════════════════════════════════════════"
if [ "$USE_NGROK" = true ] && [ -f "$ROOT_DIR/.ngrok-url" ]; then
  echo "  Nokia 6111:  $(cat "$ROOT_DIR/.ngrok-url")"
fi
if [ "$USE_CF" = true ] && [ -f "$ROOT_DIR/.cloudflare-url" ]; then
  echo "  Opera Mini:  $(cat "$ROOT_DIR/.cloudflare-url")"
fi
echo "═══════════════════════════════════════════"
echo ""

# Mantener vivo
wait ${NGROK_PID:-} 2>/dev/null || true
