#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="${ROOT_DIR}"
DIST_DIR="${ROOT_DIR}/dist"
BACKEND_DIST_DIR="${ROOT_DIR}/backend/dist"

cd "${FRONTEND_DIR}"

if [[ ! -d node_modules ]]; then
  npm install
else
  npm install --no-audit --no-fund
fi

npm run build

mkdir -p "${DIST_DIR}/config"
cp "${DIST_DIR}/index.html" "${DIST_DIR}/config/index.html"

mkdir -p "${BACKEND_DIST_DIR}"
rsync -a --delete "${DIST_DIR}/" "${BACKEND_DIST_DIR}/"

echo "Frontend build listo en ${BACKEND_DIST_DIR}" 
