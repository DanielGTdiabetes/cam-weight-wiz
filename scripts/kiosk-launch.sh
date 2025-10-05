#!/usr/bin/env bash
# Bascula UI - Chromium launcher with camera support

set -euo pipefail

log() {
  printf '[kiosk] %s\n' "$*"
}

warn() {
  printf '[kiosk][warn] %s\n' "$*" >&2
}

BASE_URL="${BASCULA_KIOSK_URL:-http://127.0.0.1:8080}"
BASE_URL="${BASE_URL%/}"
CONFIG_URL="${BASE_URL}/config"
STATUS_URL="${BASE_URL}/api/miniweb/status"
ASSET_URL="${BASE_URL}/icon-192.png"

wait_for_endpoint() {
  local url="$1"
  local label="$2"
  local attempts=200
  local delay=1

  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      log "${label} ready after ${i} attempt(s)"
      return 0
    fi
    sleep "${delay}"
  done

  warn "${label} not ready after ${attempts} attempts"
  return 0
}

# Prepare X session preferences
if command -v xset >/dev/null 2>&1; then
  xset s off || true
  xset -dpms || true
  xset s noblank || true
fi

if command -v unclutter >/dev/null 2>&1; then
  unclutter -idle 0.5 -root &
fi

# Ensure backend endpoints are reachable before launching the UI
wait_for_endpoint "${CONFIG_URL}" "UI /config"
wait_for_endpoint "${ASSET_URL}" "UI static asset"
wait_for_endpoint "${STATUS_URL}" "Miniweb status API"

DEFAULT_CHROMIUM="/usr/bin/chromium"
CHROMIUM_BIN="$(command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || echo "${DEFAULT_CHROMIUM}")"
APP_URL="${BASE_URL}/config?v=$(date +%s)"

FLAGS=(
  --kiosk
  --noerrdialogs
  --disable-infobars
  --no-first-run
  --no-default-browser-check
  --autoplay-policy=no-user-gesture-required
  --use-fake-ui-for-media-stream
  --disable-translate
  --disable-features=TranslateUI
  --enable-features=OverlayScrollbar
  --overscroll-history-navigation=0
  --disable-pinch
  --disk-cache-dir=/dev/null
  --check-for-update-interval=31536000
  --start-fullscreen
  --window-position=0,0
)

LIBCAMERIFY_BIN="$(command -v libcamerify 2>/dev/null || true)"

if [[ -n "${LIBCAMERIFY_BIN}" ]]; then
  if [[ -x "${DEFAULT_CHROMIUM}" ]]; then
    log "Launching Chromium through libcamerify (default binary)"
    exec /usr/bin/libcamerify /usr/bin/chromium "${FLAGS[@]}" --app="${APP_URL}"
  else
    log "Launching Chromium through libcamerify (${CHROMIUM_BIN})"
    exec /usr/bin/libcamerify "${CHROMIUM_BIN}" "${FLAGS[@]}" --app="${APP_URL}"
  fi
else
  log "Launching Chromium directly"
  exec "${CHROMIUM_BIN}" "${FLAGS[@]}" --app="${APP_URL}"
fi
