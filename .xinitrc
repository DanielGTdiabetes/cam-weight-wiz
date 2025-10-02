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

# Lanzar Chromium en modo kiosk
chromium-browser \
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
  http://localhost:80
