#!/usr/bin/env bash
# Bascula multimedia bootstrap for Raspberry Pi

set -euo pipefail

log() {
  echo "[install] $*"
}

warn() {
  echo "[install] warn: $*" >&2
}

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "[install] error: run as root" >&2
  exit 1
fi

TARGET_USER="${TARGET_USER:-${SUDO_USER:-pi}}"
if ! id -u "${TARGET_USER}" >/dev/null 2>&1; then
  warn "target user ${TARGET_USER} not found; using current user $(id -un)"
  TARGET_USER="$(id -un)"
fi

APT_PACKAGES=(
  alsa-utils
  sox
  ffmpeg
  rpicam-apps
  v4l-utils
  python3-picamera2
  libcamera-apps
  xserver-xorg-legacy
  python3-venv
  tesseract-ocr
  tesseract-ocr-spa
)

log "apt-get update"
if ! apt-get update -y; then
  warn "apt-get update failed"
fi

log "apt-get install -y ${APT_PACKAGES[*]}"
if ! apt-get install -y "${APT_PACKAGES[@]}"; then
  warn "package installation failed"
fi

OCR_VENV_DIR="/opt/bascula/venv"
OCR_CURRENT_DIR="/opt/bascula/current"
OCR_VENV_LINK="${OCR_CURRENT_DIR}/.venv"
OCR_REQUIREMENTS_FILE="${OCR_CURRENT_DIR}/ocr/requirements.txt"

mkdir -p "${OCR_VENV_DIR%/*}" "${OCR_CURRENT_DIR}"

log "preparing OCR virtualenv at ${OCR_VENV_DIR}"
python3 -m venv --upgrade "${OCR_VENV_DIR}"
OCR_PYTHON="${OCR_VENV_DIR}/bin/python"
"${OCR_PYTHON}" -m pip install --upgrade pip wheel
log "python virtualenv ready: ${OCR_PYTHON}"

if [[ -e "${OCR_VENV_LINK}" && ! -L "${OCR_VENV_LINK}" ]]; then
  warn "${OCR_VENV_LINK} exists and is not a symlink; replacing"
  rm -rf "${OCR_VENV_LINK}"
fi

if [[ -L "${OCR_VENV_LINK}" ]]; then
  current_target="$(readlink -f "${OCR_VENV_LINK}")"
  if [[ "${current_target}" == "${OCR_VENV_DIR}" ]]; then
    log "OCR virtualenv symlink already points to ${OCR_VENV_DIR}"
  else
    ln -sfn "${OCR_VENV_DIR}" "${OCR_VENV_LINK}"
    log "OCR virtualenv symlink updated -> ${OCR_VENV_DIR}"
  fi
else
  ln -sfn "${OCR_VENV_DIR}" "${OCR_VENV_LINK}"
  log "OCR virtualenv symlink created at ${OCR_VENV_LINK}"
fi

OCR_PIP_PACKAGES=(
  fastapi
  'uvicorn[standard]'
  pillow
  numpy
  opencv-python-headless
  pytesseract
  python-multipart
)

log "installing OCR Python packages: ${OCR_PIP_PACKAGES[*]}"
"${OCR_PYTHON}" -m pip install --upgrade "${OCR_PIP_PACKAGES[@]}"

if [[ -f "${OCR_REQUIREMENTS_FILE}" ]]; then
  log "installing additional OCR requirements from ${OCR_REQUIREMENTS_FILE}"
  "${OCR_PYTHON}" -m pip install -r "${OCR_REQUIREMENTS_FILE}"
else
  log "no extra OCR requirements found at ${OCR_REQUIREMENTS_FILE}"
fi

for group in video render input dialout; do
  if getent group "${group}" >/dev/null 2>&1; then
    if id -nG "${TARGET_USER}" | tr ' ' '\n' | grep -qx "${group}"; then
      log "${TARGET_USER} already in ${group}"
    else
      if usermod -aG "${group}" "${TARGET_USER}"; then
        log "added ${TARGET_USER} to ${group}"
      else
        warn "failed to add ${TARGET_USER} to ${group}"
      fi
    fi
  else
    warn "group ${group} not present"
  fi
done

ASOUND_CONF="/etc/asound.conf"
cat <<'ASOUND' > "${ASOUND_CONF}"
pcm.!default {
  type asym
  playback.pcm {
    type plug
    slave.pcm "hw:1,0"
  }
  capture.pcm {
    type plug
    slave.pcm "hw:0,0"
  }
}
ctl.!default {
  type hw
  card 1
}
ASOUND

if command -v alsactl >/dev/null 2>&1; then
  alsactl store || true
fi
log "ALSA defaults set: playback hw:1,0 / capture hw:0,0"

amixer -c 0 set Mic 16 unmute >/dev/null 2>&1 || true
amixer -c 0 set 'Auto Gain Control' on >/dev/null 2>&1 || true
log "Mic gain set (if supported)"

BOOT_CONFIG="/boot/firmware/config.txt"
BLOCK_START="# --- Bascula-Cam: Hardware Configuration ---"
BLOCK_END="# --- Bascula-Cam (end) ---"

if [[ -f "${BOOT_CONFIG}" ]]; then
  python3 - "$BOOT_CONFIG" <<'PY'
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
block_start = "# --- Bascula-Cam: Hardware Configuration ---"
block_end = "# --- Bascula-Cam (end) ---"
content = """# --- Bascula-Cam: Hardware Configuration ---
dtparam=i2c_arm=on
dtparam=i2s=on
dtparam=spi=on
dtparam=audio=off
dtoverlay=i2s-mmap
dtoverlay=hifiberry-dac
camera_auto_detect=1
dtoverlay=imx708
# --- Bascula-Cam (end) ---
"""
text = config_path.read_text(encoding="utf-8")
if block_start in text and block_end in text and text.index(block_start) < text.index(block_end):
    before, rest = text.split(block_start, 1)
    _, after = rest.split(block_end, 1)
    new_text = before.rstrip("\n") + "\n" + content + after.lstrip("\n")
else:
    cleaned = text
    if block_start in cleaned and block_end not in cleaned:
        cleaned = cleaned.replace(block_start, "")
    if not cleaned.endswith("\n"):
        cleaned += "\n"
    new_text = cleaned + content
config_path.write_text(new_text, encoding="utf-8")
PY
  log "config.txt updated with camera overlays"
else
  warn "${BOOT_CONFIG} not found; skipping camera configuration"
fi

POLICY_DIR="/etc/chromium/policies/managed"
POLICY_FILE="${POLICY_DIR}/bascula_policy.json"
mkdir -p "${POLICY_DIR}"
cat <<'JSON' > "${POLICY_FILE}"
{
  "AudioCaptureAllowed": true,
  "VideoCaptureAllowed": true,
  "AutoplayAllowed": true,
  "DefaultAudioCaptureSetting": 1,
  "DefaultVideoCaptureSetting": 1,
  "URLAllowlist": ["http://127.0.0.1:8080", "http://localhost:8080"]
}
JSON
log "Chromium managed policy updated"

aplay -l >/dev/null 2>&1 || warn "aplay not ready"
arecord -l >/dev/null 2>&1 || warn "arecord not ready"
python3 -c "from picamera2 import Picamera2; print('Picamera2 OK')" >/dev/null 2>&1 || warn "Picamera2 import failed"

log "systemd daemon-reload"
if systemctl daemon-reload; then
  log "systemd daemon reloaded"
else
  warn "systemd daemon-reload failed"
fi

if systemctl list-unit-files --type=service --no-legend --no-pager | awk '{print $1}' | grep -Fxq "ocr-service.service"; then
  if systemctl enable ocr-service; then
    log "ocr-service enabled"
  else
    warn "failed to enable ocr-service"
  fi
  if systemctl restart ocr-service; then
    log "ocr-service restarted"
  else
    warn "failed to restart ocr-service"
  fi
else
  warn "ocr-service.service unit not found; skipping enable/restart"
fi

log "Install script finished"
