#!/usr/bin/env bash
#
# Ensure the Bascula access point is only active when connectivity is missing.

set -euo pipefail

log() {
  local msg="$1"
  logger -t bascula-ap-ensure -- "$msg" 2>/dev/null || true
  printf '[bascula-ap-ensure] %s\n' "$msg"
}

error_exit() {
  local msg="$1"
  logger -t bascula-ap-ensure -- "ERROR: $msg" 2>/dev/null || true
  printf '[bascula-ap-ensure][err] %s\n' "$msg" >&2
  exit 1
}

AP_NAME="${AP_NAME:-BasculaAP}"
AP_SSID="${AP_SSID:-Bascula-AP}"
AP_PASS="${AP_PASS:-Bascula1234}"
AP_IFACE="${AP_IFACE:-wlan0}"
AP_GATEWAY="192.168.4.1"
AP_CIDR="${AP_GATEWAY}/24"
AP_PROFILE_DIR="/etc/NetworkManager/system-connections"
AP_PROFILE_PATH="${AP_PROFILE_DIR}/${AP_NAME}.nmconnection"
FORCE_AP_FLAG="/run/bascula/force_ap"
MINIWEB_SERVICE="bascula-miniweb"

NMCLI_BIN="${NMCLI_BIN:-$(command -v nmcli 2>/dev/null || true)}"
if [[ -z "${NMCLI_BIN}" ]]; then
  error_exit "nmcli requerido pero no disponible"
fi

ensure_ap_profile() {
  install -d -m 0755 "${AP_PROFILE_DIR}"

  if ! "${NMCLI_BIN}" -t -f NAME connection show "${AP_NAME}" >/dev/null 2>&1; then
    log "Creando perfil ${AP_NAME}"
    "${NMCLI_BIN}" connection add \
      type wifi \
      ifname "${AP_IFACE}" \
      con-name "${AP_NAME}" \
      ssid "${AP_SSID}" >/dev/null 2>&1 || \
      error_exit "No se pudo crear el perfil ${AP_NAME}"
  fi

  "${NMCLI_BIN}" connection modify "${AP_NAME}" \
    802-11-wireless.ssid "${AP_SSID}" \
    802-11-wireless.mode ap \
    802-11-wireless.band bg \
    802-11-wireless.channel 1 \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.proto rsn \
    wifi-sec.pmf 2 \
    wifi-sec.psk "${AP_PASS}" \
    ipv4.method shared \
    ipv4.addresses "${AP_CIDR}" \
    ipv4.gateway "${AP_GATEWAY}" \
    ipv4.never-default yes \
    connection.autoconnect no \
    connection.autoconnect-priority 0 \
    connection.interface-name "${AP_IFACE}" \
    ipv6.method ignore >/dev/null 2>&1 || \
    error_exit "No se pudo actualizar el perfil ${AP_NAME}"

  local tmp_profile
  tmp_profile=$(mktemp)
  if "${NMCLI_BIN}" connection export "${AP_NAME}" "${tmp_profile}" >/dev/null 2>&1; then
    install -D -m 0600 "${tmp_profile}" "${AP_PROFILE_PATH}"
    "${NMCLI_BIN}" connection load "${AP_PROFILE_PATH}" >/dev/null 2>&1 || \
      log "Advertencia: no se pudo recargar ${AP_PROFILE_PATH}"
  else
    log "Advertencia: no se pudo exportar el perfil ${AP_NAME}"
  fi
  rm -f "${tmp_profile}"
}

ap_is_active() {
  "${NMCLI_BIN}" -t -f NAME connection show --active 2>/dev/null | grep -Fxq "${AP_NAME}" || return 1
  return 0
}

bring_down_ap() {
  if ap_is_active; then
    log "Desactivando ${AP_NAME} porque hay conectividad"
    "${NMCLI_BIN}" connection down "${AP_NAME}" >/dev/null 2>&1 || true
  fi
}

bring_up_ap() {
  ensure_ap_profile

  "${NMCLI_BIN}" radio wifi on >/dev/null 2>&1 || true
  "${NMCLI_BIN}" device disconnect "${AP_IFACE}" >/dev/null 2>&1 || true
  "${NMCLI_BIN}" connection down "${AP_NAME}" >/dev/null 2>&1 || true

  if "${NMCLI_BIN}" connection up "${AP_NAME}" >/dev/null 2>&1; then
    log "${AP_NAME} activo en ${AP_IFACE} (${AP_CIDR})"
  else
    error_exit "Fallo al activar ${AP_NAME}"
  fi

  if ! systemctl restart "${MINIWEB_SERVICE}" >/dev/null 2>&1; then
    log "Advertencia: no se pudo reiniciar ${MINIWEB_SERVICE}"
  fi
}

get_connectivity() {
  local raw
  raw=$("${NMCLI_BIN}" -g CONNECTIVITY general status 2>/dev/null || true)
  if [[ -z "${raw}" ]]; then
    echo "unknown"
  else
    printf '%s' "${raw}" | tr '[:upper:]' '[:lower:]'
  fi
}

main() {
  local connectivity
  connectivity=$(get_connectivity)

  if [[ "${connectivity}" == "full" && ! -f "${FORCE_AP_FLAG}" ]]; then
    bring_down_ap
    exit 0
  fi

  if [[ "${connectivity}" != "full" ]]; then
    log "Conectividad=${connectivity:-desconocida}; asegurando ${AP_NAME}"
  else
    log "Flag de fuerza detectado; asegurando ${AP_NAME}"
  fi

  bring_up_ap
}

main "$@"
