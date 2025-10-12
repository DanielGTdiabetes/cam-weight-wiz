#!/usr/bin/env bash
set -euo pipefail

MODEL_URL=${VOSK_MODEL_URL:-https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip}
MODEL_SHA256=${VOSK_MODEL_SHA256:-f7e409775888b859504f829148d464472b725f0c60211472edbba7d6851124c8}
DEST_DIR=${VOSK_DEST_DIR:-/opt/vosk/es-small}
TMP_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP_ROOT}"
}
trap cleanup EXIT

log() { printf '[vosk] %s\n' "$*"; }
warn() { printf '[vosk][WARN] %s\n' "$*" >&2; }
err() { printf '[vosk][ERR] %s\n' "$*" >&2; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Comando requerido no disponible: $1"
    exit 1
  fi
}

main() {
  require_cmd curl
  require_cmd unzip
  require_cmd sha256sum

  if [[ -d "${DEST_DIR}" && -s "${DEST_DIR}/conf/mfcc.conf" ]]; then
    log "Modelo Vosk ya presente en ${DEST_DIR}"
    return 0
  fi

  install -d -m 0755 "${DEST_DIR}"

  local archive="${TMP_ROOT}/model.zip"
  log "Descargando modelo Vosk desde ${MODEL_URL}"
  curl --fail --location --retry 5 --retry-delay 2 -o "${archive}" "${MODEL_URL}"

  local checksum
  checksum="$(sha256sum "${archive}" | awk '{print $1}')"
  if [[ -n "${MODEL_SHA256}" && "${checksum}" != "${MODEL_SHA256}" ]]; then
    err "SHA256 inesperado (${checksum}); esperado ${MODEL_SHA256}"
    exit 1
  fi

  log "Descomprimiendo modelo..."
  unzip -q "${archive}" -d "${TMP_ROOT}"

  local extracted
  extracted="$(find "${TMP_ROOT}" -maxdepth 1 -type d -name 'vosk-model-*' | head -n1 || true)"
  if [[ -z "${extracted}" ]]; then
    err "No se encontró carpeta vosk-model-* tras la extracción"
    exit 1
  fi

  log "Instalando modelo en ${DEST_DIR}"
  rsync -a --delete "${extracted}/" "${DEST_DIR}/"

  if getent passwd pi >/dev/null 2>&1 && getent group pi >/dev/null 2>&1; then
    chown -R pi:pi "${DEST_DIR}"
  fi

  log "Modelo Vosk listo en ${DEST_DIR}"
}

main "$@"
