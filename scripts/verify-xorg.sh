#!/bin/bash
set -euo pipefail

LOG_CANDIDATES=(
  "${HOME:-/home/pi}/.local/share/xorg/Xorg.0.log"
  "/var/log/Xorg.0.log"
)

LOG_PATH=""
for _ in $(seq 1 30); do
  for candidate in "${LOG_CANDIDATES[@]}"; do
    if [[ -f "${candidate}" ]]; then
      LOG_PATH="${candidate}"
      break
    fi
  done
  [[ -n "${LOG_PATH}" ]] && break
  sleep 1
done

if [[ -z "${LOG_PATH}" ]]; then
  echo "[verify-xorg] No se encontró Xorg.0.log" >&2
  if [[ "${INSTALL_XORG_STRICT:-false}" == "true" ]]; then
    echo "[install][err]  Verificación de Xorg falló (modo estricto)" >&2
    exit 1
  else
    echo "[install][warn] Xorg no verificado (no se encontró Xorg.0.log tras 30s)" >&2
    exit 0
  fi
fi

echo "[verify-xorg] Analizando ${LOG_PATH}" >&2

relevant() {
  grep -nEi 'modeset|vc4|DRI|HDMI|EE|WW|no screens found|Cannot run in framebuffer mode|open /dev/dri/card.*-HDMI.*: No such file' "${LOG_PATH}" | tail -n 80
}

errors=0
if grep -qi 'no screens found' "${LOG_PATH}"; then
  echo "[verify-xorg] Error: 'no screens found' detectado" >&2
  errors=1
fi

if grep -qi 'Cannot run in framebuffer mode' "${LOG_PATH}"; then
  echo "[verify-xorg] Error: 'Cannot run in framebuffer mode' detectado" >&2
  errors=1
fi

if grep -qi 'open /dev/dri/card.*-HDMI.*: No such file' "${LOG_PATH}"; then
  echo "[verify-xorg] Error: dispositivo HDMI no disponible" >&2
  errors=1
fi

if ! grep -qiE 'modeset|DRI2.*vc4|Output HDMI-1 using initial mode' "${LOG_PATH}"; then
  echo "[verify-xorg] Error: no se encontró un token de éxito (modeset/DRI2 vc4/Output HDMI-1)" >&2
  errors=1
fi

if [[ ${errors} -ne 0 ]]; then
  echo "[verify-xorg] Últimas líneas relevantes:" >&2
  relevant >&2 || true
else
  echo "[verify-xorg] Validación OK" >&2
  relevant >&2 || true
fi

exit ${errors}
