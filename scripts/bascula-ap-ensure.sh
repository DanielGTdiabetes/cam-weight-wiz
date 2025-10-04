#!/usr/bin/env bash
set -euo pipefail

LOG_TAG="bascula-ap-ensure"
LOG_FILE="/var/log/bascula-ap.log"
AP_NAME="BasculaAP"
AP_SSID="Bascula-AP"
AP_PSK="Bascula1234"
AP_IFACE="wlan0"
AP_GATEWAY="192.168.4.1"
AP_CIDR="${AP_GATEWAY}/24"
FORCE_FLAG="/run/bascula/force_ap"
NMCLI_BIN="/usr/bin/nmcli"

log_dir="$(dirname "${LOG_FILE}")"
install -d -m 0755 "${log_dir}" 2>/dev/null || true
touch "${LOG_FILE}" 2>/dev/null || true

log_msg() {
  local level="$1"
  shift || true
  local msg="$*"
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  logger -t "${LOG_TAG}" -p "user.${level}" -- "${msg}" 2>/dev/null || true
  printf '%s [%s] %s\n' "${ts}" "${level^^}" "${msg}" >>"${LOG_FILE}" 2>/dev/null || true
}

log_info() { log_msg "info" "$*"; }
log_warn() { log_msg "warn" "$*"; }
log_error() { log_msg "err" "$*"; }

redact_nmcli_args() {
  local -a output=()
  local skip_next=0
  local arg
  for arg in "$@"; do
    if [[ ${skip_next} -eq 1 ]]; then
      output+=("******")
      skip_next=0
      continue
    fi
    case "${arg}" in
      wifi-sec.psk|802-11-wireless-security.psk|password|psk)
        output+=("${arg}")
        skip_next=1
        continue
        ;;
      wifi-sec.psk=*|802-11-wireless-security.psk=*|password=*|psk=*)
        output+=("${arg%%=*}=******")
        continue
        ;;
    esac
    output+=("${arg}")
  done
  if ((${#output[@]} == 0)); then
    printf '%s' ""
    return
  fi
  printf -v _nmcli_safe '%q ' "${output[@]}"
  printf '%s' "${_nmcli_safe% }"
}

run_nmcli() {
  local -a cmd=("${NMCLI_BIN}" "$@")
  local safe
  safe="$(redact_nmcli_args "${cmd[@]}")"
  if ! "${cmd[@]}" >/dev/null 2>&1; then
    local rc=$?
    log_warn "nmcli fallo rc=${rc}: ${safe}"
    return ${rc}
  fi
  log_info "nmcli ok: ${safe}"
  return 0
}

nmcli_available() {
  [[ -x "${NMCLI_BIN}" ]]
}

has_real_connectivity() {
  if nmcli_available; then
    local status
    status="$(${NMCLI_BIN} -g CONNECTIVITY general status 2>/dev/null || true)"
    if [[ "${status,,}" == "full" ]]; then
      return 0
    fi
  fi
  if ping -q -c1 -W3 8.8.8.8 >/dev/null 2>&1; then
    if getent ahostsv4 google.com >/dev/null 2>&1; then
      return 0
    fi
  fi
  return 1
}

ap_is_active() {
  ${NMCLI_BIN} -t -f NAME connection show --active 2>/dev/null | grep -Fxq "${AP_NAME}"
}

ensure_ap_profile() {
  if ! nmcli_available; then
    log_error "nmcli no disponible"
    return 1
  fi

  if ! ${NMCLI_BIN} -t -f NAME connection show "${AP_NAME}" >/dev/null 2>&1; then
    log_info "Creando perfil AP ${AP_NAME}"
    run_nmcli con add type wifi ifname "${AP_IFACE}" con-name "${AP_NAME}" ssid "${AP_SSID}" || true
  else
    log_info "Perfil AP ${AP_NAME} encontrado, actualizando"
  fi

  run_nmcli con modify "${AP_NAME}" 802-11-wireless.ssid "${AP_SSID}" || true
  run_nmcli con modify "${AP_NAME}" 802-11-wireless.mode ap || true
  run_nmcli con modify "${AP_NAME}" 802-11-wireless.band bg || true
  run_nmcli con modify "${AP_NAME}" 802-11-wireless.channel 6 || true
  run_nmcli con modify "${AP_NAME}" wifi-sec.key-mgmt wpa-psk || true
  run_nmcli con modify "${AP_NAME}" wifi-sec.proto rsn || true
  run_nmcli con modify "${AP_NAME}" wifi-sec.pmf 1 || run_nmcli con modify "${AP_NAME}" 802-11-wireless-security.pmf 1 || true
  run_nmcli con modify "${AP_NAME}" wifi-sec.psk "${AP_PSK}" || true
  run_nmcli con modify "${AP_NAME}" ipv4.method shared || true
  run_nmcli con modify "${AP_NAME}" ipv4.addresses "${AP_CIDR}" || true
  run_nmcli con modify "${AP_NAME}" ipv4.gateway "${AP_GATEWAY}" || true
  run_nmcli con modify "${AP_NAME}" ipv4.dns "" || true
  run_nmcli con modify "${AP_NAME}" ipv4.never-default yes || true
  run_nmcli con modify "${AP_NAME}" connection.interface-name "${AP_IFACE}" || true
  run_nmcli con modify "${AP_NAME}" connection.autoconnect no || true
  run_nmcli con modify "${AP_NAME}" connection.autoconnect-priority 0 || true
  run_nmcli con modify "${AP_NAME}" ipv6.method ignore || true
}

disable_client_connections() {
  local -a active
  mapfile -t active < <(${NMCLI_BIN} -t -f NAME,DEVICE connection show --active 2>/dev/null || true)
  local entry name device
  for entry in "${active[@]}"; do
    [[ -z "${entry}" ]] && continue
    name="${entry%%:*}"
    device="${entry##*:}"
    [[ "${device}" != "${AP_IFACE}" ]] && continue
    [[ "${name}" == "${AP_NAME}" ]] && continue
    log_info "Desactivando conexión cliente ${name} en ${device}"
    run_nmcli con down "${name}" || true
  done
  log_info "Desconectando dispositivo ${AP_IFACE}"
  run_nmcli dev disconnect "${AP_IFACE}" || true
}

restart_miniweb() {
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl restart bascula-miniweb >/dev/null 2>&1; then
      log_info "Servicio bascula-miniweb reiniciado"
    else
      log_warn "No se pudo reiniciar bascula-miniweb"
    fi
  else
    log_warn "systemctl no disponible para reiniciar miniweb"
  fi
}

main() {
  log_info "=== Ejecutando ensure AP ==="

  iw reg set ES >/dev/null 2>&1 || log_warn "No se pudo fijar dominio regulatorio ES"
  rfkill unblock wifi >/dev/null 2>&1 || log_warn "No se pudo desbloquear rfkill"
  if nmcli_available; then
    run_nmcli radio wifi on || true
  else
    log_error "nmcli no disponible; abortando"
    return 1
  fi

  local force_ap=0
  if [[ -f "${FORCE_FLAG}" ]]; then
    force_ap=1
    log_info "Flag force_ap detectado; mantener AP forzado"
  fi

  if has_real_connectivity; then
    log_info "Conectividad real detectada"
    if (( force_ap )); then
      log_info "force_ap activo: se preserva el AP"
      return 0
    fi
    if ap_is_active; then
      log_info "Desactivando AP por conectividad existente"
      run_nmcli con down "${AP_NAME}" || true
      run_nmcli dev disconnect "${AP_IFACE}" || true
    else
      log_info "AP ya inactivo"
    fi
    return 0
  fi

  log_info "Sin conectividad real; asegurando AP"
  ensure_ap_profile
  disable_client_connections

  if run_nmcli con up "${AP_NAME}"; then
    log_info "${AP_NAME} activo en ${AP_IFACE} (${AP_CIDR})"
    restart_miniweb
    return 0
  fi

  log_error "No se pudo activar ${AP_NAME}"
  return 1
}

main "$@"
