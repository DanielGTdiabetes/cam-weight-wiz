#!/usr/bin/env bash
set -euo pipefail

echo "[test][audio] Listando dispositivos..."
arecord -l || true
aplay -l || true

echo "[test][audio] Probar salida por bascula_out..."
if speaker-test -D bascula_out -t sine -f 1000 -r 44100 -c 2 -l 1 >/dev/null 2>&1; then
  echo "[OK] salida"
else
  echo "[FAIL] salida"
fi

echo "[test][audio] Probar entrada por bascula_mix_in (1s @16kHz mono)..."
timeout 3 arecord -D bascula_mix_in -f S16_LE -r 16000 -c 1 -d 1 /tmp/mic_test.wav >/dev/null 2>&1 || true
if [ -s /tmp/mic_test.wav ]; then
  echo "[OK] entrada (archivo existe y no está vacío)"
else
  echo "[WARN] entrada: /tmp/mic_test.wav vacío; revisa SoftMicGain/Mic"
fi
