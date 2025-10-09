#!/bin/bash
set -e

echo "[test] Verificando KMS..."
if [ ! -d /dev/dri ]; then
  echo "[FAIL] No se detecta /dev/dri"
  exit 1
fi
if ! lsmod | grep -q vc4; then
  echo "[WARN] Módulo vc4 no cargado"
else
  echo "[OK] vc4 cargado, entorno KMS operativo"
fi
exit 0
