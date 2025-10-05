#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[kiosk] %s\n' "$*"
}

warn() {
  printf '[kiosk][warn] %s\n' "$*" >&2
}

fail() {
  printf '[kiosk][err] %s\n' "$*" >&2
  exit 1
}

wait_http_200() {
  local url="$1"
  local timeout="${2:-60}"
  local label="${3:-$1}"
  local attempt
  for attempt in $(seq 1 "${timeout}"); do
    if curl --fail --silent --show-error --max-time 5 "$url" >/dev/null 2>&1; then
      log "HTTP 200 -> ${label}"
      return 0
    fi
    sleep 1
  done
  warn "Timeout esperando ${label} tras ${timeout}s"
  return 1
}

fetch_config_html() {
  curl --fail --silent --show-error --max-time 10 "$CONFIG_URL"
}


CHROME_BIN="${CHROME_BIN:-$(command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || true)}"
if [[ -z "${CHROME_BIN}" ]]; then
  fail "No se encontró el binario de Chromium"
fi

printf '\n# Binario Chromium detectado: %s\n' "${CHROME_BIN}"
printf '# DISPLAY (pre): %s\n' "${DISPLAY:-<empty>}"

URL_BASE="${URL_BASE:-http://127.0.0.1:8080}"
STATUS_URL="${STATUS_URL:-${URL_BASE}/api/miniweb/status}"
CONFIG_URL="${CONFIG_URL:-${URL_BASE}/config}"
ASSETS_BASE="${ASSETS_BASE:-${URL_BASE}}"
PROFILE_DIR="${KIOSK_PROFILE_DIR:-${HOME:-/home/pi}/.config/chromium}"

log "URL base: ${URL_BASE}"
log "Esperando Mini-Web en ${STATUS_URL}"
wait_http_200 "${STATUS_URL}" 120 "${STATUS_URL}" || warn "Mini-Web no respondió con 200"

log "Esperando /config"
wait_http_200 "${CONFIG_URL}" 120 "${CONFIG_URL}" || warn "Página /config no disponible"

JS=""
CSS=""
if HTML_CONTENT="$(fetch_config_html 2>/dev/null)"; then
  JS="$(printf '%s' "${HTML_CONTENT}" | grep -Eo 'src="/assets/[^"]+\.js"' | head -n1 | sed -E 's/src="([^"]+)"/\1/')"
  CSS="$(printf '%s' "${HTML_CONTENT}" | grep -Eo 'href="/assets/[^"]+\.css"' | head -n1 | sed -E 's/href="([^"]+)"/\1/')"
else
  warn "No se pudo descargar /config para detectar assets"
fi

log "Assets detectados -> JS: ${JS:-<none>}  CSS: ${CSS:-<none>}"
if [[ -n "${JS}" ]]; then
  wait_http_200 "${ASSETS_BASE}${JS}" 60 "${JS}" || warn "JS no disponible"
fi
if [[ -n "${CSS}" ]]; then
  wait_http_200 "${ASSETS_BASE}${CSS}" 60 "${CSS}" || warn "CSS no disponible"
fi

log "Limpiando caches de Chromium problemáticas"
rm -rf "${HOME:-/home/pi}/.config/chromium/Default/Service Worker" 2>/dev/null || true
rm -rf "${HOME:-/home/pi}/.config/chromium/Default/Cache" 2>/dev/null || true
rm -rf "${HOME:-/home/pi}/.cache/chromium" 2>/dev/null || true

export DISPLAY=":0"
printf '# DISPLAY (post): %s\n' "${DISPLAY}"

log "Lanzando Chromium"
exec "${CHROME_BIN}" \
  --app="${URL_BASE}/config?v=$(date +%s)" \
  --incognito \
  --disable-extensions \
  --disable-background-networking \
  --no-first-run \
  --password-store=basic \
  --user-data-dir="${PROFILE_DIR}" \
  --ozone-platform=x11 \
  --disable-gpu \
  --use-gl=swiftshader \
  --enable-features=UseSkiaRenderer \
  --no-default-browser-check
