#!/usr/bin/env bash
# Robust Chromium kiosk launcher for Bascula UI

set -Eeuo pipefail

LOG_FILE="/var/log/bascula/app.log"
LOG_DIR="$(dirname "${LOG_FILE}")"

if [[ ! -d "${LOG_DIR}" ]]; then
  mkdir -p "${LOG_DIR}" 2>/dev/null || true
fi

# Redirect all output to the log file while still allowing manual redirection in callers
exec >>"${LOG_FILE}" 2>&1

log() {
  printf '%(%Y-%m-%d %H:%M:%S)T [kiosk] %s\n' -1 "$*"
}

warn() {
  printf '%(%Y-%m-%d %H:%M:%S)T [kiosk][warn] %s\n' -1 "$*"
}

BASE_URL="${BASCULA_KIOSK_URL:-http://127.0.0.1:8080}"
BASE_URL="${BASE_URL%/}"

BASE_HOST_PORT="${BASE_URL#*://}"
BASE_HOST_PORT="${BASE_HOST_PORT%%/*}"
BASE_HOST="${BASE_HOST_PORT%%:*}"
BASE_PORT="${BASE_HOST_PORT##*:}"
if [[ -z "${BASE_HOST}" || "${BASE_HOST}" == "${BASE_HOST_PORT}" ]]; then
  BASE_HOST="127.0.0.1"
fi
if [[ -z "${BASE_PORT}" || "${BASE_PORT}" == "${BASE_HOST}" ]]; then
  BASE_PORT="8080"
fi

CONFIG_URL="${BASE_URL}/config"
STATUS_URL="${BASE_URL}/api/miniweb/status"

log "launcher starting (base URL: ${BASE_URL})"

export DISPLAY="${DISPLAY:-:0}"

check_port() {
  if exec 3<>"/dev/tcp/${BASE_HOST}/${BASE_PORT}"; then
    exec 3>&- 3<&-
    return 0
  fi
  return 1
}

check_status() {
  local status_code
  status_code="$(curl -sS -o /dev/null -w '%{http_code}' "${STATUS_URL}" || echo "000")"
  if [[ "${status_code}" != "200" ]]; then
    log "miniweb status not ready (http=${status_code})"
    return 1
  fi
  return 0
}

check_config() {
  local html
  if ! html="$(curl -fsS --max-time 5 "${CONFIG_URL}" 2>/dev/null)"; then
    log "miniweb config endpoint not ready"
    return 1
  fi
  local config_pattern='<script[^>]*src="/assets/index-[^"]+\.js"'
  if [[ ${html} =~ ${config_pattern} ]]; then
    return 0
  fi
  log "miniweb config missing assets bundle"
  return 1
}

wait_for_miniweb() {
  local attempt=0
  local delay=1
  local start_ts
  start_ts="$(date +%s)"
  while (( $(date +%s) - start_ts < 30 )); do
    attempt=$((attempt + 1))
    log "wait miniweb attempt ${attempt}" 
    if ! check_port; then
      log "miniweb port ${BASE_HOST}:${BASE_PORT} not available yet"
    elif ! check_status; then
      :
    elif check_config; then
      log "miniweb ready after ${attempt} attempt(s)"
      return 0
    fi
    sleep "${delay}"
    if (( delay < 5 )); then
      delay=$((delay + 1))
    fi
  done
  warn "miniweb not ready after 30s; continuing"
  return 1
}

wait_for_miniweb

CHROME_BIN="$(command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || echo chromium)"
if ! command -v "${CHROME_BIN}" >/dev/null 2>&1; then
  warn "Chromium binary not found (${CHROME_BIN}); attempting to continue"
fi

LIBCAMERIFY_BIN="$(command -v libcamerify 2>/dev/null || true)"
if [[ -n "${LIBCAMERIFY_BIN}" ]]; then
  log "libcamerify detected: ${LIBCAMERIFY_BIN}"
fi

CHROMIUM_FLAGS=(
  --kiosk
  --noerrdialogs
  --no-first-run
  --disable-infobars
  --autoplay-policy=no-user-gesture-required
  --overscroll-history-navigation=0
  --disable-pinch
  --check-for-update-interval=31536000
  --password-store=basic
  --use-fake-ui-for-media-stream
)

BACKOFF_SEQUENCE=(2 4 8 15)
backoff_index=0

while true; do
  APP_URL="${BASE_URL}/config?v=$(date +%s)"
  log "launching Chromium -> ${APP_URL}"

  start_run="$(date +%s)"
  set +e
  if [[ -n "${LIBCAMERIFY_BIN}" ]]; then
    "${LIBCAMERIFY_BIN}" "${CHROME_BIN}" "${CHROMIUM_FLAGS[@]}" "${APP_URL}"
  else
    "${CHROME_BIN}" "${CHROMIUM_FLAGS[@]}" "${APP_URL}"
  fi
  rc=$?
  set -e
  end_run="$(date +%s)"

  runtime=$((end_run - start_run))
  if (( runtime > 60 )); then
    backoff_index=0
  elif (( backoff_index < ${#BACKOFF_SEQUENCE[@]} - 1 )); then
    backoff_index=$((backoff_index + 1))
  fi

  delay="${BACKOFF_SEQUENCE[backoff_index]}"
  log "Chromium exited rc=${rc}; re-launching in ${delay}s"
  sleep "${delay}"

done
