#!/usr/bin/env bash
#
# fix-serial.sh - Configura correctamente el puerto serial en Raspberry Pi 5
# Deshabilita console serial y habilita UART para comunicación con ESP32
#

set -euo pipefail

BOOTDIR="/boot/firmware"
[[ ! -d "${BOOTDIR}" ]] && BOOTDIR="/boot"
CONF="${BOOTDIR}/config.txt"
CMDLINE="${BOOTDIR}/cmdline.txt"

log() { printf "[serial] %s\n" "$*"; }

# Verificar que existe config.txt
if [[ ! -f "${CONF}" ]]; then
  log "ERROR: ${CONF} no existe"
  exit 1
fi

# Habilitar UART en config.txt
if ! grep -q "^enable_uart=1" "${CONF}"; then
  log "Añadiendo enable_uart=1 a ${CONF}"
  echo "enable_uart=1" >> "${CONF}"
else
  log "enable_uart=1 ya presente en ${CONF}"
fi

# Deshabilitar Bluetooth en UART (libera el puerto serial principal)
if ! grep -q "^dtoverlay=disable-bt" "${CONF}"; then
  log "Añadiendo dtoverlay=disable-bt a ${CONF}"
  echo "dtoverlay=disable-bt" >> "${CONF}"
else
  log "dtoverlay=disable-bt ya presente en ${CONF}"
fi

# Remover console serial de cmdline.txt
if [[ -f "${CMDLINE}" ]]; then
  if grep -q "console=serial0" "${CMDLINE}" || grep -q "console=ttyAMA0" "${CMDLINE}"; then
    log "Removiendo console serial de ${CMDLINE}"
    cp "${CMDLINE}" "${CMDLINE}.bak"
    sed -i 's/console=serial0,[0-9]\+\s*//g' "${CMDLINE}"
    sed -i 's/console=ttyAMA0,[0-9]\+\s*//g' "${CMDLINE}"
    sed -i 's/console=ttyS0,[0-9]\+\s*//g' "${CMDLINE}"
    log "Backup guardado en ${CMDLINE}.bak"
  else
    log "Console serial no presente en ${CMDLINE}"
  fi
fi

# Deshabilitar servicios de getty en serial
log "Deshabilitando servicios getty en puertos serial..."
systemctl disable --now serial-getty@ttyAMA0.service 2>/dev/null || true
systemctl disable --now serial-getty@ttyS0.service 2>/dev/null || true
systemctl disable --now serial-getty@serial0.service 2>/dev/null || true

# Deshabilitar hciuart (Bluetooth UART)
log "Deshabilitando hciuart..."
systemctl disable --now hciuart 2>/dev/null || true

log "Configuración serial completada"
log "UART disponible en /dev/serial0 (enlace a /dev/ttyAMA0)"
log "Se requiere REINICIO para aplicar cambios: sudo reboot"
