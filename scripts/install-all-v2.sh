#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

LOG_PREFIX="[install-v2]"
LOCK_FILE="/var/lock/bascula.install"
RELEASES_DIR="/opt/bascula/releases"
CURRENT_LINK="/opt/bascula/current"
DEFAULT_USER="pi"
WWW_GROUP="www-data"
SYSTEMD_DEST="/etc/systemd/system"
TMPFILES_DEST="/etc/tmpfiles.d"
NGINX_SITES_AVAILABLE="/etc/nginx/sites-available"
NGINX_SITES_ENABLED="/etc/nginx/sites-enabled"
NGINX_DISABLED_DIR="/etc/nginx/sites-disabled-by-bascula"
NGINX_SITE_NAME="00-bascula.conf"
ASOUND_CONF="/etc/asound.conf"
AUDIO_ENV_FILE="/etc/default/bascula-audio"
BOOT_FIRMWARE_DIR="/boot/firmware"
BOOT_CONFIG_FILE="${BOOT_FIRMWARE_DIR}/config.txt"
WWW_ROOT="/var/www/bascula"
OCR_SERVICE_PORT="${BASCULA_OCR_PORT:-8082}"

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

run_checked() {
  local label="$1"
  shift
  log "[check] ${label}"
  if "$@"; then
    log "[ok] ${label}"
    return 0
  fi
  log_err "Fallo en verificación: ${label}"
  return 1
}

require_root() {
  if [[ $(id -u) -ne 0 ]]; then
    abort "Este instalador debe ejecutarse como root"
  fi
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
  if [[ ${#missing[@]} -eq 0 ]]; then
    log "Paquetes ya instalados: ${pkgs[*]}"
    return 0
  fi
  if [[ ${APT_UPDATED} -eq 0 ]]; then
    log "Ejecutando apt-get update"
    apt-get update
    APT_UPDATED=1
  fi
  log "Instalando paquetes: ${missing[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
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
  log "[step] Asegurando overlays de arranque"
  ensure_boot_config_line "dtoverlay=vc4-kms-v3d-pi5"
  ensure_boot_config_line "dtoverlay=disable-bt"
  ensure_boot_config_line "dtoverlay=hifiberry-dac"
  ensure_boot_config_line "enable_uart=1"
}

configure_x735() {
  log "[step] Configurando placa Geekworm X735"

  install -d -m0755 /etc/systemd/system /usr/local/bin

  cat >/usr/local/bin/x735-shutdown.sh <<'EOF2'
#!/bin/bash
echo 4 > /sys/class/gpio/export 2>/dev/null || true
echo out > /sys/class/gpio/gpio4/direction
echo 1 > /sys/class/gpio/gpio4/value
sleep 1
echo 0 > /sys/class/gpio/gpio4/value
poweroff
EOF2
  chmod +x /usr/local/bin/x735-shutdown.sh

  cat >/usr/local/bin/x735-fan.py <<'EOF2'
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
    if t < 45: return 0
    if t < 55: return 40
    if t < 65: return 70
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
EOF2
  chmod +x /usr/local/bin/x735-fan.py

  cat >/etc/systemd/system/x735-fan.service <<'EOF2'
[Unit]
Description=X735 Fan Control
After=multi-user.target
[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/local/bin/x735-fan.py
Restart=always
[Install]
WantedBy=multi-user.target
EOF2

  cat >/etc/systemd/system/x735-shutdown.service <<'EOF2'
[Unit]
Description=X735 Safe Shutdown
After=multi-user.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/x735-shutdown.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF2

  ensure_boot_config_line "dtoverlay=gpio-poweroff,gpiopin=4,active_low=1"
  ensure_boot_config_line "dtoverlay=gpio-shutdown,gpio_pin=17,active_low=1,gpio_pull=up"

  systemctl daemon-reload
  systemctl enable x735-shutdown.service
  systemctl enable --now x735-fan.service
  log "Servicio X735 configurado y activo"
}

current_commit() {
  if command -v git >/dev/null 2>&1 && git -C "${REPO_ROOT}" rev-parse HEAD >/dev/null 2>&1; then
    git -C "${REPO_ROOT}" rev-parse HEAD
  else
    printf 'unknown\n'
  fi
}

select_release_dir() {
  mkdir -p "${RELEASES_DIR}"
  local commit="$1"
  local existing_target
  if [[ -L "${CURRENT_LINK}" ]]; then
    existing_target=$(readlink -f "${CURRENT_LINK}")
    if [[ -n "${existing_target}" && -f "${existing_target}/.release-commit" ]]; then
      if [[ $(cat "${existing_target}/.release-commit") == "${commit}" ]]; then
        log "Reutilizando release actual ${existing_target}"
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
  install -d -m0755 -o root -g root "${RELEASE_DIR}"
}

sync_release_contents() {
  log "Sincronizando release en ${RELEASE_DIR}"
  rsync -a --delete --exclude='.git' --exclude='.venv' "${REPO_ROOT}/" "${RELEASE_DIR}/"
  printf '%s\n' "${COMMIT}" > "${RELEASE_DIR}/.release-commit"
  ln -sfn "${RELEASE_DIR}" "${CURRENT_LINK}"
}

ensure_python_venv() {
  local venv_dir="${CURRENT_LINK}/.venv"
  log "[step] Preparando entorno virtual en ${venv_dir}"
  python3 -m venv --system-site-packages "${venv_dir}"
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

  DEBIAN_FRONTEND=noninteractive apt-get install -y git libzbar0 libcap-dev libatlas-base-dev libopenjp2-7 || true

  apt_try() {
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" || return 1
  }

  apt_one_of() {
    local pkg
    for pkg in "$@"; do
      if apt_try "${pkg}"; then
        log "Usando ${pkg}"
        return 0
      fi
    done
    log_warn "Ninguna alternativa disponible: $*"
    return 0
  }

  apt_one_of libtiff6 libtiff5
  apt_one_of libavformat60 libavformat59 libavformat58
  apt_try libimath-dev || apt_try libilmbase-dev || true

  pip install --no-cache-dir \
    "rapidocr-onnxruntime==1.4.4" \
    onnxruntime \
    pyclipper \
    "shapely!=2.0.4,>=1.7.1"

  python - <<'PY'
import importlib, sys
for name in ("uvicorn", "fastapi", "starlette", "click", "httpx", "httpcore"):
    importlib.import_module(name)
for name in ("rapidocr_onnxruntime", "onnxruntime", "pyclipper", "shapely"):
    importlib.import_module(name)
print("venv dependencies OK")
PY
  deactivate || true
}

prepare_ocr_models_dir() {
  install -d -o "${DEFAULT_USER}" -g "${DEFAULT_USER}" -m0755 /opt/rapidocr/models
  cat >/opt/rapidocr/models/README.txt <<'EOF2'
Coloca aquí los modelos RapidOCR (.onnx) de detección y reconocimiento.
Variables:
  BASCULA_OCR_ENABLED=true
  BASCULA_OCR_MODELS_DIR=/opt/rapidocr/models
EOF2
  chown "${DEFAULT_USER}:${DEFAULT_USER}" /opt/rapidocr/models/README.txt
}

ensure_audio_env_file() {
  log "[step] Configurando entorno de audio"
  cat <<'EOF2' > "${AUDIO_ENV_FILE}.tmp"
BASCULA_AUDIO_DEVICE=bascula_out
BASCULA_MIC_DEVICE=bascula_mix_in
BASCULA_SAMPLE_RATE=16000
EOF2
  install -o root -g root -m0644 "${AUDIO_ENV_FILE}.tmp" "${AUDIO_ENV_FILE}"
  rm -f "${AUDIO_ENV_FILE}.tmp"
  if id -u "${DEFAULT_USER}" >/dev/null 2>&1; then
    runuser -l "${DEFAULT_USER}" -c "systemctl --user enable --now pipewire.service pipewire-pulse.service wireplumber.service" || \
      log_warn "No se pudieron activar servicios PipeWire para ${DEFAULT_USER}"
  fi
}

get_playback_hw() {
  if command -v aplay >/dev/null 2>&1; then
    local list
    list=$(aplay -L 2>/dev/null)
    local card
    card=$(printf '%s' "${list}" | awk '/^hw:CARD=sndrpihifiberry/ {print; exit}')
    if [[ -n "${card}" ]]; then
      printf '%s' "${card}"
      return 0
    fi
    card=$(printf '%s' "${list}" | awk '/^hw:CARD=vc4hdmi/ {print; exit}')
    if [[ -n "${card}" ]]; then
      printf '%s' "${card}"
      return 0
    fi
  fi
  printf 'hw:0,0'
}

get_capture_hw() {
  if command -v arecord >/dev/null 2>&1; then
    local list
    list=$(arecord -L 2>/dev/null)
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
  log "[step] Generando /etc/asound.conf"
  local playback_hw capture_hw playback_card capture_card
  playback_hw=$(get_playback_hw)
  capture_hw=$(get_capture_hw)
  playback_card=$(printf '%s' "${playback_hw}" | sed -E 's#^hw:(CARD=)?([^,]+).*$#\2#')
  capture_card=$(printf '%s' "${capture_hw}" | sed -E 's#^hw:(CARD=)?([^,]+).*$#\2#')
  cat <<EOF2 > "${ASOUND_CONF}.tmp"
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
EOF2
  if [[ -f "${ASOUND_CONF}" ]] && cmp -s "${ASOUND_CONF}.tmp" "${ASOUND_CONF}"; then
    rm -f "${ASOUND_CONF}.tmp"
    log "asound.conf sin cambios"
  else
    install -o root -g root -m0644 "${ASOUND_CONF}.tmp" "${ASOUND_CONF}"
    log "asound.conf actualizado"
  fi
}

install_tmpfiles_config() {
  install -D -m0644 "${RELEASE_DIR}/systemd/tmpfiles.d/bascula.conf" "${TMPFILES_DEST}/bascula.conf"
}

ensure_log_dir() {
  install -d -m0755 -o "${DEFAULT_USER}" -g "${DEFAULT_USER}" /var/log/bascula
}

ensure_capture_dirs() {
  install -d -m0775 -o "${DEFAULT_USER}" -g "${WWW_GROUP}" /run/bascula
  install -d -m02770 -o "${DEFAULT_USER}" -g "${WWW_GROUP}" /run/bascula/captures
  chmod g+s /run/bascula/captures
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
    bascula-miniweb.service
    bascula-backend.service
    bascula-ocr.service
    bascula-ui.service
  )
  local unit
  for unit in "${units[@]}"; do
    install_systemd_unit "${unit}"
  done
  systemctl daemon-reload
  systemctl enable --now bascula-miniweb.service bascula-backend.service bascula-ocr.service bascula-ui.service
}

ensure_node() {
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

build_frontend() {
  local front_dir
  front_dir="$(detect_frontend_dir)" || abort "No se encontró carpeta de frontend compatible"
  log "Frontend detectado en ${front_dir}"
  pushd "${front_dir}" >/dev/null
  if [[ -f pnpm-lock.yaml ]]; then
    if ! command -v pnpm >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
      corepack prepare pnpm@latest --activate 2>/dev/null || true
    fi
    command -v pnpm >/dev/null 2>&1 || abort "pnpm requerido pero no disponible"
    pnpm install --frozen-lockfile
    pnpm run build
  elif [[ -f yarn.lock ]]; then
    if ! command -v yarn >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
      corepack prepare yarn@stable --activate 2>/dev/null || true
    fi
    command -v yarn >/dev/null 2>&1 || abort "yarn requerido pero no disponible"
    yarn install --frozen-lockfile
    yarn build
  else
    if [[ -f package-lock.json ]]; then
      npm ci
    else
      npm install
    fi
    npm run build
  fi
  local candidate
  for candidate in dist build public; do
    if [[ -f "${candidate}/index.html" ]]; then
      popd >/dev/null
      printf '%s/%s\n' "${front_dir}" "${candidate}"
      return 0
    fi
  done
  popd >/dev/null
  abort "No se encontró index.html tras compilar frontend"
}

deploy_frontend() {
  log "[step] Construyendo y desplegando frontend"
  local out_dir
  out_dir="$(build_frontend)"
  install -d -m0755 -o www-data -g "${WWW_GROUP}" "${WWW_ROOT}"
  rsync -a --delete "${out_dir}/" "${WWW_ROOT}/"
  chown -R www-data:"${WWW_GROUP}" "${WWW_ROOT}"
  if [[ ! -f "${WWW_ROOT}/index.html" ]]; then
    abort "UI no desplegada correctamente en ${WWW_ROOT}"
  fi
  log "UI desplegada en ${WWW_ROOT}"
}

configure_nginx_site() {
  log "[step] Configurando Nginx"
  install -d -m0755 "${NGINX_SITES_AVAILABLE}" "${NGINX_SITES_ENABLED}" "${NGINX_DISABLED_DIR}"
  install -D -m0644 "${RELEASE_DIR}/nginx/bascula.conf" "${NGINX_SITES_AVAILABLE}/${NGINX_SITE_NAME}"
  ln -sfn "${NGINX_SITES_AVAILABLE}/${NGINX_SITE_NAME}" "${NGINX_SITES_ENABLED}/${NGINX_SITE_NAME}"

  local site
  for site in "${NGINX_SITES_ENABLED}"/*; do
    [[ "${site}" == "${NGINX_SITES_ENABLED}/${NGINX_SITE_NAME}" ]] && continue
    if [[ -e "${site}" ]]; then
      mv -f "${site}" "${NGINX_DISABLED_DIR}/" 2>/dev/null || true
    fi
  done
  for site in "${NGINX_SITES_AVAILABLE}"/*; do
    [[ "${site}" == "${NGINX_SITES_AVAILABLE}/${NGINX_SITE_NAME}" ]] && continue
    if [[ -f "${site}" ]]; then
      mv -f "${site}" "${NGINX_DISABLED_DIR}/" 2>/dev/null || true
    fi
  done

  if ! nginx -t; then
    abort "nginx -t falló"
  fi

  if systemctl is-active --quiet nginx; then
    systemctl reload nginx
  else
    systemctl enable --now nginx
  fi
}

ensure_backend_service() {
  log "[step] Comprobando bascula-backend.service"
  systemctl enable --now bascula-backend.service
  if ! systemctl is-active --quiet bascula-backend.service; then
    abort "bascula-backend.service no está activo"
  fi
  local status code=0
  for _ in {1..10}; do
    set +e
    status=$(curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/api/health)
    code=$?
    set -e
    if [[ ${code} -eq 0 && "${status}" == "200" ]]; then
      return 0
    fi
    sleep 1
  done
  abort "El backend no respondió 200 en /api/health"
}

verify_audio_camera() {
  log "[step] Verificando audio y cámara"
  run_checked "Dispositivo playback" aplay -l
  run_checked "Dispositivo capture" arecord -l
  run_checked "libcamera detecta cámara" libcamera-hello --version
}

run_final_checks() {
  log "[step] Comprobaciones finales"
  nginx -t || abort "nginx -t falló en comprobaciones finales"
  run_checked "UI raíz responde 200" curl -fsS http://127.0.0.1/ >/dev/null
  run_checked "API health vía proxy" curl -fsS http://127.0.0.1/api/health >/dev/null
  if ! run_checked "SSE /api/scale/events" bash -c "set -euo pipefail; curl -i -N --max-time 5 http://127.0.0.1/api/scale/events | head -n 1 | grep -q 'HTTP/1.1 200'"; then
    abort "SSE /api/scale/events no respondió 200"
  fi
  if ! run_checked "Miniweb cámara" curl -fsS http://127.0.0.1/api/camera/info >/dev/null; then
    log_warn "Miniweb cámara no respondió"
  fi
  if ! run_checked "OCR health" curl -fsS http://127.0.0.1/api/ocr/health >/dev/null; then
    log_warn "Servicio OCR no respondió vía Nginx"
  fi
  if ! run_checked "OCR health directo" curl -fsS "http://127.0.0.1:${OCR_SERVICE_PORT}/api/ocr/health" >/dev/null; then
    log_warn "Servicio OCR directo en ${OCR_SERVICE_PORT} no respondió"
  fi
  verify_audio_camera
  run_checked "Servicio X735" systemctl is-active --quiet x735-fan.service
  run_checked "Servicio X735 shutdown cargado" bash -c "systemctl list-unit-files | grep -q '^x735-shutdown.service'"
}

main() {
  require_root
  exec 9>"${LOCK_FILE}"
  if ! flock -n 9; then
    log_warn "Otro proceso de instalación en ejecución"
    exit 0
  fi

  local base_packages=(
    python3 python3-venv python3-pip python3-dev
    python3-numpy python3-simplejpeg python3-picamera2
    libgomp1 libzbar0 libcap-dev libatlas-base-dev libopenjp2-7
    ffmpeg git rsync curl jq nginx
    alsa-utils libcamera-apps v4l-utils espeak-ng
    xserver-xorg xinit matchbox-window-manager
    fonts-dejavu-core pipewire pipewire-pulse wireplumber
  )

  local chromium_pkg="chromium-browser"
  if ! apt-cache show "${chromium_pkg}" >/dev/null 2>&1; then
    chromium_pkg="chromium"
  fi
  base_packages+=("${chromium_pkg}")

  ensure_packages "${base_packages[@]}"

  ensure_boot_overlays
  configure_x735

  COMMIT=$(current_commit)
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

  REPO_DIR="${CURRENT_LINK}"
  ensure_node
  deploy_frontend
  configure_nginx_site
  ensure_backend_service
  verify_audio_camera
  run_final_checks
  log "Instalación completada correctamente"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
main "$@"
