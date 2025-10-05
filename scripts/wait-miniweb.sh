#!/usr/bin/env bash
# Espera a que Mini-Web responda antes de lanzar Chromium
set -euo pipefail
URL="${1:-http://127.0.0.1:8080/api/miniweb/status}"
TIMEOUT="${2:-60}"

echo "[wait-miniweb] Waiting up to ${TIMEOUT}s for ${URL} ..."
for i in $(seq 1 "${TIMEOUT}"); do
  if curl -fsS "${URL}" >/dev/null 2>&1; then
    echo "[wait-miniweb] Mini-Web is up."
    exit 0
  fi
  sleep 1
done

echo "[wait-miniweb] Timeout after ${TIMEOUT}s" >&2
# No fallamos duro: devolvemos 0 para no bloquear kiosco si el backend tarda más
exit 0
