#!/usr/bin/env bash
#
# Ensure the Bascula access point is only active when connectivity provisioning is required.

set -euo pipefail

AP_NAME="${AP_NAME:-BasculaAP}"
AP_SSID="${AP_SSID:-Bascula-AP}"
AP_PSK="${AP_PSK:-${AP_PASS:-Bascula1234}}"
AP_IFACE="${AP_IFACE:-wlan0}"
AP_GATEWAY="192.168.4.1"
AP_CIDR="${AP_GATEWAY}/24"
AP_PROFILE_DIR="/etc/NetworkManager/system-connections"
AP_PROFILE_PATH="${AP_PROFILE_DIR}/${AP_NAME}.nmconnection"
FORCE_AP_FLAG="/run/bascula/force_ap"
MINIWEB_SERVICE="bascula-miniweb"

NMCLI_BIN="${NMCLI_BIN:-$(command -v nmcli 2>/dev/null || true)}"
if [[ -z "${NMCLI_BIN}" ]]; then
  printf '[bascula-ap-ensure][err] nmcli requerido pero no disponible\n' >&2
  exit 1
fi

log_msg() {
  local level="$1"
  shift || true
  local msg="$*"
  local tag="bascula-ap-ensure"
  logger -t "${tag}" -- "${level}: ${msg}" 2>/dev/null || true
  local prefix="[${tag}]"
  case "${level}" in
    ERROR)
      printf '%s[err] %s\n' "${prefix}" "${msg}" >&2
      ;;
    WARN)
      printf '%s[warn] %s\n' "${prefix}" "${msg}"
      ;;
    *)
      printf '%s %s\n' "${prefix}" "${msg}"
      ;;
  esac
}

log_info() {
  log_msg "INFO" "$*"
}

log_warn() {
  log_msg "WARN" "$*"
}

log_error() {
  log_msg "ERROR" "$*"
}

redact_nmcli_args() {
  local -a args=("$@")
  local -a redacted=()
  local redact_next=0
  local arg lower
  for arg in "${args[@]}"; do
    lower="${arg,,}"
    if (( redact_next )); then
      redacted+=("******")
      redact_next=0
      continue
    fi
    case "${lower}" in
      *psk*|*password*)
        if [[ "${arg}" == *=* ]]; then
          redacted+=("${arg%%=*}=******")
        else
          redacted+=("${arg}")
          redact_next=1
        fi
        continue
        ;;
    esac
    redacted+=("${arg}")
  done

  local output=""
  local piece
  for piece in "${redacted[@]}"; do
    if [[ -z "${output}" ]]; then
      printf -v output '%q' "${piece}"
    else
      printf -v output '%s %q' "${output}" "${piece}"
    fi
  done
  printf '%s' "${output}"
}

run_nmcli() {
  local -a cmd=("${NMCLI_BIN}" "$@")
  local safe
  safe="$(redact_nmcli_args "${cmd[@]}")"
  if "${cmd[@]}" >/dev/null 2>&1; then
    log_info "nmcli ok: ${safe}"
    return 0
  else
    local rc=$?
    log_warn "nmcli fallo rc=${rc}: ${safe}"
    return ${rc}
  fi
}

has_saved_wifi_profiles() {
  local line
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    local type="${line%%:*}"
    local rest="${line#*:}"
    local autocon="${rest%%:*}"
    if [[ "${type}" == "802-11-wireless" && "${autocon,,}" == "yes" ]]; then
      return 0
    fi
  done < <("${NMCLI_BIN}" -t -f TYPE,AUTOCONNECT,NAME connection show 2>/dev/null || true)
  return 1
}

disable_client_connections() {
  local -a active
  mapfile -t active < <("${NMCLI_BIN}" -t -f NAME,DEVICE connection show --active 2>/dev/null || true)
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
}

ensure_ap_profile() {
  if ! "${NMCLI_BIN}" -t -f NAME connection show "${AP_NAME}" >/dev/null 2>&1; then
    log_info "Creando perfil AP ${AP_NAME}"
    run_nmcli con add type wifi ifname "${AP_IFACE}" con-name "${AP_NAME}" ssid "${AP_SSID}" || true
  fi
  run_nmcli con modify "${AP_NAME}" 802-11-wireless.ssid "${AP_SSID}" || true
  run_nmcli con modify "${AP_NAME}" 802-11-wireless.mode ap || true
  run_nmcli con modify "${AP_NAME}" 802-11-wireless.band bg || true
  run_nmcli con modify "${AP_NAME}" 802-11-wireless.channel 1 || true
  run_nmcli con modify "${AP_NAME}" wifi-sec.key-mgmt wpa-psk || true
  run_nmcli con modify "${AP_NAME}" wifi-sec.proto rsn || true
  run_nmcli con modify "${AP_NAME}" wifi-sec.pmf 2 || run_nmcli con modify "${AP_NAME}" 802-11-wireless-security.pmf 2 || true
  run_nmcli con modify "${AP_NAME}" wifi-sec.psk "${AP_PSK}" || true
  run_nmcli con modify "${AP_NAME}" ipv4.method shared || true
  run_nmcli con modify "${AP_NAME}" ipv4.addresses "${AP_CIDR}" || true
  run_nmcli con modify "${AP_NAME}" ipv4.gateway "${AP_GATEWAY}" || true
  run_nmcli con modify "${AP_NAME}" ipv4.never-default yes || true
  run_nmcli con modify "${AP_NAME}" connection.interface-name "${AP_IFACE}" || true
  run_nmcli con modify "${AP_NAME}" connection.autoconnect no || true
  run_nmcli con modify "${AP_NAME}" connection.autoconnect-priority 0 || true
  run_nmcli con modify "${AP_NAME}" ipv6.method ignore || true

  install -d -m 700 "${AP_PROFILE_DIR}"
  local tmp_profile
  tmp_profile="$(mktemp)"
  if run_nmcli con export "${AP_NAME}" "${tmp_profile}"; then
    install -D -m 600 "${tmp_profile}" "${AP_PROFILE_PATH}" || log_warn "No se pudo instalar ${AP_PROFILE_PATH}"
    run_nmcli con load "${AP_PROFILE_PATH}" || true
  else
    log_warn "No se pudo exportar el perfil ${AP_NAME}"
  fi
  rm -f "${tmp_profile}"
}

ap_is_active() {
  "${NMCLI_BIN}" -t -f NAME connection show --active 2>/dev/null | grep -Fxq "${AP_NAME}" || return 1
  return 0
}

restart_miniweb() {
  if ! command -v systemctl >/dev/null 2>&1; then
    log_warn "systemctl no disponible; no se reinicia ${MINIWEB_SERVICE}"
    return
  fi
  if systemctl restart "${MINIWEB_SERVICE}" >/dev/null 2>&1; then
    log_info "Reiniciado ${MINIWEB_SERVICE}"
  else
    log_warn "No se pudo reiniciar ${MINIWEB_SERVICE}"
  fi
}

main() {
  log_info "=== Ejecutando ensure AP (provision-only) ==="

  iw reg set ES >/dev/null 2>&1 || log_warn "No se pudo fijar dominio regulatorio ES"
  rfkill unblock wifi >/dev/null 2>&1 || log_warn "No se pudo desbloquear rfkill"
  run_nmcli radio wifi on || true

  local force_ap=0
  [[ -f "${FORCE_AP_FLAG}" ]] && force_ap=1

  if has_saved_wifi_profiles && (( force_ap == 0 )); then
    log_info "Hay perfiles Wi-Fi guardados con autoconnect; NO se activa AP"
    if ap_is_active; then
      log_info "AP activo con perfiles presentes; bajando AP"
      run_nmcli con down "${AP_NAME}" || true
    fi
    return 0
  fi

  log_info "Sin perfiles Wi-Fi guardados (o force_ap activo); asegurando AP de provisión"
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
