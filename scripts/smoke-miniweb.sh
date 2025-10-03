#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:8080}"
echo "[smoke] Target: ${BASE_URL}" 

HAS_JQ=1
if ! command -v jq >/dev/null 2>&1; then
  HAS_JQ=0
  echo "[smoke][warn] jq no está instalado, omitiendo validación de JSON estructurado" >&2
fi

echo "[smoke] GET /openapi.json"
if [[ "${HAS_JQ}" -eq 1 ]]; then
  curl -fsS "${BASE_URL}/openapi.json" | jq . >/dev/null
else
  curl -fsS "${BASE_URL}/openapi.json" >/dev/null
fi

echo "[smoke] GET /api/network/status"
if [[ "${HAS_JQ}" -eq 1 ]]; then
  curl -fsS "${BASE_URL}/api/network/status" | jq . >/dev/null
else
  curl -fsS "${BASE_URL}/api/network/status" >/dev/null
fi

echo "[smoke] GET /api/miniweb/pin"
if [[ "${HAS_JQ}" -eq 1 ]]; then
  curl -fsS "${BASE_URL}/api/miniweb/pin" | jq . >/dev/null
else
  curl -fsS "${BASE_URL}/api/miniweb/pin" >/dev/null
fi

echo "[smoke] GET /api/miniweb/scan-networks"
if [[ "${HAS_JQ}" -eq 1 ]]; then
  curl -fsS "${BASE_URL}/api/miniweb/scan-networks" | jq . >/dev/null
else
  curl -fsS "${BASE_URL}/api/miniweb/scan-networks" >/dev/null
fi

echo "[smoke] GET /config"
CONFIG_HTML="$(curl -fsS "${BASE_URL}/config")"
echo "${CONFIG_HTML}" | grep -qi "<html" || {
  echo "[smoke][warn] /config no devolvió HTML" >&2
  exit 1
}

echo "[smoke] OK"
