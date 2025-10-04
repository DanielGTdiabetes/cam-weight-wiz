#!/usr/bin/env bash
#
# bascula-ap-ensure.sh - Ensure BasculaAP comes up when no other connectivity exists
#
set -euo pipefail

LOG_TAG="bascula-ap-ensure"
LOG_FILE="/var/log/bascula/ap-ensure.log"
TMP_OUTPUT="$(mktemp -t bascula-ap-ensure.XXXXXX 2>/dev/null || echo "/tmp/bascula-ap-ensure.$$")"
trap 'rm -f "${TMP_OUTPUT}" 2>/dev/null || true' EXIT

mkdir -p "$(dirname "${LOG_FILE}")" >/dev/null 2>&1 || true

LOG() {
  local msg="$*"
  logger -t "${LOG_TAG}" -- "${msg}" 2>/dev/null || true
  printf "[ap-ensure] %s\n" "${msg}"
  printf '%s %s\n' "$(date --iso-8601=seconds 2>/dev/null || date)" "${msg}" >>"${LOG_FILE}" 2>/dev/null || true
}

NMCLI_DIAG() {
  LOG "Diagnóstico NetworkManager (${AP_IFACE}/${AP_NAME})"
  if command -v nmcli >/dev/null 2>&1; then
    while IFS= read -r line; do LOG "[diag] ${line}"; done < <(nmcli -f GENERAL,IP4,CONNECTION device show "${AP_IFACE}" 2>/dev/null || true)
    while IFS= read -r line; do LOG "[diag] ${line}"; done < <(nmcli connection show "${AP_NAME}" 2>/dev/null || true)
  fi
}

AP_NAME="${AP_NAME:-BasculaAP}"
AP_IFACE="${AP_IFACE:-wlan0}"

HAS_CONNECTIVITY=0

if command -v nmcli >/dev/null 2>&1; then
  while IFS=: read -r DEVICE TYPE STATE; do
    [[ -z "${DEVICE}" ]] && continue
    [[ "${STATE}" != connected* ]] && continue

    if [[ "${TYPE}" == "wifi" ]]; then
      CONN_LINE=$(nmcli -t -f GENERAL.CONNECTION device show "${DEVICE}" 2>/dev/null || true)
      CONN_NAME="${CONN_LINE#*:}"
      [[ -z "${CONN_NAME}" ]] && continue
      if [[ "${CONN_NAME}" == "${AP_NAME}" ]]; then
        continue
      fi
      MODE=$(nmcli -t -f 802-11-wireless.mode connection show "${CONN_NAME}" 2>/dev/null || echo "")
      if [[ "${MODE}" == "ap" ]]; then
        continue
      fi
    fi

    STATE_DETAIL=$(nmcli -t -f GENERAL.STATE device show "${DEVICE}" 2>/dev/null || true)
    if [[ "${STATE_DETAIL}" == 100* ]]; then
      HAS_CONNECTIVITY=1
      LOG "${TYPE^} ${DEVICE} activo (${STATE_DETAIL}); no se requiere ${AP_NAME}"
      break
    fi
  done < <(nmcli -t -f DEVICE,TYPE,STATE device status 2>/dev/null || true)
else
  # Fallback sin nmcli: revisar IPs directas
  if ip -4 addr show | grep -E '^[0-9]+: (eth|wlan)' | grep -q 'inet '; then
    HAS_CONNECTIVITY=1
    LOG "Interfaces con IP detectadas sin nmcli; omitiendo ${AP_NAME}"
  fi
fi

if [[ "${HAS_CONNECTIVITY}" -eq 1 ]]; then
  LOG "Conectividad presente; no se activa AP"
  exit 0
fi

LOG "Sin conectividad a Internet; activando ${AP_NAME}"
if command -v nmcli >/dev/null 2>&1; then
  if ! nmcli connection up "${AP_NAME}" >"${TMP_OUTPUT}" 2>&1; then
    LOG "Fallo al activar ${AP_NAME}"
    NMCLI_DIAG
    if ! nmcli connection modify "${AP_NAME}" connection.autoconnect yes connection.autoconnect-priority 100 >/dev/null 2>&1; then
      LOG "No se pudo forzar autoconnect como respaldo"
    else
      LOG "Autoconnect activado como respaldo para ${AP_NAME}"
    fi
    if [[ -s "${TMP_OUTPUT}" ]]; then
      while IFS= read -r line; do LOG "[nmcli] ${line}"; done <"${TMP_OUTPUT}"
    fi
    exit 1
  fi
  if [[ -s "${TMP_OUTPUT}" ]]; then
    while IFS= read -r line; do LOG "[nmcli] ${line}"; done <"${TMP_OUTPUT}"
  fi
else
  LOG "nmcli no disponible; imposible activar ${AP_NAME}"
  exit 1
fi

LOG "${AP_NAME} activado correctamente"
exit 0
