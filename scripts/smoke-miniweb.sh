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

echo "[smoke] GET /health"
if ! curl -fsS "${BASE_URL}/health" >/dev/null; then
  echo "[smoke][warn] /health no respondió" >&2
fi

echo "[smoke] GET /api/camera/test"
if [[ "${HAS_JQ}" -eq 1 ]]; then
  if ! curl -fsS "${BASE_URL}/api/camera/test" | jq .; then
    echo "[smoke][warn] /api/camera/test falló" >&2
  fi
else
  if ! curl -fsS "${BASE_URL}/api/camera/test"; then
    echo "[smoke][warn] /api/camera/test falló" >&2
  fi
fi

echo "[smoke] POST /api/camera/capture-to-file"
if [[ "${HAS_JQ}" -eq 1 ]]; then
  if ! curl -fsS -X POST "${BASE_URL}/api/camera/capture-to-file" | jq .; then
    echo "[smoke][warn] capture-to-file falló" >&2
  fi
else
  if ! curl -fsS -X POST "${BASE_URL}/api/camera/capture-to-file"; then
    echo "[smoke][warn] capture-to-file falló" >&2
  fi
fi

echo "[smoke] GET /config"
CONFIG_HTML="$(curl -fsS "${BASE_URL}/config")"
echo "${CONFIG_HTML}" | grep -qi "<html" || {
  echo "[smoke][warn] /config no devolvió HTML" >&2
  exit 1
}

echo "[smoke] OK"
