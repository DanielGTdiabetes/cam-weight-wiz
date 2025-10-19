#!/usr/bin/env bash
#
# Instalador principal para Báscula Digital Pro en Raspberry Pi OS Bookworm Lite
# Requisitos clave:
#   - Idempotente, seguro ante re-ejecuciones
#   - Gestiona releases OTA en /opt/bascula/releases/<timestamp>
#   - Configura audio, nginx, systemd y dependencias mínimas para Pi 5
#   - Ejecuta verificaciones básicas y controla reinicios diferidos
#
# Variables de entorno útiles:
#   - BASCULA_TRACE=1 → activa trazas detalladas (set -x) con timestamps enriquecidos
#   - BASCULA_LOG_DIR=/ruta → define la carpeta de logs (por defecto /var/log/bascula)
#   - BASCULA_LOG_FILE=/ruta/fichero.log → fija el fichero de log a utilizar
#

# --- Logging & tracing (SIEMPRE en pantalla y a fichero) ---
# Modo estricto
set -Euo pipefail

# --- Wi-Fi country setup -------------------------------------------------------
setup_wifi_country() {
  local WIFI_CONF="/etc/wpa_supplicant/wpa_supplicant.conf"
  local COUNTRY="${WIFI_COUNTRY:-ES}"

  echo "[install] Verificando configuración de país Wi-Fi..."

  if [[ ! -f "${WIFI_CONF}" ]]; then
    echo "[install][warn] ${WIFI_CONF} no existe; creando fichero base"
    if ! sudo install -m 600 -o root -g root /dev/null "${WIFI_CONF}"; then
      echo "[install][warn] No se pudo crear ${WIFI_CONF}" >&2
      return 0
    fi
  fi

  if ! grep -qE '^country=[A-Z]{2}$' "${WIFI_CONF}" 2>/dev/null; then
    echo "[install][warn] País Wi-Fi no definido; estableciendo a ${COUNTRY}"
    if ! sudo sed -i "1{/^country=/d;}; 1i country=${COUNTRY}" "${WIFI_CONF}"; then
      echo "[install][warn] No se pudo actualizar ${WIFI_CONF} con country=${COUNTRY}" >&2
    fi
    if ! sudo rfkill unblock wifi; then
      echo "[install][warn] rfkill unblock wifi falló" >&2
    fi
    if ! sudo iw reg set "${COUNTRY}"; then
      echo "[install][warn] iw reg set ${COUNTRY} falló" >&2
    fi
    if ! sudo raspi-config nonint do_wifi_country "${COUNTRY}"; then
      echo "[install][warn] raspi-config no pudo establecer el país Wi-Fi" >&2
    fi
  else
    echo "[install] País Wi-Fi ya configurado:"
    grep -E '^country=' "${WIFI_CONF}" || true
  fi

  return 0
}
# ------------------------------------------------------------------------------

IFS=$'\n\t'

# Ficheros/dirs de log
export BASCULA_LOG_DIR="${BASCULA_LOG_DIR:-/var/log/bascula}"
mkdir -p "${BASCULA_LOG_DIR}"
START_TS="$(date +%Y%m%d-%H%M%S)"
export BASCULA_LOG_FILE="${BASCULA_LOG_FILE:-${BASCULA_LOG_DIR}/install-${START_TS}.log}"
touch "${BASCULA_LOG_FILE}" || true

# Doble salida: consola + fichero (línea a línea)
# stdbuf evita el buffering al tee
exec > >(stdbuf -oL tee -a "${BASCULA_LOG_FILE}") 2> >(stdbuf -oL tee -a "${BASCULA_LOG_FILE}" >&2)

# PS4 con timestamp, PID, línea y función (para set -x)
export PS4='+ [$(date "+%F %T")] [$$] [${BASH_SOURCE##*/}:${LINENO}:${FUNCNAME[0]:-main}] '

# Traza detallada opcional (actívala exportando BASCULA_TRACE=1)
if [[ "${BASCULA_TRACE:-0}" == "1" ]]; then
  set -x
fi

echo "=================================================================="
echo "  BASCULA DIGITAL PRO – install-all.sh"
echo "  Inicio: $(date +"%F %T")  Host: $(hostname)  Kernel: $(uname -r)"
echo "  Log: ${BASCULA_LOG_FILE}"
echo "=================================================================="

# --- Frontend/WWW ---
export WWW_ROOT="${WWW_ROOT:-/opt/bascula/current/dist}"
# Si el usuario fija FRONTEND_DIR, lo respetamos; si no, autodetección.
export FRONTEND_DIR="${FRONTEND_DIR:-}"

# --- Helpers de log unificados ---
LOG_PREFIX="[install]"
log()       { printf '%s %s\n' "${LOG_PREFIX}" "$*"; }
log_step()  { printf '%s %s\n' "${LOG_PREFIX}" "[step] $*"; }
log_ok()    { printf '%s %s\n' "${LOG_PREFIX}" "[ok]   $*"; }
log_warn()  { printf '%s[warn] %s\n' "${LOG_PREFIX}" "$*" >&2; }
log_err()   { printf '%s[err]  %s\n' "${LOG_PREFIX}" "$*" >&2; }

# ---- readiness helpers ------------------------------------------------------
wait_for_unit_active() { # <unit> <timeout_s>
  local unit="$1" timeout="${2:-60}" start ts
  start=$(date +%s)
  log "Esperando a que systemd active ${unit} (timeout ${timeout}s)…"
  while true; do
    if systemctl is-active --quiet "${unit}"; then
      log_ok "${unit} está active"
      return 0
    fi
    ts=$(( $(date +%s) - start ))
    if [[ ${ts} -ge ${timeout} ]]; then
      log_warn "Timeout esperando ${unit}; mostrando estado"
      systemctl --no-pager --full status "${unit}" || true
      return 1
    fi
    sleep 1
  done
}

wait_for_port() { # <host> <port> <timeout_s>
  local host="$1" port="$2" timeout="${3:-60}" start ts
  start=$(date +%s)
  log "Esperando puerto ${host}:${port} (timeout ${timeout}s)…"
  while true; do
    if timeout 1 bash -c ">/dev/tcp/${host}/${port}" 2>/dev/null; then
      log_ok "Puerto ${host}:${port} disponible"
      return 0
    fi
    ts=$(( $(date +%s) - start ))
    if [[ ${ts} -ge ${timeout} ]]; then
      log_warn "Timeout esperando puerto ${host}:${port}"
      return 1
    fi
    sleep 1
  done
}

wait_for_http() { # <url> <timeout_s>
  local url="$1" timeout="${2:-90}" start ts http_code success_codes="${WAIT_FOR_HTTP_SUCCESS_CODES:-200 204}" code
  start=$(date +%s)
  log "Esperando HTTP ${success_codes} en ${url} (timeout ${timeout}s)…"
  while true; do
    http_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${url}" || echo "000")
    for code in ${success_codes}; do
      if [[ "${http_code}" == "${code}" ]]; then
        log_ok "${url} respondió ${http_code}"
        return 0
      fi
    done
    ts=$(( $(date +%s) - start ))
    if [[ ${ts} -ge ${timeout} ]]; then
      log_warn "Timeout esperando ${url} (último código ${http_code})"
      return 1
    fi
    sleep 2
  done
}
# ------------------------------------------------------------------------------

json_escape_string() {
  local str="$1"
  str="${str//\\/\\\\}"
  str="${str//\"/\\\"}"
  str="${str//$'\n'/\\n}"
  str="${str//$'\r'/\\r}"
  str="${str//$'\t'/\\t}"
  printf '%s' "${str}"
}

# --- Contexto de error / resumen final ---
_last_cmd=''
trap 'rc=$?; _last_cmd="$BASH_COMMAND"' DEBUG
on_err() {
  local rc=$?
  echo
  log_err "Fallo en: ${_last_cmd}"
  log_err "Archivo: ${BASH_SOURCE[1]:-?}  Línea: ${BASH_LINENO[0]:-?}  Función: ${FUNCNAME[1]:-main}  RC=${rc}"

  # Pistas rápidas (no bloquean si faltan)
  if command -v journalctl >/dev/null 2>&1; then
    log_warn "journalctl últimas 60 líneas de bascula-ui:"
    journalctl -u bascula-ui -n 60 --no-pager || true
  fi
  # Xorg hints
  print_xorg_tail_relevant "warn"

  log_err "Log completo: ${BASCULA_LOG_FILE}"
  return $rc
}
on_exit() {
  local rc=$?
  echo
  log_step "Resumen final (rc=${rc})"
  local ui_active=0
  systemctl is-active --quiet bascula-backend.service && log_ok "backend activo" || log_warn "backend inactivo"
  systemctl is-active --quiet bascula-miniweb.service && log_ok "miniweb activo" || log_warn "miniweb inactivo"
  if systemctl is-active --quiet bascula-ui.service; then
    log_ok "UI activa"
    ui_active=1
  else
    log_warn "UI inactiva"
  fi

  log "HTTP / => ${SUMMARY_HTTP_ROOT_STATUS:-n/d}"
  log "HTTP /api/health => ${SUMMARY_HTTP_API_STATUS:-n/d}"
  log "HTTP /api/state => ${SUMMARY_HTTP_STATE_STATUS:-n/d}"
  log "Miniweb status => ${SUMMARY_MINIWEB_STATUS:-n/d}"

  log "piper CLI => ${SUMMARY_PIPER_CLI:-no-test}"
  log "Voz: Piper=${SUMMARY_PIPER_MODELS} espeak=${SUMMARY_ESPEAK_AVAILABLE:-unknown}"
  log "  say => ${SUMMARY_SAY_STATUS:-no-test} backend=${SUMMARY_SAY_BACKEND:-desconocido}"
  log "  synth => ${SUMMARY_TTS_STATUS:-no-test} backend=${SUMMARY_TTS_BACKEND:-desconocido} bytes=${SUMMARY_TTS_WAV_BYTES}"

  local camera_line="${SUMMARY_CAMERA_STATUS:-no-test}"
  if [[ -n "${SUMMARY_CAMERA_ERROR}" ]]; then
    camera_line+=" (${SUMMARY_CAMERA_ERROR})"
  fi
  log "Cámara => ${camera_line}"

  log "Báscula => ${SUMMARY_SCALE_STATUS:-no-test} scale_connected=${SUMMARY_SCALE_CONNECTED:-unknown}"

  log "KMS => ${SUMMARY_KMS_STATUS:-n/d}; Xorg => ${SUMMARY_XORG_STATUS:-n/d}"

  if [[ -z "${KMS_KMSDEV_PATH}" && -f /etc/X11/xorg.conf.d/10-kms.conf ]]; then
    KMS_KMSDEV_PATH="$(awk '/Option/ && /"kmsdev"/ {gsub("\"","",$0); print $NF}' /etc/X11/xorg.conf.d/10-kms.conf | tail -n1)"
  fi
  if [[ -n "${KMS_KMSDEV_PATH}" ]]; then
    log "kmsdev configurado en 10-kms.conf: ${KMS_KMSDEV_PATH}"
  fi

  if [[ -n "${SUMMARY_AUDIO_DEVICES}" ]]; then
    log "Audio (aplay -l):"
    while IFS= read -r line; do
      [[ -n "${line}" ]] && log "  ${line}"
    done <<< "${SUMMARY_AUDIO_DEVICES}"
  fi

  log "CAPTURE_HW_DETECTED=${CAPTURE_HW_DETECTED}"
  if [[ -n "${CAPTURE_HW_RECOMMENDATION}" ]]; then
    log "CAPTURE_HW_RECOMMENDATION=${CAPTURE_HW_RECOMMENDATION}"
  fi

  log "Log: ${BASCULA_LOG_FILE}"

  echo
  if [[ $rc -ne 0 ]]; then
    log_err "Instalación con errores. Revisa arriba y en: ${BASCULA_LOG_FILE}"
    if [[ ${ui_active} -eq 0 ]]; then
      log_warn "Diagnóstico bascula-ui (últimas 20 líneas)"
      systemctl status bascula-ui.service -n 20 --no-pager || true
    fi
  else
    log_ok "Instalación completada correctamente. Log: ${BASCULA_LOG_FILE}"
  fi
}
trap on_err ERR
trap on_exit EXIT
RELEASES_DIR="/opt/bascula/releases"
CURRENT_LINK="/opt/bascula/current"
DEFAULT_USER="pi"
WWW_GROUP="www-data"
STATE_DIR="/var/lib/bascula"
TMPFILES_DEST="/etc/tmpfiles.d"
SYSTEMD_DEST="/etc/systemd/system"
NGINX_SITES_AVAILABLE="/etc/nginx/sites-available"
NGINX_SITES_ENABLED="/etc/nginx/sites-enabled"
NGINX_SITE_NAME="${NGINX_SITE_NAME:-bascula.conf}"
ASOUND_CONF="/etc/asound.conf"
AUDIO_ENV_FILE="/etc/default/bascula-audio"
BOOT_FIRMWARE_DIR="/boot/firmware"
BOOT_CONFIG_FILE="${BOOT_FIRMWARE_DIR}/config.txt"
PIPER_VOICES_DIR="/opt/bascula/voices/piper"
REBOOT_FLAG=0

CAPTURE_HW_DETECTED=0
CAPTURE_HW_RECOMMENDATION=""
KMS_KMSDEV_PATH=""

PIPER_BIN_PATH="${PIPER_BIN_PATH:-/usr/local/bin/piper}"
: "${PIPER_RELEASE_VERSION:=1.2.0}"
: "${PIPER_RELEASE_URL:=https://github.com/rhasspy/piper/releases/download/v${PIPER_RELEASE_VERSION}/piper_${PIPER_RELEASE_VERSION}_linux_aarch64.tar.gz}"
VOICE_SYMLINK_ROOT="/opt/bascula/voices"

SUMMARY_PIPER_CLI=""
SUMMARY_PIPER_MODELS=0
SUMMARY_ESPEAK_AVAILABLE=""
SUMMARY_TTS_BACKEND=""
SUMMARY_TTS_WAV_BYTES=0
SUMMARY_TTS_STATUS=""
SUMMARY_SAY_BACKEND=""
SUMMARY_SAY_STATUS=""
SUMMARY_CAMERA_STATUS=""
SUMMARY_CAMERA_ERROR=""
SUMMARY_SCALE_STATUS=""
SUMMARY_SCALE_CONNECTED=""
SUMMARY_HTTP_ROOT_STATUS=""
SUMMARY_HTTP_API_STATUS=""
SUMMARY_HTTP_STATE_STATUS=""
SUMMARY_MINIWEB_STATUS=""
SUMMARY_KMS_STATUS=""
SUMMARY_XORG_STATUS=""
SUMMARY_AUDIO_DEVICES=""

PI_MODEL="$(tr -d '\0' </proc/device-tree/model 2>/dev/null || true)"
IS_PI5=0
if [[ "${PI_MODEL}" == *"Raspberry Pi 5"* ]]; then
  IS_PI5=1
fi

: "${SKIP_UI_BUILD:=0}"

umask 022

FRONTEND_EXPECTED=0

ensure_remote_file() {
  local url="$1"
  local dest="$2"
  local label="${3:-$(basename "$dest")}"

  if [[ -s "${dest}" ]]; then
    log "[ok] ${label} ya presente (${dest})"
    return 0
  fi

  log "Descargando ${label} (${url})"
  local tmp
  tmp="$(mktemp)"
  if ! curl -fsSL --retry 3 --retry-delay 2 -o "${tmp}" "${url}"; then
    rm -f "${tmp}"
    abort "No se pudo descargar ${label} desde ${url}"
  fi
  install -m 0644 "${tmp}" "${dest}"
  rm -f "${tmp}"
  log "[ok] ${label} instalado en ${dest}"
}

ensure_node_runtime() {
  local need_install=1
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -v | sed -E 's/^v//;s/\..*$//')" || true
    if [[ -n "${major}" && "${major}" -ge 20 ]]; then
      need_install=0
    fi
  fi

  if [[ ${need_install} -eq 0 ]] && command -v npm >/dev/null 2>&1; then
    log "Node presente: $(node -v), npm $(npm -v)"
    return 0
  fi

  log_step "Instalando Node.js 20.x (Nodesource)"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  log "Node actualizado: $(node -v), npm $(npm -v)"
}

detect_frontend_dir() {
  local base_dir
  base_dir="${REPO_DIR:-${REPO_ROOT}}"

  if [[ -f "${base_dir}/package.json" ]]; then
    echo "${base_dir}"
    return 0
  fi

  if [[ -n "${FRONTEND_DIR:-}" ]]; then
    local abs
    abs="${FRONTEND_DIR}"
    [[ "${FRONTEND_DIR}" != /* ]] && abs="${base_dir}/${FRONTEND_DIR}"
    if [[ -f "${abs}/package.json" ]]; then
      echo "${abs}"
      return 0
    fi
  fi

  local candidates=(
    "bascula-ui"
    "frontend"
    "ui"
    "web"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "${base_dir}/${candidate}/package.json" ]]; then
      echo "${base_dir}/${candidate}"
      return 0
    fi
  done

  local found
  found="$(find "${base_dir}" -maxdepth 4 -type f -name package.json \
            -not -path '*/node_modules/*' \
            -exec dirname {} \; | sort | head -n1 || true)"
  if [[ -n "${found}" ]]; then
    echo "${found}"
    return 0
  fi

  echo ""
}

has_build_script() {
  local dir="$1"
  jq -e -r '.scripts.build // empty' "${dir}/package.json" >/dev/null 2>&1
}

detect_build_output_dir() {
  # Preferencia típica: dist (Vite) > build (CRA)
  local dir="$1"
  if [[ -d "${dir}/dist" ]]; then echo "${dir}/dist"; return 0; fi
  if [[ -d "${dir}/build" ]]; then echo "${dir}/build"; return 0; fi
  # Fallback: busca index.html recién generado
  local out
  out="$(find "${dir}" -maxdepth 3 -type f -name index.html \
          -not -path '*/node_modules/*' \
          -printf '%h\n' | head -n1 || true)"
  echo "${out}"
}

publish_frontend() {
  local src="$1"
  local dst="${WWW_ROOT}"

  if [[ -z "${src}" || ! -d "${src}" ]]; then
    log_err "Carpeta de artefactos de build inválida: ${src}"
    return 1
  fi

  mkdir -p "${dst}"
  rsync -a --delete "${src}/" "${dst}/"
  find "${dst}" -type d -exec chmod 0755 {} \;
  find "${dst}" -type f -exec chmod 0644 {} \;
  chown -R "${DEFAULT_USER}:${WWW_GROUP}" "${dst}"
  log "Frontend publicado en ${dst}"

  local published_files
  published_files="$(find "${dst}" -maxdepth 2 -type f -name 'index.html' -printf '%p\n' 2>/dev/null || true)"
  if [[ -n "${published_files}" ]]; then
    while IFS= read -r line; do
      log "Artefacto publicado: ${line}"
    done <<<"${published_files}"
  else
    log_warn "No se detectaron index.html publicados en ${dst}"
  fi
}

build_frontend_if_present() {
  if [[ "${SKIP_UI_BUILD}" == "1" ]]; then
    log_warn "SKIP_UI_BUILD=1, omitiendo build de UI"
    return 0
  fi

  local dir
  dir="$(detect_frontend_dir)"
  if [[ -z "${dir}" ]]; then
    log_err "No se encontró carpeta de frontend con package.json en ${REPO_DIR:-${REPO_ROOT}}"
    return 1
  fi

  FRONTEND_EXPECTED=1

  log_step "Compilando frontend ${dir}"
  ensure_node_runtime

  if ! has_build_script "${dir}"; then
    log_err "package.json sin script 'build' en ${dir}"
    jq -r '.scripts // {}' "${dir}/package.json" 2>/dev/null || true
    return 1
  fi

  pushd "${dir}" >/dev/null
  if [[ -f package-lock.json ]]; then
    log "npm ci (inicio)"
    npm ci
    log "npm ci (fin)"
  else
    log_warn "package-lock.json no encontrado; usando npm install"
    log "npm install (inicio)"
    npm install
    log "npm install (fin)"
  fi
  log "npm run build (inicio)"
  npm run build
  log "npm run build (fin)"
  popd >/dev/null

  local out_dir
  out_dir="$(detect_build_output_dir "${dir}")"
  if [[ -z "${out_dir}" || ! -d "${out_dir}" ]]; then
    log_err "No se encontró carpeta de salida tras build (dist/build)"
    return 1
  fi

  if [[ ! -f "${out_dir}/index.html" ]]; then
    log_err "No se encontró index.html en ${out_dir}"
    return 1
  fi

  publish_frontend "${out_dir}"
}

port_listening() {
  local port="$1"
  ss -ltn | awk -v p=":${port}" '$4 ~ p {found=1} END {exit found?0:1}'
}

get_xorg_log_path() {
  local log_path
  log_path="${HOME:-/home/pi}/.local/share/xorg/Xorg.0.log"
  if [[ ! -f "${log_path}" ]]; then
    log_path="/var/log/Xorg.0.log"
  fi
  printf '%s\n' "${log_path}"
}

print_xorg_tail_relevant() {
  local level="${1:-info}" log_path
  log_path="$(get_xorg_log_path)"
  if [[ -f "${log_path}" ]]; then
    if [[ "${level}" == "warn" ]]; then
      log_warn "Fragmento Xorg (modeset/vc4/HDMI/EE/WW):"
    else
      log "Fragmento Xorg (modeset/vc4/HDMI/EE/WW):"
    fi
    grep -Eni 'modeset|vc4|DRI|HDMI|EE|WW' "${log_path}" | tail -n 80 || true
  else
    if [[ "${level}" == "warn" ]]; then
      log_warn "No se encontró Xorg.0.log"
    else
      log "No se encontró Xorg.0.log"
    fi
  fi
}

dump_service_journal() {
  local unit="$1"
  if [[ "${unit}" != *.service ]]; then
    unit="${unit}.service"
  fi
  if command -v journalctl >/dev/null 2>&1; then
    journalctl -u "${unit}" -n 80 --no-pager || true
  fi
}

assert_unit_active() {
  local unit="$1"
  if [[ "${unit}" != *.service ]]; then
    unit="${unit}.service"
  fi
  if ! systemctl is-active --quiet "${unit}"; then
    log_err "${unit} no está activo"
    dump_service_journal "${unit}"
    exit 1
  fi
}

CHECK_FAIL_MSG=""
FINAL_FAILURES=0

final_check() {
  local description="$1"
  shift
  CHECK_FAIL_MSG=""
  if "$@"; then
    log "[ok] ${description}"
  else
    local message="Validación falló: ${description}"
    if [[ -n "${CHECK_FAIL_MSG}" ]]; then
      message+=" -> ${CHECK_FAIL_MSG}"
    fi
    log_err "${message}"
    FINAL_FAILURES=1
  fi
}

final_check_warn() {
  local description="$1"
  shift
  CHECK_FAIL_MSG=""
  if "$@"; then
    log "[ok] ${description}"
  else
    local message="Validación no bloqueante falló: ${description}"
    if [[ -n "${CHECK_FAIL_MSG}" ]]; then
      message+=" -> ${CHECK_FAIL_MSG}"
    fi
    log_warn "${message}"
  fi
}

check_http_endpoint() {
  local url="$1" expected_body="$2"
  local tmp status body
  tmp=$(mktemp)
  status=$(curl -sS -o "${tmp}" -w '%{http_code}' "${url}" || true)
  body="$(tr -d '\r\n' < "${tmp}")"
  rm -f "${tmp}"
  if [[ "${status}" != "200" ]]; then
    CHECK_FAIL_MSG="HTTP ${url} devolvió ${status}; cuerpo: ${body}"
    return 1
  fi
  if [[ -n "${expected_body}" && "${body}" != "${expected_body}" ]]; then
    CHECK_FAIL_MSG="HTTP ${url} devolvió cuerpo inesperado: ${body}"
    return 1
  fi
  return 0
}

check_piper_cli_ready() {
  local bin
  bin="$(command -v piper 2>/dev/null || true)"
  if [[ -z "${bin}" ]]; then
    CHECK_FAIL_MSG="piper no está en PATH"
    SUMMARY_PIPER_CLI="missing"
    return 1
  fi
  if ! "${bin}" --help >/dev/null 2>&1; then
    CHECK_FAIL_MSG="piper --help devolvió error"
    SUMMARY_PIPER_CLI="broken (${bin})"
    return 1
  fi
  SUMMARY_PIPER_CLI="ok (${bin})"
  return 0
}

check_voice_list_endpoint() {
  local url="http://127.0.0.1/api/voice/tts/voices"
  local tmp status rc=0
  tmp=$(mktemp)
  status=$(curl -sS -o "${tmp}" -w '%{http_code}' "${url}" || rc=$?)
  if [[ ${rc} -ne 0 ]]; then
    CHECK_FAIL_MSG="curl rc=${rc}"
    rm -f "${tmp}"
    return 1
  fi
  if [[ "${status}" != "200" ]]; then
    CHECK_FAIL_MSG="HTTP ${status}"
    SUMMARY_PIPER_MODELS=0
    SUMMARY_ESPEAK_AVAILABLE=""
    rm -f "${tmp}"
    return 1
  fi
  if command -v jq >/dev/null 2>&1; then
    SUMMARY_PIPER_MODELS=$(jq -r '(.piper_models // []) | length' "${tmp}" 2>/dev/null || echo 0)
    SUMMARY_ESPEAK_AVAILABLE=$(jq -r '.espeak_available // false' "${tmp}" 2>/dev/null || echo false)
  else
    SUMMARY_PIPER_MODELS=0
    SUMMARY_ESPEAK_AVAILABLE="unknown"
  fi
  rm -f "${tmp}"
  if (( SUMMARY_PIPER_MODELS > 0 )); then
    return 0
  fi
  CHECK_FAIL_MSG="Sin voces Piper"
  return 1
}

validate_tts_say() {
  log_step "Validando TTS (say)"
  local host="${BASCULA_HOST:-127.0.0.1}"
  local tts_port="${TTS_PORT:-8080}"
  local url="${TTS_URL:-http://${host}:${tts_port}/api/voice/tts/say}"
  local text="${TTS_TEXT:-Instalación completada}"
  local attempt=0 max_attempts=3 backoff=2 rc=0 http_code payload tmp backend=""
  payload="{"text":"$(json_escape_string "${text}")"}"
  tmp=$(mktemp)

  while (( attempt < max_attempts )); do
    attempt=$((attempt + 1))
    rc=0
    http_code=$(curl -sS -X POST \
      -H 'Content-Type: application/json' \
      -d "${payload}" \
      -o "${tmp}" -w '%{http_code}' --max-time 10 \
      "${url}" || rc=$?)

    if [[ ${rc} -eq 0 && ( "${http_code}" == "200" || "${http_code}" == "204" ) ]]; then
      SUMMARY_SAY_STATUS="HTTP ${http_code}"
      if command -v jq >/dev/null 2>&1; then
        backend=$(jq -r '.backend // empty' "${tmp}" 2>/dev/null || echo "")
      else
        backend=$(grep -o '"backend"[^"]*"[^"]*"' "${tmp}" 2>/dev/null | head -n1 | sed -E 's/.*"backend"[^"]*"([^"]*)".*/\1/' || true)
      fi
      SUMMARY_SAY_BACKEND="${backend:-unknown}"
      rm -f "${tmp}" || true
      log_ok "TTS say respondió (${SUMMARY_SAY_STATUS})"
      return 0
    fi

    if [[ ${rc} -ne 0 ]]; then
      SUMMARY_SAY_STATUS="curl rc=${rc}"
    else
      SUMMARY_SAY_STATUS="HTTP ${http_code}"
    fi

    log_warn "TTS fallo intento ${attempt}/${max_attempts} (${SUMMARY_SAY_STATUS})"
    if (( attempt < max_attempts )); then
      sleep "${backoff}"
      backoff=$((backoff * 2))
    fi
  done

  SUMMARY_SAY_BACKEND=""
  log_warn "TTS no respondió tras ${max_attempts} intentos; se continuará con la instalación"
  echo "---- journalctl (piper.service) últimas 200 líneas ----"
  journalctl -u piper.service -n 200 --no-pager || true
  echo "---- journalctl (bascula-backend.service) últimas 200 líneas ----"
  journalctl -u bascula-backend.service -n 200 --no-pager || true
  rm -f "${tmp}" || true
  return 1
}

check_voice_say_endpoint() {
  local status="${SUMMARY_SAY_STATUS:-}"
  if [[ -z "${status}" || "${status}" == "no-test" ]]; then
    CHECK_FAIL_MSG="sin datos de validación previa"
    return 1
  fi
  if [[ "${status}" =~ ^HTTP\ (200|204)$ ]]; then
    return 0
  fi
  CHECK_FAIL_MSG="${status}"
  return 1
}

check_voice_synthesize_endpoint() {
  local url="http://127.0.0.1/api/voice/tts/synthesize?text=Hola&voice=default"
  local wav headers status rc=0 backend=""
  wav=$(mktemp --suffix=.wav)
  headers=$(mktemp)
  status=$(curl -sS -X POST -H 'Accept: audio/wav' -o "${wav}" -D "${headers}" -w '%{http_code}' "${url}" || rc=$?)
  SUMMARY_TTS_STATUS="HTTP ${status}"
  if [[ ${rc} -ne 0 ]]; then
    CHECK_FAIL_MSG="curl rc=${rc}"
    rm -f "${wav}" "${headers}"
    return 1
  fi
  if [[ "${status}" != "200" ]]; then
    CHECK_FAIL_MSG="HTTP ${status}"
    rm -f "${wav}" "${headers}"
    return 1
  fi
  if ! grep -qi '^Content-Type: *audio/wav' "${headers}"; then
    CHECK_FAIL_MSG="Content-Type inesperado"
    rm -f "${wav}" "${headers}"
    return 1
  fi
  backend=$(awk -F': *' 'tolower($1)=="x-tts-backend" {print tolower($2); exit}' "${headers}" | tr -d '\r')
  SUMMARY_TTS_BACKEND="${backend:-unknown}"
  SUMMARY_TTS_WAV_BYTES=$(stat -c '%s' "${wav}" 2>/dev/null || echo 0)
  rm -f "${headers}"
  if [[ -z "${backend}" ]]; then
    CHECK_FAIL_MSG="Sin cabecera X-TTS-Backend"
    rm -f "${wav}"
    return 1
  fi
  if (( SUMMARY_TTS_WAV_BYTES < 2048 )); then
    CHECK_FAIL_MSG="WAV demasiado pequeño (${SUMMARY_TTS_WAV_BYTES} bytes)"
    rm -f "${wav}"
    return 1
  fi
  rm -f "${wav}"
  return 0
}

check_camera_info_endpoint() {
  local url="http://127.0.0.1/api/camera/info"
  local tmp status rc=0
  tmp=$(mktemp)
  status=$(curl -sS -o "${tmp}" -w '%{http_code}' "${url}" || rc=$?)
  if [[ ${rc} -ne 0 ]]; then
    SUMMARY_CAMERA_STATUS="curl rc=${rc}"
    CHECK_FAIL_MSG="curl rc=${rc}"
    rm -f "${tmp}"
    return 1
  fi
  SUMMARY_CAMERA_STATUS="HTTP ${status}"
  if command -v jq >/dev/null 2>&1; then
    SUMMARY_CAMERA_ERROR=$(jq -r '.error // empty' "${tmp}" 2>/dev/null || echo "")
  else
    SUMMARY_CAMERA_ERROR=""
  fi
  if [[ "${status}" == "200" ]]; then
    rm -f "${tmp}"
    return 0
  fi
  if [[ "${status}" == "503" && "${SUMMARY_CAMERA_ERROR}" == "camera_unavailable" ]]; then
    rm -f "${tmp}"
    return 0
  fi
  CHECK_FAIL_MSG="HTTP ${status}"
  SUMMARY_CAMERA_ERROR=$(head -c 200 "${tmp}" | tr '\n' ' ')
  rm -f "${tmp}"
  return 1
}

check_no_arecord_process() {
  if pgrep -a arecord >/dev/null 2>&1; then
    CHECK_FAIL_MSG=$(pgrep -a arecord | head -n 1)
    SUMMARY_AUDIO_CAPTURE="arecord-running"
    return 1
  fi
  SUMMARY_AUDIO_CAPTURE="idle"
  return 0
}

check_wake_disabled_logs() {
  if ! command -v journalctl >/dev/null 2>&1; then
    SUMMARY_WAKE_LOG="journalctl-missing"
    return 0
  fi
  local logs
  logs=$(journalctl -u bascula-backend.service -n 200 --no-pager 2>/dev/null || true)
  if [[ -z "${logs}" ]]; then
    SUMMARY_WAKE_LOG="no-logs"
    return 0
  fi
  if printf '%s\n' "${logs}" | grep -qi 'WakeListener inicializado'; then
    CHECK_FAIL_MSG="WakeListener inicializado"
    SUMMARY_WAKE_LOG="wake-enabled"
    return 1
  fi
  if printf '%s\n' "${logs}" | grep -qi 'listener thread started'; then
    CHECK_FAIL_MSG="listener thread started"
    SUMMARY_WAKE_LOG="wake-thread"
    return 1
  fi
  if ! printf '%s\n' "${logs}" | grep -qi 'Desactivado por configuración'; then
    CHECK_FAIL_MSG="sin log de wake desactivado"
    SUMMARY_WAKE_LOG="missing-disabled-log"
    return 1
  fi
  SUMMARY_WAKE_LOG="disabled"
  return 0
}

check_scale_health() {
  local url="http://127.0.0.1/api/health"
  local tmp status rc=0
  tmp=$(mktemp)
  status=$(curl -sS -o "${tmp}" -w '%{http_code}' "${url}" || rc=$?)
  if [[ ${rc} -ne 0 ]]; then
    CHECK_FAIL_MSG="curl rc=${rc}"
    SUMMARY_SCALE_STATUS="curl rc=${rc}"
    rm -f "${tmp}"
    return 1
  fi
  SUMMARY_HTTP_API_STATUS="HTTP ${status}"
  if [[ "${status}" != "200" ]]; then
    CHECK_FAIL_MSG="HTTP ${status}"
    SUMMARY_SCALE_STATUS="HTTP ${status}"
    rm -f "${tmp}"
    return 1
  fi
  if command -v jq >/dev/null 2>&1; then
    SUMMARY_SCALE_CONNECTED=$(jq -r '.scale_connected // empty' "${tmp}" 2>/dev/null || echo "")
    local backend
    backend=$(jq -r '.scale_backend // .scale_mode // empty' "${tmp}" 2>/dev/null || echo "")
    if [[ -n "${backend}" ]]; then
      SUMMARY_SCALE_STATUS="backend=${backend}"
    fi
    local reason
    reason=$(jq -r '.scale_status.reason // empty' "${tmp}" 2>/dev/null || echo "")
    if [[ -n "${reason}" ]]; then
      if [[ -n "${SUMMARY_SCALE_STATUS}" ]]; then
        SUMMARY_SCALE_STATUS+=" reason=${reason}"
      else
        SUMMARY_SCALE_STATUS="reason=${reason}"
      fi
    fi
  fi
  if [[ -z "${SUMMARY_SCALE_STATUS}" ]]; then
    SUMMARY_SCALE_STATUS="ok"
  fi
  rm -f "${tmp}"
  return 0
}

check_sse_headers() {
  local url="$1"
  local headers
  # HEAD requests against FastAPI StreamingResponse endpoints return 405.
  # Use a short-lived GET to capture headers without failing the generator.
  headers=$(curl -sS -X GET --max-time 5 -D - -o /dev/null "${url}" || true)
  if [[ -z "${headers}" ]]; then
    CHECK_FAIL_MSG="Sin respuesta de ${url}"
    return 1
  fi
  local status
  status=$(printf '%s\n' "${headers}" | awk 'NR==1 {print $2}')
  if [[ "${status}" != "200" ]]; then
    CHECK_FAIL_MSG="${url} respondió ${status}"
    return 1
  fi
  if ! grep -qi '^Content-Type: text/event-stream' <<<"${headers}"; then
    CHECK_FAIL_MSG="Falta Content-Type text/event-stream"
    return 1
  fi
  if ! grep -qi '^X-Accel-Buffering: no' <<<"${headers}"; then
    CHECK_FAIL_MSG="Falta X-Accel-Buffering: no"
    return 1
  fi
  return 0
}

check_file_exists() {
  local path="$1"
  if [[ -f "${path}" ]]; then
    return 0
  fi
  CHECK_FAIL_MSG="${path} no encontrado"
  return 1
}

check_owner() {
  local path="$1" expected="$2"
  local owner
  owner=$(stat -c %U:%G "${path}" 2>/dev/null || true)
  if [[ "${owner}" == "${expected}" ]]; then
    return 0
  fi
  CHECK_FAIL_MSG="Propietario actual: ${owner:-desconocido}"
  return 1
}

check_piper_voices_installed() {
  local dir="$1"
  if [[ ! -d "${dir}" ]]; then
    CHECK_FAIL_MSG="Directorio ${dir} no existe"
    return 1
  fi

  local -a voices
  shopt -s nullglob
  voices=("${dir}"/*.onnx)
  shopt -u nullglob
  if (( ${#voices[@]} > 0 )); then
    return 0
  fi

  CHECK_FAIL_MSG="No se encontraron modelos Piper (.onnx) en ${dir}"
  return 1
}

check_python_imports() {
  log_step "Validando imports críticos en el venv"
  local venv_py="${CURRENT_LINK}/.venv/bin/python"
  if [[ ! -x "${venv_py}" ]]; then
    log_err "Python del venv no existe: ${venv_py}"
    return 1
  fi

  # Ejecuta como usuario por defecto, abortando si falla la activación del venv o cualquier import
  local rc=0
  su - "${DEFAULT_USER}" -s /bin/bash <<EOF || rc=$?
set -euo pipefail
export CURRENT_LINK="${CURRENT_LINK}"
. "${CURRENT_LINK}/.venv/bin/activate"

python - <<'PY'
import os, sys, pathlib
print("executable=", sys.executable)
print("prefix    =", sys.prefix)
print("base_pref =", getattr(sys, "base_prefix", "<no-attr>"))

# Imports críticos
import fastapi, uvicorn, cv2, rapidocr_onnxruntime

# Verificación de que estamos en el venv correcto
venv_expected = pathlib.Path(os.environ["CURRENT_LINK"], ".venv").resolve()
in_venv = pathlib.Path(sys.prefix).resolve()
if in_venv != venv_expected:
    print(f"VENVCHECK=FAIL expected={venv_expected} got={in_venv}")
    raise SystemExit(2)
print("imports   = OK")
PY
EOF

  if [[ ${rc} -ne 0 ]]; then
    log_err "Validación falló: imports críticos en venv (rc=${rc})"
    return ${rc}
  fi
  log_ok "imports críticos en venv OK"
  return 0
}

abort() {
  log_err "$*"
  exit 1
}

require_root() {
  if [[ $(id -u) -ne 0 ]]; then
    abort "Este instalador debe ejecutarse como root"
  fi
}

run_checked() {
  local label="$1"
  shift
  log "check: ${label}"
  if "$@"; then
    log "check OK: ${label}"
  else
    log_warn "check falló: ${label}"
    return 1
  fi
}

set_reboot_required() {
  local reason="$1"
  REBOOT_FLAG=1
  mkdir -p "${STATE_DIR}"
  printf '%s\n' "${reason}" >> "${STATE_DIR}/reboot-reasons.txt"
}

APT_UPDATED=0
SYSTEMD_NEEDS_RELOAD=0

ensure_apt_cache() {
  if [[ ${APT_UPDATED} -eq 0 ]]; then
    log_step "Actualizando índices APT"
    apt-get update
    APT_UPDATED=1
  fi
}

ensure_packages() {
  local pkgs=("$@")
  local missing=()
  local pkg
  for pkg in "${pkgs[@]}"; do
    if ! dpkg -s "${pkg}" >/dev/null 2>&1; then
      missing+=("${pkg}")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    ensure_apt_cache
    log "Instalando paquetes: ${missing[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
  else
    log "Paquetes ya instalados"
  fi
}

purge_gui_piper() {
  if dpkg -s piper >/dev/null 2>&1; then
    log_step "Eliminando paquete Debian piper (GUI)"
    ensure_apt_cache
    DEBIAN_FRONTEND=noninteractive apt-get purge -y piper
  fi
}

package_available() {
  local pkg="$1"
  local candidate
  candidate=$(apt-cache policy "${pkg}" 2>/dev/null | awk '/Candidate:/ {print $2; exit}')
  if [[ -z "${candidate}" ]]; then
    return 1
  fi
  if [[ "${candidate}" == *none* ]]; then
    return 1
  fi
  return 0
}

ensure_package_alternative() {
  local label="$1"
  shift
  local pkg
  for pkg in "$@"; do
    if dpkg -s "${pkg}" >/dev/null 2>&1; then
      log "${label}: ${pkg} ya instalado"
      return 0
    fi
  done

  ensure_apt_cache
  for pkg in "$@"; do
    if package_available "${pkg}"; then
      log "${label}: instalando ${pkg}"
      ensure_packages "${pkg}"
      return 0
    fi
  done

  log_warn "${label}: ninguna alternativa disponible: ${*}"
  return 1
}

ensure_libavformat() {
  if dpkg -s libavformat60 >/dev/null 2>&1; then
    log "libavformat60 ya instalado"
    return 0
  fi
  if dpkg -s libavformat59 >/dev/null 2>&1; then
    log "libavformat59 ya instalado"
    return 0
  fi

  ensure_apt_cache

  if package_available libavformat60; then
    log "Instalando libavformat60"
    ensure_packages libavformat60
    return 0
  fi

  if package_available libavformat59; then
    log_warn "libavformat60 no disponible; usando libavformat59"
    ensure_packages libavformat59
    return 0
  fi

  log_warn "No se encontraron libavformat60/59; intentando libavformat58"
  ensure_package_alternative "libavformat" libavformat58
}

install_system_dependencies() {
  log_step "Instalando dependencias del sistema"
  ensure_packages \
    python3 python3-venv python3-pip python3-dev \
    python3-libcamera python3-picamera2 python3-numpy python3-simplejpeg \
    libgomp1 libzbar0 libcap-dev libatlas-base-dev libopenjp2-7 \
    ffmpeg git rsync curl jq unzip nginx alsa-utils libcamera-apps espeak-ng iproute2 libportaudio2 \
    xserver-xorg xinit openbox unclutter x11-xserver-utils upower fonts-dejavu-core

  ensure_package_alternative "chromium" chromium-browser chromium

  ensure_package_alternative "libtiff" libtiff6 libtiff5
  ensure_libavformat
  ensure_package_alternative "libimath" libimath-dev libilmbase-dev
}

ensure_boot_config_line() {
  local line="$1"
  local file="${BOOT_CONFIG_FILE}"
  if [[ ! -f "${file}" ]]; then
    abort "No se encontró ${file}; verifique montaje de /boot"
  fi
  if grep -Fxq "${line}" "${file}"; then
    return 0
  fi
  log "Añadiendo '${line}' a ${file}"
  printf '\n%s\n' "${line}" >> "${file}"
  set_reboot_required "boot-config: ${line}"
}

ensure_boot_config_backup() {
  if [[ -f "${BOOT_CONFIG_FILE}" && ! -f "${BOOT_CONFIG_FILE}.bak_bascula" ]]; then
    cp -a "${BOOT_CONFIG_FILE}" "${BOOT_CONFIG_FILE}.bak_bascula"
    log "Respaldo de config.txt creado en ${BOOT_CONFIG_FILE}.bak_bascula"
  fi
}

remove_boot_config_lines_matching() {
  local pattern="$1"
  local file="${BOOT_CONFIG_FILE}"
  if [[ ! -f "${file}" ]]; then
    abort "No se encontró ${file}; verifique montaje de /boot"
  fi
  if ! grep -Eq "${pattern}" "${file}"; then
    return 0
  fi

  log "Eliminando líneas que coinciden con '${pattern}' en ${file}"
  local tmp
  tmp="$(mktemp)"
  grep -Ev "${pattern}" "${file}" > "${tmp}"
  install -o root -g root -m 0644 "${tmp}" "${file}"
  rm -f "${tmp}"
  set_reboot_required "boot-config remove ${pattern}"
}

apply_pi5_boot_overlays() {
  if [[ ${IS_PI5} -ne 1 ]]; then
    return 0
  fi

  if [[ ! -f "${BOOT_CONFIG_FILE}" ]]; then
    abort "No se encontró ${BOOT_CONFIG_FILE}; verifique montaje de /boot"
  fi

  ensure_boot_config_backup

  local result
  result=$(python3 - "${BOOT_CONFIG_FILE}" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
lines = path.read_text().splitlines()
changed = False

def comment_exact(value: str) -> None:
    global changed
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped == value and not stripped.startswith('#'):
            prefix = line[: len(line) - len(line.lstrip())]
            lines[idx] = f"{prefix}# {value}"
            changed = True

def comment_prefixed(value: str) -> None:
    global changed
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith(value) and not stripped.startswith('#'):
            prefix = line[: len(line) - len(line.lstrip())]
            lines[idx] = f"{prefix}# {stripped}"
            changed = True

def ensure_single_setting(key: str, desired: str) -> None:
    global changed, lines
    new_lines = []
    found = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('#'):
            stripped_comment = stripped.lstrip('#').strip()
            if stripped_comment.startswith(f"{key}="):
                continue
        if stripped.startswith(f"{key}="):
            if not found:
                if stripped != desired:
                    changed = True
                new_lines.append(desired)
                found = True
            else:
                changed = True
        else:
            new_lines.append(line)
    if not found:
        new_lines.append(desired)
        changed = True
    lines = new_lines

comment_exact('dtoverlay=vc4-kms-v3d')
comment_prefixed('dtoverlay=vc4-fkms-v3d')

has_pi5 = False
for line in lines:
    stripped = line.strip()
    if stripped.startswith('dtoverlay=vc4-kms-v3d-pi5') and not stripped.startswith('#'):
        has_pi5 = True
        break

if not has_pi5:
    lines.append('dtoverlay=vc4-kms-v3d-pi5')
    changed = True

ensure_single_setting('hdmi_force_hotplug', 'hdmi_force_hotplug=1')
ensure_single_setting('hdmi_group', 'hdmi_group=2')
ensure_single_setting('hdmi_mode', 'hdmi_mode=87')
ensure_single_setting('hdmi_cvt', 'hdmi_cvt=1024 600 60 6 0 0 0')

if changed:
    path.write_text("\n".join(lines) + "\n")
    print('changed')
else:
    print('unchanged')
PY
  )

  if [[ "${result}" == "changed" ]]; then
    log "Aplicando overlay vc4-kms-v3d-pi5 y EDID forzado en ${BOOT_CONFIG_FILE}"
    set_reboot_required "boot-config: vc4-kms-v3d-pi5"
  else
    log "Overlay vc4-kms-v3d-pi5 y EDID ya presentes"
  fi
}

purgar_fbdev_driver() {
  if [[ ${IS_PI5} -ne 1 ]]; then
    return 0
  fi
  log "Purgando xserver-xorg-video-fbdev"
  DEBIAN_FRONTEND=noninteractive apt-get purge -y xserver-xorg-video-fbdev || true
}

disable_fbdev_xorg_configs() {
  if [[ ${IS_PI5} -ne 1 ]]; then
    return 0
  fi
  local path
  for path in /etc/X11/xorg.conf /etc/X11/xorg.conf.d/99-fbdev.conf; do
    if [[ -e "${path}" ]]; then
      local backup="${path}.bak_bascula"
      if [[ -e "${backup}" ]]; then
        rm -f "${path}"
        log "Eliminada configuración fbdev residual ${path} (backup existente)"
      else
        mv "${path}" "${backup}"
        log "Configuración fbdev movida a ${backup}"
      fi
    fi
  done
}

detect_drm_card_with_hdmi() {
  local card connector status first_card=""
  for card in /sys/class/drm/card*; do
    [[ -d "${card}" ]] || continue
    local card_name
    card_name="$(basename "${card}")"
    while IFS= read -r connector; do
      [[ -e "${connector}" ]] || continue
      local connector_name connector_card
      connector_name="$(basename "${connector}")"
      connector_card="${connector_name%%-*}"
      status="$(cat "${connector}/status" 2>/dev/null || echo unknown)"
      if [[ "${status}" == "connected" ]]; then
        printf '%s\n' "${connector_card}"
        return 0
      fi
      first_card="${first_card:-${connector_card}}"
    done < <(find "${card}" -maxdepth 1 -type l -name 'card*-HDMI-*' 2>/dev/null | sort)
  done

  if [[ -n "${first_card}" ]]; then
    printf '%s\n' "${first_card}"
    return 0
  fi

  printf 'card0\n'
}

ensure_kms_device_config() {
  if [[ ${IS_PI5} -ne 1 ]]; then
    return 0
  fi

  local dir="/etc/X11/xorg.conf.d"
  local conf="${dir}/10-kms.conf"
  local card
  card="$(detect_drm_card_with_hdmi)"
  KMS_KMSDEV_PATH="/dev/dri/${card}"

  install -d -m0755 "${dir}"

  local tmp
  tmp="$(mktemp)"
  cat >"${tmp}" <<EOF
Section "Device"
  Identifier "Pi5KMS"
  Driver     "modesetting"
  Option     "kmsdev" "${KMS_KMSDEV_PATH}"
EndSection
EOF

  if [[ -f "${conf}" ]] && cmp -s "${tmp}" "${conf}"; then
    rm -f "${tmp}"
    log "10-kms.conf sin cambios (kmsdev=${KMS_KMSDEV_PATH})"
  else
    install -o root -g root -m0644 "${tmp}" "${conf}"
    log "10-kms.conf actualizado (kmsdev=${KMS_KMSDEV_PATH})"
  fi
  rm -f "${tmp}" || true
}

ensure_boot_overlays() {
  if [[ ! -d "${BOOT_FIRMWARE_DIR}" ]]; then
    log_warn "${BOOT_FIRMWARE_DIR} no encontrado; omitiendo configuración de overlays"
    return
  fi
  remove_boot_config_lines_matching '^disable_fw_kms_setup=.*'
  ensure_boot_config_backup
  if [[ ${IS_PI5} -eq 1 ]]; then
    apply_pi5_boot_overlays
  fi
  ensure_boot_config_line "dtoverlay=disable-bt"
  ensure_boot_config_line "dtoverlay=hifiberry-dac"
  ensure_boot_config_line "enable_uart=1"
  if [[ ${IS_PI5} -ne 1 ]]; then
    ensure_boot_config_line "dtoverlay=vc4-kms-v3d"
  fi
}

ensure_serial_console_disabled() {
  log_step "Ajustando UART (sin consola interactiva)"

  local changed=0
  if ! command -v raspi-config >/dev/null 2>&1; then
    log "Instalando raspi-config para gestionar UART"
    apt-get update >/dev/null 2>&1 || true
    apt-get install -y raspi-config >/dev/null 2>&1 || log_warn "No se pudo instalar raspi-config"
  fi

  if command -v raspi-config >/dev/null 2>&1 && [[ -z "${BASCULA_AUTOMATED:-}" ]]; then
    local serial_state
    serial_state="$(raspi-config nonint get_serial 2>/dev/null || echo unknown)"
    if [[ "${serial_state}" != "1" ]]; then
      echo
      echo "=================================================================="
      echo "  Se abrirá raspi-config para que deshabilites la consola serie"
      echo "  Selecciona: Interface Options → Serial Port"
      echo "  ¿Login shell por serial? -> No"
      echo "  ¿Habilitar hardware serial? -> Sí"
      echo "=================================================================="
      sleep 1
      if [[ -c "$(tty 2>/dev/null)" ]]; then
        raspi-config <"$(tty)" >"$(tty)" 2>&1
      else
        raspi-config </dev/tty >/dev/tty 2>&1
      fi
      serial_state="$(raspi-config nonint get_serial 2>/dev/null || echo unknown)"
      if [[ "${serial_state}" != "1" ]]; then
        log_warn "El ajuste vía raspi-config no se completó; se aplicarán cambios manuales"
      else
        log "raspi-config configuró la UART correctamente"
        changed=1
      fi
      read -rp "Pulsa ENTER para continuar con la instalación..." _
    else
      log "Login serie ya deshabilitado (estado=${serial_state})"
    fi
  fi

  local cmdline="${BOOT_FIRMWARE_DIR}/cmdline.txt"
  if [[ -f "${cmdline}" ]]; then
    if grep -Eq 'console=(serial0|ttyAMA0|ttyS0)' "${cmdline}"; then
      log "Eliminando consola serie de ${cmdline}"
      sudo sed -i 's/console=\(serial0\|ttyAMA0\|ttyS0\)\(,[^ ]*\)\? //g' "${cmdline}"
      sudo sed -i 's/console=\(serial0\|ttyAMA0\|ttyS0\)\(,[^ ]*\)\?//' "${cmdline}"
      changed=1
    fi
  fi

  local svc
  for svc in serial-getty@serial0.service serial-getty@ttyAMA0.service; do
    if systemctl list-unit-files "${svc}" >/dev/null 2>&1; then
      if systemctl is-enabled --quiet "${svc}"; then
        systemctl disable --now "${svc}" >/dev/null 2>&1 || true
        log "Deshabilitado ${svc}"
        changed=1
      else
        systemctl stop "${svc}" >/dev/null 2>&1 || true
      fi
    fi
  done

  # Refrescar permisos de dispositivos serie si existen
  local dev
  for dev in /dev/serial0 /dev/ttyAMA0 /dev/ttyS0; do
    if [[ -e "${dev}" ]]; then
      chgrp dialout "${dev}" 2>/dev/null || true
      chmod g+rw "${dev}" 2>/dev/null || true
    fi
  done

  local udev_rules="/etc/udev/rules.d/99-bascula-serial.rules"
  cat <<'EOF' | tee "${udev_rules}" >/dev/null
KERNEL=="ttyAMA[0-9]",SYMLINK+="serial0",GROUP="dialout",MODE="0660"
KERNEL=="ttyS[0-9]",ATTRS{serial}=="?*",SYMLINK+="serial0",GROUP="dialout",MODE="0660"
EOF
  chmod 0644 "${udev_rules}"
  if command -v udevadm >/dev/null 2>&1; then
    udevadm control --reload-rules >/dev/null 2>&1 || true
    udevadm trigger --subsystem-match=tty >/dev/null 2>&1 || true
  fi

  if [[ -L /dev/serial0 || -e /dev/serial0 ]]; then
    local current_target
    current_target="$(readlink -f /dev/serial0 2>/dev/null || true)"
    if [[ "${current_target}" != "/dev/ttyAMA0" && -e /dev/ttyAMA0 ]]; then
      ln -sfn /dev/ttyAMA0 /dev/serial0
      log "Actualizado enlace /dev/serial0 -> /dev/ttyAMA0"
      changed=1
    elif [[ "${current_target}" != "/dev/ttyS0" && -e /dev/ttyS0 ]]; then
      ln -sfn /dev/ttyS0 /dev/serial0
      log "Actualizado enlace /dev/serial0 -> /dev/ttyS0"
      changed=1
    fi
  else
    if [[ -e /dev/ttyAMA0 ]]; then
      ln -sfn /dev/ttyAMA0 /dev/serial0
      log "Creado enlace /dev/serial0 -> /dev/ttyAMA0"
      changed=1
    elif [[ -e /dev/ttyS0 ]]; then
      ln -sfn /dev/ttyS0 /dev/serial0
      log "Creado enlace /dev/serial0 -> /dev/ttyS0"
      changed=1
    fi
  fi

  if command -v udevadm >/dev/null 2>&1; then
    udevadm trigger --subsystem-match=tty --action=change >/dev/null 2>&1 || true
  fi

  if command -v jq >/dev/null 2>&1; then
    local pi_cfg="/home/${DEFAULT_USER}/.bascula/config.json"
    if sudo -u "${DEFAULT_USER}" test -f "${pi_cfg}"; then
      local current_device
      current_device="$(sudo -u "${DEFAULT_USER}" jq -r '.serial_device // empty' "${pi_cfg}" 2>/dev/null || true)"
      if [[ -n "${current_device}" && "${current_device}" != "/dev/serial0" ]]; then
        log "Actualizando serial_device en ${pi_cfg} -> /dev/serial0"
        local tmp_cfg
        tmp_cfg="$(sudo -u "${DEFAULT_USER}" mktemp)"
        sudo -u "${DEFAULT_USER}" jq '.serial_device = "/dev/serial0"' "${pi_cfg}" >"${tmp_cfg}" && \
          sudo -u "${DEFAULT_USER}" mv "${tmp_cfg}" "${pi_cfg}"
        changed=1
      fi
    fi
  fi

  if [[ ${changed} -eq 1 ]]; then
    log "Requiere reinicio para aplicar totalmente la configuración de UART"
    REBOOT_FLAG=1
  fi
}

current_commit() {
  if command -v git >/dev/null 2>&1 && git -C "${REPO_ROOT}" rev-parse HEAD >/dev/null 2>&1; then
    git -C "${REPO_ROOT}" rev-parse HEAD
  else
    printf 'unknown\n'
  fi
}

select_release_dir() {
  local commit="$1"
  local existing_target
  if [[ -L "${CURRENT_LINK}" ]]; then
    existing_target=$(readlink -f "${CURRENT_LINK}")
    if [[ -n "${existing_target}" && -f "${existing_target}/.release-commit" ]]; then
      if [[ $(cat "${existing_target}/.release-commit") == "${commit}" ]]; then
        log "Reutilizando release actual ${existing_target}".
        RELEASE_DIR="${existing_target}"
        return 0
      fi
    fi
  fi
  local ts
  if [[ -n "${BASCULA_RELEASE_ID:-}" ]]; then
    ts="${BASCULA_RELEASE_ID}"
  else
    ts=$(date +%Y%m%d-%H%M%S)
  fi
  RELEASE_DIR="${RELEASES_DIR}/${ts}"
  install -d -m 0755 -o root -g root "${RELEASE_DIR}"
}

sync_release_contents() {
  log "Sincronizando release en ${RELEASE_DIR}"
  rsync -a --delete --exclude='.git' --exclude='.venv' "${REPO_ROOT}/" "${RELEASE_DIR}/"
  printf '%s\n' "${COMMIT}" > "${RELEASE_DIR}/.release-commit"
  ln -sfn "${RELEASE_DIR}" "${CURRENT_LINK}"
  ensure_release_ownership
}

ensure_release_ownership() {
  if [[ ! -L "${CURRENT_LINK}" ]]; then
    return 0
  fi

  local resolved release_basename
  resolved=$(readlink -f "${CURRENT_LINK}" || true)
  if [[ -z "${resolved}" || ! -d "${resolved}" ]]; then
    return 0
  fi

  release_basename="$(basename "${resolved}")"

  chown -R "${DEFAULT_USER}:${DEFAULT_USER}" "${CURRENT_LINK}" || true
  if [[ -d "${RELEASES_DIR}/${release_basename}" ]]; then
    chown -R "${DEFAULT_USER}:${DEFAULT_USER}" "${RELEASES_DIR}/${release_basename}"
  else
    chown -R "${DEFAULT_USER}:${DEFAULT_USER}" "${resolved}"
  fi
}

ensure_python_venv() {
  local venv_dir="${CURRENT_LINK}/.venv"
  log_step "Creando/actualizando entorno virtual en ${venv_dir}"
  python3 -m venv --system-site-packages "${venv_dir}"
  sed -i 's/^include-system-site-packages = .*/include-system-site-packages = true/' "${venv_dir}/pyvenv.cfg" || true
  source "${venv_dir}/bin/activate"
  # limpieza defensiva de wheels que rompen ABI si alguien los dejó
  pip uninstall -y numpy simplejpeg picamera2 || true
  rm -rf "${venv_dir}/lib/python3.11/site-packages"/{numpy*,simplejpeg*,picamera2*} || true
  pip install --upgrade pip wheel
  # Instalamos dependencias base fijando versiones con wheel en Pi (evitamos builds con Rust).
  pip install \
    "uvicorn>=0.30,<1.0" \
    "fastapi==0.115.6" \
    "starlette>=0.40,<0.41" \
    "pydantic==2.7.4" \
    "pydantic-core==2.18.4" \
    "typing_extensions==4.12.2" \
    "annotated-types==0.7.0" \
    "h11==0.14.0" \
    "anyio==4.4.0" \
    "sniffio==1.3.1" \
    "click>=8.1" \
    "httpx==0.28.1" \
    "httpcore>=1.0.0,<2.0.0"
  pip install -r "${CURRENT_LINK}/requirements.txt" --no-deps
  pip install --no-cache-dir \
    "rapidocr-onnxruntime==1.4.4" \
    onnxruntime \
    pyclipper \
    "shapely!=2.0.4,>=1.7.1"
  if [[ -f "${CURRENT_LINK}/requirements-voice.txt" ]]; then
    pip install -r "${CURRENT_LINK}/requirements-voice.txt" --no-deps
  fi
  if ! python -c "import vosk" >/dev/null 2>&1; then
    log_warn "vosk no disponible tras requirements-voice; instalando wheel vosk==0.3.45"
    pip install --no-cache-dir "vosk==0.3.45"
  fi
  if ! python -c "import pyzbar" >/dev/null 2>&1; then
    echo '[WARN] pyzbar no disponible'
  fi
  python - <<'PY'
import importlib
import sys

apt_modules = ("numpy", "simplejpeg", "picamera2")
for name in apt_modules:
    module = importlib.import_module(name)
    path = getattr(module, "__file__", "")
    print(name, "=>", path)
    if "/usr/lib/python3/dist-packages/" not in str(path):
        print("ERROR:", name, "no viene de APT")
        sys.exit(1)

for name in ("uvicorn", "fastapi", "starlette", "click", "httpx", "httpcore"):
    importlib.import_module(name)

for name in ("rapidocr_onnxruntime", "onnxruntime", "pyclipper", "shapely"):
    importlib.import_module(name)
print("venv deps OK")
print("OCR deps OK")
PY
  deactivate || true
}

ensure_vosk_model() {
  log_step "Preparando modelo Vosk (wake word)"
  if ! bash "$(dirname "$0")/fetch-vosk-model.sh"; then
    log_err "No se pudo preparar el modelo Vosk español"
    exit 1
  fi
}

prepare_ocr_models_dir() {
  install -d -o "${DEFAULT_USER}" -g "${DEFAULT_USER}" -m 0755 /opt/rapidocr/models
  cat >/opt/rapidocr/models/README.txt <<'EOF'
Coloca aquí los modelos RapidOCR (.onnx) de detección y reconocimiento.
Variables:
  BASCULA_OCR_ENABLED=true
  BASCULA_OCR_MODELS_DIR=/opt/rapidocr/models
EOF
  chown "${DEFAULT_USER}:${DEFAULT_USER}" /opt/rapidocr/models/README.txt
}

ensure_piper_voices() {
  if ! command -v jq >/dev/null 2>&1; then
    ensure_packages jq
  fi
  if ! command -v curl >/dev/null 2>&1; then
    ensure_packages curl
  fi

  echo "[install] [step] Preparando voces Piper"
  if ! bash "$(dirname "$0")/fetch-piper-voices.sh"; then
    log_err "Error al preparar voces Piper"
    exit 1
  fi
}

ensure_piper_cli() {
  log_step "Instalando Piper CLI"

  local existing
  existing="$(command -v piper 2>/dev/null || true)"
  if [[ -n "${existing}" ]]; then
    if "${existing}" --help >/dev/null 2>&1; then
      if [[ "${existing}" != "${PIPER_BIN_PATH}" ]]; then
        install -Dm0755 "${existing}" "${PIPER_BIN_PATH}"
        log "piper CLI copiado a ${PIPER_BIN_PATH}"
      fi
      log "piper CLI ya disponible en ${PIPER_BIN_PATH}"
      SUMMARY_PIPER_CLI="ok (${PIPER_BIN_PATH})"
      return 0
    fi
    log_warn "Comando piper existente pero inválido (${existing}); se reinstalará"
  fi

  local venv_piper="${CURRENT_LINK}/.venv/bin/piper"
  if [[ -x "${venv_piper}" ]]; then
    install -Dm0755 "${venv_piper}" "${PIPER_BIN_PATH}"
    if [[ -w "${PIPER_BIN_PATH}" ]]; then
      sed -i '1c#!/opt/bascula/current/.venv/bin/python' "${PIPER_BIN_PATH}" || true
    fi
    if "${PIPER_BIN_PATH}" --help >/dev/null 2>&1; then
      SUMMARY_PIPER_CLI="ok (${PIPER_BIN_PATH})"
      log_ok "Piper CLI operativo vía entorno virtual (${PIPER_BIN_PATH})"
      return 0
    fi
    local venv_err
    venv_err="$("${PIPER_BIN_PATH}" --help 2>&1 || true)"
    log_warn "Piper CLI de la venv no respondió correctamente, se intentará binario precompilado"
    log_warn "Salida (--help): ${venv_err}"
  fi

  local tmpdir archive
  tmpdir="$(mktemp -d)"
  archive="${tmpdir}/piper.tar.gz"

  local version="${PIPER_RELEASE_VERSION}"
  local base="https://github.com/rhasspy/piper/releases/download/v${version}"
  local -a candidates=()
  local -A seen=()

  if [[ -n "${PIPER_RELEASE_URL:-}" ]]; then
    candidates+=("${PIPER_RELEASE_URL}")
    seen["${PIPER_RELEASE_URL}"]=1
  fi

  local fallback
  for fallback in \
    "piper_${version}_linux_aarch64.tar.gz" \
    "piper_${version}_linux-aarch64.tar.gz" \
    "piper_${version}_linux-arm64.tar.gz" \
    "piper_${version}_linux_arm64.tar.gz" \
    "piper_${version}_aarch64.tar.gz" \
    "piper_${version}_arm64.tar.gz" \
    "piper_linux_aarch64.tar.gz" \
    "piper_linux-aarch64.tar.gz" \
    "piper_linux-arm64.tar.gz" \
    "piper_linux_arm64.tar.gz" \
    "piper_aarch64.tar.gz" \
    "piper_arm64.tar.gz"
  do
    local url="${base}/${fallback}"
    if [[ -z "${seen["${url}"]:-}" ]]; then
      candidates+=("${url}")
      seen["${url}"]=1
    fi
  done

  local downloaded=0 last_rc=0
  local -a tried=()
  local url
  for url in "${candidates[@]}"; do
    tried+=("${url}")
    log "Descargando Piper CLI desde ${url}"
    if curl --retry 5 --retry-delay 2 --fail --location -o "${archive}" "${url}"; then
      downloaded=1
      PIPER_RELEASE_URL="${url}"
      break
    fi
    last_rc=$?
    rm -f "${archive}"
    log_warn "Descarga de Piper CLI falló (rc=${last_rc})"
  done

  if [[ ${downloaded} -eq 0 ]]; then
    rm -rf "${tmpdir}"
    log_err "No se pudo descargar Piper CLI tras probar las siguientes URLs:"
    for url in "${tried[@]}"; do
      log_err "  - ${url}"
    done
    exit 1
  fi

  if ! tar -xzf "${archive}" -C "${tmpdir}"; then
    rc=$?
    rm -rf "${tmpdir}"
    log_err "Extracción de Piper CLI falló (rc=${rc})"
    exit 1
  fi

  local binary
  binary="$(find "${tmpdir}" -type f -name 'piper' -perm -u+x | head -n1)"
  if [[ -z "${binary}" ]]; then
    rm -rf "${tmpdir}"
    log_err "El paquete descargado no contiene binario 'piper' ejecutable"
    exit 1
  fi

  install -Dm0755 "${binary}" "${PIPER_BIN_PATH}"
  rm -rf "${tmpdir}"

  local help_output
  if ! help_output="$("${PIPER_BIN_PATH}" --help 2>&1)"; then
    log_err "piper CLI instalado pero --help falló: ${help_output}"
    exit 1
  fi

  SUMMARY_PIPER_CLI="ok (${PIPER_BIN_PATH})"
  log_ok "Piper CLI instalado en ${PIPER_BIN_PATH}"
}

ensure_voice_symlinks() {
  install -d -m0755 "${VOICE_SYMLINK_ROOT}"

  shopt -s nullglob
  local model
  for model in "${PIPER_VOICES_DIR}"/*.onnx; do
    local base
    base="$(basename "${model}")"
    ln -sfn "piper/${base}" "${VOICE_SYMLINK_ROOT}/${base}"
    if [[ -f "${model}.json" ]]; then
      ln -sfn "piper/${base}.json" "${VOICE_SYMLINK_ROOT}/${base}.json"
    fi
  done
  shopt -u nullglob

  if [[ -e "${PIPER_VOICES_DIR}/default.onnx" ]]; then
    ln -sfn "piper/default.onnx" "${VOICE_SYMLINK_ROOT}/default.onnx"
    if [[ -f "${PIPER_VOICES_DIR}/default.onnx.json" ]]; then
      ln -sfn "piper/default.onnx.json" "${VOICE_SYMLINK_ROOT}/default.onnx.json"
    fi
  fi

  if getent passwd "${DEFAULT_USER}" >/dev/null 2>&1; then
    chown -h "${DEFAULT_USER}:${DEFAULT_USER}" "${VOICE_SYMLINK_ROOT}" 2>/dev/null || true
    shopt -s nullglob
    local symlinks=("${VOICE_SYMLINK_ROOT}"/*.onnx "${VOICE_SYMLINK_ROOT}"/*.json)
    shopt -u nullglob
    if (( ${#symlinks[@]} > 0 )); then
      chown -h "${DEFAULT_USER}:${DEFAULT_USER}" "${symlinks[@]}" 2>/dev/null || true
    fi
  fi
}

ensure_user_groups() {
  if ! id "${DEFAULT_USER}" >/dev/null 2>&1; then
    log_warn "Usuario ${DEFAULT_USER} no encontrado para ajustar grupos"
    return
  fi

  local groups=(video render audio input dialout plugdev)
  local group
  for group in "${groups[@]}"; do
    if ! getent group "${group}" >/dev/null 2>&1; then
      log_warn "Grupo ${group} no existe; omitiendo"
      continue
    fi
    if id -nG "${DEFAULT_USER}" | tr ' ' '\n' | grep -Fxq "${group}"; then
      continue
    fi
    if usermod -a -G "${group}" "${DEFAULT_USER}"; then
      log "Añadido ${DEFAULT_USER} al grupo ${group}"
    else
      log_warn "No se pudo añadir ${DEFAULT_USER} al grupo ${group}"
    fi
  done
}

record_audio_devices() {
  if command -v aplay >/dev/null 2>&1; then
    SUMMARY_AUDIO_DEVICES="$(aplay -l 2>/dev/null | head -n 10)"
  else
    SUMMARY_AUDIO_DEVICES="aplay no disponible"
  fi
}

collect_display_status() {
  if [[ -e /dev/dri/card1 ]]; then
    SUMMARY_KMS_STATUS="OK (/dev/dri/card1)"
  elif [[ -e /dev/dri/card0 ]]; then
    SUMMARY_KMS_STATUS="WARN (/dev/dri/card0)"
  else
    SUMMARY_KMS_STATUS="ERROR (sin /dev/dri/card*)"
  fi

  local log_path
  log_path="$(get_xorg_log_path)"
  if [[ -f "${log_path}" ]]; then
    if grep -qi 'no screens found' "${log_path}"; then
      SUMMARY_XORG_STATUS="errores (no screens found)"
    else
      SUMMARY_XORG_STATUS="ok"
    fi
  else
    SUMMARY_XORG_STATUS="sin log"
  fi
}

ensure_audio_env_file() {
  cat <<'EOF' > "${AUDIO_ENV_FILE}.tmp"
BASCULA_AUDIO_DEVICE=bascula_out
BASCULA_MIC_DEVICE=bascula_mix_in
BASCULA_SAMPLE_RATE=16000
EOF
  install -o root -g root -m 0644 "${AUDIO_ENV_FILE}.tmp" "${AUDIO_ENV_FILE}"
  rm -f "${AUDIO_ENV_FILE}.tmp"
}

ensure_backend_env_file() {
  local file="/etc/default/bascula-backend"
  local tmp="${file}.tmp"
  cat <<'EOF' > "${tmp}"
# Variables opcionales para la báscula física.
#
# BASCULA_SCALE_PORT=/dev/ttyUSB0
# BASCULA_SCALE_BAUD=9600
# BASCULA_SCALE_PROTOCOL=serial
# BASCULA_SCALE_DEMO=false
# BASCULA_SCALE_TIMEOUT_S=2
#
# Dejar BASCULA_SCALE_DEMO=true fuerza modo demo sin hardware.
BASCULA_WAKE_ENABLED=false
BASCULA_VOSK_ENABLED=false
BASCULA_LISTEN_ENABLED=false
DISABLE_WAKE=1
BASCULA_MIC_DEVICE=bascula_mix_in
BASCULA_SAMPLE_RATE=16000
EOF
  if [[ -f "${file}" ]] && cmp -s "${tmp}" "${file}"; then
    rm -f "${tmp}"
    return
  fi
  install -o root -g root -m0644 "${tmp}" "${file}"
  rm -f "${tmp}"
}

get_playback_hw() {
  if command -v aplay >/dev/null 2>&1; then
    local list
    list=$(aplay -L 2>/dev/null)
    local hifiberry
    hifiberry=$(printf '%s\n' "${list}" | awk '/^hw:CARD=sndrpihifiberry/ {print; exit}')
    if [[ -n "${hifiberry}" ]]; then
      printf '%s\n' "${hifiberry}"
      return 0
    fi
    local hdmi
    hdmi=$(printf '%s\n' "${list}" | awk '/^hw:CARD=vc4hdmi/ {print; exit}')
    if [[ -n "${hdmi}" ]]; then
      printf '%s\n' "${hdmi}"
      return 0
    fi
  fi
  printf 'hw:0,0\n'
}

get_capture_hw() {
  CAPTURE_HW_RECOMMENDATION="hw:1,0"

  if ! command -v arecord >/dev/null 2>&1; then
    log_warn "arecord no disponible; instala alsa-utils para detectar micrófonos"
    return 0
  fi

  local capture_cards capture_list preferred
  capture_cards="$(arecord -l 2>/dev/null || true)"
  capture_list="$(arecord -L 2>/dev/null || true)"

  if [[ -n "${capture_cards//[[:space:]]/}" ]]; then
    CAPTURE_HW_DETECTED=1
  else
    log_warn "No se detectaron dispositivos de captura ALSA (arecord -l)"
  fi

  if [[ -n "${capture_list}" ]]; then
    local candidates
    candidates="$(printf '%s\n' "${capture_list}" | awk '/^(default|plughw|hw):CARD=/ {print}' || true)"
    preferred="$(printf '%s\n' "${candidates}" | grep -Ei 'usb|mic|seeed|input|record' | head -n1 || true)"
    if [[ -z "${preferred}" ]]; then
      preferred="$(printf '%s\n' "${candidates}" | awk '/^(default|plughw):CARD=/ {print; exit}' || true)"
    fi
    if [[ -z "${preferred}" ]]; then
      preferred="$(printf '%s\n' "${candidates}" | awk '/^hw:CARD=/ {print; exit}' || true)"
    fi
    if [[ -n "${preferred}" ]]; then
      CAPTURE_HW_RECOMMENDATION="${preferred}"
      log "Micrófono recomendado para Vosk/Piper: ${preferred}"
    fi
  fi

  if [[ ${CAPTURE_HW_DETECTED} -eq 0 ]]; then
    if command -v aplay >/dev/null 2>&1; then
      local playback_cards
      playback_cards="$(aplay -l 2>/dev/null || true)"
      if [[ -n "${playback_cards//[[:space:]]/}" ]]; then
        log_warn "Sólo se detectó salida ALSA; Piper funcionará pero falta micrófono para Vosk"
      else
        log_warn "Tampoco se detectaron salidas ALSA (aplay -l)"
      fi
    fi
  fi

  printf '%s\n' "${CAPTURE_HW_RECOMMENDATION}"
  return 0
}

install_asound_conf() {
  local playback_hw capture_hw playback_card capture_card
  playback_hw=$(get_playback_hw)
  capture_hw=$(get_capture_hw | tail -n1)
  playback_card=$(printf '%s' "${playback_hw}" | sed -E 's#^hw:(CARD=)?([^,]+).*$#\2#')
  if [[ "${capture_hw}" =~ ^(plughw|hw):CARD=([^,]+),DEV=([0-9]+) ]]; then
    capture_card="${BASH_REMATCH[2]}"
  elif [[ "${capture_hw}" =~ ^(plughw|hw):([^,]+),DEV=([0-9]+) ]]; then
    capture_card="${BASH_REMATCH[2]}"
  elif [[ "${capture_hw}" =~ ^(plughw|hw):CARD=([^,]+) ]]; then
    capture_card="${BASH_REMATCH[2]}"
  elif [[ "${capture_hw}" =~ ^(plughw|hw):([^,]+) ]]; then
    capture_card="${BASH_REMATCH[2]}"
  elif [[ "${capture_hw}" =~ ^hw:([0-9]+) ]]; then
    capture_card="${BASH_REMATCH[1]}"
  else
    capture_card="${capture_hw}"
  fi
  if [[ -z "${capture_card}" ]]; then
    capture_card="0"
  fi
  cat <<EOF > "${ASOUND_CONF}.tmp"
pcm.bascula_out {
    type plug
    slave.pcm "bascula_out_dmix"
}

pcm.!default {
    type plug
    slave.pcm "bascula_out"
}

pcm.bascula_out_dmix {
    type dmix
    ipc_key 8675309
    slave {
        pcm "${playback_hw}"
        channels 2
        rate 48000
        format S16_LE
    }
}

ctl.bascula_out {
    type hw
    card "${playback_card}"
}

ctl.!default {
    type hw
    card "${playback_card}"
}

pcm.bascula_mix_in {
    type plug
    slave.pcm "bascula_mix_in_raw"
}

pcm.bascula_mix_in_raw {
    type dsnoop
    ipc_key 8675310
    slave {
        pcm "${capture_hw}"
        channels 1
    }
}

ctl.bascula_mix_in {
    type hw
    card "${capture_card}"
}
EOF
  if [[ -f "${ASOUND_CONF}" ]] && cmp -s "${ASOUND_CONF}.tmp" "${ASOUND_CONF}"; then
    rm -f "${ASOUND_CONF}.tmp"
    log "asound.conf sin cambios"
  else
    install -o root -g root -m 0644 "${ASOUND_CONF}.tmp" "${ASOUND_CONF}"
    log "asound.conf desplegado playback=${playback_hw}, capture=${capture_hw}"
  fi
}

ensure_capture_dirs() {
  install -d -m 0775 -o "${DEFAULT_USER}" -g "${WWW_GROUP}" /run/bascula
  install -d -m 02770 -o "${DEFAULT_USER}" -g "${WWW_GROUP}" /run/bascula/captures
  chmod g+s /run/bascula/captures
}


ensure_x735_support() {
  local os_dir="${RELEASE_DIR}/system/os"
  local script_src="${os_dir}/x735-ensure.sh"
  local unit_src="${os_dir}/x735-ensure.service"
  local target_script="/usr/local/sbin/x735-ensure.sh"
  local target_unit="${SYSTEMD_DEST}/x735-ensure.service"

  if [[ ! -f "${script_src}" || ! -f "${unit_src}" ]]; then
    log "Soporte X735 no encontrado en release; omitiendo despliegue"
    return 0
  fi

  log_step "Instalando soporte X735 (fan/power)"
  install -D -m 0755 "${script_src}" "${target_script}"
  install -D -m 0644 "${unit_src}" "${target_unit}"

  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || true
    if ! systemctl enable x735-ensure.service; then
      log_warn "No se pudo habilitar x735-ensure.service (continuando)"
    fi
  fi

  if ! "${target_script}" --oneshot; then
    log_warn "x735-ensure.sh --oneshot devolvió un error (continuando)"
  fi
}

ensure_www_root() {
  if [[ ! -d "${WWW_ROOT}" ]]; then
    mkdir -p "${WWW_ROOT}"
  fi
  chown -R "${DEFAULT_USER}:${WWW_GROUP}" "${WWW_ROOT}"
}

install_bascula_ota_script() {
  log_step "Instalando script OTA bascula-ota"
  install -d -m 0755 -o root -g root /usr/local/bin
  local tmp
  tmp="$(mktemp)"
  cat <<'EOF' > "${tmp}"
#!/bin/bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  exec sudo "$0" "$@"
fi

OTA_ROOT="/opt/bascula"
REL_DIR="${OTA_ROOT}/releases"
CUR_LINK="${OTA_ROOT}/current"
STATE_DIR="/var/lib/bascula/ota-prev"
PREV_FILE="${STATE_DIR}/last"
LOG_TAG="bascula-ota"

mkdir -p "${STATE_DIR}"
chown pi:pi "${STATE_DIR}" >/dev/null 2>&1 || true
chmod 755 "${STATE_DIR}"

log() {
  local msg="$1"
  local ts
  ts="$(date --iso-8601=seconds)"
  printf '%s %s\n' "${ts}" "${msg}"
  logger -t "${LOG_TAG}" -- "${msg}" || true
}

die() {
  log "ERROR: $*"
  exit 1
}

current_release() {
  if [[ -L "${CUR_LINK}" ]]; then
    readlink -f "${CUR_LINK}"
  else
    echo ""
  fi
}

validate_release_path() {
  local path="$1"
  [[ -d "${path}" ]] || die "Release ${path} no encontrada"
}

release_label() {
  local path="$1"
  basename "${path}"
}

list_releases() {
  find "${REL_DIR}" -maxdepth 1 -mindepth 1 -type d -printf '%f\n' | sort
}

health_check() {
  local name="$1"
  local url="$2"
  local attempts=15
  local delay=2
  local i

  for ((i=1; i<=attempts; i++)); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      log "${name} health check passed on attempt ${i}"
      return 0
    fi
    sleep "${delay}"
  done
  log "${name} health check failed after ${attempts} attempts"
  return 1
}

restart_stack() {
  systemctl daemon-reload

  log "Restarting bascula-backend"
  systemctl restart bascula-backend
  sleep 2
  health_check "backend" "http://127.0.0.1:8081/health" || return 1

  log "Restarting bascula-miniweb"
  systemctl restart bascula-miniweb
  sleep 2
  if ! health_check "miniweb" "http://127.0.0.1:8080/health"; then
    health_check "miniweb" "http://127.0.0.1:8080/" || return 1
  fi

  log "Restarting bascula-ui"
  systemctl restart bascula-ui || true
  return 0
}

record_previous() {
  local prev="$1"
  if [[ -n "${prev}" ]]; then
    printf '%s\n' "${prev}" > "${PREV_FILE}"
    chown pi:pi "${PREV_FILE}" >/dev/null 2>&1 || true
  fi
}

switch_release() {
  local target="$1"
  local previous

  previous="$(current_release)"
  validate_release_path "${target}"

  if [[ "${target}" == "${previous}" ]]; then
    log "Target $(release_label "${target}") already active"
    return 0
  fi

  record_previous "${previous}"
  log "Switching from $(release_label "${previous}") to $(release_label "${target}")"
  ln -sfn "${target}" "${CUR_LINK}"

  if restart_stack; then
    log "Switch successful"
    return 0
  fi

  log "Switch failed; initiating rollback"
  rollback_internal || die "Automatic rollback failed"
  die "Switch failed; rolled back to $(release_label "$(current_release)")"
}

rollback_internal() {
  if [[ ! -f "${PREV_FILE}" ]]; then
    log "No previous release recorded"
    return 1
  fi
  local target
  target="$(cat "${PREV_FILE}")"
  validate_release_path "${target}"
  log "Rolling back to $(release_label "${target}")"
  ln -sfn "${target}" "${CUR_LINK}"
  restart_stack || die "Rollback restart sequence failed"
  log "Rollback completed"
  return 0
}

cmd_status() {
  local current
  current="$(current_release)"
  if [[ -z "${current}" ]]; then
    echo "current symlink missing"
  else
    echo "current -> ${current}"
  fi
  if [[ -f "${PREV_FILE}" ]]; then
    echo "previous -> $(cat "${PREV_FILE}")"
  else
    echo "previous -> (none)"
  fi
}

cmd_list() {
  list_releases
}

cmd_switch() {
  local version="$1"
  local target
  if [[ -d "${version}" ]]; then
    target="$(readlink -f "${version}")"
  else
    target="${REL_DIR}/${version}"
  fi
  validate_release_path "${target}"
  switch_release "${target}"
}

cmd_rollback() {
  rollback_internal || die "Rollback not possible"
}

usage() {
  cat <<USAGE
Usage: bascula-ota <command> [args]
Commands:
  status                Show current and previous releases
  list                  List available releases
  switch <release>      Activate release (name or absolute path)
  rollback              Return to the previously active release
USAGE
}

main() {
  local cmd="${1:-}"; shift || true
  case "${cmd}" in
    status) cmd_status "$@" ;;
    list) cmd_list "$@" ;;
    switch)
      [[ $# -eq 1 ]] || die "switch requires a release name"
      cmd_switch "$1"
      ;;
    rollback) cmd_rollback "$@" ;;
    *)
      usage
      [[ -z "${cmd}" ]] && exit 0 || exit 1
      ;;
  esac
}

main "$@"
EOF
  install -m 0755 -o root -g root "${tmp}" /usr/local/bin/bascula-ota
  rm -f "${tmp}"

  install -d -m 0755 -o root -g root /var/lib/bascula
  install -d -m 0755 -o pi -g pi /var/lib/bascula/ota-prev
}

ensure_log_dir() {
  install -d -m 0755 -o "${DEFAULT_USER}" -g "${DEFAULT_USER}" /var/log/bascula
}

install_tmpfiles_config() {
  install -D -m 0644 "${RELEASE_DIR}/systemd/tmpfiles.d/bascula.conf" "${TMPFILES_DEST}/bascula.conf"
}

install_systemd_unit() {
  local name="$1"
  local src=""
  local candidate

  for candidate in \
    "${RELEASE_DIR}/systemd/${name}" \
    "${RELEASE_DIR}/scripts/systemd/${name}" \
    "${REPO_DIR:-}/scripts/systemd/${name}" \
    "${REPO_DIR:-}/systemd/${name}" \
    "${REPO_ROOT}/scripts/systemd/${name}" \
    "${REPO_ROOT}/systemd/${name}"; do
    if [[ -n "${candidate}" && -f "${candidate}" ]]; then
      src="${candidate}"
      break
    fi
  done

  local dest="${SYSTEMD_DEST}/${name}"
  local changed=0
  if [[ -z "${src}" ]]; then
    abort "No se encontró unidad systemd ${name}"
  fi
  if [[ -f "${dest}" ]] && cmp -s "${src}" "${dest}"; then
    log "Unidad ${name} sin cambios"
  else
    install -D -m 0644 "${src}" "${dest}"
    log "Unidad ${name} instalada"
    changed=1
  fi
  if [[ -d "${src}.d" ]]; then
    local rsync_output
    rsync_output="$(rsync -a --delete --out-format='%i %n%L' "${src}.d/" "${dest}.d/" 2>&1)"
    if [[ -n "${rsync_output}" ]]; then
      log "Drop-ins actualizados para ${name}"
      changed=1
    fi
  fi
  if [[ ${changed} -eq 1 ]]; then
    SYSTEMD_NEEDS_RELOAD=1
  fi
}

install_systemd_units() {
  SYSTEMD_NEEDS_RELOAD=0
  local search_dirs=()
  if [[ -n "${REPO_DIR:-}" && -d "${REPO_DIR}/scripts/systemd" ]]; then
    search_dirs+=("${REPO_DIR}/scripts/systemd")
  fi
  if [[ -n "${REPO_DIR:-}" && -d "${REPO_DIR}/systemd" ]]; then
    search_dirs+=("${REPO_DIR}/systemd")
  fi
  if [[ -d "${REPO_ROOT}/scripts/systemd" ]]; then
    search_dirs+=("${REPO_ROOT}/scripts/systemd")
  fi
  if [[ -d "${REPO_ROOT}/systemd" ]]; then
    search_dirs+=("${REPO_ROOT}/systemd")
  fi

  declare -A seen=()
  local dir src name
  for dir in "${search_dirs[@]}"; do
    [[ -d "${dir}" ]] || continue
    while IFS= read -r -d '' src; do
      name="$(basename "${src}")"
      if [[ -n "${seen[${name}]:-}" ]]; then
        continue
      fi
      seen["${name}"]=1
      install_systemd_unit "${name}"
    done < <(find "${dir}" -maxdepth 1 -type f -name 'bascula-*.service' -print0 2>/dev/null)
  done

  local required=(
    bascula-miniweb.service
    bascula-backend.service
    bascula-health-wait.service
    bascula-ui.service
  )
  for name in "${required[@]}"; do
    if [[ -z "${seen[${name}]:-}" ]]; then
      install_systemd_unit "${name}"
    fi
  done

  if [[ ${SYSTEMD_NEEDS_RELOAD} -eq 1 ]]; then
    systemctl daemon-reload
    systemctl restart bascula-ui.service || true
    SYSTEMD_NEEDS_RELOAD=0
  fi
}

configure_nginx_site() {
  log_step "Configurando Nginx para Báscula"
  install -d -m0755 "${NGINX_SITES_AVAILABLE}" "${NGINX_SITES_ENABLED}"

  local template
  if [[ -n "${REPO_DIR:-}" && -f "${REPO_DIR}/deploy/nginx/bascula.conf" ]]; then
    template="${REPO_DIR}/deploy/nginx/bascula.conf"
  else
    template="${REPO_ROOT}/deploy/nginx/bascula.conf"
  fi
  if [[ ! -f "${template}" ]]; then
    abort "No se encontró plantilla Nginx en ${template}"
  fi

  local rendered
  rendered="$(mktemp)"
  sed "s#__WWW_ROOT__#${WWW_ROOT//\//\/}#g" "${template}" > "${rendered}"
  install -o root -g root -m0644 "${rendered}" "${NGINX_SITES_AVAILABLE}/${NGINX_SITE_NAME}"
  rm -f "${rendered}"

  ln -sfn "${NGINX_SITES_AVAILABLE}/${NGINX_SITE_NAME}" "${NGINX_SITES_ENABLED}/${NGINX_SITE_NAME}"

  if [[ -L "${NGINX_SITES_ENABLED}/default" || -f "${NGINX_SITES_ENABLED}/default" ]]; then
    rm -f "${NGINX_SITES_ENABLED}/default"
  fi
  if [[ -L "${NGINX_SITES_ENABLED}/000-default.conf" || -f "${NGINX_SITES_ENABLED}/000-default.conf" ]]; then
    rm -f "${NGINX_SITES_ENABLED}/000-default.conf"
  fi
}

ensure_kiosk_packages() {
  ensure_packages xserver-xorg xinit x11-xserver-utils openbox unclutter curl jq upower fonts-dejavu-core
}

ensure_chromium_browser() {
  ensure_kiosk_packages

  local chromium_bin
  chromium_bin="$(command -v chromium-browser 2>/dev/null || command -v chromium 2>/dev/null || true)"

  if [[ -z "${chromium_bin}" ]]; then
    log "[step] Instalando Chromium para el modo quiosco"
    ensure_package_alternative "chromium" chromium-browser chromium

    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ttf-mscorefonts-installer || \
      log_warn "No se pudo instalar ttf-mscorefonts-installer"

    chromium_bin="$(command -v chromium-browser 2>/dev/null || command -v chromium 2>/dev/null || true)"
  else
    log "Chromium ya disponible en ${chromium_bin}"
  fi

  if [[ -x /usr/bin/chromium ]] && [[ ! -e /usr/bin/chromium-browser ]]; then
    ln -sfn /usr/bin/chromium /usr/bin/chromium-browser
    chromium_bin="/usr/bin/chromium"
  fi

  if [[ -z "${chromium_bin}" || ! -x "${chromium_bin}" ]]; then
    abort "No se encontró un binario de Chromium tras la instalación"
  fi
}

configure_bascula_ui_service() {
  log "[step] Configurando bascula-ui.service"
  ensure_chromium_browser

  local kiosk_script="${REPO_DIR}/scripts/start-kiosk.sh"
  if [[ ! -f "${kiosk_script}" ]]; then
    kiosk_script="${REPO_ROOT}/scripts/start-kiosk.sh"
  fi
  if [[ ! -f "${kiosk_script}" ]]; then
    abort "No se encontró scripts/start-kiosk.sh"
  fi
  if ! bash -n "${kiosk_script}"; then
    log_err "Sintaxis inválida en ${kiosk_script}"
    exit 1
  fi

  local xinit_dest="/home/${DEFAULT_USER}/.xinitrc"
  local xinit_tmp
  xinit_tmp="$(mktemp)"
  cat >"${xinit_tmp}" <<'EOF'
# .xinitrc para Bascula UI - delega en start-kiosk.sh
exec /opt/bascula/current/scripts/start-kiosk.sh
EOF
  local needs_update=0
  if [[ ! -f "${xinit_dest}" ]]; then
    needs_update=1
  elif ! cmp -s "${xinit_tmp}" "${xinit_dest}"; then
    needs_update=1
  fi
  if [[ ${needs_update} -eq 1 ]]; then
    install -D -o "${DEFAULT_USER}" -g "${DEFAULT_USER}" -m0755 "${xinit_tmp}" "${xinit_dest}"
    log "Actualizado ${xinit_dest}"
  else
    log "${xinit_dest} sin cambios"
  fi
  rm -f "${xinit_tmp}" || true

  local dropin_dir="/etc/systemd/system/bascula-ui.service.d"
  local dropin_file="${dropin_dir}/30-chrome-cache.conf"
  install -d -m0755 "${dropin_dir}"

  if [[ ! -f "${SYSTEMD_DEST}/bascula-ui.service" ]]; then
    log_warn "bascula-ui.service ausente en ${SYSTEMD_DEST}; reinstalando"
    install_systemd_unit "bascula-ui.service"
    if [[ ! -f "${SYSTEMD_DEST}/bascula-ui.service" ]]; then
      abort "No se pudo instalar bascula-ui.service en ${SYSTEMD_DEST}"
    fi
  fi

  if [[ ${SYSTEMD_NEEDS_RELOAD:-0} -eq 1 ]]; then
    systemctl daemon-reload
    SYSTEMD_NEEDS_RELOAD=0
  fi

  local tmp="${dropin_file}.tmp"
  cat >"${tmp}" <<'EOF'
[Service]
ExecStartPre=/bin/sh -c 'rm -rf /run/bascula/chrome-profile /run/bascula/chrome-cache; install -d -m0700 -o pi -g pi /run/user/1000'
Environment=XDG_RUNTIME_DIR=/run/user/1000
EOF

  local need_reload=0
  if [[ -f "${dropin_file}" ]] && cmp -s "${tmp}" "${dropin_file}"; then
    rm -f "${tmp}"
  else
    install -o root -g root -m0644 "${tmp}" "${dropin_file}"
    need_reload=1
  fi
  rm -f "${tmp}" || true

  if [[ ${need_reload} -eq 1 ]]; then
    systemctl daemon-reload
    systemctl restart bascula-ui.service || true
  fi

  # Comprobar bus de sesión
  if ! sudo -u "${DEFAULT_USER}" test -S /run/user/1000/bus; then
    echo "[install][warn] /run/user/1000/bus aún no disponible; creando XDG_RUNTIME_DIR"
    install -d -m0700 -o pi -g pi /run/user/1000 || true
  fi

  systemctl enable bascula-ui.service
}

ensure_services_started() {
  log_step "Activando servicios básicos"
  local service unit_path
  for service in bascula-backend bascula-miniweb bascula-health-wait bascula-ui; do
    unit_path="${SYSTEMD_DEST}/${service}.service"
    if [[ ! -f "${unit_path}" ]]; then
      log_err "Falta unidad systemd requerida: ${unit_path}"
      exit 1
    fi
    if systemctl enable --now "${service}.service"; then
      log "Servicio ${service}.service habilitado y arrancado"
    else
      log_err "Fallo al habilitar/arrancar ${service}.service"
      journalctl -u "${service}.service" -n 80 --no-pager || true
      exit 1
    fi
  done
}

verify_xorg_session() {
  if [[ ${IS_PI5} -ne 1 ]]; then
    return 0
  fi

  local verify_script="${REPO_DIR}/scripts/verify-xorg.sh"
  if [[ ! -x "${verify_script}" && -x "${REPO_ROOT}/scripts/verify-xorg.sh" ]]; then
    verify_script="${REPO_ROOT}/scripts/verify-xorg.sh"
  fi
  if [[ ! -x "${verify_script}" ]]; then
    log_warn "No se encontró verify-xorg.sh para validar la sesión X"
    return 0
  fi

  if ! "${verify_script}"; then
    log_err "Verificación de Xorg falló"
    print_xorg_tail_relevant "warn"
    exit 1
  fi
}

smoke_failure_diagnostics() {
  log_warn "Diagnóstico de servicios bascula-*"
  local svc
  for svc in bascula-backend bascula-miniweb bascula-health-wait bascula-ui; do
    dump_service_journal "${svc}"
  done
  print_xorg_tail_relevant "warn"
}

run_final_smoke_tests() {
  log_step "Smoke test final"
  local failure=0

  local svc
  for svc in bascula-backend bascula-miniweb bascula-ui; do
    if ! systemctl is-active --quiet "${svc}.service"; then
      log_err "Smoke test: ${svc}.service no está activo"
      failure=1
    fi
  done

  if ! curl -fsS http://127.0.0.1:8081/api/health >/dev/null; then
    log_err "Smoke test: backend 8081/api/health no responde"
    failure=1
  fi
  if ! curl -fsS http://127.0.0.1:8080/api/miniweb/status >/dev/null; then
    log_err "Smoke test: miniweb 8080/api/miniweb/status no responde"
    failure=1
  fi

  if [[ ! -e /dev/dri/card0 && ! -e /dev/dri/card1 ]]; then
    log_err "Smoke test: no se encontró /dev/dri/card0 ni card1"
    failure=1
  fi

  if [[ ${failure} -ne 0 ]]; then
    smoke_failure_diagnostics
    exit 1
  fi

  log_ok "Smoke test final superado"
}

run_final_checks() {
  log_step "Ejecutando validaciones finales"
  FINAL_FAILURES=0

  local svc unit_path
  for svc in bascula-backend bascula-miniweb bascula-health-wait bascula-ui; do
    unit_path="${SYSTEMD_DEST}/${svc}.service"
    if [[ ! -f "${unit_path}" ]]; then
      log_err "Falta unidad systemd requerida: ${unit_path}"
      exit 1
    fi
    assert_unit_active "${svc}" && log "[ok] servicio ${svc} activo"
  done

  final_check "servicio nginx activo" systemctl is-active --quiet nginx

  final_check "puerto 8081 escuchando" port_listening 8081
  final_check "puerto 80 escuchando" port_listening 80
  final_check "miniweb status" check_http_endpoint "http://127.0.0.1:8080/api/miniweb/status" ""
  final_check "health backend directo" check_http_endpoint "http://127.0.0.1:8081/health" ""
  final_check "health vía nginx" check_scale_health
  final_check "cabeceras SSE en proxy" check_sse_headers "http://127.0.0.1/api/scale/events"
  final_check "voces Piper instaladas" check_piper_voices_installed "${PIPER_VOICES_DIR}"
  final_check "piper CLI disponible" check_piper_cli_ready
  final_check "API voces Piper" check_voice_list_endpoint
  final_check_warn "TTS say" check_voice_say_endpoint
  final_check "TTS synthesize" check_voice_synthesize_endpoint
  final_check "Cámara info" check_camera_info_endpoint
  final_check "sin procesos arecord activos" check_no_arecord_process
  final_check "wake desactivado en journal" check_wake_disabled_logs
  test -f /opt/bascula/voices/piper/default.onnx || (echo "[ERR] Piper sin voz por defecto" && exit 1)
  if [[ ${FRONTEND_EXPECTED} -eq 1 ]]; then
    final_check "frontend publicado en ${WWW_ROOT}/index.html" check_file_exists "${WWW_ROOT}/index.html"
  else
    if [[ -f "${WWW_ROOT}/index.html" ]]; then
      log "[ok] Frontend existente en ${WWW_ROOT}/index.html"
    else
      log_warn "Frontend no encontrado y no requerido en esta instalación, carpeta ausente"
    fi
  fi
  final_check "permisos /opt/bascula/current" check_owner "${CURRENT_LINK}" "${DEFAULT_USER}:${DEFAULT_USER}"
  final_check "imports críticos en venv" check_python_imports

  verify_xorg_session

  if [[ -z "${SUMMARY_HTTP_ROOT_STATUS}" ]]; then
    local root_status
    root_status=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1/ 2>/dev/null || echo "curl_error")
    if [[ "${root_status}" =~ ^[0-9]+$ ]]; then
      SUMMARY_HTTP_ROOT_STATUS="HTTP ${root_status}"
    else
      SUMMARY_HTTP_ROOT_STATUS="${root_status}"
    fi
  fi
  if [[ -z "${SUMMARY_HTTP_API_STATUS}" ]]; then
    local api_status
    api_status=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1/api/health 2>/dev/null || echo "curl_error")
    if [[ "${api_status}" =~ ^[0-9]+$ ]]; then
      SUMMARY_HTTP_API_STATUS="HTTP ${api_status}"
    else
      SUMMARY_HTTP_API_STATUS="${api_status}"
    fi
  fi
  if [[ -z "${SUMMARY_HTTP_STATE_STATUS}" ]]; then
    local state_status
    state_status=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1/api/state 2>/dev/null || echo "curl_error")
    if [[ "${state_status}" =~ ^[0-9]+$ ]]; then
      SUMMARY_HTTP_STATE_STATUS="HTTP ${state_status}"
    else
      SUMMARY_HTTP_STATE_STATUS="${state_status}"
    fi
    if [[ "${state_status}" != "200" ]]; then
      log_warn "[no-block] /api/state devolvió ${SUMMARY_HTTP_STATE_STATUS}"
    fi
  fi
  if [[ -z "${SUMMARY_MINIWEB_STATUS}" ]]; then
    local mini_status
    mini_status=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/miniweb/status 2>/dev/null || echo "curl_error")
    if [[ "${mini_status}" =~ ^[0-9]+$ ]]; then
      SUMMARY_MINIWEB_STATUS="HTTP ${mini_status}"
    else
      SUMMARY_MINIWEB_STATUS="${mini_status}"
    fi
  fi
  collect_display_status

  if [[ ${FINAL_FAILURES} -ne 0 ]]; then
    log_err "Validaciones finales con errores"
    exit 1
  fi

  run_final_smoke_tests

  log "[install][ok] Wake/Vosk desactivado por defecto; micro disponible para captura bajo demanda (Modo Receta)."

  log_ok "Instalación completa"
}

main() {
  require_root
  exec 9>/var/lock/bascula.install
  if ! flock -n 9; then
    log_warn "Otro instalador en ejecución; saliendo"
    exit 0
  fi

  log_step "Depurando instalación previa de Piper GUI"
  purge_gui_piper || true

  log_step "Instalando dependencias del sistema"
  install_system_dependencies

  log_step "Configurando overlays de arranque"
  ensure_boot_overlays || true
  ensure_serial_console_disabled || true
  setup_wifi_country || true
  purgar_fbdev_driver || true
  disable_fbdev_xorg_configs || true
  ensure_kms_device_config || true

  mkdir -p "${RELEASES_DIR}"
  COMMIT=$(current_commit)
  select_release_dir "${COMMIT}"
  REPO_SYNC_NEEDED=1
  if [[ -d "${RELEASE_DIR}" && -f "${RELEASE_DIR}/.release-commit" ]]; then
    if [[ $(cat "${RELEASE_DIR}/.release-commit") == "${COMMIT}" ]]; then
      REPO_SYNC_NEEDED=0
    fi
  fi
  if [[ ${REPO_SYNC_NEEDED} -eq 1 ]]; then
    sync_release_contents
  else
    ln -sfn "${RELEASE_DIR}" "${CURRENT_LINK}"
    log "Release ya sincronizada"
    ensure_release_ownership
  fi

  REPO_DIR="${CURRENT_LINK}"

  ensure_python_venv
  prepare_ocr_models_dir
  ensure_piper_cli
  ensure_piper_voices
  ensure_vosk_model
  ensure_voice_symlinks
  ensure_audio_env_file
  ensure_backend_env_file
  install_asound_conf
  ensure_user_groups
  record_audio_devices
  install_tmpfiles_config
  systemd-tmpfiles --create "${TMPFILES_DEST}/bascula.conf"
  ensure_log_dir
  ensure_capture_dirs
  ensure_x735_support

  install_bascula_ota_script

  log_step "Instalando unidades systemd"
  install_systemd_units
  log_step "Configurando servicio bascula-ui"
  configure_bascula_ui_service
  log "Habilitando linger para ${DEFAULT_USER}"
  loginctl enable-linger "${DEFAULT_USER}" || true
  log_step "Construyendo frontend si aplica"
  if ! build_frontend_if_present; then
    exit 1
  fi

  ensure_www_root
  log_step "Configurando sitio Nginx"
  configure_nginx_site

  log_step "Validando y recargando Nginx"
  if nginx -t; then
    systemctl enable --now nginx
    systemctl reload nginx
    log "Nginx recargado"
  else
    log_err "nginx -t falló. Abortando instalación."
    exit 1
  fi

  log_step "Activando servicios de la Báscula"
  ensure_services_started

  BASCULA_HOST="${BASCULA_HOST:-127.0.0.1}"
  BASCULA_PORT="${BASCULA_PORT:-8081}"
  PIPER_PORT="${PIPER_PORT:-59125}"
  BASCULA_HEALTH_URL="${BASCULA_HEALTH_URL:-http://${BASCULA_HOST}:${BASCULA_PORT}/health}"

  log_step "Esperando disponibilidad de servicios"
  systemctl daemon-reload || true
  if systemctl list-unit-files | grep -q '^systemd-networkd-wait-online.service'; then
    systemctl start systemd-networkd-wait-online.service || true
  fi
  if systemctl list-unit-files --type target | grep -q '^network-online.target'; then
    wait_for_unit_active "network-online.target" 60 || log_warn "network-online.target no alcanzó estado active (continuando)"
  fi
  if systemctl list-unit-files | grep -q '^piper.service'; then
    wait_for_unit_active "piper.service" 90 || log_warn "piper.service no se activó tras el timeout"
  fi
  if systemctl list-unit-files | grep -q '^bascula-backend.service'; then
    wait_for_unit_active "bascula-backend.service" 120 || log_warn "bascula-backend.service no se activó tras el timeout"
  fi

  wait_for_port "${BASCULA_HOST}" "${BASCULA_PORT}" 90 || log_warn "Puerto ${BASCULA_HOST}:${BASCULA_PORT} no disponible tras la espera"
  local tts_wait_port="${TTS_PORT:-8080}"
  if [[ "${tts_wait_port}" != "${BASCULA_PORT}" || "${BASCULA_HOST}" != "127.0.0.1" ]]; then
    wait_for_port "127.0.0.1" "${tts_wait_port}" 90 || log_warn "Puerto miniweb 127.0.0.1:${tts_wait_port} no disponible tras la espera"
  fi
  if systemctl list-unit-files | grep -q '^piper.service'; then
    wait_for_port "127.0.0.1" "${PIPER_PORT}" 90 || log_warn "Puerto Piper 127.0.0.1:${PIPER_PORT} no disponible tras la espera"
  fi

  local health_code=""
  if ! WAIT_FOR_HTTP_SUCCESS_CODES="200 204 404 405" wait_for_http "${BASCULA_HEALTH_URL}" 90; then
    health_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${BASCULA_HEALTH_URL}" || echo "000")
    log_warn "Healthcheck en ${BASCULA_HEALTH_URL} falló con código ${health_code}"
  else
    health_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${BASCULA_HEALTH_URL}" || echo "000")
    if [[ "${health_code}" == "404" || "${health_code}" == "405" ]]; then
      log "[info] Health endpoint devolvió ${health_code}; se considera servicio vivo"
    fi
  fi
  if [[ -n "${health_code}" && "${health_code}" =~ ^[0-9]+$ ]]; then
    SUMMARY_HTTP_API_STATUS="HTTP ${health_code}"
  fi

  if ! validate_tts_say; then
    log_warn "Validación TTS /say falló tras reintentos (no bloquea)."
  fi

  log_step "Sanity check sesión systemd --user"
  loginctl show-user "${DEFAULT_USER}" | grep -i Linger
  ls -ld /run/user/1000 || true
  if test -S /run/user/1000/bus; then
    echo "[ok] user bus OK"
  else
    echo "[warn] user bus ausente"
  fi

  if [[ ${REBOOT_FLAG} -eq 1 ]]; then
    log_warn "Se requiere reinicio para aplicar configuraciones de arranque. Continuando con verificaciones esenciales."
  fi

  log_step "Ejecutando comprobaciones finales"
  run_final_checks
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
main "$@"

# Matriz de pruebas manuales propuesta:
# - Instalación limpia en Debian/Raspberry Pi OS Bookworm (arm64) sin Node preinstalado.
# - Reinstalación sobre la misma release para comprobar idempotencia.
# - Frontend presente (bascula-ui con Vite) ⇒ build y publicación en ${WWW_ROOT}/index.html.
# - Sin frontend en el repositorio ⇒ se emite warning y la instalación continúa.
# - Nginx con site default activo ⇒ tras instalar sólo queda habilitado bascula.conf.
# - Backend responde 200 en /api/health tanto directo (8081) como por proxy (:80).
# - SSE en /api/scale/events devuelve Content-Type text/event-stream y X-Accel-Buffering: no.
# - Permisos finales: /opt/bascula/current con propietario pi:pi.
# - Dependencias FFmpeg: instala libavformat60 si está disponible; si no, usa libavformat59.
