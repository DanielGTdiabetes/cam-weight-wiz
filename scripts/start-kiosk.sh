#!/bin/bash
set -euo pipefail

BASCULA_KIOSK_WAIT_S="${BASCULA_KIOSK_WAIT_S:-30}"
LOG_FILE="/var/log/bascula/ui.log"; LOG_DIR="$(dirname "${LOG_FILE}")"
mkdir -p "${LOG_DIR}" 2>/dev/null || true; touch "${LOG_FILE}" 2>/dev/null || true
log(){ printf '[kiosk] %s\n' "$*" >> "${LOG_FILE}" 2>/dev/null || true; }
cleanup(){ [[ -n "${UNCLUTTER_PID:-}" ]] && kill "${UNCLUTTER_PID}" 2>/dev/null || true; }
trap cleanup EXIT

log "Iniciando sesión de kiosk (replace=${BASCULA_KIOSK_REPLACE_WM:-0})"

if command -v xset >/dev/null; then
  xset s off || true
  xset -dpms || true
  xset s noblank || true
else
  log "xset no disponible"
fi

if command -v openbox >/dev/null; then
  if [[ "${BASCULA_KIOSK_REPLACE_WM:-0}" == "1" ]]; then
    log "Ejecutando openbox --replace"; openbox --replace &
  else
    log "Lanzando openbox"; openbox &
  fi
else
  log "openbox no encontrado"
fi

UNCLUTTER_BIN="$(command -v unclutter 2>/dev/null || true)"
if [[ -n "${UNCLUTTER_BIN}" ]]; then
  "${UNCLUTTER_BIN}" -idle 0.5 -root & UNCLUTTER_PID=$!
  log "unclutter iniciado (pid=${UNCLUTTER_PID})"
else
  log "unclutter no instalado"
fi

sleep 1

TARGET_URL="http://localhost/"
for _ in $(seq 1 20); do
  if curl -sf http://127.0.0.1:8081/api/health >/dev/null; then break; fi
  sleep 1
done
if curl -sf http://127.0.0.1:8081/api/health >/dev/null; then
  log "Backend disponible, abriendo ${TARGET_URL}"
else
  TARGET_URL="http://localhost/config"
  log "Backend no respondió a tiempo, abriendo ${TARGET_URL}"
fi

CHROME_BIN="$(command -v chromium-browser 2>/dev/null || command -v chromium 2>/dev/null || echo chromium)"
log "CHROME=${CHROME_BIN} URL=${TARGET_URL}"
export XDG_RUNTIME_DIR="/run/user/1000"
export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/1000/bus"

exec "${CHROME_BIN}" \
  --kiosk --noerrdialogs --disable-infobars --no-first-run \
  --enable-features=OverlayScrollbar,ClipboardUnsanitizedContent \
  --disable-translate --disable-features=TranslateUI \
  --disable-pinch --overscroll-history-navigation=0 \
  --start-fullscreen --window-size=1024,600 --window-position=0,0 \
  --user-data-dir=/run/bascula/chrome-profile --disk-cache-dir=/run/bascula/chrome-cache \
  --check-for-update-interval=31536000 \
  "${TARGET_URL}"
