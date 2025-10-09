#!/bin/bash
set -euo pipefail

API_URL="http://localhost/api/camera/capture-to-file"
CAPTURE_PATH="/run/bascula/captures/camera-capture.jpg"

response_file="$(mktemp)"
trap 'rm -f "${response_file}"' EXIT

status="$(curl -sS -o "${response_file}" -w "%{http_code}" -X POST "${API_URL}")"
if [[ "${status}" != "200" ]]; then
  echo "[err] POST ${API_URL} respondió ${status}" >&2
  exit 1
fi

python3 - "$response_file" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, "rb") as fh:
    data = json.load(fh)
if not data.get("ok"):
    raise SystemExit("respuesta ok=false")
if data.get("path") != "/run/bascula/captures/camera-capture.jpg":
    raise SystemExit("path inesperado: %s" % data.get("path"))
size = int(data.get("size", 0))
if size <= 0:
    raise SystemExit("size inválido: %s" % data.get("size"))
PY

if [[ ! -f "${CAPTURE_PATH}" ]]; then
  echo "[err] ${CAPTURE_PATH} no existe" >&2
  exit 1
fi

if [[ ! -s "${CAPTURE_PATH}" ]]; then
  echo "[err] ${CAPTURE_PATH} está vacío" >&2
  exit 1
fi

echo "[ok] Captura escrita en ${CAPTURE_PATH}"
