#!/bin/bash
set -euo pipefail

log() { printf '[checks] %s\n' "$*"; }
warn() { printf '[checks][warn] %s\n' "$*" >&2; }
run() {
  local label="$1"
  shift
  log "run: ${label}"
  if "$@"; then
    log "ok: ${label}"
  else
    warn "falló: ${label}"
    return 1
  fi
}

STATUS=0
if command -v shellcheck >/dev/null 2>&1; then
  run "shellcheck install-all.sh" shellcheck scripts/install-all.sh || STATUS=1
else
  warn "shellcheck no disponible"
fi

run "systemd-analyze verify" systemd-analyze verify \
  /etc/systemd/system/bascula-miniweb.service \
  /etc/systemd/system/bascula-backend.service \
  /etc/systemd/system/bascula-health-wait.service \
  /etc/systemd/system/bascula-ui.service || STATUS=1

run "nginx -t" nginx -t || STATUS=1
run "miniweb status" curl -fsS http://127.0.0.1:8080/api/miniweb/status || STATUS=1
run "miniweb ok=true" /bin/sh -c 'curl -fsS http://127.0.0.1:8080/api/miniweb/status | grep -q "\"ok\"[[:space:]]*:[[:space:]]*true"' || STATUS=1
run "picamera2 import" python3 -c 'import picamera2' || STATUS=1

if [[ ${SKIP_AUDIO:-0} -ne 1 ]]; then
  run "arecord bascula_mix_in" arecord -D bascula_mix_in -f S16_LE -r 16000 -d 1 || STATUS=1
  run "speaker-test bascula_out" speaker-test -t sine -f 1000 -l 1 -D bascula_out || STATUS=1
else
  warn "audio checks omitidos (SKIP_AUDIO=1)"
fi

run "sin arecord en ejecución" bash -c '! pgrep -a arecord' || STATUS=1
run "wake listener no inicializado" bash -c 'if command -v journalctl >/dev/null 2>&1; then ! journalctl -u bascula-backend.service -n 200 --no-pager | grep -qi "WakeListener inicializado"; else exit 0; fi' || STATUS=1

log "[install][ok] Wake/Vosk desactivado por defecto; micro disponible para captura bajo demanda (Modo Receta)."

exit ${STATUS}
