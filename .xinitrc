#!/bin/sh
# .xinitrc para Bascula UI - Chromium kiosk en Raspberry Pi

# Deshabilitar screensaver y ahorro de energía
xset s off
xset -dpms
xset s noblank

# Ocultar cursor del mouse
unclutter -idle 0.5 -root &

# Iniciar openbox como window manager
openbox &

# Esperar a que el servidor X esté listo
sleep 2

# Lanzar script dedicado del kiosko
KIOSK_SCRIPT="${BASCULA_KIOSK_SCRIPT:-/opt/bascula/current/scripts/kiosk-launch.sh}"
if [ ! -x "${KIOSK_SCRIPT}" ]; then
  KIOSK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/scripts/kiosk-launch.sh"
fi
exec "${KIOSK_SCRIPT}"
