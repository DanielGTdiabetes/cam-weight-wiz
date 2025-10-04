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
AP_IFACE="${AP_IFACE:-wlan0}"
AP_SSID="${AP_SSID:-Bascula-AP}"
AP_PASS_DEFAULT="Bascula1234"
AP_PASS="${AP_PASS:-${AP_PASS_DEFAULT}}"
AP_GATEWAY="${AP_GATEWAY:-192.168.4.1}"
AP_CIDR="${AP_GATEWAY}/24"

has_connectivity=0
if command -v nmcli >/dev/null 2>&1; then
  state="$(nmcli -t -f STATE general status 2>/dev/null || true)"
  [[ "${state}" == "connected" ]] && has_connectivity=1
  if [[ "${has_connectivity}" -eq 0 ]]; then
    connectivity="$(nmcli networking connectivity check 2>/dev/null || true)"
    case "${connectivity}" in
      full|internet)
        has_connectivity=1
        ;;
    esac
  fi
fi

if [[ "${has_connectivity}" -eq 0 ]] && ip -4 route show default >/dev/null 2>&1; then
  has_connectivity=1
fi

if [[ "${has_connectivity}" -eq 1 ]]; then
  log "Conectividad detectada; asegurando que ${AP_NAME} esté bajada"
  if command -v nmcli >/dev/null 2>&1; then
    if nmcli -t -f NAME con show --active 2>/dev/null | grep -qx "${AP_NAME}"; then
      if nmcli connection down "${AP_NAME}" >/dev/null 2>&1; then
        log "${AP_NAME} desactivada por conectividad activa"
      fi
    fi
  fi
  exit 0
fi

if ! command -v nmcli >/dev/null 2>&1; then
  log "nmcli requerido para gestionar ${AP_NAME}; abortando"
  exit 1
fi

log "Sin conectividad; preparando ${AP_NAME} en ${AP_IFACE}"
rfkill unblock wifi 2>/dev/null || true
nmcli radio wifi on >/dev/null 2>&1 || true

ensure_profile() {
  local recreate=0
  if ! nmcli connection show "${AP_NAME}" >/dev/null 2>&1; then
    recreate=1
  else
    local iface mode ipv4_method ipv4_addr ipv4_gw ipv4_dns
    iface="$(nmcli -g connection.interface-name connection show "${AP_NAME}" 2>/dev/null || echo '')"
    mode="$(nmcli -g 802-11-wireless.mode connection show "${AP_NAME}" 2>/dev/null || echo '')"
    ipv4_method="$(nmcli -g ipv4.method connection show "${AP_NAME}" 2>/dev/null || echo '')"
    ipv4_addr="$(nmcli -g ipv4.addresses connection show "${AP_NAME}" 2>/dev/null || echo '')"
    ipv4_gw="$(nmcli -g ipv4.gateway connection show "${AP_NAME}" 2>/dev/null || echo '')"
    ipv4_dns="$(nmcli -g ipv4.dns connection show "${AP_NAME}" 2>/dev/null || echo '')"
    [[ "${iface}" != "${AP_IFACE}" ]] && recreate=1
    [[ "${mode}" != "ap" ]] && recreate=1
    [[ "${ipv4_method}" != "shared" ]] && recreate=1
    [[ "${ipv4_addr}" != "${AP_CIDR}" ]] && recreate=1
    [[ "${ipv4_gw}" != "${AP_GATEWAY}" ]] && recreate=1
    [[ -n "${ipv4_dns}" ]] && recreate=1
  fi

  if [[ "${recreate}" -eq 0 ]]; then
    local existing_psk
    existing_psk="$(nmcli -s -g wifi-sec.psk connection show "${AP_NAME}" 2>/dev/null || echo '')"
    [[ -n "${existing_psk}" ]] && AP_PASS="${existing_psk}"
    nmcli connection modify "${AP_NAME}" connection.autoconnect yes connection.autoconnect-priority 100 >/dev/null 2>&1 || true
    return 0
  fi

  log "Recreando perfil ${AP_NAME}"
  nmcli connection delete "${AP_NAME}" >/dev/null 2>&1 || true
  if ! nmcli connection add type wifi ifname "${AP_IFACE}" con-name "${AP_NAME}" ssid "${AP_SSID}" >/dev/null 2>&1; then
    log "Error al crear el perfil ${AP_NAME}"
    return 1
  fi

  nmcli connection modify "${AP_NAME}" \
    connection.interface-name "${AP_IFACE}" \
    802-11-wireless.mode ap \
    802-11-wireless.band bg \
    ipv4.method shared \
    ipv4.addresses "${AP_CIDR}" \
    ipv4.gateway "${AP_GATEWAY}" \
    ipv4.never-default yes \
    -ipv4.dns \
    ipv6.method ignore >/dev/null 2>&1 || return 1

  if [[ -n "${AP_PASS}" ]]; then
    nmcli connection modify "${AP_NAME}" wifi-sec.key-mgmt wpa-psk wifi-sec.psk "${AP_PASS}" >/dev/null 2>&1 || return 1
  else
    nmcli connection modify "${AP_NAME}" wifi-sec.key-mgmt none >/dev/null 2>&1 || return 1
  fi

  nmcli connection modify "${AP_NAME}" connection.autoconnect yes connection.autoconnect-priority 100 >/dev/null 2>&1 || return 1
  return 0
}

if ! ensure_profile; then
  log "No se pudo asegurar el perfil ${AP_NAME}"
  exit 1
fi

if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now dnsmasq 2>/dev/null || true
else
  if command -v service >/dev/null 2>&1; then
    service dnsmasq stop >/dev/null 2>&1 || true
  fi
fi

log "Activando ${AP_NAME}"
if nmcli connection up "${AP_NAME}" ifname "${AP_IFACE}" >"${TMP_LOG}" 2>&1; then
  while IFS= read -r line; do log "${line}"; done < "${TMP_LOG}" || true
  log "${AP_NAME} activo en ${AP_IFACE} (${AP_CIDR})"
  exit 0
fi

log "Fallo al activar ${AP_NAME}"
if [[ -s "${TMP_LOG}" ]]; then
  while IFS= read -r line; do log "${line}"; done < "${TMP_LOG}" || true
fi
exit 1
