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
FORCE_AP_FLAG="/run/bascula/force_ap"
MINIWEB_SERVICE="bascula-miniweb"

NMCLI_BIN="${NMCLI_BIN:-$(command -v nmcli 2>/dev/null || true)}"
if [[ -z "${NMCLI_BIN}" ]]; then
  printf '[bascula-ap-ensure][err] nmcli requerido pero no disponible\n' >&2
  exit 1
fi

force_ap=0
if [[ -f "${FORCE_AP_FLAG}" ]]; then
  force_ap=1
fi

if (( force_ap == 0 )); then
  if "${NMCLI_BIN}" -t -f DEVICE,STATE,CONNECTION device status | grep -q "^${AP_IFACE}:connected:"; then
    echo "[bascula-ap-ensure] ${AP_IFACE} already connected; exit fast"
    exit 0
  fi

  if "${NMCLI_BIN}" -t -f NAME,TYPE connection show \
    | grep -v "^${AP_NAME}:wifi$" \
    | grep -q ':wifi$'; then
    echo "[bascula-ap-ensure] saved Wi-Fi profiles present; do not create AP"
    exit 0
  fi
else
  echo "[bascula-ap-ensure] force_ap flag present; continuing"
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

profile_exists() {
  "${NMCLI_BIN}" -t -f NAME,TYPE connection show 2>/dev/null | grep -Fxq "${AP_NAME}:wifi"
}

nm_value() {
  "${NMCLI_BIN}" -g "$1" connection show "${AP_NAME}" 2>/dev/null || true
}

profile_needs_repair() {
  local ssid method autoconnect priority
  ssid="$(nm_value 802-11-wireless.ssid)"
  method="$(nm_value ipv4.method)"
  autoconnect="$(nm_value connection.autoconnect)"
  priority="$(nm_value connection.autoconnect-priority)"

  [[ "${ssid}" != "${AP_SSID}" || "${method}" != "shared" || "${autoconnect}" != "no" || "${priority}" != "-999" ]]
}

apply_ap_profile_settings() {
  run_nmcli connection modify "${AP_NAME}" \
    802-11-wireless.ssid "${AP_SSID}" \
    802-11-wireless.mode ap \
    802-11-wireless.band bg \
    802-11-wireless.channel 1 \
    802-11-wireless.hidden yes \
    802-11-wireless-security.pmf 1 \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.proto rsn \
    wifi-sec.psk "${AP_PSK}" \
    ipv4.method shared \
    ipv4.addresses "${AP_CIDR}" \
    ipv4.gateway "${AP_GATEWAY}" \
    ipv4.never-default yes \
    ipv6.method ignore \
    connection.interface-name "${AP_IFACE}" \
    connection.autoconnect no \
    connection.autoconnect-priority -999 \
    connection.autoconnect-retries 0 \
    connection.permissions "user:root"
}

ensure_ap_profile() {
  if ! profile_exists; then
    log_info "Creando perfil AP ${AP_NAME}"
    if ! run_nmcli connection add type wifi ifname "${AP_IFACE}" con-name "${AP_NAME}" ssid "${AP_SSID}"; then
      log_error "No se pudo crear el perfil ${AP_NAME}"
      return 1
    fi
    apply_ap_profile_settings || return 1
    return 0
  fi

  if profile_needs_repair; then
    log_warn "Reparando perfil AP ${AP_NAME}"
    apply_ap_profile_settings || return 1
  else
    log_info "Perfil AP ${AP_NAME} ya presente"
  fi
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

  iw reg set ES >/dev/null 2>&1 || log_warn "regdomain ES no aplicado"
  rfkill unblock wifi >/dev/null 2>&1 || log_warn "No se pudo desbloquear rfkill"
  run_nmcli radio wifi on || true

  ensure_ap_profile || exit 1

  if "${NMCLI_BIN}" -w 10 connection up "${AP_NAME}" >/dev/null 2>&1; then
    log_info "${AP_NAME} activa en ${AP_IFACE} (${AP_CIDR})"
    restart_miniweb
    exit 0
  fi

  echo "[bascula-ap-ensure] failed to activate AP"
  exit 0
}

main "$@"
