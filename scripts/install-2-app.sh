#!/bin/bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "[install-2-app] Ejecuta como root (sudo)." >&2
  exit 1
fi

echo "[+] Configurando /etc/default/bascula-backend (wake desactivado)"
cat <<'EOF' > /etc/default/bascula-backend
# Variables opcionales para la báscula física.
#
# BASCULA_SCALE_PORT=/dev/ttyUSB0
# BASCULA_SCALE_BAUD=9600
# BASCULA_SCALE_PROTOCOL=serial
# BASCULA_SCALE_DEMO=false
# BASCULA_SCALE_TIMEOUT_S=2
#
# Dejar BASCULA_SCALE_DEMO=true fuerza modo demo sin hardware.
BASCULA_WAKE_ENABLED=false
BASCULA_VOSK_ENABLED=false
BASCULA_LISTEN_ENABLED=false
DISABLE_WAKE=1
BASCULA_AUDIO_DEVICE=bascula_out
BASCULA_MIC_DEVICE=bascula_mix_in
BASCULA_SAMPLE_RATE=16000
EOF

echo "[+] Configurando /etc/default/bascula-miniweb (voz desactivada)"
cat <<'EOF' > /etc/default/bascula-miniweb
BASCULA_WAKE_ENABLED=false
BASCULA_VOSK_ENABLED=false
BASCULA_LISTEN_ENABLED=false
DISABLE_WAKE=1
BASCULA_AUDIO_DEVICE=bascula_out
BASCULA_MIC_DEVICE=bascula_mix_in
BASCULA_SAMPLE_RATE=16000
EOF

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reexec || true
  systemctl daemon-reload || true
  systemctl restart bascula-miniweb || true
  systemctl restart bascula-backend || true
else
  echo "[WARN] systemctl no disponible; omitiendo daemon-reload" >&2
fi

