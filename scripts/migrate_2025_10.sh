#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "This script must be run as root (use sudo)." >&2
  exit 1
fi

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
TARGET_ROOT=/opt/bascula/current
NM_DIR=/etc/NetworkManager/system-connections
POLKIT_DIR=/etc/polkit-1/rules.d
POLKIT_RULE=10-bascula-nm.rules
SERVICE_NAME=bascula-miniweb.service
AP_PROFILE=${NM_DIR}/BasculaAP.nmconnection

mkdir -p "${TARGET_ROOT}/backend"
install -m 644 "${REPO_ROOT}/backend/miniweb.py" "${TARGET_ROOT}/backend/miniweb.py"

install -m 644 "${REPO_ROOT}/systemd/${SERVICE_NAME}" "/etc/systemd/system/${SERVICE_NAME}"

mkdir -p "${POLKIT_DIR}"
install -m 644 "${REPO_ROOT}/etc/polkit-1/rules.d/10-bascula-nmcli.rules" "${POLKIT_DIR}/${POLKIT_RULE}"

if getent group netdev >/dev/null 2>&1; then
  usermod -aG netdev pi || true
fi

if command -v uuidgen >/dev/null 2>&1; then
  UUID_VALUE=$(uuidgen)
else
  UUID_VALUE=$(python3 -c 'import uuid; print(uuid.uuid4())')
fi

mkdir -p "${NM_DIR}"
if [[ ! -f "${AP_PROFILE}" ]]; then
  cat <<PROFILE > "${AP_PROFILE}"
[connection]
id=BasculaAP
uuid=${UUID_VALUE}
type=wifi
interface-name=wlan0
autoconnect=false

[wifi]
ssid=Bascula-AP
mode=ap

[wifi-security]
key-mgmt=wpa-psk
psk=Bascula1234

[ipv4]
method=shared

[ipv6]
method=ignore
PROFILE
  chmod 600 "${AP_PROFILE}"
fi

systemctl daemon-reload
if systemctl is-active --quiet polkit; then
  systemctl restart polkit
elif systemctl is-active --quiet polkitd; then
  systemctl restart polkitd
fi
systemctl restart bascula-miniweb.service

echo "Migration completed."
