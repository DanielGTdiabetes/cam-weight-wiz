#!/usr/bin/env bash
# Instalador v2 para Báscula Digital Pro / cam-weight-wiz
# Configura todos los componentes en Raspberry Pi OS Bookworm Lite

set -euo pipefail
IFS=$'\n\t'
umask 022

LOG_PREFIX="[install-v2]"
LOCK_FILE="/var/lock/bascula-install.lock"
RELEASES_DIR="/opt/bascula/releases"
CURRENT_LINK="/opt/bascula/current"
DEFAULT_USER="pi"
WWW_GROUP="www-data"
STATE_DIR="/var/lib/bascula"
TMPFILES_DEST="/etc/tmpfiles.d"
SYSTEMD_DEST="/etc/systemd/system"
NGINX_SITES_AVAILABLE="/etc/nginx/sites-available"
NGINX_SITES_ENABLED="/etc/nginx/sites-enabled"
NGINX_SITE_NAME="00-bascula.conf"
NGINX_DISABLED_DIR="/etc/nginx/sites-disabled-by-bascula"
ASOUND_CONF="/etc/asound.conf"
AUDIO_ENV_FILE="/etc/default/bascula-audio"
BOOT_FIRMWARE_DIR="/boot/firmware"
BOOT_CONFIG_FILE="${BOOT_FIRMWARE_DIR}/config.txt"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"

exec {LOCK_FD}>"${LOCK_FILE}"
if ! flock -n "${LOCK_FD}"; then
  echo "${LOG_PREFIX} Otro proceso de instalación está en ejecución" >&2
  exit 1
fi

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

run_checked() {
  local label="$1"
  shift
  log "[check] ${label}"
  if "$@"; then
    log "[ok] ${label}"
  else
    log_err "Fallo en verificación: ${label}"
    exit 1
  fi
}

require_root() {
  if [[ $(id -u) -ne 0 ]]; then
    abort "Este instalador debe ejecutarse como root"
  fi
}

APT_UPDATED=0
ensure_packages() {
  log "[step] Verificando paquetes del sistema"
  local base_packages=(
    bash curl jq git rsync ca-certificates
    python3 python3-venv python3-pip python3-dev
    python3-libcamera python3-picamera2 python3-rpi.gpio
    libatlas-base-dev libopenjp2-7 libzbar0 ffmpeg
    nginx
    libcamera-apps v4l-utils
    xserver-xorg xinit
    chromium-browser unclutter
    alsa-utils procps
    pipewire pipewire-audio pipewire-pulse wireplumber
    coreutils sed gawk findutils
  )
  local pkgs=("${base_packages[@]}" "$@")
  local missing=()
  local pkg
  for pkg in "${pkgs[@]}"; do
    if [[ -z "${pkg}" ]]; then
      continue
    fi
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
    log "Todos los paquetes requeridos están presentes"
  fi
}

ensure_boot_config_line() {
  local line="$1"
  if [[ ! -f "${BOOT_CONFIG_FILE}" ]]; then
    abort "No se encontró ${BOOT_CONFIG_FILE}; verifique montaje de /boot"
  fi
  if grep -Fxq "${line}" "${BOOT_CONFIG_FILE}"; then
    return 0
  fi
  log "Añadiendo '${line}' a ${BOOT_CONFIG_FILE}"
  printf '\n%s\n' "${line}" >> "${BOOT_CONFIG_FILE}"
}

ensure_boot_overlays() {
  log "[step] Configurando overlays de arranque"
  ensure_boot_config_line "dtoverlay=vc4-kms-v3d-pi5"
  ensure_boot_config_line "dtoverlay=disable-bt"
  ensure_boot_config_line "dtoverlay=hifiberry-dac"
  ensure_boot_config_line "enable_uart=1"
}

configure_x735() {
  log "[step] Configurando placa Geekworm X735"

  install -d -m0755 /etc/systemd/system /usr/local/bin

  cat >/usr/local/bin/x735-shutdown.sh <<'XEOF'
#!/bin/bash
echo 4 > /sys/class/gpio/export 2>/dev/null || true
echo out > /sys/class/gpio/gpio4/direction
echo 1 > /sys/class/gpio/gpio4/value
sleep 1
echo 0 > /sys/class/gpio/gpio4/value
poweroff
XEOF
  chmod +x /usr/local/bin/x735-shutdown.sh

  cat >/usr/local/bin/x735-fan.py <<'XEOF'
#!/usr/bin/env python3
import time, os
FAN_PIN = 14
try:
    import RPi.GPIO as GPIO
except Exception:
    os.system("apt-get install -y python3-rpi.gpio")
    import RPi.GPIO as GPIO
GPIO.setwarnings(False)
GPIO.setmode(GPIO.BCM)
GPIO.setup(FAN_PIN, GPIO.OUT)
fan = GPIO.PWM(FAN_PIN, 25)
fan.start(0)

def set_speed(t):
    if t < 45:
        return 0
    if t < 55:
        return 40
    if t < 65:
        return 70
    return 100

while True:
    try:
        temp = int(open("/sys/class/thermal/thermal_zone0/temp").read())/1000
        fan.ChangeDutyCycle(set_speed(temp))
        time.sleep(5)
    except KeyboardInterrupt:
        break
    except Exception:
        time.sleep(5)
GPIO.cleanup()
XEOF
  chmod +x /usr/local/bin/x735-fan.py

  cat >/etc/systemd/system/x735-fan.service <<'XEOF'
[Unit]
Description=X735 Fan Control
After=multi-user.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/local/bin/x735-fan.py
Restart=always

[Install]
WantedBy=multi-user.target
XEOF

  cat >/etc/systemd/system/x735-shutdown.service <<'XEOF'
[Unit]
Description=X735 Safe Shutdown
After=multi-user.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/x735-shutdown.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
XEOF

  ensure_boot_config_line "dtoverlay=gpio-poweroff,gpiopin=4,active_low=1"
  ensure_boot_config_line "dtoverlay=gpio-shutdown,gpio_pin=17,active_low=1,gpio_pull=up"

  systemctl daemon-reload
  systemctl enable --now x735-fan.service
  log "Servicio X735 configurado y activo"
}

current_commit() {
  if command -v git >/dev/null 2>&1 && git -C "${REPO_DIR}" rev-parse HEAD >/dev/null 2>&1; then
    git -C "${REPO_DIR}" rev-parse HEAD
  elif [[ -L "${CURRENT_LINK}" && -f "${CURRENT_LINK}/.release-commit" ]]; then
    cat "${CURRENT_LINK}/.release-commit"
  else
    echo "unknown"
  fi
}

select_release_dir() {
  log "[step] Seleccionando directorio de release"
  local commit="$1"
  if [[ -L "${CURRENT_LINK}" ]]; then
    local existing_target
    existing_target=$(readlink -f "${CURRENT_LINK}" || true)
    if [[ -n "${existing_target}" && -f "${existing_target}/.release-commit" ]]; then
      if [[ $(cat "${existing_target}/.release-commit") == "${commit}" ]]; then
        log "Reutilizando release existente ${existing_target}"
        RELEASE_DIR="${existing_target}"
        return
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
  install -d -m0755 -o root -g root "${RELEASE_DIR}"
}

sync_release_contents() {
  log "[step] Sincronizando contenido hacia ${RELEASE_DIR}"
  rsync -a --delete --exclude='.git' --exclude='.venv' "${REPO_DIR}/" "${RELEASE_DIR}/"
  printf '%s\n' "${COMMIT}" > "${RELEASE_DIR}/.release-commit"
  ln -sfn "${RELEASE_DIR}" "${CURRENT_LINK}"
}

ensure_python_venv() {
  log "[step] Configurando entorno virtual de Python"
  local venv_dir="${CURRENT_LINK}/.venv"
  python3 -m venv --system-site-packages "${venv_dir}"
  if [[ -f "${venv_dir}/pyvenv.cfg" ]]; then
    sed -i 's/^include-system-site-packages = .*/include-system-site-packages = true/' "${venv_dir}/pyvenv.cfg" || true
  fi
  # shellcheck disable=SC1091
  source "${venv_dir}/bin/activate"
  pip install --upgrade pip wheel
  pip install \
    "uvicorn[standard]" \
    "fastapi>=0.115" \
    "starlette>=0.38" \
    "click>=8.1" \
    "httpx==0.28.1" \
    "httpcore>=1.0.0,<2.0.0"
  pip install -r "${CURRENT_LINK}/requirements.txt" --no-deps
  if [[ -f "${CURRENT_LINK}/requirements-voice.txt" ]]; then
    pip install -r "${CURRENT_LINK}/requirements-voice.txt" --no-deps
  fi
  pip install --no-cache-dir \
    "rapidocr-onnxruntime==1.4.4" \
    onnxruntime \
    pyclipper \
    "shapely!=2.0.4,>=1.7.1"
  deactivate || true
}

prepare_ocr_models_dir() {
  log "[step] Preparando directorio de modelos OCR"
  install -d -o "${DEFAULT_USER}" -g "${DEFAULT_USER}" -m0755 /opt/rapidocr/models
  cat >/opt/rapidocr/models/README.txt <<'EOF_README'
Coloca aquí los modelos RapidOCR (.onnx) de detección y reconocimiento.
Variables:
  BASCULA_OCR_ENABLED=true
  BASCULA_OCR_MODELS_DIR=/opt/rapidocr/models
EOF_README
  chown "${DEFAULT_USER}:${DEFAULT_USER}" /opt/rapidocr/models/README.txt
}

ensure_audio_env_file() {
  log "[step] Configurando entorno de audio"
  cat <<'EOF_AUDIO' > "${AUDIO_ENV_FILE}.tmp"
BASCULA_AUDIO_DEVICE=bascula_out
BASCULA_MIC_DEVICE=bascula_mix_in
BASCULA_SAMPLE_RATE=16000
EOF_AUDIO
  install -o root -g root -m0644 "${AUDIO_ENV_FILE}.tmp" "${AUDIO_ENV_FILE}"
  rm -f "${AUDIO_ENV_FILE}.tmp"
}

get_playback_hw() {
  if command -v aplay >/dev/null 2>&1; then
    local list
    list=$(aplay -L 2>/dev/null || true)
    local hifiberry
    hifiberry=$(printf '%s' "${list}" | awk '/^hw:CARD=sndrpihifiberry/ {print; exit}')
    if [[ -n "${hifiberry}" ]]; then
      printf '%s' "${hifiberry}"
      return 0
    fi
    local hdmi
    hdmi=$(printf '%s' "${list}" | awk '/^hw:CARD=vc4hdmi/ {print; exit}')
    if [[ -n "${hdmi}" ]]; then
      printf '%s' "${hdmi}"
      return 0
    fi
  fi
  printf 'hw:0,0'
}

get_capture_hw() {
  if command -v arecord >/dev/null 2>&1; then
    local list
    list=$(arecord -L 2>/dev/null || true)
    local preferred
    preferred=$(printf '%s' "${list}" | awk '/^hw:CARD=/ {print}' | grep -Ei 'usb|mic|seeed|input' | head -n1)
    if [[ -n "${preferred}" ]]; then
      printf '%s' "${preferred}"
      return 0
    fi
    local first
    first=$(printf '%s' "${list}" | awk '/^hw:CARD=/ {print; exit}')
    if [[ -n "${first}" ]]; then
      printf '%s' "${first}"
      return 0
    fi
  fi
  printf 'hw:1,0'
}

install_asound_conf() {
  log "[step] Desplegando configuración ALSA"
  local playback_hw capture_hw playback_card capture_card
  playback_hw=$(get_playback_hw)
  capture_hw=$(get_capture_hw)
  playback_card=${playback_hw%%,*}
  playback_card=${playback_card#hw:}
  capture_card=${capture_hw%%,*}
  capture_card=${capture_card#hw:}
  cat >"${ASOUND_CONF}.tmp" <<EOF_ASOUND
pcm.bascula_mix_in {
    type plug
    slave {
        pcm "${capture_hw}"
        channels 2
    }
}

pcm.bascula_out {
    type plug
    slave.pcm "${playback_hw}"
}

ctl.bascula_out {
    type hw
    card "${playback_card}"
}

ctl.bascula_mix_in {
    type hw
    card "${capture_card}"
}
EOF_ASOUND
  if [[ -f "${ASOUND_CONF}" ]] && cmp -s "${ASOUND_CONF}.tmp" "${ASOUND_CONF}"; then
    rm -f "${ASOUND_CONF}.tmp"
    log "asound.conf sin cambios"
  else
    install -o root -g root -m0644 "${ASOUND_CONF}.tmp" "${ASOUND_CONF}"
    log "asound.conf actualizado"
  fi
}

install_tmpfiles_config() {
  log "[step] Instalando configuración tmpfiles"
  install -D -m0644 "${RELEASE_DIR}/systemd/tmpfiles.d/bascula.conf" "${TMPFILES_DEST}/bascula.conf"
}

ensure_log_dir() {
  log "[step] Creando directorios de log"
  install -d -m0755 -o "${DEFAULT_USER}" -g "${DEFAULT_USER}" /var/log/bascula
}

ensure_capture_dirs() {
  log "[step] Preparando directorios de captura"
  install -d -m0775 -o "${DEFAULT_USER}" -g "${WWW_GROUP}" /run/bascula
  install -d -m02770 -o "${DEFAULT_USER}" -g "${WWW_GROUP}" /run/bascula/captures
  chmod g+s /run/bascula/captures
}

install_systemd_unit() {
  local name="$1"
  local src="${RELEASE_DIR}/systemd/${name}"
  local dest="${SYSTEMD_DEST}/${name}"
  if [[ ! -f "${src}" ]]; then
    abort "Unidad systemd faltante: ${src}"
  fi
  if [[ -f "${dest}" ]] && cmp -s "${src}" "${dest}"; then
    log "Unidad ${name} sin cambios"
  else
    install -D -m0644 "${src}" "${dest}"
    log "Unidad ${name} instalada"
  fi
  if [[ -d "${src}.d" ]]; then
    rsync -a --delete "${src}.d/" "${dest}.d/"
  fi
}

install_systemd_units() {
  log "[step] Instalando unidades systemd"
  local units=(
    bascula-backend.service
    bascula-miniweb.service
    bascula-ocr.service
    bascula-ui.service
  )
  local unit
  for unit in "${units[@]}"; do
    install_systemd_unit "${unit}"
  done
  systemctl daemon-reload
  systemctl enable bascula-backend.service bascula-miniweb.service bascula-ocr.service bascula-ui.service
  systemctl enable --now bascula-ocr.service
}

ensure_node() {
  log "[step] Verificando Node.js"
  if ! command -v node >/dev/null 2>&1; then
    log "Instalando Node.js 20.x"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  fi
  log "Node $(node -v), npm $(npm -v)"
  if command -v corepack >/dev/null 2>&1; then
    corepack enable 2>/dev/null || true
    corepack prepare yarn@stable --activate 2>/dev/null || true
    corepack prepare pnpm@latest --activate 2>/dev/null || true
  fi
}

detect_frontend_dir() {
  local base="${REPO_DIR:-/opt/bascula/current}"
  local candidates=(frontend ui web app dash-ui bascula-ui src/frontend src/web src/ui)
  local d
  for d in "${candidates[@]}"; do
    if [[ -f "${base}/${d}/package.json" ]]; then
      echo "${base}/${d}"
      return 0
    fi
  done
  return 1
}

deploy_frontend() {
  log "[step] Construyendo frontend"
  local front_dir
  front_dir="$(detect_frontend_dir)" || abort "No se encontró carpeta de frontend con package.json"
  log "Directorio de frontend: ${front_dir}"
  pushd "${front_dir}" >/dev/null
  local pm="npm"
  if [[ -f pnpm-lock.yaml ]]; then
    pm="pnpm"
  elif [[ -f yarn.lock ]]; then
    pm="yarn"
  elif [[ -f package-lock.json ]]; then
    pm="npm-ci"
  fi
  case "${pm}" in
    pnpm)
      if ! command -v pnpm >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
        corepack prepare pnpm@latest --activate 2>/dev/null || true
      fi
      command -v pnpm >/dev/null 2>&1 || abort "pnpm requerido pero no disponible"
      pnpm install --frozen-lockfile
      pnpm run build
      ;;
    yarn)
      if ! command -v yarn >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
        corepack prepare yarn@stable --activate 2>/dev/null || true
      fi
      command -v yarn >/dev/null 2>&1 || abort "yarn requerido pero no disponible"
      yarn install --frozen-lockfile
      yarn build
      ;;
    npm-ci)
      npm ci
      npm run build
      ;;
    *)
      npm install
      npm run build
      ;;
  esac
  local build_dir=""
  local candidates=(dist build public)
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "${front_dir}/${candidate}/index.html" ]]; then
      build_dir="${front_dir}/${candidate}"
      break
    fi
  done
  if [[ -z "${build_dir}" ]]; then
    abort "No se encontró index.html en dist/, build/ ni public/"
  fi
  install -d -m0755 /var/www/bascula
  rsync -a --delete "${build_dir}/" /var/www/bascula/
  chown -R "${WWW_GROUP}:${WWW_GROUP}" /var/www/bascula
  popd >/dev/null
}

configure_nginx_site() {
  log "[step] Configurando Nginx"
  local src="${RELEASE_DIR}/nginx/bascula.conf"
  local dest="${NGINX_SITES_AVAILABLE}/${NGINX_SITE_NAME}"
  if [[ ! -f "${src}" ]]; then
    abort "No se encontró plantilla Nginx en ${src}"
  fi
  install -D -m0644 "${src}" "${dest}"
  install -d -m0755 "${NGINX_DISABLED_DIR}"
  local entry
  for entry in "${NGINX_SITES_ENABLED}"/*; do
    [[ -e "${entry}" ]] || continue
    if [[ "$(basename "${entry}")" != "${NGINX_SITE_NAME}" ]]; then
      mv "${entry}" "${NGINX_DISABLED_DIR}/$(basename "${entry}")" 2>/dev/null || rm -f "${entry}"
    fi
  done
  for entry in "${NGINX_SITES_AVAILABLE}"/*; do
    [[ -e "${entry}" ]] || continue
    local name="$(basename "${entry}")"
    if [[ "${name}" != "${NGINX_SITE_NAME}" ]] && [[ "${name}" == default* || "${name}" == 000-default.conf ]]; then
      mv "${entry}" "${NGINX_DISABLED_DIR}/${name}" 2>/dev/null || true
    fi
  done
  ln -sfn "${dest}" "${NGINX_SITES_ENABLED}/${NGINX_SITE_NAME}"
  if ! nginx -t; then
    log_err "Validación de Nginx falló"
    nginx -t || true
    exit 1
  fi
  if ! systemctl reload nginx; then
    log_warn "Reload falló, intentando restart"
    systemctl restart nginx
  fi
}

enable_pipewire_for_pi() {
  if id -u "${DEFAULT_USER}" >/dev/null 2>&1; then
    log "[step] Activando PipeWire para ${DEFAULT_USER}"
    runuser -l "${DEFAULT_USER}" -c 'systemctl --user enable --now pipewire.service pipewire-pulse.service wireplumber.service' || \
      log_warn "No se pudo habilitar PipeWire para ${DEFAULT_USER}"
  fi
}

ensure_backend_service() {
  log "[step] Iniciando servicios principales"
  systemctl restart bascula-miniweb.service
  systemctl restart bascula-backend.service
  systemctl restart bascula-ocr.service
  systemctl restart bascula-ui.service
}

verify_audio_camera() {
  log "[step] Verificando audio y cámara"
  enable_pipewire_for_pi
  run_checked "Dispositivo playback" aplay -l
  run_checked "Dispositivo capture" arecord -l
  run_checked "libcamera detecta cámara" libcamera-hello --version
}

run_final_checks() {
  log "[step] Comprobaciones finales"
  nginx -t
  run_checked "UI raíz responde 200" bash -o pipefail -c "curl -fsS http://127.0.0.1/ >/dev/null"
  run_checked "API health vía proxy" bash -o pipefail -c "curl -fsS http://127.0.0.1/api/health >/dev/null"
  run_checked "SSE /api/scale/events" bash -o pipefail -c "curl -i -N --max-time 5 http://127.0.0.1/api/scale/events | head -n 1 | grep -q 'HTTP/1.1 200'"
  run_checked "Miniweb cámara" bash -o pipefail -c "curl -fsS http://127.0.0.1/api/camera/info >/dev/null"
  run_checked "OCR health" bash -o pipefail -c "curl -fsS http://127.0.0.1/api/ocr/health >/dev/null"
  verify_audio_camera
  run_checked "Servicio X735" systemctl is-active --quiet x735-fan.service
  run_checked "Servicio X735 shutdown" bash -o pipefail -c "systemctl list-unit-files | grep -q 'x735-shutdown.service'"
}

main() {
  log "Iniciando instalador v2"
  require_root
  ensure_packages
  ensure_boot_overlays
  configure_x735
  COMMIT="$(current_commit)"
  select_release_dir "${COMMIT}"
  sync_release_contents
  ensure_python_venv
  prepare_ocr_models_dir
  ensure_audio_env_file
  install_asound_conf
  install_tmpfiles_config
  systemd-tmpfiles --create "${TMPFILES_DEST}/bascula.conf"
  ensure_log_dir
  ensure_capture_dirs
  install_systemd_units
  ensure_node
  deploy_frontend
  configure_nginx_site
  ensure_backend_service
  run_final_checks
  log "Instalación completada correctamente"
}

main "$@"
