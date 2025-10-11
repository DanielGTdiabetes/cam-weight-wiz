#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FETCH_SCRIPT="${REPO_ROOT}/scripts/fetch-piper-voices.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT

if [[ ! -x "${FETCH_SCRIPT}" ]]; then
  echo "[FAIL] fetch-piper-voices.sh no encontrado" >&2
  exit 1
fi

if grep -R "huggingface.co/rhasspy/piper-voices" -n "${REPO_ROOT}/scripts" --exclude "$(basename "$0")" >/dev/null 2>&1; then
  echo "[ERR] quedan URLs de HuggingFace" >&2
  exit 1
fi

VOICES_DIR="${TMPDIR}/voices"
mkdir -p "${VOICES_DIR}"

if ! VOICES_DIR="${VOICES_DIR}" bash "${FETCH_SCRIPT}"; then
  echo "[FAIL] fetch-piper-voices.sh devolvió error" >&2
  exit 1
fi

shopt -s nullglob
voices=("${VOICES_DIR}"/*.onnx)
metas=("${VOICES_DIR}"/*.onnx.json)
shopt -u nullglob

if (( ${#voices[@]} == 0 )); then
  echo "[FAIL] no se descargaron voces .onnx" >&2
  exit 1
fi

if (( ${#metas[@]} == 0 )); then
  echo "[FAIL] no se descargaron metadatos .json" >&2
  exit 1
fi

if [[ ! -L "${VOICES_DIR}/default.onnx" ]]; then
  echo "[FAIL] default.onnx no es un symlink" >&2
  exit 1
fi

default_target="$(readlink -f "${VOICES_DIR}/default.onnx")"
if [[ ! -f "${default_target}" ]]; then
  echo "[FAIL] default.onnx apunta a archivo inexistente" >&2
  exit 1
fi

for meta in "${metas[@]}"; do
  sha="$(jq -r '.sha256 // empty' "${meta}" || true)"
  if [[ -n "${sha}" ]]; then
    voice_path="${VOICES_DIR}/$(basename "${meta}" .json)"
    echo "${sha}  ${voice_path}" | sha256sum -c - >/dev/null
  fi
done

echo "[PASS] Voces Piper descargadas correctamente"
