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
NGINX_SITE_NAME="00-bascula.conf"
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
  sudo apt-get update

  export DEBIAN_FRONTEND=noninteractive

  # Instala una lista de paquetes; si alguno no existe, no aborta el script.
  apt_try() {
    sudo apt-get install -y "$@" || return 1
  }

  # Prueba alternativas; devuelve 0 si alguna entra.
  apt_one_of() {
    for pkg in "$@"; do
      if apt_try "$pkg"; then
        echo "[install] usando $pkg"
        return 0
      fi
    done
    echo "[install][warn] ninguna alternativa disponible: $*"
    return 0
  }

  # Paquetes base presentes en Bookworm y Bullseye
  sudo apt-get install -y \
    git python3-venv python3-pip \
    python3-libcamera python3-picamera2 \
    libcap-dev libatlas-base-dev libopenjp2-7 \
    ffmpeg nginx curl jq libzbar0

  # Transiciones de versión entre Bullseye ↔ Bookworm:
  # TIFF: Bullseye=libtiff5, Bookworm=libtiff6
  apt_one_of libtiff6 libtiff5

  # FFmpeg (libavformat): Bullseye=58, Bookworm=59, testing puede ser 60
  apt_one_of libavformat60 libavformat59 libavformat58

  # ilmbase dejó de existir como runtime en Bookworm; intenta los headers si están
  apt_try libimath-dev || apt_try libilmbase-dev || true
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

configure_nginx_site() {
  log "[step] Configurando Nginx para Báscula"
  install -d -m0755 "${NGINX_SITES_AVAILABLE}" "${NGINX_SITES_ENABLED}" /var/www/bascula

  log "[step] Limpiando vhosts antiguos"
  rm -f /etc/nginx/conf.d/00-bascula.conf /etc/nginx/conf.d/00-bascula.conf.*
  if [[ -d /etc/nginx/conf.d ]]; then
    find /etc/nginx/conf.d -maxdepth 1 -type f -print0 \
      | while IFS= read -r -d '' file; do
        if grep -Eq '\blisten\s+80' "${file}"; then
          log_warn "Eliminando definición duplicada en ${file}"
          rm -f "${file}"
        fi
      done
  fi
  find "${NGINX_SITES_ENABLED}" -maxdepth 1 \( -type f -o -type l \) -name '*.bak' -print0 \
    | while IFS= read -r -d '' file; do
      if grep -Eq '\blisten\s+80' "${file}"; then
        rm -f "${file}"
      fi
    done
  rm -f "${NGINX_SITES_ENABLED}/default" || true

  local enabled
  while IFS= read -r -d '' enabled; do
    local target="${enabled}"
    if [[ "${target}" != "${NGINX_SITES_ENABLED}/${NGINX_SITE_NAME}" ]] \
      && grep -Eq '\blisten\s+80' "${target}" 2>/dev/null; then
      log_warn "Eliminando vhost duplicado en ${target}"
      rm -f "${target}"
    fi
  done < <(find "${NGINX_SITES_ENABLED}" -maxdepth 1 \( -type l -o -type f \) -print0)

  local site_path="${NGINX_SITES_AVAILABLE}/${NGINX_SITE_NAME}"
  local tmp="${site_path}.tmp"
  cat <<'EOF' >"${tmp}"
server {
    listen 80;
    server_name _;

    root /var/www/bascula;
    index index.html;

    # Front (SPA)
    location / {
        try_files $uri /index.html;
    }

    # Backend
    location /api/ {
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
        proxy_buffering off;
    }
}
EOF
  if [[ -f "${site_path}" ]] && cmp -s "${tmp}" "${site_path}"; then
    log "Configuración de Nginx sin cambios"
  else
    install -o root -g root -m0644 "${tmp}" "${site_path}"
    log "Configuración de Nginx actualizada"
  fi
  rm -f "${tmp}"

  ln -sfn "${site_path}" "${NGINX_SITES_ENABLED}/${NGINX_SITE_NAME}"

  if ! nginx -t; then
    abort "nginx -t falló tras configurar el vhost"
  fi
  systemctl reload nginx
}

ensure_node() {
  if ! command -v node >/dev/null 2>&1; then
    log "Instalando Node.js 20.x"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  fi
  log "Node $(node -v), npm $(npm -v)"
  corepack enable 2>/dev/null || true
  corepack prepare yarn@stable --activate 2>/dev/null || true
  corepack prepare pnpm@latest --activate 2>/dev/null || true
}

detect_frontend_dir() {
  for d in frontend ui web app; do
    if [ -d "${REPO_DIR:-/opt/bascula/current}/$d" ]; then
      echo "${REPO_DIR:-/opt/bascula/current}/$d"
      return 0
    fi
  done
  return 1
}

build_frontend() {
  local front_dir
  front_dir="$(detect_frontend_dir)" || {
    log_warn "No se encontró carpeta de frontend (frontend/ui/web/app). Omitiendo build."
    return 0
  }
  log "Frontend: ${front_dir}"

  pushd "${front_dir}" >/dev/null

  if [ -f pnpm-lock.yaml ]; then
    if ! command -v pnpm >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
      corepack prepare pnpm@latest --activate 2>/dev/null || true
    fi
    if command -v pnpm >/dev/null 2>&1; then
      log "Usando pnpm"
      pnpm install --frozen-lockfile
      pnpm run build
    else
      popd >/dev/null
      log_err "UI: pnpm requerido pero no disponible"
      exit 1
    fi
  elif [ -f yarn.lock ]; then
    if ! command -v yarn >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
      corepack prepare yarn@stable --activate 2>/dev/null || true
    fi
    if command -v yarn >/dev/null 2>&1; then
      log "Usando yarn"
      yarn install --frozen-lockfile
      yarn build
    else
      popd >/dev/null
      log_err "UI: yarn requerido pero no disponible"
      exit 1
    fi
  else
    log "Usando npm"
    (npm ci || npm install)
    npm run build
  fi

  local out
  for out in dist build public; do
    if [ -f "$out/index.html" ]; then
      popd >/dev/null
      echo "${front_dir}/${out}"
      return 0
    fi
  done

  popd >/dev/null
  log_err "UI: falta index.html tras build (no se encontró en dist/build/public)"
  exit 1
}

deploy_frontend() {
  local out_dir
  out_dir="$(build_frontend)" || return 0
  [ -z "${out_dir}" ] && return 0

  local docroot="/var/www/bascula"
  mkdir -p "${docroot}"
  rsync -a --delete "${out_dir}/" "${docroot}/"

  chown -R root:root "${docroot}"
  find "${docroot}" -type d -print0 | xargs -0 chmod 0755
  find "${docroot}" -type f -print0 | xargs -0 chmod 0644

  if [ ! -f "${docroot}/index.html" ]; then
    log_err "UI: falta ${docroot}/index.html después del despliegue"
    exit 1
  fi
  log "UI desplegado en ${docroot}"
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

ensure_backend_service() {
  log "[step] Asegurando bascula-backend.service"
  systemctl enable --now bascula-backend.service
  if ! systemctl is-active --quiet bascula-backend.service; then
    abort "bascula-backend.service no está activo"
  fi

  local status attempt
  for attempt in {1..10}; do
    status=$(curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/health || true)
    if [[ "${status}" == "200" ]]; then
      return 0
    fi
    sleep 1
  done
  abort "El backend no respondió 200 en /health (último código ${status})"
}

verify_ui_served() {
  log "[step] Verificando UI en Nginx"
  if [[ ! -f /var/www/bascula/index.html ]]; then
    abort "UI no desplegada en /var/www/bascula (falta index.html)"
  fi

  if ! curl -fsSI http://127.0.0.1/ | grep -q '^HTTP/.* 200'; then
    abort "La raíz HTTP no respondió 200"
  fi

  local body
  body=$(curl -fsS http://127.0.0.1/)
  if [[ "${body}" != *"<title>Panel de configuración del dispositivo</title>"* ]] \
    && [[ "${body}" != *"<link rel=\"manifest\" href=\"/manifest.json\""* ]] \
    && [[ "${body}" != *"<script type=\"module\" crossorigin src=\"/assets/"* ]]; then
    abort "UI no servida desde /var/www/bascula; revisa vhost y copia de ficheros"
  fi
}

systemd_status_brief() {
  local unit="$1"
  systemctl --no-pager -l -q status "${unit}" 2>/dev/null \
    | sed -n 's/^\s*Active: \(.*\)$/Active: \1/p' \
    | head -n1
}

log_nginx_root_and_listing() {
  local site_path="${NGINX_SITES_AVAILABLE}/${NGINX_SITE_NAME}"
  local nginx_root="(desconocido)"
  if [[ -f "${site_path}" ]]; then
    nginx_root=$(awk '/^[[:space:]]*root / {gsub(";", "", $2); print $2; exit}' "${site_path}")
    [[ -z "${nginx_root}" ]] && nginx_root="(sin definir)"
  fi
  log "[step] Root Nginx configurado: ${nginx_root}"
  if [[ -d /var/www/bascula ]]; then
    log "[step] Contenido de /var/www/bascula:"
    ls -alh /var/www/bascula
  else
    log_warn "Directorio /var/www/bascula no existe"
  fi
}

run_final_checks() {
  log "[step] Ejecutando comprobaciones finales"
  if ! nginx -t; then
    abort "nginx -t falló en comprobaciones finales"
  fi

  local api_health
  api_health=$(curl -fsS http://127.0.0.1/api/health || true)
  if [[ -z "${api_health}" ]] || [[ ! ${api_health} =~ "status"[[:space:]]*:[[:space:]]*"ok" ]]; then
    abort "API de salud no devolvió status ok"
  fi

  verify_ui_served

  log_nginx_root_and_listing

  local backend_status ui_status
  backend_status=$(systemd_status_brief bascula-backend.service)
  ui_status=$(systemd_status_brief bascula-ui.service)
  log "[step] Estado bascula-backend: ${backend_status}"
  log "[step] Estado bascula-ui: ${ui_status}"

  log "[step] curl -sS http://127.0.0.1/api/health"
  curl -fsS http://127.0.0.1/api/health
  log "[step] curl -sS http://127.0.0.1/ | head -n 30"
  curl -fsS http://127.0.0.1/ | head -n 30
  if [[ -f /var/log/nginx/access.log ]]; then
    log "[step] Últimas peticiones relevantes en access.log"
    grep -E '"[A-Z]+ /( |assets/index-.*\.js)' /var/log/nginx/access.log | tail -n 5 || true
  else
    log_warn "No existe /var/log/nginx/access.log"
  fi
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
    libgomp1 libzbar0 libcap-dev libatlas-base-dev libopenjp2-7 \
    ffmpeg git rsync curl jq nginx \
    alsa-utils libcamera-apps espeak-ng \
    xserver-xorg xinit matchbox-window-manager \
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
  configure_nginx_site
  install_systemd_units

  REPO_DIR="${CURRENT_LINK}"
  ensure_node
  deploy_frontend
  configure_bascula_ui_service
  ensure_backend_service

  if [[ ${REBOOT_FLAG} -eq 1 ]]; then
    log_warn "Se requiere reinicio para aplicar configuraciones de arranque. Continuando con verificaciones esenciales."
  fi

  run_final_checks
  log "Instalación completada"
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
main "$@"
