#!/bin/bash
set -euo pipefail

LOG_PREFIX="[health-wait]"
MINIWEB_URL="${MINIWEB_URL:-http://127.0.0.1:8080/api/miniweb/status}"
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:8081/health}"
MAX_ATTEMPTS=10
SLEEP_BASE=2

log() {
  printf '%s %s\n' "${LOG_PREFIX}" "$*"
}

check_endpoint() {
  local name="$1"
  local url="$2"
  if curl -fsS --max-time 5 "$url" >/dev/null; then
    log "${name} ok (${url})"
    return 0
  fi
  log "${name} todavía no responde (${url})"
  return 1
}

attempt=1
sleep_time=${SLEEP_BASE}
miniweb_ready=0
backend_ready=0

while (( attempt <= MAX_ATTEMPTS )); do
  log "Intento ${attempt}/${MAX_ATTEMPTS}"
  miniweb_ready=0
  backend_ready=0

  if check_endpoint "miniweb" "${MINIWEB_URL}"; then
    miniweb_ready=1
  fi

  if check_endpoint "backend" "${BACKEND_URL}"; then
    backend_ready=1
  fi

  if (( miniweb_ready == 1 && backend_ready == 1 )); then
    log "Servicios disponibles"
    exit 0
  fi

  if (( attempt == MAX_ATTEMPTS )); then
    break
  fi

  log "Reintentando en ${sleep_time}s"
  sleep "${sleep_time}"
  sleep_time=$(( sleep_time * 2 ))
  if (( sleep_time > 60 )); then
    sleep_time=60
  fi
  attempt=$(( attempt + 1 ))
done

if (( backend_ready == 0 )); then
  log "[ERROR] backend no responde tras ${MAX_ATTEMPTS} intentos"
  journalctl -u bascula-backend.service -n 20 --no-pager || true
fi

if (( miniweb_ready == 0 )); then
  log "[ERROR] miniweb no responde tras ${MAX_ATTEMPTS} intentos"
fi

exit 1
