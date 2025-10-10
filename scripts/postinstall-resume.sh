#!/bin/bash
# Reanudación tras reinicio para Báscula Digital Pro
set -euo pipefail

exec 9>/var/lock/bascula.install && flock -n 9 || { echo "[postinstall] otro instalador en marcha"; exit 0; }

log() { printf '[postinstall] %s\n' "$*"; }
log_warn() { printf '[postinstall][warn] %s\n' "$*" >&2; }

STATE_DIR="/var/lib/bascula"
MARKER="${STATE_DIR}/postinstall.done"
TMPFILES_BASE="/etc/tmpfiles.d"
APP_ROOT="/opt/bascula/current"
TARGET_USER="${BASCULA_TARGET_USER:-$(stat -c '%U' "${APP_ROOT}" 2>/dev/null || echo pi)}"
TARGET_GROUP="${BASCULA_TARGET_GROUP:-$(stat -c '%G' "${APP_ROOT}" 2>/dev/null || echo pi)}"

install -d -m 0755 -o root -g root "${STATE_DIR}"

if [[ -f "${MARKER}" ]]; then
  log "[postinstall][skip] ya aplicado (${MARKER})"
  exit 0
fi

log "Aplicando tareas post-reinicio mínimas..."

if command -v systemd-tmpfiles >/dev/null 2>&1; then
  systemd-tmpfiles --create "${TMPFILES_BASE}/bascula.conf" || log_warn "tmpfiles bascula.conf falló"
  if [[ -f "${TMPFILES_BASE}/bascula-x11.conf" ]]; then
    systemd-tmpfiles --create "${TMPFILES_BASE}/bascula-x11.conf" || log_warn "tmpfiles bascula-x11.conf falló"
  fi
else
  log_warn "systemd-tmpfiles no disponible"
fi

install -d -o "${TARGET_USER}" -g www-data -m 0755 /run/bascula
install -d -o "${TARGET_USER}" -g www-data -m 02770 /run/bascula/captures
chmod g+s /run/bascula/captures || true
chgrp www-data /run/bascula /run/bascula/captures || true

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
  for unit in nginx.service bascula-miniweb.service bascula-ui.service; do
    if systemctl list-unit-files | grep -q "^${unit}"; then
      if ! systemctl is-enabled "${unit}" >/dev/null 2>&1; then
        systemctl enable "${unit}" || log_warn "No se pudo habilitar ${unit}"
      fi
      systemctl try-restart "${unit}" || true
    fi
  done
else
  log_warn "systemctl no disponible"
fi

systemctl_status_cmd() {
  local unit="$1"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl is-active --quiet "${unit}" && printf '%s' "active" || printf '%s' "inactive"
  else
    printf '%s' "n/a"
  fi
}

log "Estados tras postinstalación: nginx=$(systemctl_status_cmd nginx.service), miniweb=$(systemctl_status_cmd bascula-miniweb.service), ui=$(systemctl_status_cmd bascula-ui.service)"

touch "${MARKER}"
log "[postinstall][done] Reanudación completada (${MARKER})"
