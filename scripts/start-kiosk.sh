#!/bin/bash
# Bascula UI - Chromium Kiosk Mode Launcher

set -euo pipefail

BASCULA_KIOSK_WAIT_S="${BASCULA_KIOSK_WAIT_S:-30}"
BASCULA_KIOSK_PROBE_MS="${BASCULA_KIOSK_PROBE_MS:-500}"

LOG_FILE="/var/log/bascula/ui.log"
LOG_DIR="$(dirname "${LOG_FILE}")"

# Ensure log directory/file exist without failing if permissions differ
mkdir -p "${LOG_DIR}" 2>/dev/null || true
touch "${LOG_FILE}" 2>/dev/null || true

log() {
  printf '[kiosk] %s\n' "$*" >> "${LOG_FILE}" 2>/dev/null || true
}

cleanup_background() {
  if [[ -n "${UNCLUTTER_PID:-}" ]]; then
    kill "${UNCLUTTER_PID}" 2>/dev/null || true
  fi
}

trap cleanup_background EXIT

log "Iniciando sesión de kiosk (replace=${BASCULA_KIOSK_REPLACE_WM:-0})"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v xset >/dev/null 2>&1; then
  xset s off || true
  xset -dpms || true
  xset s noblank || true
else
  log "xset no disponible"
fi

if command -v openbox >/dev/null 2>&1; then
  if [[ "${BASCULA_KIOSK_REPLACE_WM:-0}" == "1" ]]; then
    log "Ejecutando openbox --replace"
    openbox --replace &
  else
    log "Lanzando openbox"
    openbox &
  fi
else
  log "openbox no encontrado"
fi

UNCLUTTER_BIN="$(command -v unclutter 2>/dev/null || true)"
if [[ -n "${UNCLUTTER_BIN}" ]]; then
  "${UNCLUTTER_BIN}" -idle 0.5 -root &
  UNCLUTTER_PID=$!
  log "unclutter iniciado (pid=${UNCLUTTER_PID})"
else
  log "unclutter no instalado"
fi

sleep 1

BACKEND_RESULT=""
set +e
BACKEND_RESULT=$(BASCULA_KIOSK_WAIT_S="${BASCULA_KIOSK_WAIT_S}" \
  BASCULA_KIOSK_PROBE_MS="${BASCULA_KIOSK_PROBE_MS}" \
  python3 "${SCRIPT_DIR}/choose_kiosk_target.py")
PY_STATUS=$?
set -e
if [[ ${PY_STATUS} -ne 0 || -z "${BACKEND_RESULT}" ]]; then
  BACKEND_RESULT=""
  for attempt in $(seq 1 20); do
    if curl -sf http://127.0.0.1:8080/api/miniweb/status >/dev/null; then
      BACKEND_RESULT="ready|http://localhost/"
      break
    fi
    sleep 1
  done
  if [[ -z "${BACKEND_RESULT}" ]]; then
    BACKEND_RESULT="fallback|http://localhost/config"
  fi
fi

BACKEND_STATE="${BACKEND_RESULT%%|*}"
TARGET_URL="${BACKEND_RESULT#*|}"

if [[ "${BACKEND_STATE}" == "ready" ]]; then
  log "Backend disponible, abriendo ${TARGET_URL}"
else
  log "Backend no respondió a tiempo, abriendo ${TARGET_URL}"
fi

CHROME_BIN="${BASCULA_CHROME_BIN:-${CHROME:-}}"
if [[ -z "${CHROME_BIN}" ]]; then
  CHROME_BIN="$(command -v chromium-browser 2>/dev/null || command -v chromium 2>/dev/null || command -v "${CHROME_PKG:-chromium}" 2>/dev/null || echo chromium)"
fi

log "CHROME=${CHROME_BIN} URL=${TARGET_URL}"

exec "${CHROME_BIN}" \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --enable-features=OverlayScrollbar,ClipboardUnsanitizedContent \
  --disable-translate \
  --disable-features=TranslateUI \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --start-fullscreen \
  --window-size=1024,600 \
  --window-position=0,0 \
  --user-data-dir=/run/bascula/chrome-profile \
  --disk-cache-dir=/run/bascula/chrome-cache \
  --check-for-update-interval=31536000 \
  "${TARGET_URL}"
