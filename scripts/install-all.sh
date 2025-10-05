#!/bin/bash
#
# Script de instalación completa para Báscula Digital Pro (bascula-cam)
# Raspberry Pi 5 + Bookworm Lite 64-bit
# - Instala estructura OTA con versionado
# - Configura HDMI (1024x600), KMS, I2S audio, UART, Camera Module 3
# - Instala Piper TTS, Tesseract OCR, servicios y NetworkManager AP fallback
# - Idempotente con verificaciones exhaustivas
#

set -euo pipefail
trap 'echo "[inst][err] línea $LINENO"; exit 1' ERR

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { printf "${BLUE}[inst]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[inst][warn]${NC} %s\n" "$*"; }
err()  { printf "${RED}[inst][err]${NC} %s\n" "$*"; }
fail() { err "$*"; exit 1; }

apt_has() {
  dpkg -s "$1" >/dev/null 2>&1
}

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

ensure_pkg() {
  local pkg
  for pkg in "$@"; do
    apt_has "${pkg}" || apt_install "${pkg}"
  done
}

apt_candidate_exists() {
  local candidate
  candidate=$(apt-cache policy "$1" 2>/dev/null | awk '/Candidate:/ {print $2; exit}')
  [[ -n "${candidate}" && "${candidate}" != "(none)" ]]
}

ensure_user_in_group() {
  local user="$1"
  local group="$2"
  if ! id -u "${user}" >/dev/null 2>&1; then
    warn "Usuario ${user} no existe; omitiendo adición a ${group}"
    return
  fi
  if ! getent group "${group}" >/dev/null 2>&1; then
    warn "Grupo ${group} no existe; omitiendo adición de ${user}"
    return
  fi
  if id -nG "${user}" | tr ' ' '\n' | grep -qx "${group}"; then
    log "Usuario ${user} ya pertenece al grupo ${group}"
    return
  fi
  if usermod -aG "${group}" "${user}"; then
    log "Añadido usuario ${user} al grupo ${group}"
  else
    warn "No se pudo añadir ${user} al grupo ${group}"
  fi
}

ensure_enable_uart() {
  local conf_file="$1"
  if [[ ${SKIP_HARDWARE_CONFIG:-0} == 1 ]]; then
    warn "SKIP_HARDWARE_CONFIG=1, omitiendo forzar enable_uart"
    return
  fi
  if [[ ! -f "${conf_file}" ]]; then
    warn "No se encontró ${conf_file}; creando archivo para habilitar UART"
    if ! touch "${conf_file}"; then
      warn "No se pudo crear ${conf_file}; UART no configurado"
      return
    fi
  fi
  if grep -qE '^\s*enable_uart=1\b' "${conf_file}"; then
    log "UART ya habilitado en ${conf_file}"
    return
  fi
  if grep -qE '^\s*enable_uart=' "${conf_file}"; then
    if sed -i 's/^\s*enable_uart=.*/enable_uart=1/' "${conf_file}"; then
      log "Actualizado enable_uart=1 en ${conf_file}"
    else
      warn "No se pudo actualizar enable_uart en ${conf_file}"
    fi
  else
    {
      printf '\n# Habilitado por instalador de Báscula\n'
      printf 'enable_uart=1\n'
    } >>"${conf_file}" || warn "No se pudo escribir enable_uart en ${conf_file}"
    log "Añadido enable_uart=1 a ${conf_file}"
  fi
}

backup_boot_config_once() {
  local bootcfg="$1"
  local ts="$2"
  if [[ ! -f "${bootcfg}" ]]; then
    warn "config.txt no existe en ${bootcfg}"
    return 1
  fi
  local backup_path="${bootcfg}.bak-${ts}"
  if cp -a "${bootcfg}" "${backup_path}"; then
    printf '[install] Backup: %s\n' "${backup_path}"
  else
    warn "No se pudo crear copia de seguridad ${backup_path}"
    return 1
  fi
}

ensure_bootcfg_line() {
  local bootcfg="$1"
  local re="$2"
  local line="$3"
  if grep -Eq "^[[:space:]]*#?[[:space:]]*$re[[:space:]]*$" "${bootcfg}"; then
    sed -ri "s~^[[:space:]]*#?[[:space:]]*$re[[:space:]]*$~${line}~g" "${bootcfg}"
  else
    printf '%s\n' "${line}" >> "${bootcfg}"
  fi
}

configure_pi_boot_hardware() {
  local bootcfg="${CONF}"
  local ts="$(date +%Y%m%d-%H%M%S)"
  local dac_name="${HW_DAC_NAME:-hifiberry-dac}"

  if [[ ! -f "${bootcfg}" ]]; then
    warn "config.txt no existe en ${bootcfg}"
    return 1
  fi

  if [[ ! -w "${bootcfg}" ]]; then
    warn "No se puede escribir en ${bootcfg}"
    return 1
  fi

  backup_boot_config_once "${bootcfg}" "${ts}" || true

  if grep -q "Bascula-Cam: Hardware Configuration" "${bootcfg}" && \
     grep -q "# --- Bascula-Cam (end) ---" "${bootcfg}"; then
    if sed -i '/# --- Bascula-Cam: Hardware Configuration ---/,/# --- Bascula-Cam (end) ---/d' "${bootcfg}"; then
      printf '[install] Removed previous Bascula-Cam block safely\n'
    else
      warn "No se pudo eliminar bloque previo Bascula-Cam en ${bootcfg}"
    fi
  else
    printf '[install] Bascula-Cam block not fully delimited, skipping safe delete\n'
  fi

  {
    printf '\n'
    printf '# --- Bascula-Cam: Hardware Configuration ---\n'
    printf '# (autoconfig generado por install-all.sh)\n'
    printf 'dtparam=i2c_arm=on\n'
    printf 'dtparam=i2s=on\n'
    printf 'dtparam=spi=on\n'
    printf 'dtparam=audio=off\n'
    printf 'dtoverlay=i2s-mmap\n'
    printf 'dtoverlay=%s\n' "${dac_name}"
    printf 'camera_auto_detect=1\n'
    printf 'dtoverlay=imx708\n'
    printf '# --- Bascula-Cam (end) ---\n'
  } >> "${bootcfg}" || warn "No se pudo escribir bloque Bascula-Cam en ${bootcfg}"

  local tmp_file="${bootcfg}.tmp.$$"
  if awk 'NR==1 {prev=$0; print; next} {if ($0 != prev) print; prev=$0}' "${bootcfg}" > "${tmp_file}"; then
    mv "${tmp_file}" "${bootcfg}"
  else
    rm -f "${tmp_file}"
    warn "No se pudo limpiar duplicados en ${bootcfg}"
  fi

  printf '[install] Boot overlays activados (I2C/I2S/SPI + %s + imx708). Requiere reboot.\n' "${dac_name}"
}

# --- Require root privileges ---
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  err "Ejecuta con sudo: sudo ./install-all.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Detect systemd availability early
HAS_SYSTEMD=0
[ -d /run/systemd/system ] && HAS_SYSTEMD=1
if [[ "${HAS_SYSTEMD}" -eq 0 ]]; then
  warn "systemd no está activo (PID 1); se omitirán comandos systemctl"
fi

systemctl_safe() {
  if [[ "${HAS_SYSTEMD}" -eq 1 ]]; then
    if ! systemctl "$@"; then
      warn "systemctl $* falló"
    fi
  else
    warn "systemd no disponible: systemctl $* omitido"
  fi
}

safe_install() {
  local src="$1"
  local dst="$2"
  if [ -e "${src}" ] && [ -e "${dst}" ]; then
    local src_real dst_real
    src_real=$(readlink -f "${src}" 2>/dev/null || echo "")
    dst_real=$(readlink -f "${dst}" 2>/dev/null || echo "")
    if [[ -n "${src_real}" && -n "${dst_real}" && "${src_real}" == "${dst_real}" ]]; then
      echo "[inst][info] skip install: ${dst} ya es el mismo fichero"
      return 0
    fi
  fi
  install -m 0755 "${src}" "${dst}"
}

install_x735() {
  echo "[inst] [X735] Configurando soporte x735 (fan/power)…"

  if ! command -v git >/dev/null 2>&1; then
    if [[ "${NET_OK:-0}" -eq 1 ]]; then
      ensure_pkg git || warn "[X735] No se pudo instalar git"
    else
      echo "[inst] [X735][warn] git no disponible y sin red; los servicios se configurarán en cuanto esté disponible"
    fi
  fi

  # Sello de idempotencia
  install -d -m 0755 /var/lib

  # Script ensure (se reintenta en cada boot hasta ver PWM)
  install -d -m 0755 /usr/local/sbin
  install -d -m 0755 /etc/systemd/system

  # X735 ensure: instalar, habilitar y EJECUTAR ahora
  install -m 0755 system/os/x735-ensure.sh /usr/local/sbin/x735-ensure.sh
  install -m 0644 system/os/x735-ensure.service /etc/systemd/system/x735-ensure.service || true
  chmod +x /usr/local/sbin/x735-ensure.sh

  if [ -d /run/systemd/system ]; then
    systemctl daemon-reload
    systemctl enable x735-ensure.service || true
    systemctl start x735-ensure.service || true
    systemctl enable --now x735-fan.service 2>/dev/null || true
    systemctl enable --now x735-pwr.service 2>/dev/null || true
    systemctl is-active --quiet x735-ensure.service && echo "[inst] ✓ X735 ensure ejecutado (sin reboot)"
    systemctl is-active --quiet x735-fan.service && echo "[inst] ✓ X735 fan activo"
    systemctl is-active --quiet x735-pwr.service && echo "[inst] ✓ X735 power activo"
  else
    /usr/local/sbin/x735-ensure.sh --oneshot || /usr/local/sbin/x735-ensure.sh || true
  fi

  echo "[inst] ✓ X735 configurado (ensure service instalado)"
}

# --- Configuration variables ---
TARGET_USER="${SUDO_USER:-pi}"
TARGET_ENTRY="$(getent passwd "$TARGET_USER" || true)"
if [[ -z "${TARGET_ENTRY}" ]]; then
  warn "Usuario ${TARGET_USER} no encontrado; usando $(id -un)"
  TARGET_USER="$(id -un)"
  TARGET_ENTRY="$(getent passwd "$TARGET_USER" || true)"
fi

TARGET_GROUP="${TARGET_USER}"
if [[ -n "${TARGET_ENTRY}" ]]; then
  TARGET_GID="$(printf '%s' "${TARGET_ENTRY}" | cut -d: -f4)"
  TARGET_HOME="$(printf '%s' "${TARGET_ENTRY}" | cut -d: -f6)"
  if [[ -n "${TARGET_GID}" ]]; then
    TARGET_GROUP="$(getent group "${TARGET_GID}" | cut -d: -f1)"
  fi
else
  TARGET_HOME="${HOME:-/root}"
fi

if [[ -z "${TARGET_HOME}" ]]; then
  err "No se pudo determinar el home de ${TARGET_USER}"
  exit 1
fi

# Asegura que el grupo existe; si el gid no se resolvió usa el del usuario
if [[ -z "${TARGET_GROUP}" ]] || ! getent group "${TARGET_GROUP}" &>/dev/null; then
  TARGET_GROUP="$(id -gn "${TARGET_USER}")"
fi

BASCULA_ROOT="/opt/bascula"
BASCULA_RELEASES_DIR="${BASCULA_ROOT}/releases"
BASCULA_CURRENT_LINK="${BASCULA_ROOT}/current"
CFG_DIR="${TARGET_HOME}/.bascula"
CFG_PATH="${CFG_DIR}/config.json"
STATE_DIR="/var/lib/bascula"
STATE_FILE="${STATE_DIR}/scale.json"
LOG_DIR="/var/log/bascula"

AP_IFACE="wlan0"
AP_GATEWAY="192.168.4.1"
AP_SSID="${AP_SSID:-Bascula-AP}"
AP_PASS="${AP_PASS:-Bascula1234}"
AP_NAME="${AP_NAME:-BasculaAP}"
AP_POOL_START="${AP_POOL_START:-192.168.4.20}"
AP_POOL_END="${AP_POOL_END:-192.168.4.99}"

BOOTDIR="/boot/firmware"
[[ ! -d "${BOOTDIR}" ]] && BOOTDIR="/boot"
CONF="${BOOTDIR}/config.txt"

log "============================================"
log "  Instalación Completa - Báscula Digital Pro"
log "============================================"
log "Target user      : $TARGET_USER ($TARGET_GROUP)"
log "Target home      : $TARGET_HOME"
log "OTA current link : $BASCULA_CURRENT_LINK"
log "AP (NM)          : SSID=${AP_SSID} PASS=<oculto> IFACE=${AP_IFACE}"

# Check internet connection
log "[1/20] Verificando conexión a Internet..."
if ! ping -c 1 google.com &> /dev/null; then
    warn "Sin conexión a Internet. Instalación limitada."
    NET_OK=0
else
    log "✓ Conexión verificada"
    NET_OK=1
fi

# Detect architecture
ARCH=$(uname -m)
if [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "armv7l" ]; then
    warn "No se detectó arquitectura ARM. Este script está diseñado para Raspberry Pi."
fi

# Update system
log "[2/20] Actualizando el sistema..."
if [[ "${NET_OK}" -eq 1 ]]; then
    if ! apt-get update -y; then
        warn "apt-get update falló; continúa con el resto de la instalación"
    elif ! apt-get upgrade -y; then
        warn "apt-get upgrade falló; continúa con el resto de la instalación"
    else
        log "✓ Sistema actualizado"
    fi
else
    warn "Sin red: omitiendo apt-get update/upgrade"
fi

# Install base system packages
log "[3/20] Instalando dependencias del sistema..."
if [[ "${NET_OK}" -eq 1 ]]; then
    BASE_PACKAGES=(
        git curl ca-certificates build-essential cmake pkg-config
        python3 python3-venv python3-pip python3-dev python3-tk python3-numpy python3-serial
        python3-pil python3-pil.imagetk python3-xdg
        x11-xserver-utils xserver-xorg-legacy
        fonts-dejavu-core
        libjpeg-dev zlib1g-dev libpng-dev
        alsa-utils sox ffmpeg
        libzbar0 gpiod python3-rpi.gpio
        network-manager dnsmasq-base dnsutils jq sqlite3 tesseract-ocr tesseract-ocr-spa espeak-ng
        uuid-runtime
    )
    if apt_install "${BASE_PACKAGES[@]}"; then
        log "✓ Dependencias base instaladas"
    else
        warn "No se pudieron instalar todas las dependencias base"
    fi

    # Ensure global dnsmasq daemon is never installed/active (only dnsmasq-base needed)
    log "Asegurando que dnsmasq global no esté activo..."
    if [[ "${HAS_SYSTEMD}" -eq 1 ]]; then
      systemctl disable --now dnsmasq 2>/dev/null || true
      systemctl mask dnsmasq 2>/dev/null || true
    else
      warn "systemd no disponible: omitiendo systemctl para dnsmasq"
    fi
    apt-get -y purge dnsmasq 2>/dev/null || true
    # Install only dnsmasq-base (library for NetworkManager)
    ensure_pkg dnsmasq-base
    log "✓ dnsmasq-base instalado (dnsmasq global removido)"

    ensure_pkg xorg
    ensure_pkg xinit
    ensure_pkg openbox
    ensure_pkg unclutter
    ensure_pkg python3-serial
else
    warn "Sin red: omitiendo la instalación de dependencias base"
    warn "Instala manualmente python3-serial para el backend UART"
fi

CHROME_PKG=""
if apt_candidate_exists chromium; then
  CHROME_PKG="chromium"
fi
if apt_candidate_exists chromium-browser; then
  CHROME_PKG="${CHROME_PKG:-chromium-browser}"
fi

if [[ -n "${CHROME_PKG}" ]]; then
  if [[ "${NET_OK}" -eq 1 ]]; then
    ensure_pkg "${CHROME_PKG}"
  fi
  log "✓ Paquete Chromium seleccionado: ${CHROME_PKG}"
else
  fail "No se encontró paquete Chromium disponible en apt-cache"
fi

POLKIT_PKG=""
if apt_candidate_exists policykit-1; then
  POLKIT_PKG="policykit-1"
fi
if apt_candidate_exists polkitd; then
  POLKIT_PKG="${POLKIT_PKG:-polkitd}"
fi

if [[ -n "${POLKIT_PKG}" && "${NET_OK}" -eq 1 ]]; then
  ensure_pkg "${POLKIT_PKG}"
  log "✓ Paquete Polkit seleccionado: ${POLKIT_PKG}"
elif [[ -n "${POLKIT_PKG}" ]]; then
  log "✓ Paquete Polkit detectado: ${POLKIT_PKG}"
else
  warn "No se encontró paquete Polkit disponible en apt-cache"
fi

STARTX_BIN="$(command -v startx || command -v xinit || true)"
if [[ -z "${STARTX_BIN}" ]]; then
  fail "Falta startx/xinit tras la instalación"
fi
log "✓ Binario X detectado: ${STARTX_BIN}"

if ! command -v openbox >/dev/null 2>&1; then
  fail "Falta openbox tras la instalación"
fi

CHROME_BIN="$(command -v chromium || command -v chromium-browser || true)"
if [[ -z "${CHROME_BIN}" ]]; then
  fail "Falta Chromium tras la instalación"
fi
log "✓ Binario Chromium detectado: ${CHROME_BIN}"

log "Configurando GPIO para HX711 y persistencia de báscula..."
if [[ "${NET_OK}" -eq 1 ]]; then
  ensure_pkg python3-lgpio
else
  warn "Sin red: instala python3-lgpio manualmente para habilitar el backend lgpio"
fi

if [[ "${NET_OK}" -eq 1 ]]; then
  if apt_candidate_exists python3-pigpio; then
    ensure_pkg python3-pigpio
  else
    log "python3-pigpio no disponible en apt-cache; se omite instalación"
  fi
  if apt_candidate_exists pigpiod; then
    ensure_pkg pigpiod
  else
    log "pigpiod no disponible en apt-cache; se omite instalación"
  fi
else
  log "Sin red: omitiendo instalación opcional de python3-pigpio/pigpiod"
fi

PIGPIOD_SERVICE_FILE=""
for candidate in /lib/systemd/system/pigpiod.service /etc/systemd/system/pigpiod.service; do
  if [[ -f "${candidate}" ]]; then
    PIGPIOD_SERVICE_FILE="${candidate}"
    break
  fi
done

if [[ -n "${PIGPIOD_SERVICE_FILE}" ]]; then
  log "Servicio pigpiod detectado; habilitando si es posible"
  systemctl_safe enable pigpiod
  systemctl_safe start pigpiod
else
  log "Servicio pigpiod no disponible; se omite enable/start"
fi

if getent group pigpio >/dev/null 2>&1; then
  ensure_user_in_group "${TARGET_USER}" pigpio
else
  log "Grupo pigpio no encontrado; se omite adición de ${TARGET_USER}"
fi

mkdir -p "${STATE_DIR}"
chown "${TARGET_USER}:${TARGET_GROUP}" "${STATE_DIR}" 2>/dev/null || true
if [[ ! -f "${STATE_FILE}" ]]; then
  cat > "${STATE_FILE}" <<'EOF'
{
  "calibration_factor": 1.0,
  "tare_offset": 0.0
}
EOF
  log "Archivo de estado de báscula inicializado en ${STATE_FILE}"
fi
chmod 664 "${STATE_FILE}" 2>/dev/null || true
chown "${TARGET_USER}:${TARGET_GROUP}" "${STATE_FILE}" 2>/dev/null || true

mkdir -p "${LOG_DIR}"
touch "${LOG_DIR}/app.log"
chown "${TARGET_USER}:${TARGET_GROUP}" "${LOG_DIR}" 2>/dev/null || true
chown "${TARGET_USER}:${TARGET_GROUP}" "${LOG_DIR}/app.log" 2>/dev/null || true
chmod 664 "${LOG_DIR}/app.log" 2>/dev/null || true

# Ensure NetworkManager service is enabled and running
log "[3a/20] Reinstalando NetworkManager..."
if [[ "${NET_OK}" -eq 1 ]]; then
    if ! apt-get install -y network-manager; then
        warn "No se pudo reinstalar NetworkManager"
    fi
else
    warn "Sin red: omitiendo reinstalación de NetworkManager"
fi
systemctl_safe enable NetworkManager --now
systemctl_safe enable NetworkManager-wait-online.service

NM_WAIT_OVERRIDE_DIR="/etc/systemd/system/NetworkManager-wait-online.service.d"
NM_WAIT_OVERRIDE_FILE="${NM_WAIT_OVERRIDE_DIR}/override.conf"
if install -d -m 0755 "${NM_WAIT_OVERRIDE_DIR}"; then
  if [[ -f "${NM_WAIT_OVERRIDE_FILE}" ]]; then
    TMP_OVERRIDE_FILE="$(mktemp)"
    awk '
      BEGIN {
        section=""
        service_written=0
      }
      /^\[.*\]$/ {
        section=$0
        print
        if (section == "[Service]" && service_written == 0) {
          print "ExecStart="
          print "ExecStart=/usr/lib/NetworkManager/NetworkManager-wait-online --timeout=10"
          service_written=1
        }
        next
      }
      {
        if (section == "[Service]" && ($0 ~ /^ExecStart=/ || $0 ~ /^TimeoutStartSec=/)) {
          next
        }
        print
      }
      END {
        if (service_written == 0) {
          print "[Service]"
          print "ExecStart="
          print "ExecStart=/usr/lib/NetworkManager/NetworkManager-wait-online --timeout=10"
        }
      }
    ' "${NM_WAIT_OVERRIDE_FILE}" > "${TMP_OVERRIDE_FILE}"
    mv "${TMP_OVERRIDE_FILE}" "${NM_WAIT_OVERRIDE_FILE}"
  else
    cat > "${NM_WAIT_OVERRIDE_FILE}" <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/lib/NetworkManager/NetworkManager-wait-online --timeout=10
EOF
  fi
  printf '[install] Set NetworkManager-wait-online timeout to 10s\n'
else
  warn "No se pudo crear ${NM_WAIT_OVERRIDE_DIR}"
fi
systemctl_safe daemon-reload

# Install camera dependencies
log "[4/20] Instalando dependencias de cámara..."
if [[ "${NET_OK}" -eq 1 ]]; then
    if apt-get install -y libcamera-apps v4l-utils python3-picamera2 \
        python3-libcamera libcamera-ipa python3-opencv; then
        log "✓ Dependencias de cámara instaladas"
    else
        warn "No se pudieron instalar todas las dependencias de cámara"
    fi
else
    warn "Sin red: omitiendo dependencias de cámara"
fi

# Install Node.js
log "[5/20] Instalando Node.js..."
if ! command -v node &> /dev/null; then
    if [[ "${NET_OK}" -eq 1 ]]; then
        if curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; then
            if apt-get install -y nodejs; then
                log "✓ Node.js $(node --version) instalado"
            else
                warn "No se pudo instalar Node.js"
            fi
        else
            warn "No se pudo descargar el instalador de NodeSource"
        fi
    else
        warn "Sin red: omitiendo instalación de Node.js"
    fi
else
    log "✓ Node.js $(node --version) instalado"
fi

# Configure hardware permissions
log "[6/20] Configurando permisos de hardware..."
HARDWARE_GROUPS=(video render input dialout i2c gpio audio netdev)
for grp in "${HARDWARE_GROUPS[@]}"; do
  if getent group "${grp}" >/dev/null 2>&1; then
    usermod -aG "${grp}" "${TARGET_USER}" || warn "No se pudo añadir ${TARGET_USER} al grupo ${grp}"
  else
    warn "Grupo ${grp} no existe en el sistema; omitiendo"
  fi
done
log "✓ Usuario ${TARGET_USER} añadido a grupos disponibles"

# Garantiza acceso a UART para usuario pi
ensure_user_in_group "pi" "dialout"

# Configure boot config
log "[7/20] Configurando boot/config.txt..."

if [[ ! -f "${CONF}" ]]; then
  warn "No se encontró ${CONF}; omitiendo configuración de arranque"
elif [[ "${SKIP_HARDWARE_CONFIG:-0}" == "1" ]]; then
  warn "SKIP_HARDWARE_CONFIG=1, saltando modificación de config.txt"
elif grep -qi "raspberry pi" /proc/device-tree/model 2>/dev/null; then
  if ! configure_pi_boot_hardware; then
    warn "No se pudo completar la autoconfiguración de hardware"
  fi
else
  warn "Equipo no identificado como Raspberry Pi; omitiendo autoconfiguración de hardware"
fi

ensure_enable_uart "${CONF}"

# Disable Bluetooth UART
if [[ "${HAS_SYSTEMD}" -eq 1 ]]; then
  if systemctl list-unit-files | grep -q '^hciuart.service'; then
    systemctl disable --now hciuart 2>/dev/null || warn "No se pudo deshabilitar hciuart"
  else
    log "hciuart.service no existe; nada que deshabilitar"
  fi
else
  warn "systemd no disponible: hciuart no puede deshabilitarse en esta sesión"
fi
systemctl_safe disable --now serial-getty@ttyAMA0.service
systemctl_safe disable --now serial-getty@ttyS0.service

# Run fix-serial script
log "Ejecutando fix-serial.sh..."
bash "${SCRIPT_DIR}/fix-serial.sh" || warn "fix-serial.sh falló, continuar de todos modos"
log "✓ Serial configurado"

# Configure Xwrapper
log "[8/20] Configurando Xwrapper..."
for config in /etc/Xwrapper.config /etc/X11/Xwrapper.config; do
    install -D -m 0644 /dev/null "${config}"
    cat > "${config}" <<'EOF'
allowed_users=anybody
needs_root_rights=yes
EOF
done
if [[ -f /usr/lib/xorg/Xorg ]]; then
  chown root:root /usr/lib/xorg/Xorg || warn "No se pudo ajustar propietario de Xorg"
  chmod 4755 /usr/lib/xorg/Xorg || warn "No se pudo ajustar permisos de Xorg"
else
  warn "/usr/lib/xorg/Xorg no existe; omitiendo ajustes de permisos"
fi
echo "xserver-xorg-legacy xserver-xorg-legacy/allowed_users select Anybody" | debconf-set-selections
DEBIAN_FRONTEND=noninteractive dpkg-reconfigure xserver-xorg-legacy || true
log "✓ Xwrapper configurado"

# Configure Xorg to use KMS/modesetting instead of fbdev
log "[8b/20] Configurando Xorg para KMS (modesetting driver)..."
# Remove fbdev driver if installed to prevent framebuffer mode
apt-get purge -y xserver-xorg-video-fbdev 2>/dev/null || true
apt-get autoremove -y || true

# Remove any fbdev config files
rm -f /usr/share/X11/xorg.conf.d/*fbdev*.conf /etc/X11/xorg.conf.d/*fbdev*.conf 2>/dev/null || true

# Force modesetting driver (KMS/DRM) for Raspberry Pi 5
install -d -m 0755 /etc/X11/xorg.conf.d
cat > /etc/X11/xorg.conf.d/10-modesetting.conf <<'EOF'
Section "Device"
  Identifier "Modesetting"
  Driver "modesetting"
  Option "AccelMethod" "glamor"
EndSection
EOF

log "✓ Xorg configurado para KMS (modesetting)"

# Configure Xorg to use correct DRM card (vc4 = card1)
log "[8c/20] Configurando Xorg para usar card1 (vc4)..."
cat > /etc/X11/xorg.conf.d/10-modesetting.conf <<'EOF'
Section "Device"
  Identifier "vc4"
  Driver "modesetting"
  Option "AccelMethod" "glamor"
  Option "kmsdev" "/dev/dri/card1"
EndSection

Section "Screen"
  Identifier "Screen0"
  Device "vc4"
EndSection
EOF
log "✓ Xorg configurado para DRM card1"

# Configure Polkit rules
log "[9/20] Configurando Polkit..."
install -d -m 0755 /etc/polkit-1/rules.d

ensure_user_in_group "${TARGET_USER}" netdev
if [[ "${TARGET_USER}" != "pi" ]]; then
  ensure_user_in_group pi netdev
fi

POLKIT_RULE_SRC="${PROJECT_ROOT}/packaging/polkit/49-nmcli.rules"
if [[ -f "${POLKIT_RULE_SRC}" ]]; then
  install -m 0644 "${POLKIT_RULE_SRC}" /etc/polkit-1/rules.d/49-nmcli.rules
else
  warn "No se encontró ${POLKIT_RULE_SRC}; creando regla básica"
  install -m 0644 /dev/null /etc/polkit-1/rules.d/49-nmcli.rules
    cat > /etc/polkit-1/rules.d/49-nmcli.rules <<'EOF'
polkit.addRule(function(action, subject) {
  if (subject.isInGroup("netdev") || subject.user == "pi") {
    if (action.id == "org.freedesktop.NetworkManager.settings.modify.system") {
      return polkit.Result.YES;
    }
    if (action.id == "org.freedesktop.NetworkManager.settings.modify.own") {
      return polkit.Result.YES;
    }
    if (action.id == "org.freedesktop.NetworkManager.network-control") {
      return polkit.Result.YES;
    }
    if (action.id == "org.freedesktop.NetworkManager.wifi.scan") {
      return polkit.Result.YES;
    }
    if (action.id == "org.freedesktop.NetworkManager.enable-disable-wifi") {
      return polkit.Result.YES;
    }
  }
});
EOF
fi

cat > /etc/polkit-1/rules.d/51-bascula-systemd.rules <<EOF
polkit.addRule(function(action, subject) {
  var id = action.id;
  var unit = action.lookup("unit") || "";
  function allowed(u) {
    return u == "bascula-miniweb.service" || u == "bascula-app.service" || u == "ocr-service.service";
  }
  if ((subject.user == "${TARGET_USER}" || subject.isInGroup("${TARGET_GROUP}")) &&
      (id == "org.freedesktop.systemd1.manage-units" ||
       id == "org.freedesktop.systemd1.restart-unit" ||
       id == "org.freedesktop.systemd1.start-unit" ||
       id == "org.freedesktop.systemd1.stop-unit") &&
      allowed(unit)) {
    return polkit.Result.YES;
  }
});
EOF

if id -u pi >/dev/null 2>&1 && ! id -nG pi | tr ' ' '\n' | grep -qw netdev; then
  fail "pi no pertenece a netdev tras la instalación"
fi

if [[ -f /etc/polkit-1/rules.d/49-nmcli.rules ]]; then
  log "Regla Polkit 49-nmcli.rules instalada"
else
  fail "No se encontró /etc/polkit-1/rules.d/49-nmcli.rules"
fi

# === Bascula AP profile + polkit + recargas ===
set -e

# Instalar siempre la regla polkit (ya creada antes)
if [ -f system/os/10-bascula-nm.rules ]; then
  install -D -m 0644 system/os/10-bascula-nm.rules /etc/polkit-1/rules.d/10-bascula-nm.rules
else
  warn "No se encontró system/os/10-bascula-nm.rules; instalando regla básica"
  cat >/etc/polkit-1/rules.d/10-bascula-nm.rules <<'EOF'
polkit.addRule(function(action, subject) {
  if (subject.user === "pi") {
    if (action.id.startsWith("org.freedesktop.NetworkManager.")) {
      return polkit.Result.YES;
    }
    if (action.id.startsWith("org.freedesktop.NetworkManager.settings.")) {
      return polkit.Result.YES;
    }
  }
});
EOF
fi

# Configurar el perfil AP de provisión (persistente y estable)
if command -v nmcli >/dev/null 2>&1; then
  log "Asegurando perfil AP ${AP_NAME} (solo provisión)"

  rfkill unblock wifi || true
  nmcli radio wifi on || true

  install -d -m 0700 /etc/NetworkManager/system-connections
  target_ap_path="/etc/NetworkManager/system-connections/${AP_NAME}.nmconnection"

  ap_uuid=""
  if [[ -f "${target_ap_path}" ]]; then
    ap_uuid="$(awk -F= 'tolower($1)=="uuid"{print $2; exit}' "${target_ap_path}" | tr -d '[:space:]' || true)"
  fi
  if [[ -z "${ap_uuid}" ]]; then
    if command -v uuidgen >/dev/null 2>&1; then
      ap_uuid="$(uuidgen)"
    else
      ap_uuid="$(python3 -c 'import uuid; print(uuid.uuid4())')"
    fi
  fi

  tmp_ap_cfg="$(mktemp)"
  cat >"${tmp_ap_cfg}" <<EOF
[connection]
id=${AP_NAME}
uuid=${ap_uuid}
type=wifi
interface-name=${AP_IFACE}
autoconnect=false
autoconnect-priority=-999
autoconnect-retries=0
permissions=user:root

[wifi]
mode=ap
ssid=${AP_SSID}
band=bg
channel=1
hidden=true

[wifi-security]
key-mgmt=wpa-psk
psk=${AP_PASS}
proto=rsn
pmf=1

[ipv4]
method=shared
address1=${AP_GATEWAY}/24,${AP_GATEWAY}
never-default=true

[ipv6]
method=ignore
EOF
  install -m 0600 "${tmp_ap_cfg}" "${target_ap_path}"
  rm -f "${tmp_ap_cfg}"
  chmod 600 "${target_ap_path}" || warn "No se pudieron ajustar permisos de ${target_ap_path}"
  chown root:root "${target_ap_path}" || warn "No se pudo ajustar propietario de ${target_ap_path}"

  if ! nmcli connection reload >/dev/null 2>&1; then
    warn "No se pudo recargar conexiones NM tras actualizar ${AP_NAME}"
  fi

  if ! nmcli con load "${target_ap_path}" >/dev/null 2>&1; then
    warn "No se pudo cargar ${AP_NAME} desde ${target_ap_path}"
  fi

  nmcli con modify "${AP_NAME}" \
    connection.id "${AP_NAME}" \
    connection.interface-name "${AP_IFACE}" \
    connection.autoconnect no \
    connection.autoconnect-priority -999 \
    connection.autoconnect-retries 0 \
    connection.permissions "user:root" \
    802-11-wireless.mode ap \
    802-11-wireless.ssid "${AP_SSID}" \
    802-11-wireless.band bg \
    802-11-wireless.channel 1 \
    802-11-wireless.hidden yes \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.proto rsn \
    802-11-wireless-security.pmf 1 \
    wifi-sec.psk "${AP_PASS}" \
    ipv4.method shared \
    ipv4.addresses "${AP_GATEWAY}/24 ${AP_GATEWAY}" \
    ipv4.never-default yes \
    ipv6.method ignore >/dev/null 2>&1 || warn "No se pudieron fijar parámetros de ${AP_NAME}"

  while IFS=: read -r name uuid filename; do
    [[ "${name}" != "${AP_NAME}" ]] && continue
    [[ -z "${uuid}" ]] && continue
    [[ "${filename}" == "${target_ap_path}" ]] && continue
    nmcli con delete uuid "${uuid}" >/dev/null 2>&1 || true
  done < <(nmcli -t -f NAME,UUID,FILENAME con show 2>/dev/null || true)

  if [[ "${HAS_SYSTEMD}" -eq 1 ]]; then
    systemctl disable --now dnsmasq 2>/dev/null || true
  fi

  verify_line="$(nmcli -t -f NAME,AUTOCONNECT,AUTOCONNECT-PRIORITY,FILENAME con show 2>/dev/null | grep "^${AP_NAME}:" || true)"
  if [[ -n "${verify_line}" ]]; then
    log "[inst] BasculaAP verificada: ${verify_line}"
  else
    warn "No se pudo verificar BasculaAP en la salida de nmcli"
  fi
else
  warn "nmcli no disponible; no se pudo configurar ${AP_NAME}"
fi

WPA_SUPP_CONF="/etc/wpa_supplicant/wpa_supplicant.conf"
if [[ -f "${WPA_SUPP_CONF}" ]] && grep -qE '^\s*network=' "${WPA_SUPP_CONF}"; then
  BACKUP_PATH="${WPA_SUPP_CONF}.preinstall"
  if [[ ! -f "${BACKUP_PATH}" ]]; then
    cp "${WPA_SUPP_CONF}" "${BACKUP_PATH}" || warn "No se pudo crear copia de ${WPA_SUPP_CONF}"
  fi
  SOURCE_PATH="${BACKUP_PATH}"
  [[ -f "${SOURCE_PATH}" ]] || SOURCE_PATH="${WPA_SUPP_CONF}"
  log "Limpiando redes preconfiguradas en ${WPA_SUPP_CONF}"
  awk 'BEGIN{network_seen=0} {if($0 ~ /^\s*network=/){network_seen=1;exit} print}' "${SOURCE_PATH}" >"${WPA_SUPP_CONF}" || true
  cat >>"${WPA_SUPP_CONF}" <<'EOF'

# Redes Wi-Fi preconfiguradas eliminadas por el instalador de Báscula
# Añade nuevas redes mediante la interfaz de usuario.
EOF
  chmod 600 "${WPA_SUPP_CONF}" || true
fi

if [[ -f "${WPA_SUPP_CONF}" ]]; then
  if ! grep -qE '^\s*country=ES\b' "${WPA_SUPP_CONF}"; then
    if grep -qE '^\s*country=' "${WPA_SUPP_CONF}"; then
      if sed -i 's/^\s*country=.*/country=ES/' "${WPA_SUPP_CONF}"; then
        log "Actualizado country=ES en ${WPA_SUPP_CONF}"
      else
        warn "No se pudo actualizar la directiva country en ${WPA_SUPP_CONF}"
      fi
    else
      if sed -i '1icountry=ES' "${WPA_SUPP_CONF}"; then
        log "Añadido country=ES a ${WPA_SUPP_CONF}"
      else
        warn "No se pudo añadir country=ES a ${WPA_SUPP_CONF}"
      fi
    fi
  fi
fi

# Si hay systemd, recargar polkit/NM
if [[ "${HAS_SYSTEMD}" -eq 1 ]]; then
  systemctl list-unit-files | grep -q '^polkit\.service' && systemctl reload polkit || true
  systemctl list-unit-files | grep -q '^NetworkManager\.service' && systemctl reload NetworkManager || true
else
  warn "systemd no disponible: omitiendo recarga de polkit y NetworkManager"
fi

# Nota: La UI, al conectar a una nueva Wi-Fi, deberá:
#  - crear/actualizar esa conexión con autoconnect=yes y prioridad 120
#  - mantener BasculaAP con autoconnect=no (para no competir)

if command -v nmcli >/dev/null 2>&1; then
  while IFS= read -r PRECONF_UUID; do
    [[ -z "${PRECONF_UUID}" ]] && continue
    NAME=$(nmcli -g connection.id connection show "${PRECONF_UUID}" 2>/dev/null || true)
    if [[ -n "${NAME}" && "${NAME,,}" == *preconfig* ]]; then
      log "Eliminando perfil Wi-Fi preconfigurado: ${NAME}"
      nmcli connection delete "${PRECONF_UUID}" >/dev/null 2>&1 || true
    fi
  done < <(nmcli -t -f UUID connection show 2>/dev/null | sed 's/^UUID://')

  nmcli dev status || true
  nmcli -t -f NAME,AUTOCONNECT,AUTOCONNECT-PRIORITY,FILENAME con show | grep -E 'BasculaAP|802-11-wireless' || true
fi

if ! nmcli general status >/dev/null 2>&1; then
  err "ERR: nmcli no responde"
  exit 1
fi

if ! runuser -l "${TARGET_USER}" -c "nmcli device wifi list" >/dev/null 2>&1; then
  fail "nmcli device wifi list falló para ${TARGET_USER} sin sudo"
fi
log "✓ nmcli usable sin sudo para ${TARGET_USER}"

log "Chequeos rápidos de nmcli (PolicyKit)..."
set +e
__nmcli_wifi_status_output="$(nmcli -t -f WIFI general status 2>&1)"
__nmcli_wifi_status_rc=$?
set -e
if [[ ${__nmcli_wifi_status_rc} -ne 0 ]]; then
  if printf '%s' "${__nmcli_wifi_status_output}" | grep -qiE "(not authorized|access denied|permission denied)"; then
    fail "PolicyKit denegó 'nmcli -t -f WIFI general status': ${__nmcli_wifi_status_output}"
  else
    warn "nmcli WIFI status devolvió código ${__nmcli_wifi_status_rc}: ${__nmcli_wifi_status_output}"
  fi
else
  log "nmcli WIFI status: ${__nmcli_wifi_status_output}"
fi

set +e
__nmcli_wifi_list_output="$(nmcli -t -f SSID,SECURITY,SIGNAL device wifi list ifname wlan0 --rescan yes 2>&1)"
__nmcli_wifi_list_rc=$?
set -e
if [[ ${__nmcli_wifi_list_rc} -ne 0 ]]; then
  if printf '%s' "${__nmcli_wifi_list_output}" | grep -qiE "(not authorized|access denied|permission denied)"; then
    fail "PolicyKit denegó 'nmcli device wifi list': ${__nmcli_wifi_list_output}"
  else
    warn "nmcli device wifi list devolvió código ${__nmcli_wifi_list_rc}: ${__nmcli_wifi_list_output}"
  fi
else
  log "Listado Wi-Fi detectado correctamente"
fi

log "✓ Polkit configurado"

# Create config.json
log "[10/20] Creando configuración por defecto..."
install -d -m 0755 -o "${TARGET_USER}" -g "${TARGET_GROUP}" "${CFG_DIR}"
if [[ ! -s "${CFG_PATH}" ]]; then
  cat > "${CFG_PATH}" <<'PY'
{
  "general": {
    "sound_enabled": true,
    "volume": 70,
    "tts_enabled": true
  },
  "scale": {
    "port": "/dev/serial0",
    "baud": 115200,
    "hx711_dt": 5,
    "hx711_sck": 6,
    "calib_factor": 1.0,
    "smoothing": 5,
    "decimals": 0,
    "unit": "g",
    "ml_factor": 1.0
  },
  "network": {
    "miniweb_enabled": true,
    "miniweb_port": 8080,
    "miniweb_pin": ""
  },
  "diabetes": {
    "diabetes_enabled": false,
    "ns_url": "",
    "ns_token": "",
    "hypo_alarm": 70,
    "hyper_alarm": 180,
    "mode_15_15": false,
    "insulin_ratio": 12.0,
    "insulin_sensitivity": 50.0,
    "target_glucose": 110
  },
  "audio": {
    "audio_device": "default"
  }
}
PY
  chown "${TARGET_USER}:${TARGET_GROUP}" "${CFG_PATH}" || true
fi
log "✓ Configuración creada en ${CFG_PATH}"

# OTA: Setup release directory structure
log "[11/20] Configurando estructura OTA..."
install -d -m 0755 "${BASCULA_RELEASES_DIR}"
if [[ ! -e "${BASCULA_CURRENT_LINK}" ]]; then
  DEST="${BASCULA_RELEASES_DIR}/v1"
  log "Copiando proyecto a ${DEST}..."
  install -d -m 0755 "${DEST}"
  (cd "${PROJECT_ROOT}" && tar --exclude .git --exclude .venv --exclude __pycache__ --exclude '*.pyc' --exclude node_modules -cf - .) | tar -xf - -C "${DEST}"
  ln -s "${DEST}" "${BASCULA_CURRENT_LINK}"
  log "✓ Release v1 creado"
fi
chown -R "${TARGET_USER}:${TARGET_GROUP}" "${BASCULA_ROOT}"
log "✓ Estructura OTA configurada"

# Setup Python virtual environment
log "[12/20] Configurando entorno Python..."
cd "${BASCULA_CURRENT_LINK}"
if [[ ! -d ".venv" ]]; then
  python3 -m venv .venv
fi
VENV_DIR="${BASCULA_CURRENT_LINK}/.venv"
VENV_PY="${VENV_DIR}/bin/python"
VENV_PIP="${VENV_DIR}/bin/pip"

# Allow venv to see system packages (picamera2)
VENV_SITE="$(${VENV_PY} -c 'import sysconfig; print(sysconfig.get_paths().get("purelib"))')"
if [ -n "${VENV_SITE}" ] && [ -d "${VENV_SITE}" ]; then
  echo "/usr/lib/python3/dist-packages" > "${VENV_SITE}/system_dist.pth"
fi

export PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_ROOT_USER_ACTION=ignore PIP_PREFER_BINARY=1
export PIP_INDEX_URL="https://www.piwheels.org/simple"
export PIP_EXTRA_INDEX_URL="https://pypi.org/simple"

if [[ "${NET_OK}" -eq 1 ]]; then
  if ! ${VENV_PIP} install --upgrade pip wheel setuptools; then
    warn "No se pudo actualizar pip/wheel/setuptools"
  fi
  if ! ${VENV_PIP} install fastapi 'uvicorn[standard]' websockets python-multipart \
    pyserial opencv-python pillow pyzbar numpy aiofiles httpx \
    pytesseract rapidocr-onnxruntime; then
    warn "No se pudieron instalar todas las dependencias de Python"
  fi
else
  warn "Sin red: omitiendo instalación de dependencias Python"
fi

log "✓ Entorno Python configurado"

# Install Piper TTS
log "[13/20] Instalando Piper TTS..."
install -d -m 0755 /opt/piper/models /opt/piper/bin
if ! command -v piper >/dev/null 2>&1; then
  PIPER_BIN_URL=""
  case "${ARCH}" in
    aarch64) PIPER_BIN_URL="https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_aarch64.tar.gz" ;;
    armv7l) PIPER_BIN_URL="https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_armv7l.tar.gz" ;;
  esac
  if [[ -n "${PIPER_BIN_URL}" && "${NET_OK}" = "1" ]]; then
    TMP_TGZ="/tmp/piper_bin_$$.tgz"
    if curl -fL --retry 2 -m 20 -o "${TMP_TGZ}" "${PIPER_BIN_URL}" 2>/dev/null; then
      tar -xzf "${TMP_TGZ}" -C /opt/piper/bin || true
      rm -f "${TMP_TGZ}" || true
      F_BIN="$(find /opt/piper/bin -maxdepth 2 -type f -name 'piper' | head -n1)"
      if [[ -n "${F_BIN}" ]]; then
        chmod +x "${F_BIN}" || true
        ln -sf "${F_BIN}" /usr/local/bin/piper || true
      fi
    fi
  fi
fi

# Download Spanish voice models
VOICE_DIR="/opt/bascula/voices"
install -d -m 0755 "${VOICE_DIR}"

voices=(
  "es_ES-carlfm-x_low.onnx"
  "es_ES-carlfm-x_low.onnx.json"
  "es_ES-davefx-medium.onnx"
  "es_ES-davefx-medium.onnx.json"
  "es_ES-sharvard-medium.onnx"
  "es_ES-sharvard-medium.onnx.json"
)

VOICE_BASE_URL="https://github.com/DanielGTdiabetes/bascula-cam/releases/download/voices-v1"

for voice in "${voices[@]}"; do
  dest="${VOICE_DIR}/${voice}"
  if [[ -s "${dest}" ]]; then
    log "[info] Voz ${voice} ya instalada"
    continue
  fi
  if [[ "${NET_OK}" != "1" ]]; then
    warn "Sin red: omitiendo descarga de ${voice}"
    continue
  fi
  log "Descargando voz: ${voice}"
  if wget -q --show-progress -O "${dest}.tmp" "${VOICE_BASE_URL}/${voice}"; then
    mv "${dest}.tmp" "${dest}"
  else
    rm -f "${dest}.tmp"
    warn "No se pudo descargar ${voice} (saltando)"
  fi
done

# Create say.sh wrapper
cat > /usr/local/bin/say.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
TEXT="${*:-Prueba de voz}"
VOICE="${PIPER_VOICE:-es_ES-mls_10246-medium}"
MODEL="/opt/piper/models/${VOICE}.onnx"
CONFIG="/opt/piper/models/${VOICE}.onnx.json"
BIN="$(command -v piper || echo "/opt/piper/bin/piper")"

if [[ -x "${BIN}" && -f "${MODEL}" && -f "${CONFIG}" ]]; then
  echo -n "${TEXT}" | "${BIN}" -m "${MODEL}" -c "${CONFIG}" --length-scale 1.0 --noise-scale 0.5 | aplay -q -r 22050 -f S16_LE -t raw -
else
  espeak-ng -v es -s 170 "${TEXT}" >/dev/null 2>&1 || true
fi
EOF
chmod 0755 /usr/local/bin/say.sh
log "✓ Piper TTS instalado"

install_x735

# Setup OCR service
log "[14/20] Configurando servicio OCR..."
install -d -m 0755 /opt/ocr-service
cat > /opt/ocr-service/app.py <<'PY'
import io
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse, PlainTextResponse
from PIL import Image
import pytesseract

app = FastAPI(title="OCR Service", version="1.0")

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.get("/")
async def root():
    return PlainTextResponse("ok")

@app.post("/ocr")
async def ocr_endpoint(file: UploadFile = File(...), lang: str = Form("spa")):
    try:
        data = await file.read()
        img = Image.open(io.BytesIO(data))
        txt = pytesseract.image_to_string(img, lang=lang)
        return JSONResponse({"ok": True, "text": txt})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
PY

cat > /etc/systemd/system/ocr-service.service <<EOF
[Unit]
Description=Bascula OCR Service
After=network.target

[Service]
Type=simple
User=${TARGET_USER}
Group=${TARGET_GROUP}
WorkingDirectory=/opt/ocr-service
ExecStart=${VENV_DIR}/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8078
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl_safe daemon-reload
systemctl_safe enable ocr-service.service
systemctl_safe restart ocr-service.service
log "✓ Servicio OCR configurado"

# Setup Frontend (build if node_modules exists)
log "[15/20] Configurando frontend..."
cd "${BASCULA_CURRENT_LINK}"
if [[ -f "package.json" ]]; then
  if [[ -f ".env.device" ]]; then
    cp -f .env.device .env
  fi
  npm install || warn "npm install falló, continuar con backend"
  if command -v node >/dev/null 2>&1; then
    if ! node scripts/generate-service-worker.mjs; then
      warn "No se pudo generar service worker"
    fi
  else
    warn "Node.js no disponible para generar service worker"
  fi
  npm run build || warn "npm build falló"
  log "✓ Frontend compilado"
fi

# Install and configure Nginx
log "[16/20] Instalando y configurando Nginx..."
if [[ "${NET_OK}" -eq 1 ]]; then
  if ! apt-get install -y nginx; then
    warn "No se pudo instalar Nginx"
  fi
else
  warn "Sin red: omitiendo instalación de Nginx"
fi
systemctl_safe enable nginx
install -d -m 0755 /etc/nginx/sites-available /etc/nginx/sites-enabled
cat > /etc/nginx/sites-available/bascula <<EOF
server {
    listen 80 default_server;
    server_name _;
    root ${BASCULA_CURRENT_LINK}/dist;
    index index.html;

    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location /api {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }

    location /ws {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
    }
}
EOF
ln -sf /etc/nginx/sites-available/bascula /etc/nginx/sites-enabled/bascula
rm -f /etc/nginx/sites-enabled/default
nginx -t || warn "Configuración de Nginx con errores"
systemctl_safe restart nginx
systemctl_safe enable nginx
log "✓ Nginx configurado"

# Create mini-web backend service
log "[17/20] Configurando servicio mini-web..."
install -d -m 0755 -o "${TARGET_USER}" -g "${TARGET_GROUP}" "${CFG_DIR}"

SYSTEMD_SRC="${PROJECT_ROOT}/packaging/systemd/bascula-miniweb.service"
if [[ ! -f "${SYSTEMD_SRC}" ]]; then
  err "No se encontró ${SYSTEMD_SRC}"
  exit 1
fi

install -m 0644 "${SYSTEMD_SRC}" /etc/systemd/system/bascula-miniweb.service
log "✓ Mini-web backend configurado"

# Install AP ensure service and script
log "[17a/20] Configurando servicio de arranque de AP..."
AP_ENSURE_SERVICE_INSTALLED=0

AP_ENSURE_SCRIPT_SRC="${PROJECT_ROOT}/scripts/bascula-ap-ensure.sh"
AP_ENSURE_SCRIPT_DST="${BASCULA_CURRENT_LINK}/scripts/bascula-ap-ensure.sh"
if [[ -f "${AP_ENSURE_SCRIPT_SRC}" ]]; then
  install -d "${BASCULA_CURRENT_LINK}/scripts"
  safe_install "${AP_ENSURE_SCRIPT_SRC}" "${AP_ENSURE_SCRIPT_DST}"
  chown "${TARGET_USER}:${TARGET_GROUP}" "${AP_ENSURE_SCRIPT_DST}" || true
  log "✓ Script bascula-ap-ensure.sh desplegado en ${AP_ENSURE_SCRIPT_DST}"
else
  warn "No se encontró scripts/bascula-ap-ensure.sh"
fi

install -d /etc/systemd/system
if [[ -f "${PROJECT_ROOT}/systemd/bascula-ap-ensure.service" ]]; then
  install -m 0644 "${PROJECT_ROOT}/systemd/bascula-ap-ensure.service" /etc/systemd/system/bascula-ap-ensure.service
  AP_ENSURE_SERVICE_INSTALLED=1
elif [[ -f "${PROJECT_ROOT}/system/os/bascula-ap-ensure.service" ]]; then
  warn "Usando servicio heredado de system/os/"
  install -m 0644 "${PROJECT_ROOT}/system/os/bascula-ap-ensure.service" /etc/systemd/system/bascula-ap-ensure.service
  AP_ENSURE_SERVICE_INSTALLED=1
else
  warn "No se encontró definición de servicio bascula-ap-ensure"
fi

if [[ "${HAS_SYSTEMD}" -eq 1 ]]; then
  if ! systemctl daemon-reload; then
    warn "systemctl daemon-reload falló"
  fi
  systemctl disable --now bascula-ap-ensure.timer 2>/dev/null || true
  if [[ "${AP_ENSURE_SERVICE_INSTALLED}" -eq 1 ]]; then
    if systemctl enable --now bascula-ap-ensure.service bascula-miniweb.service; then
      log "✓ Servicios bascula-ap-ensure y bascula-miniweb habilitados"
    else
      warn "No se pudieron habilitar bascula-ap-ensure/bascula-miniweb"
      systemctl status bascula-ap-ensure.service --no-pager || true
      systemctl status bascula-miniweb.service --no-pager || true
    fi
  else
    warn "Servicio bascula-ap-ensure no instalado; habilitando solo bascula-miniweb"
    if systemctl enable --now bascula-miniweb.service; then
      log "✓ Servicio bascula-miniweb habilitado"
    else
      warn "No se pudo habilitar bascula-miniweb.service"
      systemctl status bascula-miniweb.service --no-pager || true
    fi
  fi
else
  warn "systemd no disponible: BasculaAP dependerá de connection.autoconnect"
fi

# Setup UI kiosk service
log "[18/20] Configurando servicio UI kiosk..."

# Copiar .xinitrc del proyecto al home del usuario
if [[ -f "${BASCULA_CURRENT_LINK}/.xinitrc" ]]; then
  cp "${BASCULA_CURRENT_LINK}/.xinitrc" "${TARGET_HOME}/.xinitrc"
  chmod +x "${TARGET_HOME}/.xinitrc"
  chown "${TARGET_USER}:${TARGET_GROUP}" "${TARGET_HOME}/.xinitrc"
  log "✓ .xinitrc copiado desde el proyecto"
else
  warn ".xinitrc no encontrado en el proyecto, creando uno básico"
  cat > "${TARGET_HOME}/.xinitrc" <<EOF
#!/bin/sh
set -e
xset s off
xset -dpms
xset s noblank
unclutter -idle 0.5 -root &
openbox &
sleep 2
CHROME_BIN="\$(command -v ${CHROME_PKG} 2>/dev/null || command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || printf '%s' '${CHROME_BIN}')"
exec "\${CHROME_BIN}" \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --enable-features=OverlayScrollbar \
  --disable-translate \
  --disable-features=TranslateUI \
  --disk-cache-dir=/dev/null \
  --overscroll-history-navigation=0 \
  --disable-pinch \
  --check-for-update-interval=31536000 \
  http://localhost:8080
EOF
  chmod +x "${TARGET_HOME}/.xinitrc"
  chown "${TARGET_USER}:${TARGET_GROUP}" "${TARGET_HOME}/.xinitrc"
fi

# Determinar binario startx/xinit disponible
if [[ -z "${STARTX_BIN}" ]]; then
  STARTX_BIN="$(command -v startx || command -v xinit || true)"
fi
if [[ -z "${STARTX_BIN}" ]]; then
  fail "No se encontró startx/xinit"
fi

if [[ "${STARTX_BIN##*/}" == "startx" ]]; then
  STARTX_CMD="${STARTX_BIN} -- :0 vt1"
else
  STARTX_CMD="${STARTX_BIN} ${TARGET_HOME}/.xinitrc -- :0 vt1"
fi

# Crear servicio systemd usando el archivo del proyecto o uno por defecto
SERVICE_FILE="${BASCULA_CURRENT_LINK}/systemd/bascula-ui.service"
if [[ -f "${SERVICE_FILE}" ]]; then
  # Usar el servicio del proyecto reemplazando las variables
  TMP_SERVICE_FILE="$(mktemp)"
  sed -e "s|/home/pi|${TARGET_HOME}|g" \
      -e "s|User=pi|User=${TARGET_USER}|g" \
      -e "s|Group=pi|Group=${TARGET_GROUP}|g" \
      -e "s|/home/pi/bascula-ui|${BASCULA_CURRENT_LINK}|g" \
      "${SERVICE_FILE}" > "${TMP_SERVICE_FILE}"

  if grep -q '^After=' "${TMP_SERVICE_FILE}"; then
    if ! grep -q '^After=.*NetworkManager\.service' "${TMP_SERVICE_FILE}"; then
      sed -i 's/^After=\(.*\)$/After=\1 NetworkManager.service/' "${TMP_SERVICE_FILE}"
    fi
  else
    sed -i '/^\[Unit\]/a After=NetworkManager.service' "${TMP_SERVICE_FILE}"
  fi

  if grep -q '^Wants=' "${TMP_SERVICE_FILE}"; then
    if ! grep -q '^Wants=.*NetworkManager\.service' "${TMP_SERVICE_FILE}"; then
      sed -i 's/^Wants=\(.*\)$/Wants=\1 NetworkManager.service/' "${TMP_SERVICE_FILE}"
    fi
  else
    sed -i '/^\[Unit\]/a Wants=NetworkManager.service' "${TMP_SERVICE_FILE}"
  fi

  mv "${TMP_SERVICE_FILE}" /etc/systemd/system/bascula-app.service
  log "✓ bascula-app.service copiado desde el proyecto"
  printf '[install] Updated bascula-app.service to remove network-online.target\n'
else
  cat > /etc/systemd/system/bascula-app.service <<EOF
[Unit]
Description=Bascula Digital Pro - UI (Xorg kiosk)
After=graphical.target systemd-user-sessions.service NetworkManager.service
Wants=NetworkManager.service
Conflicts=getty@tty1.service
StartLimitIntervalSec=120
StartLimitBurst=3

[Service]
Type=simple
User=${TARGET_USER}
Group=${TARGET_GROUP}
WorkingDirectory=${BASCULA_CURRENT_LINK}
Environment=HOME=${TARGET_HOME}
Environment=USER=${TARGET_USER}
Environment=XDG_RUNTIME_DIR=/run/user/$(id -u ${TARGET_USER})
PermissionsStartOnly=yes
ExecStartPre=/usr/bin/install -d -m 0755 -o ${TARGET_USER} -g ${TARGET_GROUP} /var/log/bascula
ExecStartPre=/usr/bin/install -o ${TARGET_USER} -g ${TARGET_GROUP} -m 0644 /dev/null /var/log/bascula/app.log
ExecStartPre=/usr/bin/install -d -m 0700 -o ${TARGET_USER} -g ${TARGET_GROUP} ${TARGET_HOME}/.local/share/xorg
ExecStartPre=/bin/bash -c 'for i in {1..5}; do [ -d /sys/class/net/wlan0 ] && exit 0; sleep 1; done; exit 0'
ExecStart=${STARTX_CMD}
Restart=on-failure
RestartSec=2
StandardOutput=journal
StandardError=journal
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes

[Install]
WantedBy=multi-user.target
EOF
  log "✓ bascula-app.service creado por defecto"
  printf '[install] Updated bascula-app.service to remove network-online.target\n'
fi

systemctl_safe daemon-reload
systemctl_safe disable getty@tty1.service
systemctl_safe enable bascula-app.service
log "✓ UI kiosk configurado"

# Setup tmpfiles
log "[19/20] Configurando tmpfiles..."
cat > /etc/tmpfiles.d/bascula.conf <<EOF
d /run/bascula 0755 ${TARGET_USER} ${TARGET_GROUP} -
f /run/bascula.alive 0666 ${TARGET_USER} ${TARGET_GROUP} -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/bascula.conf || true
log "✓ tmpfiles configurado"

# Final permissions
log "[20/20] Ajustando permisos finales..."
install -d -m 0755 -o "${TARGET_USER}" -g "${TARGET_GROUP}" /var/log/bascula
chown -R "${TARGET_USER}:${TARGET_GROUP}" "${BASCULA_ROOT}" /opt/ocr-service
log "✓ Permisos ajustados"

# Quick nmcli verification (logging only)
if command -v nmcli >/dev/null 2>&1; then
  log "Verificación rápida NetworkManager (no bloqueante)..."
  nmcli dev status || true
  nmcli -t -f NAME,TYPE,DEVICE con show || true
  nmcli -g connection.interface-name,802-11-wireless.mode,ipv4.method,ipv4.addresses,ipv4.gateway,ipv4.dns con show "${AP_NAME}" || true
else
  warn "nmcli no disponible para verificación rápida"
fi

# Final message
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
log "============================================"
log "  ¡Instalación Completada!"
log "============================================"
echo ""
echo -e "${GREEN}Sistema instalado con éxito:${NC}"
echo "  ✅ Estructura OTA en: ${BASCULA_CURRENT_LINK}"
echo "  ✅ Config en: ${CFG_PATH}"
echo "  ✅ Audio I2S + Piper TTS"
echo "  ✅ Camera Module 3 + OCR"
echo "  ✅ Nginx + Mini-web + UI kiosk"
echo ""
echo -e "${YELLOW}═══════════════════════════════════════════${NC}"
echo -e "${YELLOW}  ⚠ REINICIO REQUERIDO${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════${NC}"
echo ""
echo "  sudo reboot"
echo ""
echo "Después del reinicio, acceder a:"
echo "  http://${IP:-<IP>} o http://localhost"
echo "  Mini-Web: visita http://${IP:-<IP>}:8080 · PIN: consulta /api/miniweb/pin en AP o mira la pantalla"
echo ""
echo "Comandos útiles:"
echo "  journalctl -u bascula-miniweb.service -f"
echo "  journalctl -u bascula-app.service -f"
echo "  journalctl -u ocr-service.service -f"
echo "  journalctl -u x735-fan.service -f    # monitorear ventilador"
echo "  libcamera-hello  # probar cámara"
echo "  say.sh 'Hola'    # probar voz"
echo "  x735off          # apagar el sistema de forma segura"
echo ""
log "Instalación finalizada"
log "Backend de báscula predeterminado: UART (ESP32 en /dev/serial0)"
systemctl_safe status bascula-miniweb --no-pager -l
if command -v ss >/dev/null 2>&1; then
  ss -ltnp | grep 8080 || true
else
  warn "Herramienta 'ss' no disponible; omitiendo comprobación de puertos"
fi
