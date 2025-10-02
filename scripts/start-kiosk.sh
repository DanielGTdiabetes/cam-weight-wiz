#!/bin/bash
# Bascula UI - Chromium Kiosk Mode Launcher

# Disable screen blanking
xset s off
xset -dpms
xset s noblank

# Hide cursor after inactivity
unclutter -idle 5 -root &

# Start Chromium in kiosk mode
chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --enable-features=OverlayScrollbar \
  --disable-translate \
  --disable-features=TranslateUI \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --start-fullscreen \
  --window-size=1024,600 \
  --window-position=0,0 \
  http://localhost
