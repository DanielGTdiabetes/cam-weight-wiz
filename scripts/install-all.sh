#!/bin/bash
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
export WWW_ROOT="${WWW_ROOT:-/opt/bascula/www}"
# Si el usuario fija FRONTEND_DIR, lo respetamos; si no, autodetección.
export FRONTEND_DIR="${FRONTEND_DIR:-}"

# --- Helpers de log unificados ---
LOG_PREFIX="[install]"
log()       { printf '%s %s\n' "${LOG_PREFIX}" "$*"; }
log_step()  { printf '%s %s\n' "${LOG_PREFIX}" "[step] $*"; }
log_ok()    { printf '%s %s\n' "${LOG_PREFIX}" "[ok]   $*"; }
log_warn()  { printf '%s[warn] %s\n' "${LOG_PREFIX}" "$*" >&2; }
log_err()   { printf '%s[err]  %s\n' "${LOG_PREFIX}" "$*" >&2; }

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
  local xlog="${HOME:-/home/pi}/.local/share/xorg/Xorg.0.log"
  [[ -f "${xlog}" ]] || xlog="/var/log/Xorg.0.log"
  if [[ -f "${xlog}" ]]; then
    log_warn "Fragmento Xorg (modeset/vc4/HDMI/EE/WW):"
    grep -E 'modeset|vc4|DRI|HDMI|EE|WW|no screens found|framebuffer' "${xlog}" | tail -n 80 || true
  fi

  log_err "Log completo: ${BASCULA_LOG_FILE}"
  return $rc
}
on_exit() {
  local rc=$?
  echo
  log_step "Resumen final (rc=${rc})"
  # Estados clave (no fallan el resumen)
  systemctl is-active --quiet bascula-backend.service && log_ok "backend activo" || log_warn "backend inactivo"
  systemctl is-active --quiet bascula-miniweb.service && log_ok "miniweb activo" || log_warn "miniweb inactivo o no instalado"
  systemctl is-active --quiet bascula-ui.service && log_ok "UI activa" || log_warn "UI inactiva"

  # Endpoints (sin abortar)
  curl -fsS http://127.0.0.1:8081/api/health >/dev/null && log_ok "health backend 200" || log_warn "health backend no devuelve 200"
  curl -fsS http://127.0.0.1:8080/api/miniweb/status >/dev/null && log_ok "miniweb status 200" || log_warn "miniweb status no devuelve 200"

  # Info útil de Pi5/GPU
  [[ -e /dev/dri/card0 ]] && log_ok "/dev/dri/card0 presente" || log_warn "No existe /dev/dri/card0"
  grep -E 'dtoverlay=vc4-(fkms|kms)-v3d(-pi5)?' -n /boot/firmware/config.txt 2>/dev/null || true

  echo
  if [[ $rc -ne 0 ]]; then
    log_err "Instalación con errores. Revisa arriba y en: ${BASCULA_LOG_FILE}"
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
    ffmpeg git rsync curl jq nginx alsa-utils libcamera-apps espeak-ng iproute2 \
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

if changed:
    path.write_text("\n".join(lines) + "\n")
    print('changed')
else:
    print('unchanged')
PY
  )

  if [[ "${result}" == "changed" ]]; then
    log "Aplicando overlay vc4-kms-v3d-pi5 y deshabilitando fkms/fbdev en ${BOOT_CONFIG_FILE}"
    set_reboot_required "boot-config: vc4-kms-v3d-pi5"
  else
    log "Overlay vc4-kms-v3d-pi5 ya presente"
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
  pip install \
    "uvicorn[standard]" \
    "fastapi>=0.115" \
    "starlette>=0.38" \
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

ensure_audio_env_file() {
  cat <<'EOF' > "${AUDIO_ENV_FILE}.tmp"
BASCULA_AUDIO_DEVICE=bascula_out
BASCULA_MIC_DEVICE=bascula_mix_in
BASCULA_SAMPLE_RATE=16000
EOF
  install -o root -g root -m 0644 "${AUDIO_ENV_FILE}.tmp" "${AUDIO_ENV_FILE}"
  rm -f "${AUDIO_ENV_FILE}.tmp"
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
  if command -v arecord >/dev/null 2>&1; then
    local list
    list=$(arecord -L 2>/dev/null)
    local preferred
    preferred=$(printf '%s\n' "${list}" | awk '/^hw:CARD=/ {print}' | grep -Ei 'usb|mic|seeed|input' | head -n1)
    if [[ -n "${preferred}" ]]; then
      printf '%s\n' "${preferred}"
      return 0
    fi
    local first
    first=$(printf '%s\n' "${list}" | awk '/^hw:CARD=/ {print; exit}')
    if [[ -n "${first}" ]]; then
      printf '%s\n' "${first}"
      return 0
    fi
  fi
  printf 'hw:1,0\n'
}

install_asound_conf() {
  local playback_hw capture_hw playback_card capture_card
  playback_hw=$(get_playback_hw)
  capture_hw=$(get_capture_hw)
  playback_card=$(printf '%s' "${playback_hw}" | sed -E 's#^hw:(CARD=)?([^,]+).*$#\2#')
  capture_card=$(printf '%s' "${capture_hw}" | sed -E 's#^hw:(CARD=)?([^,]+).*$#\2#')
  cat <<EOF > "${ASOUND_CONF}.tmp"
pcm.bascula_out {
    type plug
    slave.pcm "bascula_out_dmix"
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

pcm.bascula_mix_in {
    type dsnoop
    ipc_key 8675310
    slave {
        pcm "${capture_hw}"
        channels 1
        rate 16000
        format S16_LE
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

ensure_www_root() {
  if [[ ! -d "${WWW_ROOT}" ]]; then
    mkdir -p "${WWW_ROOT}"
  fi
  chown -R "${DEFAULT_USER}:${WWW_GROUP}" "${WWW_ROOT}"
}

ensure_log_dir() {
  install -d -m 0755 -o "${DEFAULT_USER}" -g "${DEFAULT_USER}" /var/log/bascula
}

install_tmpfiles_config() {
  install -D -m 0644 "${RELEASE_DIR}/systemd/tmpfiles.d/bascula.conf" "${TMPFILES_DEST}/bascula.conf"
}

install_systemd_unit() {
  local name="$1"
  local src="${RELEASE_DIR}/systemd/${name}"
  if [[ ! -f "${src}" && -n "${REPO_DIR:-}" && -f "${REPO_DIR}/systemd/${name}" ]]; then
    src="${REPO_DIR}/systemd/${name}"
  fi
  if [[ ! -f "${src}" && -f "${REPO_ROOT}/systemd/${name}" ]]; then
    src="${REPO_ROOT}/systemd/${name}"
  fi
  local dest="${SYSTEMD_DEST}/${name}"
  local changed=0
  if [[ ! -f "${src}" ]]; then
    abort "No se encontró unidad systemd ${src}"
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
  local units=(
    bascula-miniweb.service
    bascula-backend.service
    bascula-health-wait.service
    bascula-ui.service
  )
  local unit
  for unit in "${units[@]}"; do
    install_systemd_unit "${unit}"
  done
  if [[ ${SYSTEMD_NEEDS_RELOAD} -eq 1 ]]; then
    systemctl daemon-reload
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

  local xinit_src=""
  if [[ -n "${REPO_DIR:-}" && -f "${REPO_DIR}/.xinitrc" ]]; then
    xinit_src="${REPO_DIR}/.xinitrc"
  elif [[ -f "${REPO_ROOT}/.xinitrc" ]]; then
    xinit_src="${REPO_ROOT}/.xinitrc"
  fi

  if [[ -n "${xinit_src}" ]]; then
    local xinit_dest="/home/${DEFAULT_USER}/.xinitrc"
    local tmp
    tmp="$(mktemp)"
    install -m0755 "${xinit_src}" "${tmp}"
    local needs_update=0
    if [[ ! -f "${xinit_dest}" ]]; then
      needs_update=1
    elif ! cmp -s "${tmp}" "${xinit_dest}"; then
      needs_update=1
    fi
    if [[ ${needs_update} -eq 1 ]]; then
      install -D -o "${DEFAULT_USER}" -g "${DEFAULT_USER}" -m0755 "${tmp}" "${xinit_dest}"
      log "Actualizado ${xinit_dest}"
    fi
    rm -f "${tmp}" || true
  else
    log_warn "No se encontró plantilla .xinitrc en el release"
  fi

  local dropin_dir="/etc/systemd/system/bascula-ui.service.d"
  local dropin_file="${dropin_dir}/30-chrome-cache.conf"
  install -d -m0755 "${dropin_dir}"

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
  fi
  systemctl enable bascula-ui.service
}

ensure_services_started() {
  log_step "Activando servicios básicos"
  systemctl enable --now bascula-backend.service

  if systemctl list-unit-files | grep -q '^bascula-miniweb.service'; then
    systemctl enable --now bascula-miniweb.service
  else
    log_warn "bascula-miniweb.service no instalado"
  fi

  if systemctl list-unit-files | grep -q '^bascula-ui.service'; then
    systemctl enable bascula-ui.service
    if ! systemctl start bascula-ui.service; then
      log_err "Fallo al iniciar bascula-ui.service"
      journalctl -u bascula-ui.service -n 80 --no-pager || true
      exit 1
    fi
    sleep 1
    if ! systemctl is-active --quiet bascula-ui.service; then
      log_err "bascula-ui.service no está activo tras el arranque"
      journalctl -u bascula-ui.service -n 80 --no-pager || true
      exit 1
    fi
  else
    log_warn "bascula-ui.service no instalado"
  fi
}

run_final_checks() {
  log_step "Ejecutando validaciones finales"
  FINAL_FAILURES=0

  final_check "servicio bascula-backend activo" systemctl is-active --quiet bascula-backend.service
  final_check "servicio nginx activo" systemctl is-active --quiet nginx

  if systemctl list-unit-files | grep -q '^bascula-miniweb.service'; then
    final_check "servicio bascula-miniweb activo" systemctl is-active --quiet bascula-miniweb.service
  else
    log_warn "bascula-miniweb.service no instalado; omitiendo validación"
  fi

  if systemctl list-unit-files | grep -q '^bascula-ui.service'; then
    final_check "servicio bascula-ui activo" systemctl is-active --quiet bascula-ui.service
  else
    log_warn "bascula-ui.service no instalado; omitiendo validación"
  fi

  final_check "puerto 8081 escuchando" port_listening 8081
  final_check "puerto 80 escuchando" port_listening 80
  final_check "health backend directo" check_http_endpoint "http://127.0.0.1:8081/api/health" '{"status":"ok"}'
  final_check "health vía nginx" check_http_endpoint "http://127.0.0.1/api/health" '{"status":"ok"}'
  final_check "cabeceras SSE en proxy" check_sse_headers "http://127.0.0.1/api/scale/events"
  final_check "voces Piper instaladas" check_piper_voices_installed "${PIPER_VOICES_DIR}"
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

  if [[ ${FINAL_FAILURES} -ne 0 ]]; then
    log_err "Validaciones finales con errores"
    exit 1
  fi

  log_ok "Instalación completa"
}

main() {
  require_root
  exec 9>/var/lock/bascula.install
  if ! flock -n 9; then
    log_warn "Otro instalador en ejecución; saliendo"
    exit 0
  fi

  log_step "Instalando dependencias del sistema"
  install_system_dependencies

  log_step "Configurando overlays de arranque"
  ensure_boot_overlays || true
  purgar_fbdev_driver || true
  disable_fbdev_xorg_configs || true

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
  ensure_piper_voices
  ensure_audio_env_file
  install_asound_conf
  install_tmpfiles_config
  systemd-tmpfiles --create "${TMPFILES_DEST}/bascula.conf"
  ensure_log_dir
  ensure_capture_dirs

  log_step "Instalando unidades systemd"
  install_systemd_units
  log_step "Configurando servicio bascula-ui"
  configure_bascula_ui_service
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

  if [[ ${IS_PI5} -eq 1 ]]; then
    local verify_script="${REPO_DIR}/scripts/verify-xorg.sh"
    if [[ ! -x "${verify_script}" && -x "${REPO_ROOT}/scripts/verify-xorg.sh" ]]; then
      verify_script="${REPO_ROOT}/scripts/verify-xorg.sh"
    fi
    if [[ -x "${verify_script}" ]]; then
      if ! "${verify_script}"; then
        log_err "Pi 5 requiere vc4-kms-v3d-pi5; hemos desactivado fbdev. Revisa /boot/firmware/config.txt y reinicia."
        exit 1
      fi
    else
      log_warn "No se encontró verify-xorg.sh para validar la sesión X"
    fi
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
