#!/bin/bash
#
# Instalador principal para Báscula Digital Pro en Raspberry Pi OS Bookworm Lite
# Requisitos clave:
#   - Idempotente, seguro ante re-ejecuciones
#   - Gestiona releases OTA en /opt/bascula/releases/<timestamp>
#   - Configura audio, nginx, systemd y dependencias mínimas para Pi 5
#   - Ejecuta verificaciones básicas y controla reinicios diferidos
#

set -euo pipefail
IFS=$'\n\t'

# --- Frontend/WWW ---
export WWW_ROOT="${WWW_ROOT:-/opt/bascula/www}"
# Si el usuario fija FRONTEND_DIR, lo respetamos; si no, autodetección.
export FRONTEND_DIR="${FRONTEND_DIR:-}"

LOG_PREFIX="[install]"
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
REBOOT_FLAG=0

: "${SKIP_UI_BUILD:=0}"

umask 022

FRONTEND_EXPECTED=1

log() {
  printf '%s %s\n' "${LOG_PREFIX}" "$*"
}

log_step() {
  log "[step] $*"
}

log_warn() {
  printf '%s[warn] %s\n' "${LOG_PREFIX}" "$*" >&2
}

log_err() {
  printf '%s[err] %s\n' "${LOG_PREFIX}" "$*" >&2
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
}

build_frontend_if_present() {
  if [[ "${SKIP_UI_BUILD}" == "1" ]]; then
    log_warn "SKIP_UI_BUILD=1, omitiendo build de UI"
    return 0
  fi

  local dir
  dir="$(detect_frontend_dir)"
  if [[ -z "${dir}" ]]; then
    log_warn "No se encontró carpeta de frontend con package.json; se omite compilación"
    FRONTEND_EXPECTED=0
    return 0
  fi

  log_step "Compilando frontend ${dir}"
  ensure_node_runtime

  if ! has_build_script "${dir}"; then
    log_err "package.json sin script 'build' en ${dir}"
    jq -r '.scripts // {}' "${dir}/package.json" 2>/dev/null || true
    return 1
  fi

  pushd "${dir}" >/dev/null
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    log_warn "package-lock.json no encontrado; usando npm install"
    npm install
  fi
  npm run build
  popd >/dev/null

  local out_dir
  out_dir="$(detect_build_output_dir "${dir}")"
  if [[ -z "${out_dir}" || ! -d "${out_dir}" ]]; then
    log_err "No se encontró carpeta de salida tras build (dist/build)"
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
  headers=$(curl -sS -I "${url}" || true)
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

check_python_imports() {
  local output
  output=$(su - "${DEFAULT_USER}" -s /bin/bash <<EOF 2>&1
set -euo pipefail # Garantiza fail-fast dentro de la shell de verificación
venv_dir="${CURRENT_LINK}/.venv"
venv_activate="${CURRENT_LINK}/.venv/bin/activate"
venv_python="${CURRENT_LINK}/.venv/bin/python"

if [[ ! -d "${venv_dir}" ]]; then
  printf '%s[err] Entorno virtual no encontrado: %s\n' "${LOG_PREFIX}" "${venv_dir}" >&2
  exit 1
fi

if [[ ! -f "${venv_activate}" ]]; then
  printf '%s[err] Script de activación inexistente: %s\n' "${LOG_PREFIX}" "${venv_activate}" >&2
  exit 1
fi

if [[ ! -x "${venv_python}" ]]; then
  printf '%s[err] Binario python del venv no encontrado: %s\n' "${LOG_PREFIX}" "${venv_python}" >&2
  exit 1
fi

# Activa el venv y lanza el bloque Python en la misma shell (fail-fast)
source "${venv_activate}" && python - <<'PY'
import importlib
import os
import sys

log_prefix = "${LOG_PREFIX}"
venv_dir = os.path.realpath("${CURRENT_LINK}/.venv")
env_venv = os.environ.get("VIRTUAL_ENV")
exe = os.path.realpath(sys.executable)

if not env_venv:
    print(f"{log_prefix}[err] VIRTUAL_ENV no establecido tras activar el venv")
    raise SystemExit(1)

if os.path.realpath(env_venv) != venv_dir:
    print(f"{log_prefix}[err] VIRTUAL_ENV apunta a {env_venv}, esperado {venv_dir}")
    raise SystemExit(1)

if not exe.startswith(os.path.join(venv_dir, "")):
    print(f"{log_prefix}[err] sys.executable fuera del venv: {exe}")
    raise SystemExit(1)

required = [  # Módulos críticos para el runtime Python
    "fastapi",
    "uvicorn",
    "cv2",
    "rapidocr_onnxruntime",
    "onnxruntime",
    "sounddevice",
    "vosk",
]

missing = []
for module in required:
    try:
        importlib.import_module(module)
    except Exception as exc:  # noqa: BLE001 - logueamos fallo explícito
        print(f"{log_prefix}[err] Falló import {module!r}: {exc}")
        missing.append(module)

if missing:
    separator = ", "
    print(f"{log_prefix}[err] Módulos faltantes o con error: {separator.join(missing)}")
    raise SystemExit(1)

print(f"{log_prefix}[ok] OK: imports y venv correctos")
PY
EOF
  )

  local status=$?
  if [[ ${status} -eq 0 ]]; then
    printf '%s\n' "${output}" # Superficie el log exitoso al caller
    return 0
  fi

  CHECK_FAIL_MSG="${output}"
  return 1
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
    xserver-xorg xinit matchbox-window-manager fonts-dejavu-core

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

ensure_boot_overlays() {
  if [[ ! -d "${BOOT_FIRMWARE_DIR}" ]]; then
    log_warn "${BOOT_FIRMWARE_DIR} no encontrado; omitiendo configuración de overlays"
    return
  fi
  ensure_boot_config_line "dtoverlay=vc4-kms-v3d-pi5"
  ensure_boot_config_line "dtoverlay=disable-bt"
  ensure_boot_config_line "dtoverlay=hifiberry-dac"
  ensure_boot_config_line "enable_uart=1"
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
  local dest="${SYSTEMD_DEST}/${name}"
  if [[ ! -f "${src}" ]]; then
    abort "No se encontró unidad systemd ${src}"
  fi
  if [[ -f "${dest}" ]] && cmp -s "${src}" "${dest}"; then
    log "Unidad ${name} sin cambios"
  else
    install -D -m 0644 "${src}" "${dest}"
    log "Unidad ${name} instalada"
  fi
  if [[ -d "${src}.d" ]]; then
    rsync -a --delete "${src}.d/" "${dest}.d/"
  fi
}

install_systemd_units() {
  local units=(
    bascula-miniweb.service
    bascula-backend.service
  )
  local unit
  for unit in "${units[@]}"; do
    install_systemd_unit "${unit}"
  done
  systemctl daemon-reload
}

configure_nginx_site() {
  log_step "Configurando Nginx para Báscula"
  install -d -m0755 "${NGINX_SITES_AVAILABLE}" "${NGINX_SITES_ENABLED}"

  local template="${REPO_ROOT}/deploy/nginx/bascula.conf"
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

ensure_chromium_browser() {
  if [[ -x /usr/bin/chromium-browser ]]; then
    return 0
  fi

  log "[step] Instalando Chromium para el modo quiosco"
  ensure_packages xserver-xorg xinit fonts-dejavu-core

  if apt-cache show chromium-browser >/dev/null 2>&1; then
    ensure_packages chromium-browser
  else
    ensure_packages chromium
  fi

  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ttf-mscorefonts-installer || \
    log_warn "No se pudo instalar ttf-mscorefonts-installer"

  if [[ -x /usr/bin/chromium ]] && [[ ! -e /usr/bin/chromium-browser ]]; then
    ln -sfn /usr/bin/chromium /usr/bin/chromium-browser
  fi

  if [[ ! -x /usr/bin/chromium-browser ]]; then
    abort "No se encontró /usr/bin/chromium-browser tras instalar Chromium"
  fi
}

configure_bascula_ui_service() {
  log "[step] Configurando bascula-ui.service"
  ensure_chromium_browser

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
  systemctl enable --now bascula-ui.service
}

ensure_services_started() {
  log_step "Activando servicios básicos"
  systemctl enable --now bascula-backend.service

  if systemctl list-unit-files | grep -q '^bascula-miniweb.service'; then
    systemctl enable --now bascula-miniweb.service
  fi

  if systemctl list-unit-files | grep -q '^bascula-ui.service'; then
    systemctl enable --now bascula-ui.service
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

  log "[install][ok] Instalación completa"
}

main() {
  require_root
  exec 9>/var/lock/bascula.install
  if ! flock -n 9; then
    log_warn "Otro instalador en ejecución; saliendo"
    exit 0
  fi

  install_system_dependencies

  ensure_boot_overlays || true

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
  ensure_audio_env_file
  install_asound_conf
  install_tmpfiles_config
  systemd-tmpfiles --create "${TMPFILES_DEST}/bascula.conf"
  ensure_log_dir
  ensure_capture_dirs

  install_systemd_units
  configure_bascula_ui_service
  if ! build_frontend_if_present; then
    exit 1
  fi

  ensure_www_root
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

  ensure_services_started

  if [[ ${REBOOT_FLAG} -eq 1 ]]; then
    log_warn "Se requiere reinicio para aplicar configuraciones de arranque. Continuando con verificaciones esenciales."
  fi

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
