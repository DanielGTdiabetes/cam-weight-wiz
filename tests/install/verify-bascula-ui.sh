#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

log() { printf '[test] %s\n' "$*"; }
log_err() { printf '[test][err] %s\n' "$*" >&2; }

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  log_err "Se requiere ejecutar como root"
  exit 1
fi

if [[ ! -d /run/systemd/system ]]; then
  log_err "systemd no está activo"
  exit 1
fi

systemctl daemon-reload

if ! systemd-analyze verify bascula-ui.service; then
  log_err "systemd-analyze verify falló"
  exit 1
fi

override="/etc/systemd/system/bascula-ui.service.d/override.conf"
if [[ ! -f "${override}" ]]; then
  log_err "No existe ${override}"
  exit 1
fi

if ! grep -q '^ExecStart=$' "${override}"; then
  log_err "Falta línea ExecStart= en blanco para limpiar overrides"
  exit 1
fi

if ! grep -q '^ExecStartPre=$' "${override}"; then
  log_err "Falta línea ExecStartPre= en blanco para limpiar overrides"
  exit 1
fi

if command -v file >/dev/null 2>&1; then
  if ! file "${override}" | grep -q 'ASCII text'; then
    log_err "${override} no es texto ASCII"
    exit 1
  fi
fi

if sed -n 'l' "${override}" | grep -q '\\r'; then
  log_err "${override} contiene caracteres \\r"
  exit 1
fi

log "${override} verificado"
