#!/bin/bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "[install-2-app] Ejecuta como root (sudo)." >&2
  exit 1
fi

echo "[+] Publicando variables de audio en bascula-miniweb (I/O)"
mkdir -p /etc/systemd/system/bascula-miniweb.service.d
cat <<'EOC' > /etc/systemd/system/bascula-miniweb.service.d/21-audio.conf
[Service]
# Entrada (micro compartido → 16 kHz vía plug)
Environment=BASCULA_MIC_DEVICE=bascula_mix_in
Environment=BASCULA_SAMPLE_RATE=16000

# Salida (HiFiBerry con dmix/plug)
Environment=BASCULA_AUDIO_DEVICE=bascula_out
EOC

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
else
  echo "[WARN] systemctl no disponible; omitiendo daemon-reload" >&2
fi

