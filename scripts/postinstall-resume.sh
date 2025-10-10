#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

log() { printf '[postinstall] %s\n' "$*"; }
log_warn() { printf '[postinstall][warn] %s\n' "$*" >&2; }

run_or_warn() {
  local label="$1"
  shift
  if "$@"; then
    log "${label}"
    return 0
  fi
  local status=$?
  log_warn "${label} falló (status ${status})"
  return ${status}
}

STATE_DIR="/var/lib/bascula"
FLAG_FILE="${STATE_DIR}/reboot-required"
REASONS_FILE="${STATE_DIR}/reboot-reasons.txt"
CAPTURE_ROOT="/run/bascula"
CAPTURE_DIR="${CAPTURE_ROOT}/captures"

log "Reanudando post-instalación tras reboot..."

if [[ -f "${REASONS_FILE}" && -s "${REASONS_FILE}" ]]; then
  log "Motivos del reinicio previo:"
  sed 's/^/[postinstall]  - /' "${REASONS_FILE}" || true
fi

install -d -m 0755 "${CAPTURE_ROOT}"
install -d -o pi -g www-data -m 02770 "${CAPTURE_DIR}"
chmod g+s "${CAPTURE_DIR}" || true

run_or_warn "systemd-tmpfiles --create" systemd-tmpfiles --create
run_or_warn "systemctl daemon-reload" systemctl daemon-reload
run_or_warn "systemctl enable --now bascula-miniweb.service" systemctl enable --now bascula-miniweb.service
run_or_warn "systemctl enable --now bascula-ui.service" systemctl enable --now bascula-ui.service

if command -v curl >/dev/null 2>&1; then
  if curl -fsS http://127.0.0.1:8080/api/miniweb/status >/dev/null; then
    log "miniweb responde en /api/miniweb/status"
  else
    log_warn "miniweb no respondió en /api/miniweb/status"
  fi
  if curl -fsS http://127.0.0.1/ >/dev/null; then
    log "nginx responde en http://127.0.0.1/"
  else
    log_warn "nginx no respondió en http://127.0.0.1/"
  fi
  tmp_file="$(mktemp "${CAPTURE_DIR}/postinstall.XXXXXX")"
  echo "postinstall" > "${tmp_file}"
  capture_name="$(basename "${tmp_file}")"
  if curl -fsS "http://127.0.0.1/captures/${capture_name}" >/dev/null; then
    log "Nginx sirve /captures/${capture_name} en loopback"
  else
    log_warn "No se pudo acceder a /captures/${capture_name} en loopback"
  fi
  rm -f "${tmp_file}" || true
else
  log_warn "curl no disponible; omitiendo smoke HTTP"
fi

rm -f "${FLAG_FILE}" || true
: > "${REASONS_FILE}" || true

if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files | grep -q '^bascula-postinstall.service'; then
    run_or_warn "systemctl disable bascula-postinstall.service" systemctl disable bascula-postinstall.service
  fi
fi

log "Post-instalación completada"
