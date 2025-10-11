#!/bin/bash
set -euo pipefail

LOG_PATH="${HOME:-/home/pi}/.local/share/xorg/Xorg.0.log"
if [[ ! -f "${LOG_PATH}" ]]; then
  LOG_PATH="/var/log/Xorg.0.log"
fi

if [[ ! -f "${LOG_PATH}" ]]; then
  echo "[verify-xorg] No se encontró Xorg.0.log" >&2
  exit 1
fi

echo "[verify-xorg] Analizando ${LOG_PATH}" >&2

relevant() {
  grep -nEi 'modeset|vc4|HDMI|DRI|no screens found|Cannot run in framebuffer mode|open /dev/dri/card.*-HDMI-A-1' "$LOG_PATH" | tail -n 80
}

errors=0
if grep -qi 'no screens found' "$LOG_PATH"; then
  echo "[verify-xorg] Error: 'no screens found' detectado" >&2
  errors=1
fi

if grep -qi 'Cannot run in framebuffer mode' "$LOG_PATH"; then
  echo "[verify-xorg] Error: framebuffer mode detectado" >&2
  errors=1
fi

if grep -qi 'open /dev/dri/card.*-HDMI-A-1: No such file or directory' "$LOG_PATH"; then
  echo "[verify-xorg] Error: dispositivo HDMI no disponible" >&2
  errors=1
fi

if ! grep -qiE 'modeset|vc4|HDMI|DRI' "$LOG_PATH"; then
  echo "[verify-xorg] Error: no aparecen tokens modeset/vc4/HDMI/DRI" >&2
  errors=1
fi

if [[ ${errors} -ne 0 ]]; then
  echo "[verify-xorg] Últimas líneas relevantes:" >&2
  relevant >&2 || true
else
  echo "[verify-xorg] Tokens modeset/vc4/HDMI/DRI presentes" >&2
  relevant >&2 || true
fi

exit ${errors}
