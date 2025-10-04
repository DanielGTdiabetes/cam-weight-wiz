#!/usr/bin/env bash
#
# net-fallback.sh - WiFi AP fallback automático
# Detecta si hay conectividad a Internet. Si no, activa AP mode.
# Se ejecuta via systemd timer cada 30 segundos
#

set -euo pipefail

log() { logger -t bascula-net-fallback "$*"; }

# Configuración
AP_SSID="${AP_SSID:-Bascula-AP}"
AP_PASS="${AP_PASS:-bascula2025}"
AP_IFACE="${AP_IFACE:-wlan0}"
AP_NAME="${AP_NAME:-BasculaAP}"
AP_GATEWAY="${AP_GATEWAY:-192.168.4.1}"
AP_POOL_START="${AP_POOL_START:-192.168.4.20}"
AP_POOL_END="${AP_POOL_END:-192.168.4.99}"

set_ap_autoconnect() {
  local enabled="$1"
  local priority="$2"
  local value="no"
  if [[ "${enabled}" == "yes" ]]; then
    value="yes"
  fi
  nmcli connection modify "${AP_NAME}" \
    connection.autoconnect "${value}" \
    connection.autoconnect-priority "${priority}" \
    connection.interface-name "${AP_IFACE}" >/dev/null 2>&1 || true
}

# Verificar si hay conexión a Internet
have_inet() {
  curl -fsI -m 4 https://deb.debian.org >/dev/null 2>&1 || \
  curl -fsI -m 4 https://www.piwheels.org/simple >/dev/null 2>&1
}

# Verificar si WiFi está conectado y activo
wifi_active() {
  nmcli -t -f TYPE,STATE connection show --active 2>/dev/null | grep -q '^wifi:activated$'
}

# Verificar si Ethernet está conectada
ethernet_active() {
  local line
  while IFS=: read -r device type state rest; do
    if [[ -z "${device}" || -z "${type}" || -z "${state}" ]]; then
      continue
    fi
    if [[ "${type}" == "ethernet" && "${state}" == connected* ]]; then
      return 0
    fi
  done < <(nmcli -t -f DEVICE,TYPE,STATE device status 2>/dev/null || true)
  return 1
}

# Verificar si AP está activo
ap_active() {
  nmcli -t -f NAME,DEVICE connection show --active 2>/dev/null | grep -q "^${AP_NAME}:"
}

# Verificar si el perfil AP existe
ap_profile_exists() {
  nmcli -t -f NAME connection show 2>/dev/null | grep -qx "${AP_NAME}"
}

# Crear perfil AP si no existe
create_ap_profile() {
  log "Creando perfil AP: ${AP_NAME}"

  nmcli connection add type wifi ifname "${AP_IFACE}" \
    con-name "${AP_NAME}" \
    autoconnect no \
    ssid "${AP_SSID}" 2>/dev/null || return 1

  if ! nmcli connection modify "${AP_NAME}" \
    802-11-wireless.mode ap \
    802-11-wireless.band bg \
    ipv4.method shared \
    ipv4.addresses "${AP_GATEWAY}/24" \
    ipv4.gateway "${AP_GATEWAY}" \
    ipv4.dns "${AP_GATEWAY}" \
    ipv6.method ignore 2>/dev/null; then
    return 1
  fi

  nmcli connection modify "${AP_NAME}" \
    ipv4.dhcp-server.address-pool-start "${AP_POOL_START}" \
    ipv4.dhcp-server.address-pool-end "${AP_POOL_END}" \
    ipv4.dhcp-server.gateway "${AP_GATEWAY}" \
    ipv4.dhcp-server.default-route yes \
    ipv4.dhcp-server.dns "${AP_GATEWAY}" >/dev/null 2>&1 || true

  if [[ -n "${AP_PASS}" ]]; then
    nmcli connection modify "${AP_NAME}" \
      802-11-wireless-security.key-mgmt wpa-psk \
      802-11-wireless-security.psk "${AP_PASS}" 2>/dev/null || return 1
  fi
  
  log "Perfil AP creado exitosamente"
  return 0
}

# Activar AP mode
activate_ap() {
  log "Activando AP mode: ${AP_SSID}"

  # Asegurarse de que WiFi está habilitado
  rfkill unblock wifi 2>/dev/null || true
  nmcli radio wifi on >/dev/null 2>&1 || true

  set_ap_autoconnect yes 50

  # Activar el perfil AP
  if nmcli connection up "${AP_NAME}" ifname "${AP_IFACE}" 2>/dev/null; then
    log "AP mode activado exitosamente"
    return 0
  else
    log "Error al activar AP mode"
    return 1
  fi
}

# Desactivar AP mode
deactivate_ap() {
  log "Desactivando AP mode"
  nmcli connection down "${AP_NAME}" 2>/dev/null || true
  set_ap_autoconnect no -999
}

# Intentar reconectar WiFi
try_reconnect_wifi() {
  log "Intentando reconectar WiFi..."
  
  # Rescan WiFi
  nmcli device wifi rescan ifname "${AP_IFACE}" >/dev/null 2>&1 || true
  sleep 2
  
  # Intentar conectar a WiFi guardado
  local saved_wifi
  saved_wifi="$(nmcli -t -f NAME,TYPE connection show | grep ':802-11-wireless$' | grep -v "${AP_NAME}" | cut -d: -f1 | head -n1)"
  
  if [[ -n "${saved_wifi}" ]]; then
    log "Intentando conectar a: ${saved_wifi}"
    nmcli connection up "${saved_wifi}" ifname "${AP_IFACE}" >/dev/null 2>&1 || true
    sleep 3
  fi
}

# Main logic
main() {
  # Verificar que NetworkManager está corriendo
  if ! systemctl is-active --quiet NetworkManager; then
    log "ERROR: NetworkManager no está activo"
    exit 1
  fi

  # Crear perfil AP si no existe
  if ! ap_profile_exists; then
    if ! create_ap_profile; then
      log "ERROR: No se pudo crear perfil AP"
      exit 1
    fi
  fi

  if wifi_active || ethernet_active; then
    set_ap_autoconnect no -999
  else
    set_ap_autoconnect yes 50
  fi

  if ethernet_active; then
    log "Ethernet activa detectada; no se activará el AP"
    if ap_active; then
      deactivate_ap
    fi
    set_ap_autoconnect no -999
    exit 0
  fi

  # Verificar conectividad
  if have_inet; then
    # Tenemos Internet, desactivar AP si está activo
    if ap_active; then
      log "Internet disponible, desactivando AP"
      deactivate_ap
    fi
    set_ap_autoconnect no -999
    # Todo OK
    exit 0
  fi
  
  # No hay Internet
  log "Sin conectividad a Internet detectada"
  
  # Si ya está en AP mode, no hacer nada
  if ap_active; then
    log "AP mode ya está activo"
    exit 0
  fi
  
  # Intentar reconectar WiFi primero
  if wifi_active; then
    log "WiFi conectado pero sin Internet, reintentando..."
    try_reconnect_wifi
    
    # Verificar de nuevo
    if have_inet; then
      log "Reconexión WiFi exitosa"
      exit 0
    fi
  fi
  
  # Última opción: activar AP
  log "Activando fallback AP mode"
  activate_ap
}

main "$@"
