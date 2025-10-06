#!/bin/bash
# Bascula UI - Chromium Kiosk Mode Launcher

# Disable screen blanking
xset s off
xset -dpms
xset s noblank

# Hide cursor after inactivity
unclutter -idle 5 -root &

# Determine target URL based on miniweb status
resolve_target_url() {
  python3 <<'PY'
import json
import time
import urllib.error
import urllib.request

STATUS_URL = "http://127.0.0.1:8080/api/miniweb/status"


def choose_url() -> str:
    for _ in range(20):
        try:
            with urllib.request.urlopen(STATUS_URL, timeout=2) as response:
                data = json.load(response)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError):
            time.sleep(1)
            continue
        except Exception:
            time.sleep(1)
            continue

        mode = str(data.get("mode") or "").lower()
        wifi = data.get("wifi") or {}
        wifi_connected = bool(wifi.get("connected"))
        wifi_ip = wifi.get("ip") or data.get("ip") or data.get("ip_address")
        ethernet_connected = bool(data.get("ethernet_connected"))

        if mode == "kiosk" or (wifi_connected and wifi_ip) or ethernet_connected:
            return "http://localhost/"
        if mode == "ap":
            return "http://localhost/config"

        time.sleep(1)

    return "http://localhost/config"


print(choose_url())
PY
}

TARGET_URL="$(resolve_target_url)"

# Start Chromium in kiosk mode
chromium \
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
  "$TARGET_URL"
