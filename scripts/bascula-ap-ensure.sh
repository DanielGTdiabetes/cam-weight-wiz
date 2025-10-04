#!/usr/bin/env bash
#
# Ensure the Bascula access point only comes up when there is no real connectivity
# and at least one configured client profile is failing.

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
AP_PASS_DEFAULT="Bascula1234"
AP_PASS="${AP_PASS:-${AP_PASS_DEFAULT}}"
AP_IFACE="${AP_IFACE:-wlan0}"
AP_GATEWAY="192.168.4.1"
AP_CIDR="${AP_GATEWAY}/24"
AP_PROFILE_DIR="/etc/NetworkManager/system-connections"

if ! command -v nmcli >/dev/null 2>&1; then
  error_exit "nmcli requerido pero no disponible"
fi

real_connectivity() {
  local status
  status=$(nmcli networking connectivity check 2>/dev/null || echo "unknown")
  case "${status,,}" in
    full|portal)
      return 0
      ;;
  esac

  if ping -q -c 1 -W 3 1.1.1.1 >/dev/null 2>&1; then
    return 0
  fi

  if getent ahostsv4 debian.org >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

list_client_profiles() {
  nmcli -t --separator '|' -f NAME,TYPE,802-11-wireless.mode,AUTOCONNECT connection show 2>/dev/null |
    awk -F'|' -v ap="${AP_NAME}" 'tolower($2)=="802-11-wireless" && tolower($3)=="infrastructure" && $1!=ap {print $1 "|" $4}'
}

ensure_ap_profile() {
  install -d -m 0755 "${AP_PROFILE_DIR}"

  if ! nmcli -t -f NAME connection show "${AP_NAME}" >/dev/null 2>&1; then
    nmcli connection add type wifi ifname "${AP_IFACE}" con-name "${AP_NAME}" ssid "${AP_SSID}" \
      ipv4.method shared ipv4.addresses "${AP_CIDR}" ipv4.gateway "${AP_GATEWAY}" \
      802-11-wireless.mode ap wifi-sec.key-mgmt wpa-psk wifi-sec.psk "${AP_PASS}" >/dev/null 2>&1 || \
      error_exit "No se pudo crear el perfil ${AP_NAME}"
  else
    nmcli connection modify "${AP_NAME}" 802-11-wireless.mode ap \
      wifi-sec.key-mgmt wpa-psk wifi-sec.psk "${AP_PASS}" >/dev/null 2>&1 || true
  fi

  nmcli connection modify "${AP_NAME}" \
    connection.autoconnect no \
    connection.autoconnect-priority 0 \
    connection.interface-name "${AP_IFACE}" \
    802-11-wireless.band bg \
    ipv4.method shared \
    ipv4.addresses "${AP_CIDR}" \
    ipv4.gateway "${AP_GATEWAY}" \
    ipv4.never-default yes \
    ipv6.method ignore >/dev/null 2>&1 || true
}

activate_client_profiles() {
  local profile autocon
  while IFS='|' read -r profile autocon; do
    [[ -z "${profile}" ]] && continue
    if real_connectivity; then
      return 0
    fi
    if [[ "${autocon}" != "yes" ]]; then
      continue
    fi
    log "Intentando activar perfil Wi-Fi '${profile}'"
    nmcli connection up "${profile}" >/dev/null 2>&1 || true
    sleep 5
    if real_connectivity; then
      return 0
    fi
  done
  return 1
}

count_failing_profiles() {
  local profile autocon failures=0 total=0 active
  mapfile -t active < <(nmcli -t --separator '|' -f NAME connection show --active 2>/dev/null || true)
  while IFS='|' read -r profile autocon; do
    [[ -z "${profile}" ]] && continue
    [[ "${autocon}" != "yes" ]] && continue
    (( total++ ))
    local is_active=0
    for entry in "${active[@]}"; do
      [[ "${entry}" == "${profile}" ]] && { is_active=1; break; }
    done
    if (( is_active == 0 )); then
      (( failures++ ))
    fi
  done

  if (( failures == 0 && total > 0 )); then
    failures=${total}
  fi

  echo "${failures}"
}

main() {
  nmcli radio wifi on >/dev/null 2>&1 || true

  if real_connectivity; then
    log "Conectividad detectada; no se activa AP"
    exit 0
  fi

  mapfile -t client_profiles < <(list_client_profiles)

  if (( ${#client_profiles[@]} == 0 )); then
    log "Sin perfiles Wi-Fi cliente configurados; no se activa AP"
    exit 0
  fi

  printf '%s\n' "${client_profiles[@]}" | activate_client_profiles || true

  if real_connectivity; then
    log "Conectividad restaurada tras reintentar perfiles cliente"
    exit 0
  fi

  local failures
  failures=$(printf '%s\n' "${client_profiles[@]}" | count_failing_profiles)

  if [[ -z "${failures}" || "${failures}" == "0" ]]; then
    log "No hay perfiles cliente fallando; no se activa AP"
    exit 0
  fi

  ensure_ap_profile

  nmcli device disconnect "${AP_IFACE}" >/dev/null 2>&1 || true
  nmcli connection down "${AP_NAME}" >/dev/null 2>&1 || true

  if nmcli connection up "${AP_NAME}" >/dev/null 2>&1; then
    log "${AP_NAME} activo en ${AP_IFACE} (${AP_CIDR})"
    exit 0
  fi

  error_exit "Fallo al activar ${AP_NAME}"
}

main "$@"
