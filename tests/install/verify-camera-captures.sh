#!/bin/bash
set -euo pipefail

API_URL="http://localhost/api/camera/capture-to-file"
CAPTURE_URL="http://localhost/captures/camera-capture.jpg"
TRAVERSAL_URL="http://localhost/captures/../../etc/passwd"
FORBIDDEN_IP="203.0.113.10"

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
if data.get("url") != "/captures/camera-capture.jpg":
    raise SystemExit("url inesperada: %s" % data.get("url"))
if data.get("path") != "/run/bascula/captures/camera-capture.jpg":
    raise SystemExit("path inesperado: %s" % data.get("path"))
PY

if ! curl -fsSI "${CAPTURE_URL}" | grep -qi '^content-type: *image/jpeg'; then
  echo "[err] HEAD ${CAPTURE_URL} sin Content-Type image/jpeg" >&2
  exit 1
fi

if [[ "$(curl -s -o /dev/null -w "%{http_code}" "${CAPTURE_URL}")" != "200" ]]; then
  echo "[err] GET ${CAPTURE_URL} no devolvió 200" >&2
  exit 1
fi

if [[ "$(curl -s -o /dev/null -w "%{http_code}" "${TRAVERSAL_URL}")" != "404" ]]; then
  echo "[err] ${TRAVERSAL_URL} no devolvió 404" >&2
  exit 1
fi

code="$(curl -s -o /dev/null -w "%{http_code}" -H "X-Forwarded-For: ${FORBIDDEN_IP}" "${CAPTURE_URL}")"
if [[ "${code}" != "403" && "${code}" != "444" ]]; then
  echo "[err] GET ${CAPTURE_URL} con IP simulada devolvió ${code}" >&2
  exit 1
fi

if ! nginx -t; then
  echo "[err] nginx -t falló" >&2
  exit 1
fi

echo "[ok] Capturas protegidas correctamente"
