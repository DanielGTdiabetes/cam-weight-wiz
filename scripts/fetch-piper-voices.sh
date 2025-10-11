#!/usr/bin/env bash
set -euo pipefail

VOICES_DIR=${VOICES_DIR:-/opt/bascula/voices/piper}
REPO=${REPO:-DanielGTdiabetes/bascula-cam}
TAG=${BASCULA_VOICES_TAG:-voices-v1}
BASE="https://github.com/${REPO}/releases/download/${TAG}"

VOICES=(
  "es_ES-davefx-medium.onnx"
  "es_ES-sharvard-medium.onnx"
  "es_ES-carlfm-x_low.onnx"
)

log() {
  printf '[voices] %s\n' "$*"
}

warn() {
  printf '[voices][WARN] %s\n' "$*" >&2
}

error() {
  printf '[voices][ERR] %s\n' "$*" >&2
}

ensure_command() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    error "Comando requerido no encontrado: ${cmd}"
    return 1
  fi
}

main() {
  ensure_command curl
  ensure_command jq
  ensure_command sha256sum

  install -d -m 0755 "${VOICES_DIR}"
  if getent passwd pi >/dev/null 2>&1 && getent group pi >/dev/null 2>&1; then
    chown pi:pi "${VOICES_DIR}"
  fi

  local parent_dir
  parent_dir="$(dirname "${VOICES_DIR}")"
  if [[ -d "${parent_dir}" ]]; then
    chmod 0755 "${parent_dir}" 2>/dev/null || true
  fi

  local voice
  local -a available=()

  for voice in "${VOICES[@]}"; do
    process_voice "${voice}" && available+=("${voice}") || true
  done

  if [[ ${#available[@]} -eq 0 ]]; then
    error "Ninguna voz Piper se descargó correctamente"
    return 1
  fi

  ensure_default_link "${available[@]}"
  print_summary "${available[@]}"
}

process_voice() {
  local voice="$1"
  local voice_path="${VOICES_DIR}/${voice}"
  local meta_path="${voice_path}.json"
  local voice_url="${BASE}/${voice}"
  local meta_url="${voice_url}.json"

  log "Preparando ${voice}"

  local meta_downloaded=1
  if ! download_if_needed "${meta_url}" "${meta_path}" "${voice}.json"; then
    warn "${voice}: metadatos no disponibles; continuando sin verificación de checksum"
    meta_downloaded=0
  fi

  if ! download_if_needed "${voice_url}" "${voice_path}" "${voice}"; then
    error "${voice}: fallo al descargar modelo"
    rm -f "${voice_path}" "${meta_path}"
    error "${voice} FAIL"
    return 1
  fi

  if ! verify_checksum "${voice_path}" "${meta_path}"; then
    rm -f "${voice_path}" "${meta_path}"
    error "${voice} FAIL"
    return 1
  fi

  if [[ ${meta_downloaded} -eq 0 ]]; then
    set_permissions "${voice_path}"
  else
    set_permissions "${voice_path}" "${meta_path}"
  fi

  log "${voice} OK"
  return 0
}

download_if_needed() {
  local url="$1"
  local dest="$2"
  local label="$3"

  if [[ -s "${dest}" ]]; then
    log "${label} ya presente"
    return 0
  fi

  local tmp
  tmp="$(mktemp)"
  if ! curl --retry 5 --retry-delay 2 --fail --location -o "${tmp}" "${url}"; then
    rm -f "${tmp}"
    return 1
  fi

  install -m 0644 "${tmp}" "${dest}"
  rm -f "${tmp}"
  return 0
}

verify_checksum() {
  local voice_path="$1"
  local meta_path="$2"

  if [[ ! -s "${meta_path}" ]]; then
    warn "${voice_path##*/}: metadatos ausentes"
    return 0
  fi

  local sha
  sha="$(jq -r '.sha256 // empty' "${meta_path}" || true)"
  if [[ -z "${sha}" ]]; then
    warn "${voice_path##*/}: metadatos sin sha256"
    return 0
  fi

  local computed
  computed="$(sha256sum "${voice_path}" | awk '{print $1}')"
  if [[ "${computed}" != "${sha}" ]]; then
    error "${voice_path##*/}: sha256 no coincide"
    return 1
  fi

  return 0
}

set_permissions() {
  local path
  local -a existing=()

  for path in "$@"; do
    [[ -n "${path}" && -e "${path}" ]] || continue
    chmod 0644 "${path}"
    existing+=("${path}")
  done

  if [[ ${#existing[@]} -eq 0 ]]; then
    return
  fi

  if getent passwd pi >/dev/null 2>&1 && getent group pi >/dev/null 2>&1; then
    chown pi:pi "${existing[@]}"
  else
    warn "usuario/grupo pi no existe; omitiendo chown"
  fi
}

ensure_default_link() {
  local available=("$@")
  local default_link="${VOICES_DIR}/default.onnx"
  local current_target=""

  if [[ -L "${default_link}" ]]; then
    current_target="$(readlink "${default_link}" || true)"
    local base
    base="$(basename "${current_target}")"
    local voice
    for voice in "${VOICES[@]}"; do
      if [[ "${base}" == "${voice}" ]]; then
        if [[ -e "${VOICES_DIR}/${voice}" ]]; then
          return 0
        fi
        break
      fi
    done
  fi

  local first_available="${available[0]}"
  if [[ -z "${first_available}" ]]; then
    error "No se encontró voz para default"
    return 1
  fi

  ln -sfn "${first_available}" "${default_link}"

  if getent passwd pi >/dev/null 2>&1 && getent group pi >/dev/null 2>&1; then
    chown -h pi:pi "${default_link}"
  fi

  log "Enlace default.onnx -> ${first_available}"
}

print_summary() {
  local available=("$@")
  log "Voces disponibles: ${#available[@]} (${available[*]})"
}

main "$@"
