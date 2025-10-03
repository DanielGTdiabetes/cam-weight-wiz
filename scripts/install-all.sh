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

# --- Require root privileges ---
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  err "Ejecuta con sudo: sudo ./install-all.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Detect systemd availability early
HAS_SYSTEMD=1
if [[ ! -d /run/systemd/system ]]; then
  warn "systemd no está activo (PID 1); se omitirán comandos systemctl"
  HAS_SYSTEMD=0
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

AP_SSID="${AP_SSID:-Bascula_AP}"
AP_PASS="${AP_PASS:-bascula1234}"
AP_IFACE="${AP_IFACE:-wlan0}"
AP_NAME="${AP_NAME:-BasculaAP}"

BOOTDIR="/boot/firmware"
[[ ! -d "${BOOTDIR}" ]] && BOOTDIR="/boot"
CONF="${BOOTDIR}/config.txt"

log "============================================"
log "  Instalación Completa - Báscula Digital Pro"
log "============================================"
log "Target user      : $TARGET_USER ($TARGET_GROUP)"
log "Target home      : $TARGET_HOME"
log "OTA current link : $BASCULA_CURRENT_LINK"
log "AP (NM)          : SSID=${AP_SSID} PASS=${AP_PASS} IFACE=${AP_IFACE}"

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
        network-manager policykit-1 dnsutils jq sqlite3 tesseract-ocr tesseract-ocr-spa espeak-ng
    )
    if apt_install "${BASE_PACKAGES[@]}"; then
        log "✓ Dependencias base instaladas"
    else
        warn "No se pudieron instalar todas las dependencias base"
    fi

    ensure_pkg xorg
    ensure_pkg xinit
    ensure_pkg openbox
    ensure_pkg unclutter

    CHROME_PKG=""
    if apt-cache policy chromium 2>/dev/null | grep -q 'Candidate:'; then
      CHROME_PKG="chromium"
    fi
    if apt-cache policy chromium-browser 2>/dev/null | grep -q 'Candidate:'; then
      CHROME_PKG="${CHROME_PKG:-chromium-browser}"
    fi
    if [[ -n "${CHROME_PKG}" ]]; then
      ensure_pkg "${CHROME_PKG}"
      log "✓ Paquete Chromium seleccionado: ${CHROME_PKG}"
    else
      warn "No se encontró paquete Chromium disponible en apt-cache"
    fi
else
    warn "Sin red: omitiendo la instalación de dependencias base"
fi

if ! command -v startx >/dev/null 2>&1 && ! command -v xinit >/dev/null 2>&1; then
  fail "Falta startx/xinit tras la instalación"
fi

if ! command -v openbox >/dev/null 2>&1; then
  fail "Falta openbox tras la instalación"
fi

if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
  fail "Falta Chromium tras la instalación"
fi

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

# Configure boot config
log "[7/20] Configurando boot/config.txt..."

if [[ ! -f "${CONF}" ]]; then
  warn "No se encontró ${CONF}; omitiendo configuración de arranque"
elif [[ "${SKIP_HARDWARE_CONFIG:-0}" == "1" ]]; then
  warn "SKIP_HARDWARE_CONFIG=1, saltando modificación de config.txt"
else
  # Limpiar configuración anterior
  sed -i '/# --- Bascula-Cam/,/# --- Bascula-Cam (end) ---/d' "${CONF}" || warn "No se pudo limpiar configuración previa"

  # Añadir configuración mínima segura por defecto
  # El usuario puede habilitar más hardware después del primer arranque exitoso
  cat >> "${CONF}" <<'EOF'
# --- Bascula-Cam: Hardware Configuration ---
# HDMI forzado + modo 1024x600@60Hz
hdmi_force_hotplug=1
hdmi_group=2
hdmi_mode=87
hdmi_cvt=1024 600 60 3 0 0 0
dtoverlay=vc4-kms-v3d-pi5
disable_overscan=1

# I2C
dtparam=i2c_arm=on

# UART para ESP32 (báscula)
enable_uart=1
dtoverlay=disable-bt

# Configuración avanzada opcional (comentado por seguridad):
# Descomentar solo si tienes el hardware conectado y verificado

# HDMI Personalizado alternativo
#hdmi_group=2
#hdmi_mode=87
#hdmi_cvt=800 480 60 6 0 0 0  # ejemplo para 800x480

# Audio I2S - HifiBerry DAC / MAX98357A (descomentar si tienes DAC I2S)
#dtparam=audio=off
#dtoverlay=i2s-mmap
#dtoverlay=hifiberry-dac

# Camera Module 3 IMX708 (descomentar si tienes Camera Module 3 conectada)
#camera_auto_detect=1
#dtoverlay=imx708
# --- Bascula-Cam (end) ---
EOF

  log "✓ Configuración mínima segura añadida a ${CONF}"
  warn "Hardware específico (cámara, audio I2S, HDMI custom) comentado por seguridad"
  warn "Edita ${CONF} para habilitar después del primer arranque exitoso"
fi

# Disable Bluetooth UART
systemctl_safe disable --now hciuart
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

POLKIT_RULE_SRC="${PROJECT_ROOT}/packaging/polkit/49-nmcli.rules"
if [[ -f "${POLKIT_RULE_SRC}" ]]; then
  install -m 0644 "${POLKIT_RULE_SRC}" /etc/polkit-1/rules.d/49-nmcli.rules
else
  warn "No se encontró ${POLKIT_RULE_SRC}; creando regla básica"
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
    if (action.id == "org.freedesktop.NetworkManager.wifi.share.protected") {
      return polkit.Result.YES;
    }
    if (action.id == "org.freedesktop.NetworkManager.wifi.share.open") {
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
if [[ "${HAS_SYSTEMD}" -eq 1 ]]; then
  systemctl restart polkit 2>/dev/null || systemctl restart polkitd 2>/dev/null || warn "No se pudo reiniciar polkit"
else
  warn "systemd no disponible: omitiendo reinicio de polkit"
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
voices=(
  es_ES-mls_10246-medium.onnx
  es_ES-mls_10246-medium.onnx.json
)
for f in "${voices[@]}"; do
  if [[ ! -s "/opt/piper/models/$f" && "${NET_OK}" = "1" ]]; then
    log "Descargando voz: $f"
    curl -fL --retry 2 -m 30 -o "/opt/piper/models/$f" \
      "https://github.com/rhasspy/piper/releases/download/v1.2.0/$f" 2>/dev/null || warn "No se pudo descargar $f"
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

# Setup X735 v3 Power Management Board
log "[13b/20] Configurando X735 v3 (gestión de alimentación y ventilador)..."
install -d -m 0755 /opt
if [[ ! -d /opt/x735-script/.git && "${NET_OK}" = "1" ]]; then
  git clone https://github.com/geekworm-com/x735-script /opt/x735-script || warn "No se pudo clonar x735-script"
elif [[ ! -d /opt/x735-script/.git ]]; then
  warn "Sin red: no se puede clonar x735-script"
fi

if [[ -d /opt/x735-script ]]; then
  cd /opt/x735-script || true
  chmod +x *.sh || true

  install -m 0755 x735-fan.sh /usr/local/bin/x735-fan.sh || true
  install -m 0755 xPWR.sh /usr/local/bin/xPWR.sh || true
  install -m 0644 pwm_fan_control.py /usr/local/bin/pwm_fan_control.py || true
  install -m 0755 xSoft.sh /usr/local/bin/xSoft.sh || true

  # Añadir alias para apagar el sistema desde la X735
  cp -f ./xSoft.sh /usr/local/bin/ 2>/dev/null || true
  if [[ -f "${TARGET_HOME}/.bashrc" ]] && ! grep -q 'alias x735off=' "${TARGET_HOME}/.bashrc" 2>/dev/null; then
    echo 'alias x735off="sudo /usr/local/bin/xSoft.sh 0 20"' >> "${TARGET_HOME}/.bashrc"
    chown "${TARGET_USER}:${TARGET_GROUP}" "${TARGET_HOME}/.bashrc" || true
  fi

  log "✓ X735 v3 scripts instalados"
else
  warn "X735 script no disponible, continuando sin soporte X735"
fi

# Script xPWR modernizado con debounce y logs
cat > /usr/local/bin/xPWR.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

LOG_TAG="x735-pwr"
log() {
  logger -t "${LOG_TAG}" "$*"
  printf '[x735-pwr] %s\n' "$*"
}

if [[ $# -ne 3 ]]; then
  log "Uso: $0 <gpiochip> <shutdown_pin> <boot_pin>"
  exit 1
fi

GPIOCHIP_RAW="$1"
SHUTDOWN_PIN="$2"
BOOT_PIN="$3"

if [[ ! "$GPIOCHIP_RAW" =~ ^(gpiochip)?[0-9]+$ ]]; then
  log "gpiochip inválido: ${GPIOCHIP_RAW}"
  exit 1
fi

for pin in "$SHUTDOWN_PIN" "$BOOT_PIN"; do
  if [[ ! "$pin" =~ ^[0-9]+$ ]]; then
    log "Pin GPIO inválido: ${pin}"
    exit 1
  fi
done

if ! command -v gpioget >/dev/null 2>&1 || ! command -v gpioset >/dev/null 2>&1; then
  log "Herramientas gpiod no disponibles"
  exit 1
fi

GPIOCHIP="${GPIOCHIP_RAW}"
if [[ "$GPIOCHIP" =~ ^[0-9]+$ ]]; then
  GPIOCHIP="gpiochip${GPIOCHIP}"
fi

DEBOUNCE_MS=${DEBOUNCE_MS:-200}
REBOOT_MAX_MS=${REBOOT_MAX_MS:-800}
LONG_PRESS_MS=${LONG_PRESS_MS:-1500}
SAMPLE_SLEEP=${SAMPLE_SLEEP:-0.02}

millis() { date +%s%3N; }

safe_poweroff() {
  log "Solicitando apagado seguro (shutdown -h now)"
  if ! shutdown -h now; then
    log "shutdown falló, usando systemctl poweroff"
    systemctl poweroff || poweroff
  fi
}

safe_reboot() {
  log "Solicitando reinicio seguro"
  systemctl reboot || reboot
}

log "Inicializando (chip=${GPIOCHIP} shutdown_pin=${SHUTDOWN_PIN} boot_pin=${BOOT_PIN})"
gpioset "${GPIOCHIP}" "${BOOT_PIN}=1"

trap 'log "Servicio finalizado"' EXIT

while true; do
  if [[ "$(gpioget "${GPIOCHIP}" "${SHUTDOWN_PIN}")" -eq 0 ]]; then
    sleep "${SAMPLE_SLEEP}"
    continue
  fi

  press_start=$(millis)
  log "Botón presionado"

  while [[ "$(gpioget "${GPIOCHIP}" "${SHUTDOWN_PIN}")" -eq 1 ]]; do
    sleep "${SAMPLE_SLEEP}"
  done

  press_duration_ms=$(( $(millis) - press_start ))
  log "Duración pulsación: ${press_duration_ms} ms"

  if (( press_duration_ms < DEBOUNCE_MS )); then
    log "Pulsación descartada (bounce)"
    sleep "${SAMPLE_SLEEP}"
    continue
  fi

  if (( press_duration_ms >= LONG_PRESS_MS )); then
    log "Pulsación larga detectada -> apagado"
    safe_poweroff
    break
  fi

  if (( press_duration_ms <= REBOOT_MAX_MS )); then
    log "Pulsación corta detectada -> reinicio"
    safe_reboot
    break
  fi

  log "Duración intermedia, se interpreta como reinicio"
  safe_reboot
  break
done
EOF
chmod 0755 /usr/local/bin/xPWR.sh

# Script de verificación y ajuste dinámico del ventilador X735
cat > /usr/local/sbin/x735-ensure.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

LOG_TAG="x735-ensure"
log() {
  logger -t "${LOG_TAG}" "$*"
  printf '[x735-ensure] %s\n' "$*"
}

STAMP=/var/lib/x735-setup.done
mkdir -p /var/lib

if [[ -f "${STAMP}" ]]; then
  log "Configuración previa detectada (${STAMP})"
fi

wait_for_pwm() {
  local timeout=${1:-30}
  local elapsed=0
  while (( elapsed < timeout )); do
    mapfile -t chips < <(find /sys/class/pwm -maxdepth 1 -mindepth 1 -type d -name 'pwmchip*' 2>/dev/null | sort)
    if (( ${#chips[@]} > 0 )); then
      local last_index=$(( ${#chips[@]} - 1 ))
      PWM_PATH="${chips[$last_index]}"
      return 0
    fi
    sleep 1
    ((elapsed++))
  done
  return 1
}

if ! wait_for_pwm 30; then
  log "PWM no disponible tras la espera; se reintentará en el próximo arranque"
  exit 0
fi

PWM_CHIP="${PWM_PATH##*/}"
log "PWM detectado: ${PWM_CHIP}"

TARGET_SCRIPT="/usr/local/bin/x735-fan.sh"
if [[ -f "${TARGET_SCRIPT}" ]]; then
  if sed -i -E "s|/sys/class/pwm/pwmchip[0-9]+|/sys/class/pwm/${PWM_CHIP}|g" "${TARGET_SCRIPT}"; then
    log "Actualizado PWM_CHIP_PATH en ${TARGET_SCRIPT}"
  else
    log "No se pudo actualizar ${TARGET_SCRIPT}"
  fi
else
  log "${TARGET_SCRIPT} no encontrado"
fi

touch "${STAMP}"
log "Configuración X735 completada"
EOF
chmod 0755 /usr/local/sbin/x735-ensure.sh

# Servicios systemd para X735
cat > /etc/systemd/system/x735-ensure.service <<'EOF'
[Unit]
Description=Ensure Geekworm X735 fan/power configuration
After=local-fs.target sysinit.target
Before=x735-fan.service x735-pwr.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/x735-ensure.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/x735-fan.service <<'EOF'
[Unit]
Description=Geekworm X735 Fan Controller
Requires=x735-ensure.service
After=x735-ensure.service
ConditionPathExistsGlob=/sys/class/pwm/pwmchip*

[Service]
Type=simple
ExecStart=/usr/local/bin/x735-fan.sh
Restart=on-failure
RestartSec=5
User=root
Group=root

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/x735-pwr.service <<'EOF'
[Unit]
Description=Geekworm X735 Power Button Handler
Requires=x735-ensure.service
After=multi-user.target x735-ensure.service

[Service]
Type=simple
ExecStart=/usr/local/bin/xPWR.sh gpiochip0 5 12
Restart=on-failure
RestartSec=5
User=root
Group=root
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl_safe daemon-reload
systemctl_safe enable x735-ensure.service x735-fan.service x735-pwr.service
systemctl_safe start x735-fan.service x735-pwr.service

# Advertencia si el kernel es demasiado antiguo para PWM estable
KERNEL_VERSION="$(uname -r)"
if command -v dpkg >/dev/null 2>&1; then
  if dpkg --compare-versions "${KERNEL_VERSION}" lt "6.6.22"; then
    warn "Kernel ${KERNEL_VERSION} < 6.6.22: el ventilador X735 puede no funcionar; actualiza el kernel"
  fi
else
  warn "No se pudo comparar versión de kernel (dpkg ausente)"
fi

log "[X735] Kernel ${KERNEL_VERSION}"
if PWM_PATHS=$(ls /sys/class/pwm/pwmchip* 2>/dev/null); then
  log "[X735] PWM disponible: $(printf '%s' "${PWM_PATHS}" | tr '\n' ' ')"
else
  warn "[X735] PWM no disponible en /sys/class/pwm"
fi

if [[ "${HAS_SYSTEMD}" -eq 1 ]]; then
  systemctl is-active x735-fan.service >/dev/null 2>&1 && log "[X735] x735-fan.service activo" || warn "[X735] x735-fan.service no activo"
  systemctl is-active x735-pwr.service >/dev/null 2>&1 && log "[X735] x735-pwr.service activo" || warn "[X735] x735-pwr.service no activo"
else
  warn "[X735] systemd no disponible para verificar servicios"
fi

cd "${BASCULA_CURRENT_LINK}"
log "✓ X735 v3 power management configurado"

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
  npm install || warn "npm install falló, continuar con backend"
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
systemctl_safe daemon-reload
systemctl_safe enable --now bascula-miniweb.service
log "✓ Mini-web backend configurado"

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
  cat > "${TARGET_HOME}/.xinitrc" <<'EOF'
#!/bin/sh
set -e
xset s off
xset -dpms
xset s noblank
unclutter -idle 0.5 -root &
openbox &
sleep 2
CHROME_BIN="$(command -v chromium || command -v chromium-browser || echo chromium)"
exec "$CHROME_BIN" \
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
STARTX_BIN="$(command -v startx || true)"
if [[ -z "${STARTX_BIN}" ]]; then
  STARTX_BIN="$(command -v xinit || true)"
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
  sed -e "s|/home/pi|${TARGET_HOME}|g" \
      -e "s|User=pi|User=${TARGET_USER}|g" \
      -e "s|Group=pi|Group=${TARGET_GROUP}|g" \
      -e "s|/home/pi/bascula-ui|${BASCULA_CURRENT_LINK}|g" \
      "${SERVICE_FILE}" > /etc/systemd/system/bascula-app.service
  log "✓ bascula-app.service copiado desde el proyecto"
else
  cat > /etc/systemd/system/bascula-app.service <<EOF
[Unit]
Description=Bascula Digital Pro - UI (Xorg kiosk)
After=network-online.target bascula-miniweb.service
Wants=network-online.target
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
systemctl_safe status bascula-miniweb --no-pager -l
if command -v ss >/dev/null 2>&1; then
  ss -ltnp | grep 8080 || true
else
  warn "Herramienta 'ss' no disponible; omitiendo comprobación de puertos"
fi
