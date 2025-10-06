#!/bin/bash
# Bascula UI - Chromium Kiosk Mode Launcher

set -euo pipefail

LOG_FILE="/var/log/bascula/ui.log"
LOG_DIR="$(dirname "${LOG_FILE}")"

# Ensure log directory/file exist without failing if permissions differ
mkdir -p "${LOG_DIR}" 2>/dev/null || true
touch "${LOG_FILE}" 2>/dev/null || true

log() {
  printf '[kiosk] %s\n' "$*" >> "${LOG_FILE}" 2>/dev/null || true
}

cleanup_background() {
  if [[ -n "${UNCLUTTER_PID:-}" ]]; then
    kill "${UNCLUTTER_PID}" 2>/dev/null || true
  fi
}

trap cleanup_background EXIT

log "Iniciando sesión de kiosk (replace=${BASCULA_KIOSK_REPLACE_WM:-0})"

if command -v xset >/dev/null 2>&1; then
  xset s off || true
  xset -dpms || true
  xset s noblank || true
else
  log "xset no disponible"
fi

if command -v openbox >/dev/null 2>&1; then
  if [[ "${BASCULA_KIOSK_REPLACE_WM:-0}" == "1" ]]; then
    log "Ejecutando openbox --replace"
    openbox --replace &
  else
    log "Lanzando openbox"
    openbox &
  fi
else
  log "openbox no encontrado"
fi

UNCLUTTER_BIN="$(command -v unclutter 2>/dev/null || true)"
if [[ -n "${UNCLUTTER_BIN}" ]]; then
  "${UNCLUTTER_BIN}" -idle 0.5 -root &
  UNCLUTTER_PID=$!
  log "unclutter iniciado (pid=${UNCLUTTER_PID})"
else
  log "unclutter no instalado"
fi

sleep 1

BACKEND_RESULT=""
set +e
BACKEND_RESULT=$(python3 <<'PY'
import json
import time
import urllib.error
import urllib.request

HEALTH_URL = "http://127.0.0.1:8080/health"
STATUS_URL = "http://127.0.0.1:8080/api/miniweb/status"


def wait_for_health(timeout: float = 15.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(HEALTH_URL, timeout=2) as response:
                if 200 <= getattr(response, "status", 200) < 500:
                    return True
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
            time.sleep(1)
            continue
        except Exception:
            time.sleep(1)
            continue
    return False


def choose_target(timeout: float = 5.0) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
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
    return "http://localhost/config"

if wait_for_health():
    target = choose_target()
    print(f"ready|{target}")
else:
    print("fallback|http://localhost/config")
PY
)
PY_STATUS=$?
set -e
if [[ ${PY_STATUS} -ne 0 ]]; then
  BACKEND_RESULT="fallback|http://localhost/config"
fi

BACKEND_STATE="${BACKEND_RESULT%%|*}"
TARGET_URL="${BACKEND_RESULT#*|}"

if [[ "${BACKEND_STATE}" == "ready" ]]; then
  log "Backend disponible, abriendo ${TARGET_URL}"
else
  log "Backend no respondió a tiempo, abriendo ${TARGET_URL}"
fi

CHROME_BIN="$(command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || command -v ${CHROME_PKG:-chromium} 2>/dev/null || echo chromium)"

exec "${CHROME_BIN}" \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --enable-features=OverlayScrollbar,ClipboardUnsanitizedContent \
  --disable-translate \
  --disable-features=TranslateUI \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --start-fullscreen \
  --window-size=1024,600 \
  --window-position=0,0 \
  --disk-cache-dir=/dev/null \
  --check-for-update-interval=31536000 \
  "${TARGET_URL}"
