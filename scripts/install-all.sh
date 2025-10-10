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
NGINX_SITE_NAME="bascula.conf"
ASOUND_CONF="/etc/asound.conf"
AUDIO_ENV_FILE="/etc/default/bascula-audio"
BOOT_FIRMWARE_DIR="/boot/firmware"
BOOT_CONFIG_FILE="${BOOT_FIRMWARE_DIR}/config.txt"
REBOOT_FLAG=0

umask 022

log() {
  printf '%s %s\n' "${LOG_PREFIX}" "$*"
}

log_warn() {
  printf '%s[warn] %s\n' "${LOG_PREFIX}" "$*" >&2
}

log_err() {
  printf '%s[err] %s\n' "${LOG_PREFIX}" "$*" >&2
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
    log_warn "check falló (${label})"
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
    if [[ ${APT_UPDATED} -eq 0 ]]; then
      log "Ejecutando apt-get update"
      apt-get update
      APT_UPDATED=1
    fi
    log "Instalando paquetes: ${missing[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
  else
    log "Paquetes ya instalados"
  fi
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
}

ensure_python_venv() {
  local venv_dir="${CURRENT_LINK}/.venv"
  log "Creando/actualizando entorno virtual en ${venv_dir} con paquetes del sistema"
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
  # Dependencias OCR (RapidOCR + runtime ARM64 sin compilación)
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    libgomp1 libzbar0 libcap-dev libatlas-base-dev libopenjp2-7 libtiff5 libilmbase25 libavformat58 ffmpeg
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
    hifiberry=$(printf '%s
' "${list}" | awk '/^hw:CARD=sndrpihifiberry/ {print; exit}')
    if [[ -n "${hifiberry}" ]]; then
      printf '%s
' "${hifiberry}"
      return 0
    fi
    local hdmi
    hdmi=$(printf '%s
' "${list}" | awk '/^hw:CARD=vc4hdmi/ {print; exit}')
    if [[ -n "${hdmi}" ]]; then
      printf '%s
' "${hdmi}"
      return 0
    fi
  fi
  printf 'hw:0,0
'
}

get_capture_hw() {
  if command -v arecord >/dev/null 2>&1; then
    local list
    list=$(arecord -L 2>/dev/null)
    local preferred
    preferred=$(printf '%s
' "${list}" | awk '/^hw:CARD=/ {print}' | grep -Ei 'usb|mic|seeed|input' | head -n1)
    if [[ -n "${preferred}" ]]; then
      printf '%s
' "${preferred}"
      return 0
    fi
    local first
    first=$(printf '%s
' "${list}" | awk '/^hw:CARD=/ {print; exit}')
    if [[ -n "${first}" ]]; then
      printf '%s
' "${first}"
      return 0
    fi
  fi
  printf 'hw:1,0
'
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
    log "asound.conf desplegado (playback=${playback_hw}, capture=${capture_hw})"
  fi
}

ensure_capture_dirs() {
  install -d -m 0775 -o "${DEFAULT_USER}" -g "${WWW_GROUP}" /run/bascula
  install -d -m 02770 -o "${DEFAULT_USER}" -g "${WWW_GROUP}" /run/bascula/captures
  chmod g+s /run/bascula/captures
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
    bascula-health-wait.service
    bascula-ui.service
  )
  local unit
  for unit in "${units[@]}"; do
    install_systemd_unit "${unit}"
  done
  systemctl daemon-reload
  systemctl enable bascula-miniweb.service bascula-backend.service bascula-health-wait.service bascula-ui.service
  systemctl restart bascula-miniweb.service bascula-backend.service || true
  systemctl restart bascula-health-wait.service || true
  systemctl restart bascula-ui.service || true
}

install_nginx_site() {
  local site_path="${NGINX_SITES_AVAILABLE}/${NGINX_SITE_NAME}"
  local enabled_link="${NGINX_SITES_ENABLED}/bascula.conf"
  find "${NGINX_SITES_ENABLED}" -maxdepth 1 -type l -name 'bascula*' -exec rm -f {} +
  cat <<'EOF' > "${site_path}.tmp"
server {
    listen 127.0.0.1:80;
    listen [::1]:80;
    server_name _;

    access_log /var/log/nginx/bascula.access.log;
    error_log /var/log/nginx/bascula.error.log;

    location /captures/ {
        root /run/bascula;
        autoindex off;
        add_header Cache-Control "no-store" always;
    }
}
EOF
  if [[ -f "${site_path}" ]] && cmp -s "${site_path}.tmp" "${site_path}"; then
    rm -f "${site_path}.tmp"
    log "Configuración nginx sin cambios"
  else
    install -o root -g root -m 0644 "${site_path}.tmp" "${site_path}"
    log "Configuración nginx actualizada"
  fi
  rm -f "${site_path}.tmp"
  ln -sfn "${site_path}" "${enabled_link}"
  nginx -t
  systemctl restart nginx
}

run_health_checks() {
  run_checked "systemd-analyze verify" systemd-analyze verify \
    "${SYSTEMD_DEST}/bascula-miniweb.service" \
    "${SYSTEMD_DEST}/bascula-backend.service" \
    "${SYSTEMD_DEST}/bascula-health-wait.service" \
    "${SYSTEMD_DEST}/bascula-ui.service"
  run_checked "nginx -t" nginx -t
  if ! curl -fsS http://127.0.0.1:8080/api/miniweb/status >/dev/null; then
    echo "[ERROR] miniweb no responde"
    return 1
  fi
  log "check OK: miniweb responde"
  run_checked "miniweb ok=true" /bin/sh -c 'curl -fsS http://127.0.0.1:8080/api/miniweb/status | grep -q "\"ok\"[[:space:]]*:[[:space:]]*true"'
  if ! curl -fsS http://127.0.0.1:8081/health >/dev/null; then
    echo "[ERROR] backend no responde"
    return 1
  fi
  log "check OK: backend responde"
  run_checked "picamera2 import" python3 -c 'import picamera2'
  run_checked "arecord bascula_mix_in" arecord -D bascula_mix_in -f S16_LE -r 16000 -d 1
  run_checked "speaker-test bascula_out" speaker-test -t sine -f 1000 -l 1 -D bascula_out
}

main() {
  require_root
  exec 9>/var/lock/bascula.install
  if ! flock -n 9; then
    log_warn "Otro instalador en ejecución; saliendo"
    exit 0
  fi

  ensure_packages \
    python3 python3-venv python3-pip python3-dev \
    python3-numpy python3-simplejpeg python3-picamera2 \
    libgomp1 libzbar0 libcap-dev libatlas-base-dev libopenjp2-7 libtiff5 libilmbase25 libavformat58 ffmpeg \
    git rsync curl jq nginx \
    alsa-utils libcamera-apps \
    xserver-xorg xinit chromium-browser matchbox-window-manager \
    fonts-dejavu-core

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
  fi

  ensure_python_venv
  prepare_ocr_models_dir
  ensure_audio_env_file
  install_asound_conf
  install_tmpfiles_config
  systemd-tmpfiles --create "${TMPFILES_DEST}/bascula.conf"
  ensure_log_dir
  ensure_capture_dirs
  install_nginx_site
  install_systemd_units

  if [[ ${REBOOT_FLAG} -eq 1 ]]; then
    log_warn "Se requiere reinicio para aplicar configuraciones de arranque. Omitiendo pruebas de audio (arecord/aplay)."
    run_checked "systemd-analyze verify" systemd-analyze verify \
      "${SYSTEMD_DEST}/bascula-miniweb.service" \
      "${SYSTEMD_DEST}/bascula-backend.service" \
      "${SYSTEMD_DEST}/bascula-health-wait.service" \
      "${SYSTEMD_DEST}/bascula-ui.service"
    run_checked "nginx -t" nginx -t
    if ! curl -fsS http://127.0.0.1:8080/api/miniweb/status >/dev/null; then
      echo "[ERROR] miniweb no responde"
      exit 1
    fi
    log "check OK: miniweb responde"
    run_checked "miniweb ok=true" /bin/sh -c 'curl -fsS http://127.0.0.1:8080/api/miniweb/status | grep -q "\"ok\"[[:space:]]*:[[:space:]]*true"'
    if ! curl -fsS http://127.0.0.1:8081/health >/dev/null; then
      echo "[ERROR] backend no responde"
      exit 1
    fi
    log "check OK: backend responde"
    run_checked "picamera2 import" python3 -c 'import picamera2'
    log_warn "Reinicie el sistema y vuelva a ejecutar las pruebas de audio manualmente."
    exit 0
  fi

  run_health_checks
  log "Instalación completada"
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
main "$@"
