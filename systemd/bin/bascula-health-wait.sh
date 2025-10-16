#!/usr/bin/env bash
set -euo pipefail
log(){ echo "[health-wait] $*" >&2; }
TRIES="${TRIES:-10}"; SLEEP="${SLEEP:-1}"
ok(){ curl -fsS "$1" >/dev/null 2>&1; }

for i in $(seq 1 "$TRIES"); do
  log "Intento $i/$TRIES"
  MOK=0; BOK=0
  ok "http://127.0.0.1:8080/api/miniweb/status" && { log "miniweb ok"; MOK=1; } || true
  ok "http://127.0.0.1:8081/api/health"        && { log "backend ok"; BOK=1; } || true
  if [ "$BOK" -eq 1 ]; then log "Servicios disponibles"; exit 0; fi
  sleep "$SLEEP"
done
log "Timeout esperando servicios"; exit 1
