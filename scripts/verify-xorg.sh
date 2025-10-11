#!/bin/bash
set -euo pipefail

LOG_PREFIX="[verify-xorg]"
log(){ printf '%s %s\n' "${LOG_PREFIX}" "$*"; }
log_err(){ printf '%s[err] %s\n' "${LOG_PREFIX}" "$*" >&2; }

candidates=(
  "/home/pi/.local/share/xorg/Xorg.0.log"
  "/var/log/Xorg.0.log"
)

log_file=""
for path in "${candidates[@]}"; do
  if [[ -f "${path}" ]]; then
    log_file="${path}"
    break
  fi
done

if [[ -z "${log_file}" ]]; then
  log_err "No se encontró Xorg.0.log en ${candidates[*]}"
  exit 1
fi

log "Analizando ${log_file}"
if ! grep -E 'modeset|HDMI|DRI2|vc4|EE|WW' "${log_file}"; then
  log "No se encontraron coincidencias relevantes en ${log_file}"
fi

if grep -q 'Cannot run in framebuffer mode' "${log_file}"; then
  log_err "Xorg intentó ejecutarse en modo framebuffer"
  exit 1
fi

if ! grep -Eq 'modeset|vc4' "${log_file}"; then
  log_err "No se detectaron trazas de modeset/vc4 en ${log_file}"
  exit 1
fi

log "Xorg reporta modos modeset/vc4 correctamente"
