#!/usr/bin/env bash
#
# Ensure BasculaAP comes up on wlan0 when no other connectivity is available.

set -euo pipefail

log() {
  local msg="$1"
  logger -t bascula-ap-ensure -- "$msg" 2>/dev/null || true
  printf '[bascula-ap-ensure] %s\n' "$msg"
}

trap 'logger -t bascula-ap-ensure "error en línea $LINENO"; exit 1' ERR

AP_NAME="${AP_NAME:-BasculaAP}"
AP_SSID="${AP_SSID:-Bascula-AP}"
AP_PASS_DEFAULT="Bascula1234"
AP_PASS="${AP_PASS:-${AP_PASS_DEFAULT}}"
AP_IFACE="wlan0"
AP_GATEWAY="192.168.4.1"
AP_CIDR="${AP_GATEWAY}/24"
AP_KEYFILE="/etc/NetworkManager/system-connections/${AP_NAME}.nmconnection"

nm-online -s -q -t 25 || true

if ! command -v nmcli >/dev/null 2>&1; then
  log "nmcli requerido pero no disponible; abortando"
  exit 1
fi

has_connectivity() {
  local status
  status=$(nmcli networking connectivity check 2>/dev/null || echo unknown)
  status=${status,,}
  case "${status}" in
    full|portal|limited|local)
      return 0
      ;;
  esac
  return 1
}

list_client_profiles() {
  nmcli -t -f NAME,TYPE,802-11-wireless.mode,connection.autoconnect connection show 2>/dev/null |
    awk -F: -v ap="${AP_NAME}" 'tolower($2)=="802-11-wireless" && tolower($3)=="infrastructure" && tolower($4)=="yes" && $1!=ap {print $1}'
}

cleanup_runtime_duplicates() {
  local target="$1"
  local target_real=""
  if [[ -n "${target}" && -e "${target}" ]]; then
    target_real=$(readlink -f "${target}" 2>/dev/null || echo "")
  fi
  nmcli -t -f NAME,UUID,FILENAME con show 2>/dev/null | while IFS=: read -r name uuid filename; do
    [[ "${name}" != "${AP_NAME}" ]] && continue
    [[ -z "${uuid}" ]] && continue
    if [[ -n "${target_real}" && -n "${filename}" ]]; then
      local fname_real
      fname_real=$(readlink -f "${filename}" 2>/dev/null || echo "")
      if [[ -n "${fname_real}" && "${fname_real}" == "${target_real}" ]]; then
        continue
      fi
    fi
    nmcli con delete uuid "${uuid}" >/dev/null 2>&1 || true
  done
}

ensure_ap_profile() {
  local recreate=0
  local existing_psk=""

  if nmcli connection show "${AP_NAME}" >/dev/null 2>&1; then
    existing_psk="$(nmcli -s -g wifi-sec.psk connection show "${AP_NAME}" 2>/dev/null || echo "")"
    local iface mode method addr gateway dns autoconnect priority
    iface="$(nmcli -g connection.interface-name connection show "${AP_NAME}" 2>/dev/null || echo "")"
    mode="$(nmcli -g 802-11-wireless.mode connection show "${AP_NAME}" 2>/dev/null || echo "")"
    method="$(nmcli -g ipv4.method connection show "${AP_NAME}" 2>/dev/null || echo "")"
    addr="$(nmcli -g ipv4.addresses connection show "${AP_NAME}" 2>/dev/null | head -n1 || echo "")"
    gateway="$(nmcli -g ipv4.gateway connection show "${AP_NAME}" 2>/dev/null || echo "")"
    dns="$(nmcli -g ipv4.dns connection show "${AP_NAME}" 2>/dev/null || echo "")"
    autoconnect="$(nmcli -g connection.autoconnect connection show "${AP_NAME}" 2>/dev/null || echo "")"
    priority="$(nmcli -g connection.autoconnect-priority connection show "${AP_NAME}" 2>/dev/null || echo "")"
    if [[ "${iface}" != "${AP_IFACE}" || "${mode}" != "ap" || "${method}" != "shared" || "${addr}" != "${AP_CIDR}" || "${gateway}" != "${AP_GATEWAY}" || -n "${dns}" || "${autoconnect}" != "no" || "${priority}" != "0" ]]; then
      recreate=1
    fi
  else
    recreate=1
  fi

  local effective_psk="${AP_PASS}"
  [[ -z "${effective_psk}" ]] && effective_psk="${AP_PASS_DEFAULT}"
  [[ -n "${existing_psk}" ]] && effective_psk="${existing_psk}"

  if [[ "${recreate}" -eq 1 ]]; then
    nmcli con delete "${AP_NAME}" >/dev/null 2>&1 || true
    nmcli con add type wifi ifname "${AP_IFACE}" con-name "${AP_NAME}" ssid "${AP_SSID}" >/dev/null 2>&1 || {
      log "No se pudo crear ${AP_NAME}"
      return 1
    }
  fi

  nmcli con modify "${AP_NAME}" connection.interface-name "${AP_IFACE}" >/dev/null 2>&1 || true
  nmcli con modify "${AP_NAME}" 802-11-wireless.mode ap 802-11-wireless.band bg >/dev/null 2>&1 || true
  nmcli con modify "${AP_NAME}" wifi-sec.key-mgmt wpa-psk >/dev/null 2>&1 || true
  nmcli con modify "${AP_NAME}" wifi-sec.psk "${effective_psk}" >/dev/null 2>&1 || true
  nmcli con modify "${AP_NAME}" ipv4.method shared >/dev/null 2>&1 || true
  nmcli con modify "${AP_NAME}" ipv4.addresses "${AP_CIDR}" >/dev/null 2>&1 || true
  nmcli con modify "${AP_NAME}" ipv4.gateway "${AP_GATEWAY}" >/dev/null 2>&1 || true
  nmcli con modify "${AP_NAME}" ipv4.never-default yes >/dev/null 2>&1 || true
  nmcli con modify "${AP_NAME}" -ipv4.dns >/dev/null 2>&1 || true
  nmcli con modify "${AP_NAME}" ipv6.method ignore >/dev/null 2>&1 || true
  nmcli con modify "${AP_NAME}" connection.autoconnect no >/dev/null 2>&1 || true
  nmcli con modify "${AP_NAME}" connection.autoconnect-priority 0 >/dev/null 2>&1 || true

  install -d -m 0755 /etc/NetworkManager/system-connections
  if nmcli con export "${AP_NAME}" "${AP_KEYFILE}" >/dev/null 2>&1; then
    chmod 600 "${AP_KEYFILE}" >/dev/null 2>&1 || true
    nmcli con load "${AP_KEYFILE}" >/dev/null 2>&1 || log "No se pudo recargar ${AP_NAME} desde ${AP_KEYFILE}"
    cleanup_runtime_duplicates "${AP_KEYFILE}"
  else
    log "No se pudo exportar ${AP_NAME} a ${AP_KEYFILE}"
  fi
}

attempt_client_profiles() {
  local profiles=("$@")
  [[ ${#profiles[@]} -eq 0 ]] && return 1

  nmcli device wifi rescan >/dev/null 2>&1 || true
  for profile in "${profiles[@]}"; do
    [[ -z "${profile}" ]] && continue
    log "Intentando activar perfil cliente '${profile}'"
    nmcli con up "${profile}" >/dev/null 2>&1 || true
    for _ in {1..5}; do
      if has_connectivity; then
        log "Conectividad recuperada mediante '${profile}'"
        return 0
      fi
      sleep 3
    done
  done
  return 1
}

rfkill unblock wifi 2>/dev/null || true
nmcli radio wifi on >/dev/null 2>&1 || true

state="$(nmcli -t -f STATE g 2>/dev/null || echo disconnected)"
state_lc="${state,,}"

device_info="$(nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status 2>/dev/null | awk -F: -v iface="${AP_IFACE}" '$1==iface {print $3":"$4; exit}')"
wlan_state="${device_info%%:*}"
wlan_connection="${device_info#*:}"
[[ "${wlan_connection}" == "${device_info}" ]] && wlan_connection=""

mapfile -t client_profiles < <(list_client_profiles)
client_count=${#client_profiles[@]}

if [[ "${state_lc}" == connected* ]]; then
  if [[ "${wlan_connection}" == "${AP_NAME}" && ${client_count} -gt 0 ]]; then
    log "Conectividad presente con ${AP_NAME} activo; intentando perfiles cliente"
    nmcli con down "${AP_NAME}" >/dev/null 2>&1 || true
    if attempt_client_profiles "${client_profiles[@]}"; then
      exit 0
    fi
    log "No se consiguió cliente; reactivando ${AP_NAME}" 
    nmcli con up "${AP_NAME}" >/dev/null 2>&1 || true
  else
    log "Conectividad presente (${state}); no se requiere AP"
  fi
  exit 0
fi

if [[ "${state_lc}" == connecting* ]]; then
  log "NetworkManager en estado connecting; esperando hasta 45s"
  end=$((SECONDS + 45))
  while (( SECONDS < end )); do
    if has_connectivity; then
      log "Conectividad recuperada durante la espera"
      exit 0
    fi
    state_now="$(nmcli -t -f STATE g 2>/dev/null || echo disconnected)"
    state_now_lc="${state_now,,}"
    if [[ "${state_now_lc}" == connected* ]]; then
      log "NetworkManager pasó a ${state_now}; no se requiere AP"
      exit 0
    fi
    sleep 3
  done
fi

if has_connectivity; then
  log "Conectividad detectada tras espera; no se sube AP"
  exit 0
fi

if [[ ${client_count} -gt 0 ]]; then
  log "Sin conectividad; intentando perfiles cliente persistentes"
  if nmcli -t -f NAME con show --active 2>/dev/null | grep -qx "${AP_NAME}"; then
    nmcli con down "${AP_NAME}" >/dev/null 2>&1 || true
  fi
  if attempt_client_profiles "${client_profiles[@]}"; then
    exit 0
  fi
fi

log "Sin conectividad válida; asegurando ${AP_NAME}"
ensure_ap_profile || {
  log "No se pudo asegurar el perfil ${AP_NAME}"
  exit 1
}

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl disable --now dnsmasq 2>/dev/null || true
fi

if nmcli con up "${AP_NAME}" >/dev/null 2>&1; then
  log "${AP_NAME} activada en ${AP_IFACE} (${AP_CIDR})"
  exit 0
fi

log "Fallo al activar ${AP_NAME}"
exit 1
