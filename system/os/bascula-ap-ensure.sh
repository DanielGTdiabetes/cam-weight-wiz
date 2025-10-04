#!/usr/bin/env bash
#
# bascula-ap-ensure.sh - Ensure BasculaAP comes up when no other connectivity exists

set -euo pipefail

LOG_TAG="bascula-ap-ensure"
LOG_FILE="/var/log/bascula/ap-ensure.log"

mkdir -p "$(dirname "${LOG_FILE}")" >/dev/null 2>&1 || true

log() {
  local msg="$1"
  logger -t "${LOG_TAG}" -- "$msg" 2>/dev/null || true
  printf '[ap-ensure] %s\n' "$msg"
  printf '%s %s\n' "$(date --iso-8601=seconds 2>/dev/null || date)" "$msg" >>"${LOG_FILE}" 2>/dev/null || true
}

error_exit() {
  local msg="$1"
  logger -t "${LOG_TAG}" -- "ERROR: $msg" 2>/dev/null || true
  printf '[ap-ensure][err] %s\n' "$msg" >&2
  printf '%s ERROR: %s\n' "$(date --iso-8601=seconds 2>/dev/null || date)" "$msg" >>"${LOG_FILE}" 2>/dev/null || true
  exit 1
}

AP_NAME="${AP_NAME:-BasculaAP}"
AP_SSID="${AP_SSID:-Bascula-AP}"
AP_PASS_DEFAULT="Bascula1234"
AP_PASS="${AP_PASS:-${AP_PASS_DEFAULT}}"
AP_IFACE="${AP_IFACE:-wlan0}"
AP_GATEWAY="192.168.4.1"
AP_CIDR="${AP_GATEWAY}/24"
AP_PROFILE="/etc/NetworkManager/system-connections/${AP_NAME}.nmconnection"

if ! command -v nmcli >/dev/null 2>&1; then
  error_exit "nmcli requerido pero no disponible"
fi

has_connectivity() {
  local status
  status=$(nmcli networking connectivity check 2>/dev/null || echo "unknown")
  case "${status,,}" in
    full|portal|limited|local)
      return 0
      ;;
  esac
  return 1
}

list_client_profiles() {
  nmcli -t -f NAME,TYPE,802-11-wireless.mode connection show 2>/dev/null |
    awk -F: -v ap="${AP_NAME}" 'tolower($2)=="802-11-wireless" && tolower($3)=="infrastructure" && $1!=ap {print $1}'
}

ensure_ap_profile() {
  local effective_pass="${AP_PASS:-}" info_line
  if [[ -z "${effective_pass}" ]]; then
    effective_pass="${AP_PASS_DEFAULT}"
  fi

  install -d -m 0755 /etc/NetworkManager/system-connections

  nmcli con down "${AP_NAME}" >/dev/null 2>&1 || true
  nmcli con delete "${AP_NAME}" >/dev/null 2>&1 || true

  if ! nmcli con add type wifi ifname "${AP_IFACE}" con-name "${AP_NAME}" ssid "${AP_SSID}" >/dev/null 2>&1; then
    log "No se pudo crear el perfil ${AP_NAME}"
    return 1
  fi

  nmcli con modify "${AP_NAME}" 802-11-wireless.mode ap 802-11-wireless.band bg 802-11-wireless.channel 6 >/dev/null 2>&1 || true
  nmcli con modify "${AP_NAME}" wifi-sec.key-mgmt wpa-psk wifi-sec.proto rsn wifi-sec.pmf 1 wifi-sec.psk "${effective_pass}" >/dev/null 2>&1 || true
  nmcli con modify "${AP_NAME}" ipv4.method shared ipv4.addresses "${AP_CIDR}" ipv4.gateway "${AP_GATEWAY}" >/dev/null 2>&1 || true
  nmcli con modify "${AP_NAME}" -ipv4.dns >/dev/null 2>&1 || true
  nmcli con modify "${AP_NAME}" ipv4.never-default yes >/dev/null 2>&1 || true
  nmcli con modify "${AP_NAME}" connection.interface-name "${AP_IFACE}" connection.autoconnect no connection.autoconnect-priority 0 >/dev/null 2>&1 || true
  nmcli con modify "${AP_NAME}" ipv6.method ignore >/dev/null 2>&1 || true

  if nmcli con export "${AP_NAME}" "${AP_PROFILE}" >/dev/null 2>&1; then
    chmod 600 "${AP_PROFILE}" >/dev/null 2>&1 || true
    nmcli con delete "${AP_NAME}" >/dev/null 2>&1 || true
    if ! nmcli con load "${AP_PROFILE}" >/dev/null 2>&1; then
      log "No se pudo recargar ${AP_NAME} desde ${AP_PROFILE}"
    fi
    while IFS=: read -r name uuid filename; do
      [[ "${name}" != "${AP_NAME}" ]] && continue
      [[ -z "${uuid}" ]] && continue
      [[ "${filename}" == "${AP_PROFILE}" ]] && continue
      nmcli con delete uuid "${uuid}" >/dev/null 2>&1 || true
    done < <(nmcli -t -f NAME,UUID,FILENAME con show 2>/dev/null || true)
  else
    log "No se pudo exportar ${AP_NAME} a ${AP_PROFILE}"
  fi

  info_line=$(nmcli -t -f NAME,AUTOCONNECT,AUTOCONNECT-PRIORITY,FILENAME con show 2>/dev/null | grep "^${AP_NAME}:" || true)
  [[ -n "${info_line}" ]] && log "Perfil ${AP_NAME} listo: ${info_line}"

  return 0
}

disable_client_autoconnect() {
  local profile
  while IFS= read -r profile; do
    [[ -z "${profile}" ]] && continue
    nmcli con modify "${profile}" connection.autoconnect no connection.autoconnect-priority 0 >/dev/null 2>&1 || true
    nmcli con down "${profile}" >/dev/null 2>&1 || true
  done < <(list_client_profiles)
}

state=$(nmcli -t -f STATE general status 2>/dev/null || echo "disconnected")
state_lc="${state,,}"

if [[ "${state_lc}" == connected* ]]; then
  log "Conectividad presente (${state}); no se activa AP"
  exit 0
fi

if [[ "${state_lc}" == connecting* ]]; then
  log "NetworkManager en estado connecting; esperando hasta 45s"
  end=$((SECONDS + 45))
  while (( SECONDS < end )); do
    if has_connectivity; then
      log "Conectividad detectada durante la espera; no se activa AP"
      exit 0
    fi
    state=$(nmcli -t -f STATE general status 2>/dev/null || echo "disconnected")
    state_lc="${state,,}"
    if [[ "${state_lc}" == connected* ]]; then
      log "NetworkManager pasó a ${state}; no se activa AP"
      exit 0
    fi
    sleep 3
  done
fi

if has_connectivity; then
  log "Conectividad detectada; no se activa AP"
  exit 0
fi

rfkill unblock wifi >/dev/null 2>&1 || true
nmcli radio wifi on >/dev/null 2>&1 || true

if ! ensure_ap_profile; then
  error_exit "No se pudo asegurar el perfil ${AP_NAME}"
fi

disable_client_autoconnect

if nmcli con up "${AP_NAME}" >/dev/null 2>&1; then
  log "${AP_NAME} activa en ${AP_IFACE} (${AP_CIDR})"
  exit 0
fi

error_exit "Fallo al activar ${AP_NAME}"
