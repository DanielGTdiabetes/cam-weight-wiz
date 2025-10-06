#!/bin/bash
# Wrapper tolerante para el kiosk de Báscula

set -euo pipefail

LOG_FILE="/var/log/bascula/ui.log"
LOG_DIR="$(dirname "${LOG_FILE}")"
SESSION_SCRIPT="/opt/bascula/current/scripts/start-kiosk.sh"
DISPLAY_LOCK="/tmp/.X0-lock"

mkdir -p "${LOG_DIR}" 2>/dev/null || true
touch "${LOG_FILE}" 2>/dev/null || true

log() {
  printf '[kiosk] %s\n' "$*" >> "${LOG_FILE}" 2>/dev/null || true
}

x_running() {
  if pgrep -f 'Xorg .*:0' >/dev/null 2>&1; then
    return 0
  fi
  if pgrep -f 'Xorg.bin .*:0' >/dev/null 2>&1; then
    return 0
  fi
  if pgrep -f 'Xwayland .*:0' >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

log "Wrapper kiosk iniciado"

if [[ -e "${DISPLAY_LOCK}" ]] && ! x_running; then
  log "Eliminando lock X huérfano (${DISPLAY_LOCK})"
  rm -f "${DISPLAY_LOCK}" || true
fi

if x_running; then
  log "Servidor X detectado en :0; iniciando sesión sin startx"
  export BASCULA_KIOSK_REPLACE_WM=1
  exec "${SESSION_SCRIPT}"
fi

log "Servidor X no detectado; lanzando startx"
exec /usr/bin/startx /opt/bascula/current/.xinitrc -- :0 vt1 -nocursor
