#!/usr/bin/env bash
# NokiaMSN por su cuenta, sin GateWayNK: arranca la app con Docker Compose y la expone a
# Internet para el Nokia 6111.
#   · HTTP en claro  → ngrok HTTP                          → nokia-msn:3001
#   · HTTPS del 6111 → playit.gg / ngrok TCP → nokia-tls:8443 → nokia-msn:3001
# La configuración va toda en el .env de NokiaMSN (ver .env.example, sección «Arranque
# sin GateWayNK»). Los contenedores siguen en marcha al cerrar la terminal.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
NGROK_DIR="$ROOT_DIR/.ngrok"
NGROK_CONFIG_FILE="$NGROK_DIR/ngrok.yml"
TLS_DIR="$ROOT_DIR/data/tls"
TLS_ADDRESS_FILE="$TLS_DIR/public-address"
TLS_NOTIFIED_FILE="$TLS_DIR/last-notified-address"
APP_CONTAINER="nokiamsn-app"
TLS_CONTAINER="nokiamsn-tls"
NGROK_CONTAINER="nokiamsn-ngrok"

COMMAND="up"
BUILD=true
FOLLOW=false
TUNNELS_ARG=""   # http | https | both | local (por flag; si no, EXPOSE_TUNNELS del .env)
EXTRA_ARGS=()

usage() {
  cat <<EOF
Uso: $(basename "$0") [comando] [opciones]

Comandos:
  up (por defecto)   Construye, arranca y expone NokiaMSN.
  status             Estado de los contenedores y de las entradas públicas.
  logs [servicio…]   Sigue los logs (nokia-msn, nokia-tls, ngrok). Ctrl+C para salir.
  restart [servicio…] Reinicia los servicios indicados (o todos).
  pin                Cambia el PIN de acceso desde el Nokia (lo guarda cifrado en .env).
  stop               Para todo.

Opciones de «up»:
  --http        Solo la entrada HTTP en claro (ngrok).
  --https       Solo el HTTPS del Nokia (TLS 1.0, nokia-tls).
  --both        Las dos.
  --local       Sin túneles: solo http://127.0.0.1:\${NOKIA_MSN_PORT:-3001}/
                Sin flag: EXPOSE_TUNNELS del .env (http|https|both|local), o «both».
  --no-build    No reconstruye las imágenes (por defecto se reconstruye lo que cambió).
  -f, --follow  Al terminar, se queda mostrando los logs de la app.

El HTTPS del Nokia lo lleva NOKIA_TLS_PROVIDER (ngrok | playit) del .env.
EOF
}

if [ $# -gt 0 ]; then
  case "$1" in
    up|status|logs|restart|pin|stop) COMMAND="$1"; shift ;;
  esac
fi
for arg in "$@"; do
  case "$arg" in
    --http|--https|--both|--local) TUNNELS_ARG="${arg#--}" ;;
    --no-build)  BUILD=false ;;
    -f|--follow) FOLLOW=true ;;
    -h|--help)   usage; exit 0 ;;
    -*) echo "Opción desconocida: $arg" >&2; usage >&2; exit 1 ;;
    *)
      if [ "$COMMAND" = "logs" ] || [ "$COMMAND" = "restart" ]; then
        EXTRA_ARGS+=("$arg")
      else
        echo "Argumento inesperado: $arg" >&2; usage >&2; exit 1
      fi ;;
  esac
done

# ── Salida ─────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
  CLEAR_LINE=$'\r\033[K'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; CLEAR_LINE=''
fi
log_step() { printf '\n%s%s▶ %s%s\n' "$C_BOLD" "$C_CYAN" "$1" "$C_RESET"; }
log_ok()   { printf '  %s✔%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
log_warn() { printf '  %s⚠%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
log_err()  { printf '  %s✘%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; }
log_info() { printf '  %s%s%s\n' "$C_DIM" "$1" "$C_RESET"; }
fail() { log_err "$1"; exit 1; }

on_error() {
  local code=$? line=$1
  log_err "Fallo inesperado en la línea ${line} (código ${code}): ${BASH_COMMAND}"
}
trap 'on_error $LINENO' ERR
trap 'printf "%s\n" "$CLEAR_LINE"; log_warn "Interrumpido. Lo ya arrancado sigue en marcha ($(basename "$0") stop para pararlo)."; exit 130' INT TERM

cd "$ROOT_DIR"

# ── Configuración (.env) ───────────────────────────────────────────────────
# No se hace «source» del .env: el hash del PIN lleva «$» y otros valores llevan
# espacios. Se lee solo lo necesario, quitando comillas.
env_get() { # $1 = clave, $2 = valor por defecto
  local line value
  line="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" 2>/dev/null | tail -1 || true)"
  if [ -z "$line" ]; then printf '%s' "${2:-}"; return; fi
  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "$value" =~ ^\'(.*)\'$ ]] || [[ "$value" =~ ^\"(.*)\"$ ]]; then value="${BASH_REMATCH[1]}"; fi
  printf '%s' "$value"
}

if [ ! -f "$ENV_FILE" ]; then
  [ -f "$ENV_EXAMPLE" ] || fail "Falta $ENV_FILE (y no hay .env.example para copiarlo)."
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log_warn "No había .env: copiado de .env.example. Revísalo y pon tu PIN con: $(basename "$0") pin"
fi

NOKIA_MSN_PORT="$(env_get NOKIA_MSN_PORT 3001)"
NOKIA_TLS_PORT="$(env_get NOKIA_TLS_PORT 8443)"
NGROK_API_PORT="$(env_get NGROK_API_PORT 4045)"
NGROK_AUTHTOKEN="$(env_get NGROK_AUTHTOKEN)"
NGROK_HTTP_URL="$(env_get NGROK_HTTP_URL)"
NOKIA_TLS_PROVIDER="$(env_get NOKIA_TLS_PROVIDER ngrok)"
NOKIA_TLS_PUBLIC_ADDRESS="$(env_get NOKIA_TLS_PUBLIC_ADDRESS)"
NGROK_START_TIMEOUT="$(env_get NGROK_START_TIMEOUT 40)"
# Placeholder de .env.example: no es un dominio real.
case "$NGROK_HTTP_URL" in *tu-dominio*) NGROK_HTTP_URL="" ;; esac
export NOKIA_MSN_PORT NOKIA_TLS_PORT NGROK_API_PORT NGROK_AUTHTOKEN

[ -n "$TUNNELS_ARG" ] || TUNNELS_ARG="$(env_get EXPOSE_TUNNELS both)"
case "$TUNNELS_ARG" in
  http)  HTTP_ENABLED=true;  TLS_ENABLED=false ;;
  https) HTTP_ENABLED=false; TLS_ENABLED=true ;;
  both)  HTTP_ENABLED=true;  TLS_ENABLED=true ;;
  local) HTTP_ENABLED=false; TLS_ENABLED=false ;;
  *) fail "EXPOSE_TUNNELS / flag no válido: '$TUNNELS_ARG' (usa http, https, both o local)" ;;
esac
case "$NOKIA_TLS_PROVIDER" in
  ngrok|playit) ;;
  *) fail "NOKIA_TLS_PROVIDER no válido: '$NOKIA_TLS_PROVIDER' (usa ngrok o playit)" ;;
esac
is_host_port() { printf '%s' "$1" | grep -qE '^[A-Za-z0-9.-]+:[0-9]{1,5}$'; }

# ── Docker ─────────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || fail "docker no está instalado o no está en el PATH."
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose -f "$COMPOSE_FILE")
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose -f "$COMPOSE_FILE")
else
  fail "Falta Docker Compose (docker compose)."
fi
docker info >/dev/null 2>&1 || fail "No se puede hablar con Docker (¿está arrancado? ¿tu usuario está en el grupo docker?)."
DC_ALL=("${DC[@]}" --profile tls --profile ngrok)

# Nombre del servicio de compose a partir del contenedor.
service_name() { case "$1" in "$APP_CONTAINER") echo nokia-msn ;; "$TLS_CONTAINER") echo nokia-tls ;; *) echo ngrok ;; esac; }

container_running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]; }
inspect_container() { # → "estado salud reinicios"
  docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' "$1" 2>/dev/null \
    || echo "missing none 0"
}
show_logs() { # $1 = servicio, $2 = líneas
  "${DC_ALL[@]}" logs --no-color --no-log-prefix --tail "${2:-25}" "$1" 2>&1 | sed "s/^/    ${C_DIM}│${C_RESET} /" || true
}

http_get() { # $1 = URL → cuerpo (vacío si falla)
  if command -v curl >/dev/null 2>&1; then curl -fsS -m 3 "$1" 2>/dev/null || true
  else wget -q -T 3 -O - "$1" 2>/dev/null || true; fi
}

# URL pública de ngrok: $1 = http | tcp
ngrok_tunnel_url() {
  local urls
  urls="$(http_get "http://127.0.0.1:${NGROK_API_PORT}/api/tunnels" | grep -oE '"public_url":"[^"]+"' | cut -d'"' -f4 || true)"
  if [ "$1" = "tcp" ]; then
    printf '%s\n' "$urls" | grep -m1 '^tcp://' || true
  else
    # Con http+https hay dos URLs del mismo túnel: la http:// es la del Nokia.
    { printf '%s\n' "$urls" | grep '^http://'; printf '%s\n' "$urls" | grep '^https://'; } | head -1 || true
  fi
}

whatsapp_status() {
  http_get "http://127.0.0.1:${NOKIA_MSN_PORT}/healthz" | grep -oE '"status":"[^"]*"' | head -1 | cut -d'"' -f4 || true
}

# ── Subcomandos sencillos ──────────────────────────────────────────────────
cmd_status() {
  printf '%sContenedores%s\n' "$C_BOLD" "$C_RESET"
  "${DC_ALL[@]}" ps -a --format 'table {{.Service}}\t{{.Status}}' 2>/dev/null || true
  printf '\n%sEntradas%s\n' "$C_BOLD" "$C_RESET"
  printf '  %-13s http://127.0.0.1:%s/\n' "Local:" "$NOKIA_MSN_PORT"
  local wa http_url tcp_url
  wa="$(whatsapp_status)"
  printf '  %-13s %s\n' "WhatsApp:" "${wa:-(sin respuesta)}"
  if container_running "$NGROK_CONTAINER"; then
    http_url="$(ngrok_tunnel_url http)"; tcp_url="$(ngrok_tunnel_url tcp)"
    [ -n "$http_url" ] && printf '  %-13s %s\n' "HTTP:" "$http_url"
    [ -n "$tcp_url" ] && printf '  %-13s %s\n' "ngrok TCP:" "$tcp_url"
  fi
  if [ -f "$TLS_ADDRESS_FILE" ] && container_running "$TLS_CONTAINER"; then
    printf '  %-13s https://%s/  (%s)\n' "Nokia HTTPS:" "$(cat "$TLS_ADDRESS_FILE")" "$NOKIA_TLS_PROVIDER"
    # ngrok da otra dirección TCP cada vez que se reinicia: avisar si ya no coincide.
    if [ "$NOKIA_TLS_PROVIDER" = "ngrok" ] && [ -n "${tcp_url:-}" ] && [ "${tcp_url#tcp://}" != "$(cat "$TLS_ADDRESS_FILE")" ]; then
      printf '  %s⚠ ngrok ha cambiado de dirección (%s): vuelve a ejecutar «%s up».%s\n' "$C_YELLOW" "${tcp_url#tcp://}" "$(basename "$0")" "$C_RESET"
    fi
  fi
}

cmd_pin() {
  local pin pin2 hash
  [ -t 0 ] || fail "«pin» necesita una terminal para pedir el PIN."
  read -r -s -p "Nuevo PIN (solo lo que teclearás en el Nokia): " pin; printf '\n'
  read -r -s -p "Repítelo: " pin2; printf '\n'
  [ -n "$pin" ] || fail "PIN vacío."
  [ "$pin" = "$pin2" ] || fail "No coinciden."
  log_info "Generando el hash (con la imagen de NokiaMSN; la primera vez se construye)…"
  "${DC[@]}" build nokia-msn >/dev/null
  # El PIN entra por la entrada estándar: no aparece en la lista de procesos.
  hash="$(printf '%s' "$pin" | "${DC[@]}" run --rm --no-deps -T --entrypoint node nokia-msn \
    -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(require('bcryptjs').hashSync(s,10)))" | tail -1)"
  [[ "$hash" =~ ^\$2[aby]\$ ]] || fail "No se pudo generar el hash."
  local tmp; tmp="$(mktemp "$ROOT_DIR/.env.XXXXXX")"
  grep -vE '^[[:space:]]*ACCESS_PIN_HASH_BCRYPT=' "$ENV_FILE" > "$tmp" || true
  printf "ACCESS_PIN_HASH_BCRYPT='%s'\n" "$hash" >> "$tmp"
  chmod --reference="$ENV_FILE" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  log_ok "PIN guardado en .env."
  # «restart» no vuelve a leer el .env (env_file): hay que recrear el contenedor.
  if container_running "$APP_CONTAINER"; then
    "${DC[@]}" up -d --no-deps --force-recreate nokia-msn >/dev/null 2>&1 \
      && log_ok "NokiaMSN reiniciado para usar el PIN nuevo." \
      || log_warn "No se pudo reiniciar NokiaMSN: hazlo con «$(basename "$0") up»."
  fi
}

case "$COMMAND" in
  status)  cmd_status; exit 0 ;;
  logs)    trap - INT; "${DC_ALL[@]}" logs -f --tail 100 "${EXTRA_ARGS[@]}"; exit 0 ;;
  restart) "${DC_ALL[@]}" restart "${EXTRA_ARGS[@]}"; exit 0 ;;
  pin)     cmd_pin; exit 0 ;;
  stop)
    log_step "Parando NokiaMSN"
    "${DC_ALL[@]}" down
    # Una dirección TCP de ngrok deja de existir al pararlo; la de playit es fija.
    if [ "$NOKIA_TLS_PROVIDER" = "ngrok" ]; then rm -f "$TLS_ADDRESS_FILE"; fi
    log_ok "Parado."
    exit 0 ;;
esac

# ════════════════════════════════════════════════════════════════════════════
# up
# ════════════════════════════════════════════════════════════════════════════
log_step "Comprobando la configuración"
# Creadas como este usuario antes de que Docker las cree como root.
mkdir -p "$ROOT_DIR/data" "$TLS_DIR" "$ROOT_DIR/.wwebjs_auth" "$ROOT_DIR/public/media" "$NGROK_DIR"

if grep -qE "^[[:space:]]*ACCESS_PIN_HASH_BCRYPT=.*cambia\.esto" "$ENV_FILE" || [ -z "$(env_get ACCESS_PIN_HASH_BCRYPT)" ]; then
  log_warn "Aún no hay PIN de acceso: no podrás entrar desde el Nokia. Ponlo con: $(basename "$0") pin"
else
  log_ok "PIN de acceso configurado"
fi

NGROK_HTTP="$HTTP_ENABLED"
NGROK_TLS=false
if [ "$TLS_ENABLED" = "true" ] && [ "$NOKIA_TLS_PROVIDER" = "ngrok" ]; then NGROK_TLS=true; fi
if [ "$NGROK_HTTP" = "true" ] || [ "$NGROK_TLS" = "true" ]; then
  if [ -z "$NGROK_AUTHTOKEN" ]; then
    log_warn "Falta NGROK_AUTHTOKEN en .env: sin túneles de ngrok (https://dashboard.ngrok.com/get-started/your-authtoken)."
    NGROK_HTTP=false; NGROK_TLS=false
  else
    log_ok "ngrok configurado"
  fi
fi
if [ "$TLS_ENABLED" = "true" ] && [ "$NOKIA_TLS_PROVIDER" = "playit" ] && ! is_host_port "$NOKIA_TLS_PUBLIC_ADDRESS"; then
  log_warn "Con NOKIA_TLS_PROVIDER=playit hace falta NOKIA_TLS_PUBLIC_ADDRESS=host:puerto en .env: sin HTTPS."
  TLS_ENABLED=false
fi
if [ "$TLS_ENABLED" = "true" ] && [ "$NOKIA_TLS_PROVIDER" = "ngrok" ] && [ "$NGROK_TLS" != "true" ]; then
  TLS_ENABLED=false
fi
NGROK_NEEDED=false
if [ "$NGROK_HTTP" = "true" ] || [ "$NGROK_TLS" = "true" ]; then NGROK_NEEDED=true; fi

PROFILES=()
[ "$TLS_ENABLED" = "true" ] && PROFILES+=(--profile tls)
[ "$NGROK_NEEDED" = "true" ] && PROFILES+=(--profile ngrok)

# ── Construcción ───────────────────────────────────────────────────────────
if [ "$BUILD" = "true" ]; then
  log_step "Construyendo imágenes (la primera vez tarda unos minutos)"
  "${DC[@]}" "${PROFILES[@]}" build || fail "Ha fallado la construcción (el error de Docker está justo encima)."
  log_ok "Imágenes al día"
fi

# ── Raíz TLS del Nokia ─────────────────────────────────────────────────────
# Se crea UNA vez y no se toca nunca más: es la que se instala en el teléfono. Mismos
# parámetros que entiende el 6111: RSA 2048, firma SHA-1, CA válida 10 años.
if [ "$TLS_ENABLED" = "true" ]; then
  if [ -f "$TLS_DIR/ca.pem" ] && [ -f "$TLS_DIR/ca.key" ] && [ -f "$TLS_DIR/ca.cer" ]; then
    log_ok "Raíz TLS del Nokia: $TLS_DIR/ca.pem"
  elif [ -e "$TLS_DIR/ca.pem" ] || [ -e "$TLS_DIR/ca.key" ]; then
    fail "La raíz TLS está incompleta en $TLS_DIR (falta ca.pem, ca.key o ca.cer). No se regenera para no invalidar la del teléfono: revísalo a mano."
  else
    log_step "Creando la raíz TLS del Nokia (solo esta vez)"
    "${DC[@]}" --profile tls run --rm --no-deps -T --user "$(id -u):$(id -g)" --entrypoint sh nokia-tls -c '
      set -e
      cd /tls
      openssl req -x509 -newkey rsa:2048 -nodes -sha1 -days 3650 \
        -keyout ca.key -out ca.pem -subj "/CN=NokiaMSN Root CA/O=NokiaMSN" \
        -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
      openssl x509 -in ca.pem -outform der -out ca.cer
      chmod 600 ca.key
    ' || fail "No se pudo crear la raíz TLS."
    log_ok "Raíz creada en $TLS_DIR (ca.pem / ca.key / ca.cer). Haz copia de ca.key: sin ella hay que reinstalar la raíz en el teléfono."
  fi
  # playit: la dirección es fija y nokia-tls la necesita al arrancar para su certificado.
  if [ "$NOKIA_TLS_PROVIDER" = "playit" ]; then echo "$NOKIA_TLS_PUBLIC_ADDRESS" > "$TLS_ADDRESS_FILE"; fi
fi

# ── Configuración de ngrok (sin secretos: el token va por variable de entorno) ───────
write_ngrok_config() { # $1 = túnel HTTP, $2 = túnel TCP del Nokia
  {
    echo 'version: "2"'
    echo 'web_addr: 0.0.0.0:4040'
    echo 'tunnels:'
    if [ "$1" = "true" ]; then
      echo '  nokiamsn:'
      echo '    proto: http'
      echo '    addr: nokia-msn:3001'
      if [ -n "$NGROK_HTTP_URL" ]; then
        echo "    domain: $(printf '%s' "$NGROK_HTTP_URL" | sed -E 's#^[a-z]+://##; s#/.*$##')"
      fi
      # Sin esto ngrok solo abre https:// (TLS moderno que el 6111 no entiende).
      echo '    schemes:'
      echo '      - http'
      echo '      - https'
    fi
    if [ "$2" = "true" ]; then
      # Sin proxy_proto: la cuenta gratuita no lo permite y tumbaría la sesión entera.
      echo '  nokia-tls:'
      echo '    proto: tcp'
      echo '    addr: nokia-tls:8443'
    fi
  } > "$NGROK_CONFIG_FILE"
  chmod 644 "$NGROK_CONFIG_FILE"
}
NGROK_CONFIG_CHANGED=false
if [ "$NGROK_NEEDED" = "true" ]; then
  old_config="$(cat "$NGROK_CONFIG_FILE" 2>/dev/null || true)"
  write_ngrok_config "$NGROK_HTTP" "$NGROK_TLS"
  [ "$old_config" = "$(cat "$NGROK_CONFIG_FILE")" ] || NGROK_CONFIG_CHANGED=true
fi

# ── Arranque ───────────────────────────────────────────────────────────────
log_step "Arrancando"
NGROK_WAS_RUNNING=false
container_running "$NGROK_CONTAINER" && NGROK_WAS_RUNNING=true
"${DC[@]}" "${PROFILES[@]}" up -d --remove-orphans || fail "docker compose up ha fallado (el error está justo encima)."
# Lo que esta vez no hace falta (p. ej. pasar de --both a --http) se para.
if [ "$TLS_ENABLED" != "true" ] && docker inspect "$TLS_CONTAINER" >/dev/null 2>&1; then
  "${DC_ALL[@]}" rm -sf nokia-tls >/dev/null 2>&1 || true
  rm -f "$TLS_ADDRESS_FILE"
fi
if [ "$NGROK_NEEDED" != "true" ] && docker inspect "$NGROK_CONTAINER" >/dev/null 2>&1; then
  "${DC_ALL[@]}" rm -sf ngrok >/dev/null 2>&1 || true
fi
if [ "$NGROK_WAS_RUNNING" = "true" ] && [ "$NGROK_CONFIG_CHANGED" = "true" ]; then
  log_info "La configuración de ngrok ha cambiado: reiniciándolo."
  docker restart "$NGROK_CONTAINER" >/dev/null
fi
log_ok "Contenedores en marcha"

# ── Espera a que estén sanos ───────────────────────────────────────────────
log_step "Esperando a que estén listos"
WAIT=("$APP_CONTAINER")
[ "$TLS_ENABLED" = "true" ] && WAIT+=("$TLS_CONTAINER")
[ "$NGROK_NEEDED" = "true" ] && WAIT+=("$NGROK_CONTAINER")
declare -A RESTARTS0=()
for c in "${WAIT[@]}"; do read -r _ _ r <<<"$(inspect_container "$c")"; RESTARTS0[$c]="$r"; done
FAILED=()
PENDING=("${WAIT[@]}")
START="$(date +%s)"
while [ "${#PENDING[@]}" -gt 0 ]; do
  elapsed=$(( $(date +%s) - START ))
  still=()
  for c in "${PENDING[@]}"; do
    read -r state health restarts <<<"$(inspect_container "$c")"
    svc="$(service_name "$c")"
    if [ "$state" = "running" ] && { [ "$health" = "healthy" ] || [ "$health" = "none" ]; }; then
      printf '%s' "$CLEAR_LINE"; log_ok "$(printf '%-10s listo (%ss)' "$svc" "$elapsed")"
    elif [ "$state" = "exited" ] || [ "$state" = "dead" ] || [ "$state" = "missing" ] \
         || [ "$state" = "restarting" ] || [ "$restarts" -gt "${RESTARTS0[$c]:-0}" ] || [ "$health" = "unhealthy" ] \
         || [ "$elapsed" -ge 180 ]; then
      printf '%s' "$CLEAR_LINE"; log_err "$svc no arranca bien (estado: $state, salud: $health). Últimos logs:"
      show_logs "$svc" 25
      FAILED+=("$svc")
    else
      still+=("$c")
    fi
  done
  PENDING=("${still[@]}")
  if [ "${#PENDING[@]}" -gt 0 ]; then
    # La línea de progreso solo en una terminal (en un log saldría repetida cada segundo).
    if [ -t 1 ]; then
      names=(); for c in "${PENDING[@]}"; do names+=("$(service_name "$c")"); done
      printf '%s  %s… esperando %s (%ss)%s' "$CLEAR_LINE" "$C_YELLOW" "${names[*]}" "$elapsed" "$C_RESET"
    fi
    sleep 1
  fi
done
printf '%s' "$CLEAR_LINE"
if printf '%s\n' "${FAILED[@]}" | grep -qx nokia-msn; then
  fail "NokiaMSN no ha arrancado. Logs completos: $(basename "$0") logs nokia-msn"
fi

# ── HTTPS del Nokia ────────────────────────────────────────────────────────
# Comprueba la conexión como la haría el 6111 (TLS 1.0 + AES, sin SNI) contra la raíz propia.
probe_nokia_tls() {
  command -v openssl >/dev/null 2>&1 || { log_info "Sin openssl en este PC: no se comprueba el HTTPS desde fuera."; return 0; }
  local address="$1" probe
  probe="$(printf 'GET /healthz HTTP/1.0\r\n\r\n' | timeout 15 openssl s_client -connect "$address" -tls1 \
    -cipher 'AES256-SHA:AES128-SHA:@SECLEVEL=0' -noservername -CAfile "$TLS_DIR/ca.pem" \
    -verify_hostname "${address%:*}" -ign_eof 2>&1 || true)"
  if printf '%s' "$probe" | grep -q 'Verify return code: 0' && printf '%s' "$probe" | grep -q '^HTTP/1\.[01] '; then
    log_ok "HTTPS del Nokia comprobado desde Internet: https://${address}/"
    return 0
  fi
  return 1
}

# Guarda la dirección y reinicia nokia-tls solo si cambia (genera entonces el certificado
# de esa dirección, firmado por la raíz). Reiniciar sin necesidad cortaría conexiones.
apply_tls_address() {
  local address="$1" previous
  previous="$(cat "$TLS_ADDRESS_FILE" 2>/dev/null || true)"
  echo "$address" > "$TLS_ADDRESS_FILE"
  if [ "$previous" = "$address" ] && [ -f "$TLS_DIR/server-${address%:*}.pem" ] && container_running "$TLS_CONTAINER"; then
    return 0
  fi
  docker restart "$TLS_CONTAINER" >/dev/null 2>&1 || { log_warn "No se pudo reiniciar nokia-tls."; return 1; }
  local i
  for (( i = 0; i < 30; i++ )); do
    [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$TLS_CONTAINER" 2>/dev/null)" = "healthy" ] && break
    sleep 1
  done
  log_info "nokia-tls usa ahora ${address}."
}

# SMS con la nueva dirección HTTPS (si hay Twilio configurado y ha cambiado).
notify_tls_address() {
  local address="$1" result
  [ "$(cat "$TLS_NOTIFIED_FILE" 2>/dev/null || true)" = "$address" ] && return 0
  result="$(docker exec "$APP_CONTAINER" node -e "
const p = require('path').resolve('src/services/sms-notification.service.js');
import(p).then((m) => m.sendSecurityAlertSms(process.argv[1]))
  .then((r) => console.log(r && r.status)).catch((e) => console.log('error: ' + e.message));
" "NokiaMSN: nueva direccion segura https://${address}/ . Actualiza el marcador del Nokia." 2>/dev/null | tail -1 || true)"
  if [ "$result" = "sent" ]; then
    echo "$address" > "$TLS_NOTIFIED_FILE"
    log_ok "SMS enviado con la nueva dirección HTTPS."
  fi
}

TLS_ADDRESS=""
if [ "$TLS_ENABLED" = "true" ] && [ "$NOKIA_TLS_PROVIDER" = "playit" ]; then
  log_step "HTTPS del Nokia (playit.gg)"
  TLS_ADDRESS="$NOKIA_TLS_PUBLIC_ADDRESS"
  apply_tls_address "$TLS_ADDRESS" || true
  probe_nokia_tls "$TLS_ADDRESS" || {
    log_warn "No se pudo comprobar https://${TLS_ADDRESS}/ desde aquí."
    log_info "En playit.gg, el túnel TCP debe apuntar a 127.0.0.1:${NOKIA_TLS_PORT} y el agente estar en línea."
  }
fi

# ── ngrok ──────────────────────────────────────────────────────────────────
NGROK_HTTP_PUBLIC=""
NGROK_TCP_PUBLIC=""
ngrok_error() {
  docker logs --tail 50 "$NGROK_CONTAINER" 2>&1 | grep -oE 'ERROR: +[^ ].*|err="[^"]*"' | head -1 \
    | sed -E 's/^ERROR: +//; s/^err="//; s/"$//' || true
}
wait_ngrok() { # $1 = HTTP, $2 = TCP
  local deadline=$(( $(date +%s) + NGROK_START_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    container_running "$NGROK_CONTAINER" || return 1
    [ "$1" = "true" ] && [ -z "$NGROK_HTTP_PUBLIC" ] && NGROK_HTTP_PUBLIC="$(ngrok_tunnel_url http)"
    [ "$2" = "true" ] && [ -z "$NGROK_TCP_PUBLIC" ] && NGROK_TCP_PUBLIC="$(ngrok_tunnel_url tcp)"
    if { [ "$1" != "true" ] || [ -n "$NGROK_HTTP_PUBLIC" ]; } && { [ "$2" != "true" ] || [ -n "$NGROK_TCP_PUBLIC" ]; }; then return 0; fi
    sleep 1
  done
  return 1
}

if [ "$NGROK_NEEDED" = "true" ]; then
  log_step "Túneles de ngrok"
  if ! wait_ngrok "$NGROK_HTTP" "$NGROK_TLS"; then
    if [ "$NGROK_HTTP" = "true" ] && [ "$NGROK_TLS" = "true" ] && [ -z "$NGROK_TCP_PUBLIC" ]; then
      # Que el túnel TCP no deje sin acceso: seguir solo con el HTTP.
      log_warn "ngrok no abrió el túnel del HTTPS: $(ngrok_error). Sigo solo con HTTP."
      NGROK_TLS=false
      write_ngrok_config true false
      docker restart "$NGROK_CONTAINER" >/dev/null
      wait_ngrok true false || true
    fi
  fi
  if [ "$NGROK_TLS" = "true" ]; then
    if [ -n "$NGROK_TCP_PUBLIC" ] && is_host_port "${NGROK_TCP_PUBLIC#tcp://}"; then
      TLS_ADDRESS="${NGROK_TCP_PUBLIC#tcp://}"
      if apply_tls_address "$TLS_ADDRESS"; then
        probe_nokia_tls "$TLS_ADDRESS" || log_warn "No se pudo comprobar https://${TLS_ADDRESS}/ desde aquí; se deja activo igualmente."
        notify_tls_address "$TLS_ADDRESS"
      fi
    else
      log_warn "No apareció el túnel TCP del HTTPS: $(ngrok_error)"
      rm -f "$TLS_ADDRESS_FILE"
    fi
  fi
  if [ "$NGROK_HTTP" = "true" ]; then
    if [ -n "$NGROK_HTTP_PUBLIC" ]; then
      log_ok "Túnel HTTP: $NGROK_HTTP_PUBLIC"
    else
      log_err "ngrok no ha abierto el túnel HTTP: $(ngrok_error). Últimos logs:"
      show_logs ngrok 15
    fi
  fi
fi

# ── Resumen ────────────────────────────────────────────────────────────────
WA="$(whatsapp_status)"
printf '\n%s' "$C_BOLD"; printf '═%.0s' $(seq 1 58); printf '\n  NokiaMSN\n'; printf '═%.0s' $(seq 1 58); printf '%s\n' "$C_RESET"
for svc in "${FAILED[@]}"; do printf '  %s✘ %s con problemas%s\n' "$C_RED" "$svc" "$C_RESET"; done
printf '  %-13s http://127.0.0.1:%s/\n' "Local:" "$NOKIA_MSN_PORT"
[ -n "$NGROK_HTTP_PUBLIC" ] && printf '  %-13s %s\n' "HTTP:" "$NGROK_HTTP_PUBLIC"
if [ -n "$TLS_ADDRESS" ] && [ -f "$TLS_ADDRESS_FILE" ]; then
  printf '  %-13s https://%s/  %s(%s)%s\n' "Nokia HTTPS:" "$TLS_ADDRESS" "$C_DIM" "$NOKIA_TLS_PROVIDER" "$C_RESET"
  # %-14s: la «í» ocupa dos bytes y printf cuenta bytes.
  printf '  %-14s http://%s/ca.cer  %s(instálalo una vez en el Nokia como autoridad)%s\n' "Raíz TLS:" "$TLS_ADDRESS" "$C_DIM" "$C_RESET"
fi
if [ -z "$NGROK_HTTP_PUBLIC" ] && [ -z "$TLS_ADDRESS" ]; then
  printf '  %s(sin entrada pública: solo acceso local)%s\n' "$C_YELLOW" "$C_RESET"
fi
case "$WA" in
  connected) printf '  %-13s %s%s%s\n' "WhatsApp:" "$C_GREEN" "conectado" "$C_RESET" ;;
  *) printf '  %-13s %s%s%s  → vincula en http://127.0.0.1:%s/whatsapp/qr\n' "WhatsApp:" "$C_YELLOW" "${WA:-arrancando}" "$C_RESET" "$NOKIA_MSN_PORT" ;;
esac
printf '%s' "$C_BOLD"; printf '═%.0s' $(seq 1 58); printf '%s\n' "$C_RESET"
log_info "Sigue funcionando en segundo plano. $(basename "$0") status / logs / stop"
if [ "$NOKIA_TLS_PROVIDER" = "ngrok" ] && [ -n "$TLS_ADDRESS" ]; then
  log_info "Con ngrok la dirección HTTPS cambia si ngrok se reinicia: vuelve a ejecutar «$(basename "$0") up»."
fi

if [ "$HTTP_ENABLED" = "true" ] && [ -z "$NGROK_HTTP_PUBLIC" ] && [ -z "$TLS_ADDRESS" ]; then
  log_warn "No hay ninguna entrada pública activa."
fi

if [ "$FOLLOW" = "true" ]; then
  trap - INT
  "${DC[@]}" logs -f --tail 0 nokia-msn
fi
