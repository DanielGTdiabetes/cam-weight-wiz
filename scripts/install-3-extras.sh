#!/bin/bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "[install-3-extras] Ejecuta como root (sudo)." >&2
  exit 1
fi

echo "[+] Configurando ALSA (mic USB compartido y salida HiFiBerry)"
cat <<'EOC' > /etc/asound.conf
##### ENTRADA (MICRÓFONO USB) #####
# Dispositivo físico del micrófono USB (ajustado tras `arecord -l`): card 0, device 0
pcm.raw_mic {
  type hw
  card 0
  device 0
}

# dsnoop a 48 kHz (nativo del USB), para acceso simultáneo (Basculín + Recetas)
pcm.dsnoop_mic {
  type dsnoop
  ipc_key 2048
  slave {
    pcm "raw_mic"
    format S16_LE
    rate 48000
    channels 1
    period_time 0
    period_size 1024
    buffer_size 4096
  }
}

# plug que adapta automáticamente la tasa que pidan las apps (ej. 16 kHz)
pcm.bascula_mix_in {
  type plug
  slave.pcm "dsnoop_mic"
}

ctl.bascula_mix_in {
  type hw
  card 0
}

##### SALIDA (HIFIBERRY DAC) #####
# Ajusta la card del DAC si difiere (ver `aplay -l`). En nuestros equipos suele ser card 1, device 0.
pcm.raw_dac {
  type hw
  card 1
  device 0
}

# dmix para permitir múltiples clientes de salida simultáneos
pcm.dmix_dac {
  type dmix
  ipc_key 2049
  slave {
    pcm "raw_dac"
    format S16_LE
    rate 44100
    channels 2
    period_time 0
    period_size 1024
    buffer_size 4096
  }
}

# plug para adaptar cualquier formato a lo que acepte dmix_dac
pcm.bascula_out {
  type plug
  slave.pcm "dmix_dac"
}

ctl.bascula_out {
  type hw
  card 1
}
EOC

if command -v alsactl >/dev/null 2>&1; then
  alsactl store || true
fi

echo "[+] Verificando MIC (arecord a 16 kHz vía bascula_mix_in)"
if command -v arecord >/dev/null 2>&1; then
  if arecord -q -D bascula_mix_in -f S16_LE -r 16000 -c 1 -d 2 /tmp/alsa_mic_test.wav; then
    echo "[OK] MIC grabó correctamente: /tmp/alsa_mic_test.wav"
  else
    echo "[WARN] MIC no disponible. Revisa /etc/asound.conf y arecord -l"
  fi
else
  echo "[WARN] arecord no disponible; omitiendo prueba de micrófono"
fi

echo "[+] Reiniciando bascula-miniweb para aplicar audio I/O"
if command -v systemctl >/dev/null 2>&1; then
  if systemctl restart bascula-miniweb; then
    sleep 2
  else
    echo "[WARN] No se pudo reiniciar bascula-miniweb"
  fi
else
  echo "[WARN] systemctl no disponible; omitiendo reinicio de bascula-miniweb"
fi

echo "[+] Comprobando wake status"
if command -v curl >/dev/null 2>&1; then
  if curl -s http://localhost:8080/api/voice/wake/status | grep -q '"running":true'; then
    echo "[OK] Wake activo y escuchando."
  else
    echo "[WARN] Wake no activo. Revisa logs y envs."
  fi
else
  echo "[WARN] curl no disponible; omitiendo comprobación de wake"
fi

echo "[+] Verificando SALIDA (HiFiBerry) con aplay/speaker-test"
if command -v aplay >/dev/null 2>&1; then
  if [ -f /usr/share/sounds/alsa/Front_Center.wav ]; then
    if aplay -q -D bascula_out /usr/share/sounds/alsa/Front_Center.wav; then
      echo "[OK] Salida HiFiBerry reproducida (Front_Center.wav)."
    else
      echo "[WARN] aplay falló; probando speaker-test tono 440Hz 1s"
      if command -v speaker-test >/dev/null 2>&1; then
        if speaker-test -D bascula_out -t sine -f 440 -l 1 >/dev/null 2>&1; then
          echo "[OK] Tono reproducido."
        else
          echo "[ERROR] Falló la reproducción en bascula_out"
        fi
      else
        echo "[WARN] speaker-test no disponible; omitiendo tono"
      fi
    fi
  else
    if command -v speaker-test >/dev/null 2>&1; then
      if speaker-test -D bascula_out -t sine -f 440 -l 1 >/dev/null 2>&1; then
        echo "[OK] Tono reproducido."
      else
        echo "[ERROR] Falló la reproducción en bascula_out"
      fi
    else
      echo "[WARN] speaker-test no disponible; omitiendo prueba de salida"
    fi
  fi
else
  echo "[WARN] aplay no disponible; intenta con speaker-test"
  if command -v speaker-test >/dev/null 2>&1; then
    if speaker-test -D bascula_out -t sine -f 440 -l 1 >/dev/null 2>&1; then
      echo "[OK] Tono reproducido."
    else
      echo "[ERROR] Falló la reproducción en bascula_out"
    fi
  fi
fi

echo "[+] Probando cámara con libcamera-still"
if command -v libcamera-still >/dev/null 2>&1; then
  TMP_LIBCAM_LOG=$(mktemp -t libcamera-still.XXXXXX.log)
  if libcamera-still -o /tmp/test_cam.jpg --timeout 800 >"$TMP_LIBCAM_LOG" 2>&1; then
    echo "[OK] libcamera-still capturó /tmp/test_cam.jpg"
  else
    status=$?
    echo "[ERROR] libcamera-still falló (código $status). Cámara ocupada — comprobar servicios en ejecución."
    cat "$TMP_LIBCAM_LOG" || true
  fi
  rm -f "$TMP_LIBCAM_LOG"
else
  echo "[WARN] libcamera-still no disponible; omitiendo prueba de cámara"
fi

