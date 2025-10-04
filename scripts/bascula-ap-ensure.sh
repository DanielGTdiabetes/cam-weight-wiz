#!/usr/bin/env bash
#
# Ensure BasculaAP comes up on wlan0 when no other connectivity is available.
# Compatible with systems with or without systemd.

set -euo pipefail

TMP_LOG="$(mktemp -t bascula-ap-ensure.XXXXXX 2>/dev/null || printf '/tmp/bascula-ap-ensure.%s' "$$")"

trap 'logger -t bascula-ap-ensure "error en línea $LINENO"; echo "[bascula-ap-ensure] error en línea $LINENO" >&2' ERR
trap 'rm -f "${TMP_LOG}" 2>/dev/null || true' EXIT

log() {
  logger -t bascula-ap-ensure -- "$1" 2>/dev/null || true
  printf '[bascula-ap-ensure] %s\n' "$1"
}

AP_NAME="${AP_NAME:-BasculaAP}"
AP_IFACE="wlan0"
AP_SSID="${AP_SSID:-Bascula-AP}"
AP_PASS_DEFAULT="Bascula1234"
AP_PASS="${AP_PASS:-${AP_PASS_DEFAULT}}"
AP_GATEWAY="192.168.4.1"
AP_CIDR="${AP_GATEWAY}/24"

if ! command -v nmcli >/dev/null 2>&1; then
  log "nmcli requerido para gestionar ${AP_NAME}; abortando"
  exit 1
fi


: "${AP_ENSURE_CONNECTING_WAIT:=45}"
: "${AP_ENSURE_CONNECTING_STEP:=3}"

state="$(nmcli -t -f STATE g 2>/dev/null || echo disconnected)"
case "${state}" in
  connected)
    log "NM=connected → no AP"
    exit 0
    ;;
  connecting)
    log "NM=connecting → esperando hasta ${AP_ENSURE_CONNECTING_WAIT}s"
    t_end=$(( $(date +%s) + AP_ENSURE_CONNECTING_WAIT ))
    timed_out=1
    while [ "$(date +%s)" -lt "${t_end}" ]; do
      if nmcli networking connectivity check 2>/dev/null | grep -qiE 'full|portal|limited'; then
        log "Conectividad conseguida durante espera → no AP"
        exit 0
      fi

      st="$(nmcli -t -f STATE g 2>/dev/null || echo disconnected)"
      if [ "${st}" = "connected" ]; then
        log "NM=connected tras espera → no AP"
        exit 0
      elif [ "${st}" = "disconnected" ] || [ "${st}" = "asleep" ] || [ "${st}" = "unknown" ]; then
        log "NM=${st} tras espera → proceder a AP"
        timed_out=0
        break
      fi

      sleep "${AP_ENSURE_CONNECTING_STEP}"
    done
    if [ "${timed_out}" -eq 1 ]; then
      log "Sin conectividad tras ${AP_ENSURE_CONNECTING_WAIT}s adicionales → proceder a AP"
    fi
    ;;
  *)
    log "NM state=${state}; continuando con validaciones"
    ;;
esac

if nmcli networking connectivity check 2>/dev/null | grep -qiE 'full|portal|limited'; then
  log "Conectividad disponible en último momento → no AP"
  exit 0
fi

connectivity="$(nmcli networking connectivity check 2>/dev/null || echo 'unknown')"
case "${connectivity}" in
  full|internet|portal|limited)
    log "Conectividad (${connectivity}); bajando ${AP_NAME} si está activo"
    if nmcli -t -f NAME con show --active 2>/dev/null | grep -qx "${AP_NAME}"; then
      if nmcli connection down "${AP_NAME}" >/dev/null 2>&1; then
        log "${AP_NAME} desactivada por conectividad existente"
      fi
    fi
    exit 0
    ;;
esac

log "Sin conectividad tras espera; preparando ${AP_NAME} en ${AP_IFACE}"
rfkill unblock wifi 2>/dev/null || true
nmcli radio wifi on >/dev/null 2>&1 || true

ensure_profile() {
  local recreate=0
  if ! nmcli connection show "${AP_NAME}" >/dev/null 2>&1; then
    recreate=1
  else
    local iface mode ipv4_method ipv4_addr ipv4_gw ipv4_dns key_mgmt
    iface="$(nmcli -g connection.interface-name connection show "${AP_NAME}" 2>/dev/null || echo '')"
    mode="$(nmcli -g 802-11-wireless.mode connection show "${AP_NAME}" 2>/dev/null || echo '')"
    ipv4_method="$(nmcli -g ipv4.method connection show "${AP_NAME}" 2>/dev/null || echo '')"
    ipv4_addr="$(nmcli -g ipv4.addresses connection show "${AP_NAME}" 2>/dev/null | head -n1 || echo '')"
    ipv4_gw="$(nmcli -g ipv4.gateway connection show "${AP_NAME}" 2>/dev/null || echo '')"
    ipv4_dns="$(nmcli -g ipv4.dns connection show "${AP_NAME}" 2>/dev/null || echo '')"
    key_mgmt="$(nmcli -g wifi-sec.key-mgmt connection show "${AP_NAME}" 2>/dev/null || echo '')"
    [[ "${iface}" != "${AP_IFACE}" ]] && recreate=1
    [[ "${mode}" != "ap" ]] && recreate=1
    [[ "${ipv4_method}" != "shared" ]] && recreate=1
    [[ "${ipv4_addr}" != "${AP_CIDR}" ]] && recreate=1
    [[ "${ipv4_gw}" != "${AP_GATEWAY}" ]] && recreate=1
    [[ -n "${ipv4_dns}" ]] && recreate=1
    [[ "${key_mgmt}" != "wpa-psk" ]] && recreate=1
  fi

  local effective_psk="${AP_PASS}"
  if [[ "${recreate}" -eq 0 ]]; then
    local existing_psk
    existing_psk="$(nmcli -s -g wifi-sec.psk connection show "${AP_NAME}" 2>/dev/null || echo '')"
    [[ -n "${existing_psk}" ]] && effective_psk="${existing_psk}"
    nmcli connection modify "${AP_NAME}" connection.autoconnect yes connection.autoconnect-priority 100 >/dev/null 2>&1 || true
    return 0
  fi

  log "Recreando perfil ${AP_NAME}"
  local previous_psk
  previous_psk="$(nmcli -s -g wifi-sec.psk connection show "${AP_NAME}" 2>/dev/null || echo '')"
  [[ -n "${previous_psk}" ]] && effective_psk="${previous_psk}"

  nmcli connection delete "${AP_NAME}" >/dev/null 2>&1 || true
  nmcli con delete "BasculaAP" >/dev/null 2>&1 || true
  sudo rm -f /etc/NetworkManager/system-connections/BasculaAP.nmconnection 2>/dev/null || true

  if ! nmcli connection add type wifi ifname "${AP_IFACE}" con-name "${AP_NAME}" ssid "${AP_SSID}" >/dev/null 2>&1; then
    log "Error al crear el perfil ${AP_NAME}"
    nmcli dev status || true
    nmcli -t -f NAME,TYPE,DEVICE con show || true
    nmcli -g connection.interface-name,802-11-wireless.mode,ipv4.method,ipv4.addresses,ipv4.gateway,ipv4.dns con show "${AP_NAME}" || true
    return 1
  fi

  nmcli connection modify "${AP_NAME}" connection.interface-name "${AP_IFACE}" 802-11-wireless.mode ap 802-11-wireless.band bg >/dev/null 2>&1 || return 1
  nmcli connection modify "${AP_NAME}" ipv4.method shared ipv4.addresses "${AP_CIDR}" ipv4.gateway "${AP_GATEWAY}" ipv4.never-default yes >/dev/null 2>&1 || return 1
  nmcli connection modify "${AP_NAME}" -ipv4.dns >/dev/null 2>&1 || true
  nmcli connection modify "${AP_NAME}" ipv6.method ignore >/dev/null 2>&1 || true
  nmcli connection modify "${AP_NAME}" wifi-sec.key-mgmt wpa-psk >/dev/null 2>&1 || return 1

  [[ -z "${effective_psk}" ]] && effective_psk="${AP_PASS_DEFAULT}"
  nmcli connection modify "${AP_NAME}" wifi-sec.psk "${effective_psk}" >/dev/null 2>&1 || return 1
  nmcli connection modify "${AP_NAME}" connection.autoconnect yes connection.autoconnect-priority 100 >/dev/null 2>&1 || return 1
  return 0
}

if ! ensure_profile; then
  log "No se pudo asegurar el perfil ${AP_NAME}"
  exit 1
fi

if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  systemctl disable --now dnsmasq 2>/dev/null || true
elif command -v service >/dev/null 2>&1; then
  service dnsmasq stop >/dev/null 2>&1 || true
fi

if ! nmcli dev status 2>/dev/null | awk -v iface="${AP_IFACE}" 'NR>1 && $1 == iface {found=1} END {exit found?0:1}'; then
  log "Interfaz ${AP_IFACE} no listada por nmcli; reintento posterior"
  exit 75
fi

log "Activando ${AP_NAME}"
if nmcli connection up "${AP_NAME}" ifname "${AP_IFACE}" >"${TMP_LOG}" 2>&1; then
  while IFS= read -r line; do log "${line}"; done < "${TMP_LOG}" || true
  sleep 1
  log "${AP_NAME} activo en ${AP_IFACE} (${AP_CIDR})"
  exit 0
fi

rc=$?
log "Fallo al activar ${AP_NAME} (rc=${rc})"
if [[ -s "${TMP_LOG}" ]]; then
  while IFS= read -r line; do log "${line}"; done < "${TMP_LOG}" || true
fi

if grep -qiE 'No device|not find device|not available|device not managed' "${TMP_LOG}" 2>/dev/null; then
  log "Interfaz ${AP_IFACE} no disponible; reintento posterior"
  exit 75
fi

exit "${rc}"
