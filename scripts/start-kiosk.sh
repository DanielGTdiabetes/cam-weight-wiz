#!/usr/bin/env bash
set -euo pipefail

export XDG_RUNTIME_DIR=/run/user/1000
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
mkdir -p "$XDG_RUNTIME_DIR"

export DISPLAY=:0
if ! pgrep -x Xorg >/dev/null; then
  startx || true
fi

sudo -u pi /usr/bin/chromium-browser \
  --kiosk --no-first-run --noerrdialogs --disable-infobars \
  --autoplay-policy=no-user-gesture-required \
  --enable-features=WebRTCPipeWireCapturer \
  --start-fullscreen --window-size=1024,600 \
  --user-data-dir=/run/user/1000/chromium-kiosk \
  --disk-cache-dir=/run/user/1000/chromium-cache \
  http://localhost/
