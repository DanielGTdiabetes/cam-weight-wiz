#!/bin/bash
#
# Script de instalación completa para Báscula Digital Pro (bascula-cam)
# Raspberry Pi 5 + Bookworm Lite 64-bit
# - Instala estructura OTA con versionado
# - Configura HDMI (1024x600), KMS, I2S audio, UART, Camera Module 3
# - Instala Piper TTS, Tesseract OCR, servicios y NetworkManager AP fallback
# - Idempotente con verificaciones exhaustivas
#

set -euo pipefail
IFS=$'\n\t'
trap 'echo "[inst][err] línea $LINENO"; exit 1' ERR

log() { printf '[inst] %s\n' "$*"; }
log_err() { printf '[inst][err] %s\n' "$*" >&2; }
log_warn() { printf '[inst][warn] %s\n' "$*"; }

warn() { log_warn "$@"; }
err() { log_err "$@"; }
fail() { log_err "$*"; exit 1; }

OVERLAY_ADDED=0
INSTALL_LOG=""

disable_cloud_init() {
  local bootcfg_dir="/boot/firmware"
  local mark_file="${bootcfg_dir}/cloud-init.disabled"
  local cmdline="${bootcfg_dir}/cmdline.txt"

  echo "[install] Disabling cloud-init (if present)"

  if [ -d "${bootcfg_dir}" ]; then
    if [ ! -f "${mark_file}" ]; then
      touch "${mark_file}" || true
      echo "[install] Created ${mark_file}"
    else
      echo "[install] Marker already present: ${mark_file}"
    fi

    if [ -f "${cmdline}" ] && ! grep -q 'cloud-init=disabled' "${cmdline}"; then
      sed -i '1 s|$| cloud-init=disabled|' "${cmdline}" || true
      echo "[install] Appended cloud-init=disabled to ${cmdline}"
    fi
  else
    echo "[install] ${bootcfg_dir} not found; skipping boot markers"
  fi

  if [[ "${HAS_SYSTEMD:-0}" -eq 1 ]]; then
    if systemctl list-unit-files | grep -q '^cloud-init\\.service'; then
      systemctl disable --now cloud-init.service cloud-init-local.service cloud-config.service cloud-final.service || true
      systemctl mask cloud-init.service cloud-init-local.service cloud-config.service cloud-final.service || true
      echo "[install] cloud-init services disabled & masked"
    else
      echo "[install] cloud-init services not found (ok)"
    fi
  else
    echo "[install] systemd not available; skipping cloud-init services"
  fi

  echo "[install] cloud-init disabled (reboot recommended)"
}

apt_has() {
  dpkg -s "$1" >/dev/null 2>&1
}

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

ensure_pkg() {
  local pkg
  for pkg in "$@"; do
    apt_has "${pkg}" || apt_install "${pkg}"
  done
}

apt_candidate_exists() {
  local candidate
  candidate=$(apt-cache policy "$1" 2>/dev/null | awk '/Candidate:/ {print $2; exit}')
  [[ -n "${candidate}" && "${candidate}" != "(none)" ]]
}

ensure_user_in_group() {
  local user="$1"
  local group="$2"
  if ! id -u "${user}" >/dev/null 2>&1; then
    warn "Usuario ${user} no existe; omitiendo adición a ${group}"
    return
  fi
  if ! getent group "${group}" >/dev/null 2>&1; then
    warn "Grupo ${group} no existe; omitiendo adición de ${user}"
    return
  fi
  if id -nG "${user}" | tr ' ' '\n' | grep -qx "${group}"; then
    log "Usuario ${user} ya pertenece al grupo ${group}"
    return
  fi
  if usermod -aG "${group}" "${user}"; then
    log "Añadido usuario ${user} al grupo ${group}"
  else
    warn "No se pudo añadir ${user} al grupo ${group}"
  fi
}

ensure_enable_uart() {
  local conf_file="$1"
  if [[ ${SKIP_HARDWARE_CONFIG:-0} == 1 ]]; then
    warn "SKIP_HARDWARE_CONFIG=1, omitiendo forzar enable_uart"
    return
  fi
  if [[ ! -f "${conf_file}" ]]; then
    warn "No se encontró ${conf_file}; creando archivo para habilitar UART"
    if ! touch "${conf_file}"; then
      warn "No se pudo crear ${conf_file}; UART no configurado"
      return
    fi
  fi
  if grep -qE '^\s*enable_uart=1\b' "${conf_file}"; then
    log "UART ya habilitado en ${conf_file}"
    return
  fi
  if grep -qE '^\s*enable_uart=' "${conf_file}"; then
    if sed -i 's/^\s*enable_uart=.*/enable_uart=1/' "${conf_file}"; then
      log "Actualizado enable_uart=1 en ${conf_file}"
    else
      warn "No se pudo actualizar enable_uart en ${conf_file}"
    fi
  else
    {
      printf '\n# Habilitado por instalador de Báscula\n'
      printf 'enable_uart=1\n'
    } >>"${conf_file}" || warn "No se pudo escribir enable_uart en ${conf_file}"
    log "Añadido enable_uart=1 a ${conf_file}"
  fi
}

backup_boot_config_once() {
  local bootcfg="$1"
  local ts="$2"
  if [[ ! -f "${bootcfg}" ]]; then
    warn "config.txt no existe en ${bootcfg}"
    return 1
  fi
  local backup_path="${bootcfg}.bak-${ts}"
  if cp -a "${bootcfg}" "${backup_path}"; then
    printf '[install] Backup: %s\n' "${backup_path}"
  else
    warn "No se pudo crear copia de seguridad ${backup_path}"
    return 1
  fi
}

ensure_bootcfg_line() {
  local bootcfg="$1"
  local re="$2"
  local line="$3"
  if grep -Eq "^[[:space:]]*#?[[:space:]]*$re[[:space:]]*$" "${bootcfg}"; then
    sed -ri "s~^[[:space:]]*#?[[:space:]]*$re[[:space:]]*$~${line}~g" "${bootcfg}"
  else
    printf '%s\n' "${line}" >> "${bootcfg}"
  fi
}

configure_pi_boot_hardware() {
  local bootcfg="${CONF}"
  local ts="$(date +%Y%m%d-%H%M%S)"
  local dac_name="${HW_DAC_NAME:-hifiberry-dac}"
  local block_start="# --- Bascula-Cam: Hardware Configuration ---"
  local block_end="# --- Bascula-Cam (end) ---"

  if [[ ! -f "${bootcfg}" ]]; then
    warn "config.txt no existe en ${bootcfg}"
    return 1
  fi

  if [[ ! -w "${bootcfg}" ]]; then
    warn "No se puede escribir en ${bootcfg}"
    return 1
  fi

  backup_boot_config_once "${bootcfg}" "${ts}" || true

  local cleaned="${bootcfg}.clean.$$"
  if awk -v start="${block_start}" -v end="${block_end}" '
    BEGIN {skip=0}
    $0 == start {skip=1; next}
    skip && $0 == end {skip=0; next}
    !skip {print}
  ' "${bootcfg}" > "${cleaned}"; then
    mv "${cleaned}" "${bootcfg}"
  else
    rm -f "${cleaned}"
    warn "No se pudo limpiar bloque previo Bascula-Cam en ${bootcfg}"
  fi

  {
    printf '\n%s\n' "${block_start}"
    printf '# (autoconfig generado por install-all.sh)\n'
    printf 'dtparam=i2c_arm=on\n'
    printf 'dtparam=i2s=on\n'
    printf 'dtparam=spi=on\n'
    printf 'dtparam=audio=off\n'
    printf 'dtoverlay=i2s-mmap\n'
    printf 'dtoverlay=%s\n' "${dac_name}"
    printf 'camera_auto_detect=1\n'
    printf 'dtoverlay=imx708\n'
    printf '%s\n' "${block_end}"
  } >> "${bootcfg}" || warn "No se pudo escribir bloque Bascula-Cam en ${bootcfg}"

  local tmp_file="${bootcfg}.tmp.$$"
  if awk 'NR==1 {prev=$0; print; next} {if ($0 != prev) print; prev=$0}' "${bootcfg}" > "${tmp_file}"; then
    mv "${tmp_file}" "${bootcfg}"
  else
    rm -f "${tmp_file}"
    warn "No se pudo limpiar duplicados en ${bootcfg}"
  fi

  printf '[install] Cámara Picamera2 configurada\n'
  printf '[install] Boot overlays activados (I2C/I2S/SPI + %s + imx708). Requiere reboot.\n' "${dac_name}"
}

configure_hifiberry_audio() {
  local cards_file="/proc/asound/cards"
  local asound_conf="/etc/asound.conf"

  if [[ ! -f "${cards_file}" ]] || ! grep -qi 'snd_rpi_hifiberry_dac' "${cards_file}"; then
    warn "DAC HifiBerry no detectado; omitiendo configuración de audio"
    return
  fi

  cat > "${asound_conf}" <<'EOF'
# ===========================
# Báscula Digital Pro - Audio Config (verificada)
# ===========================

##### ENTRADA (MICRÓFONO USB) — compatible 48 kHz/16 kHz #####
# Ajusta card/device según tu arecord -l
pcm.dsnoop_mic {
  type dsnoop
  ipc_key 2048
  slave {
    pcm "hw:0,0"
    rate 48000
    channels 1
    format S16_LE
    period_time 0
    period_size 1024
    buffer_size 4096
  }
}

# Ganancia software (control SoftMicGain) encadenada a dsnoop
pcm.soft_mic {
  type softvol
  slave.pcm "dsnoop_mic"
  control {
    name "SoftMicGain"
    card 0
  }
  use_dB yes
  min_dB -30.0
  max_dB +20.0
  resolution 100
}

# EXPOSICIÓN PARA LAS APPS con re-muestreo automático
pcm.bascula_mix_in {
  type plug
  slave.pcm "soft_mic"
}

ctl.bascula_mix_in {
  type hw
  card 0
}

##### SALIDA (HIFIBERRY DAC) #####
# HiFiBerry DAC (card 1)
pcm.bascula_out {
    type plug
    slave.pcm "plughw:CARD=sndrpihifiberry,DEV=0"
}

ctl.bascula_out {
    type hw
    card 1
}

# Alias globales
pcm.!default {
    type plug
    slave.pcm "bascula_out"
}

ctl.!default {
    type hw
    card 1
}
EOF

  if command -v amixer >/dev/null 2>&1; then
    amixer -c 0 sset 'Mic' 16 cap >/dev/null 2>&1 || true
    amixer -c 0 sset 'Auto Gain Control' on >/dev/null 2>&1 || true
    amixer -c 0 sset 'SoftMicGain' 10dB >/dev/null 2>&1 || true
  fi

  printf '[inst][info] SoftMicGain disponible (softvol). Ajustable desde alsamixer (F6->card 0) si fuera necesario.\n'

  if command -v aplay >/dev/null 2>&1; then
    if aplay -L | grep -q 'plughw:CARD=sndrpihifiberry,DEV=0'; then
      printf '[ok] HiFiBerry detectado\n'
    else
      printf '[warn] DAC no encontrado\n'
    fi
  fi

  if command -v alsactl >/dev/null 2>&1; then
    if ! alsactl store >/dev/null 2>&1; then
      warn "No se pudo ejecutar alsactl store"
    fi
  else
    warn "alsactl no disponible; no se guardó el estado de audio"
  fi

  printf '[install] Audio (HifiBerry DAC + mic USB compartido) configurado\n'
}

configure_usb_microphone() {
  if ! amixer -c 0 scontrols >/dev/null 2>&1; then
    warn "No se pudo acceder a controles de la tarjeta 0; omitiendo Mic"
    return
  fi

  if ! amixer -c 0 scontrols 2>/dev/null | grep -q "'Mic'"; then
    warn "Control 'Mic' no disponible en la tarjeta 0"
    return
  fi

  amixer -c 0 sset 'Mic' 16 cap >/dev/null 2>&1 || true
  amixer -c 0 sset 'Auto Gain Control' on >/dev/null 2>&1 || true

  printf '[install] Micrófono USB configurado (Mic=100%%, AGC=on). SoftMicGain listo en alsamixer.\n'
}

configure_miniweb_audio_env() {
  local override_dir="/etc/systemd/system/bascula-miniweb.service.d"
  local override_file="${override_dir}/21-audio.conf"

  install -d -m 0755 "${override_dir}"

  cat > "${override_file}" <<'EOF'
[Service]
Environment="BASCULA_AUDIO_DEVICE=bascula_out"
Environment="BASCULA_MIC_DEVICE=bascula_mix_in"
Environment="BASCULA_SAMPLE_RATE=16000"
EOF

  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reexec || warn "systemctl daemon-reexec falló"
    systemctl daemon-reload || warn "systemctl daemon-reload falló"
    systemctl restart bascula-miniweb || warn "No se pudo reiniciar bascula-miniweb"
  else
    warn "systemctl no disponible; no se pudo aplicar override de audio"
  fi

  printf '[install] Override de audio para bascula-miniweb.service aplicado\n'
}

log_env_audio() {
  if [[ "${HAS_SYSTEMD}" -ne 1 ]]; then
    warn "systemd no disponible; no se puede inspeccionar entorno de bascula-miniweb"
    return
  fi

  log "Inspeccionando entorno de audio de bascula-miniweb"

  local env_output
  if ! env_output=$(systemctl show -p Environment bascula-miniweb 2>/dev/null); then
    warn "No se pudo obtener entorno de bascula-miniweb"
    return
  fi

  env_output=${env_output#Environment=}
  if [[ -z "${env_output}" ]]; then
    warn "variables de audio no presentes en entorno de bascula-miniweb"
    return
  fi

  local env_lines
  env_lines=$(printf '%s' "${env_output}" | tr ' ' '\n')

  local audio_dev mic_dev sample_rate
  audio_dev=$(printf '%s\n' "${env_lines}" | sed -n 's/^BASCULA_AUDIO_DEVICE=//p' | head -n1)
  mic_dev=$(printf '%s\n' "${env_lines}" | sed -n 's/^BASCULA_MIC_DEVICE=//p' | head -n1)
  sample_rate=$(printf '%s\n' "${env_lines}" | sed -n 's/^BASCULA_SAMPLE_RATE=//p' | head -n1)

  if [[ -z "${audio_dev}" || -z "${mic_dev}" || -z "${sample_rate}" ]]; then
    warn "variables de audio no presentes en entorno de bascula-miniweb"
  else
    printf '[inst] BASCULA_AUDIO_DEVICE=%s\n' "${audio_dev}"
    printf '[inst] BASCULA_MIC_DEVICE=%s\n' "${mic_dev}"
    printf '[inst] BASCULA_SAMPLE_RATE=%s\n' "${sample_rate}"
  fi
}

check_playback() {
  log "Verificando SALIDA (HiFiBerry) con aplay/speaker-test"

  if ! command -v aplay >/dev/null 2>&1; then
    warn "aplay no disponible; omitiendo prueba de salida"
    return
  fi

  local cmd_bascula_out=(aplay -D bascula_out -r 44100 -f S16_LE -c 2 -d 1 /dev/zero)
  if "${cmd_bascula_out[@]}"; then
    printf '[inst][ok] salida OK via bascula_out\n'
    return
  fi

  warn "aplay falló via bascula_out (intento 1); reintentando en 2s"
  sleep 2
  if "${cmd_bascula_out[@]}"; then
    printf '[inst][ok] salida OK via bascula_out\n'
    return
  fi

  warn "aplay falló via bascula_out tras reintento; probando hw:1,0"
  local cmd_hw_fallback=(aplay -D hw:1,0 -r 44100 -f S16_LE -c 2 -d 1 /dev/zero)
  if "${cmd_hw_fallback[@]}"; then
    printf '[inst][ok] salida OK via hw:1,0 (fallback)\n'
    return
  fi

  if command -v speaker-test >/dev/null 2>&1; then
    warn "aplay falló via hw:1,0; probando speaker-test"
    if speaker-test -D bascula_out -t sine -f 1000 -r 44100 -c 2 -l 1; then
      log "speaker-test completado tras reintentos"
      printf '[inst][ok] salida OK via bascula_out\n'
      return
    fi
  else
    warn "speaker-test no disponible; omitiendo prueba de tono"
  fi

  warn "reproducción falló en bascula_out y hw:1,0"
}

run_audio_io_self_tests() {
  local restart_service="${1:-1}"
  local waited_param="${2:-0}"
  local waited=0

  if [[ "${restart_service}" -eq 1 ]]; then
    if [[ "${HAS_SYSTEMD}" -eq 1 && "${ALLOW_SYSTEMD:-1}" -eq 1 ]]; then
      log "Recargando systemd y reiniciando bascula-miniweb para aplicar audio I/O"
      if systemctl daemon-reload; then
        if systemctl restart bascula-miniweb; then
          sleep 5
          waited=1
        else
          warn "No se pudo reiniciar bascula-miniweb"
        fi
      else
        warn "systemctl daemon-reload falló"
      fi
    else
      warn "systemd no disponible o ALLOW_SYSTEMD!=1; no se reinició bascula-miniweb"
    fi
  fi

  if [[ "${waited}" -eq 0 && "${waited_param}" -eq 0 ]]; then
    sleep 5
    waited=1
  fi

  log_env_audio

  log "Verificando MIC (arecord vía bascula_mix_in a 16 kHz y 48 kHz)"
  if command -v arecord >/dev/null 2>&1; then
    local rate
    for rate in 16000 48000; do
      local mic_test="/tmp/alsa_mic_test_${rate}.wav"
      if arecord -q -D bascula_mix_in -f S16_LE -r "${rate}" -c 1 -d 2 "${mic_test}"; then
        printf '[inst][ok] MIC grabó correctamente a %s Hz: %s\n' "${rate}" "${mic_test}"
      else
        warn "MIC no disponible a ${rate} Hz. Revisa /etc/asound.conf y arecord -l"
      fi
    done
  else
    warn "arecord no disponible; omitiendo prueba de micrófono"
  fi

  if command -v curl >/dev/null 2>&1; then
    log "Comprobando wake status"
    if curl -s http://localhost:8080/api/voice/wake/status | grep -q '"running":true'; then
      printf '[inst][ok] Wake activo y escuchando\n'
    else
      warn "Wake no activo. Revisa logs y envs"
    fi
  else
    warn "curl no disponible; omitiendo comprobación de wake"
  fi

  check_playback
}

post_install_hardware_checks() {
  if aplay -l >/dev/null 2>&1; then
    printf '[install] aplay -l ok\n'
  else
    warn "Verificación aplay -l falló"
  fi

  if arecord -l >/dev/null 2>&1; then
    printf '[install] arecord -l ok\n'
  else
    warn "Verificación arecord -l falló"
  fi

  local picamera_msg
  if picamera_msg=$(python3 -c "from picamera2 import Picamera2; print('Picamera2 OK')" 2>/dev/null); then
    if [[ -n "${picamera_msg}" ]]; then
      printf '[install] %s\n' "${picamera_msg}"
    else
      printf '[install] Picamera2 OK\n'
    fi
  else
    warn "Picamera2 no disponible o falló la prueba"
  fi
}

# --- Require root privileges ---
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  err "Ejecuta con sudo: sudo ./install-all.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Detect systemd availability early
HAS_SYSTEMD=0
[ -d /run/systemd/system ] && HAS_SYSTEMD=1
if [[ "${HAS_SYSTEMD}" -eq 0 ]]; then
  warn "systemd no está activo (PID 1); se omitirán comandos systemctl"
fi

ALLOW_SYSTEMD="${ALLOW_SYSTEMD:-1}"

systemctl_safe() {
  if [[ "${HAS_SYSTEMD}" -eq 1 ]]; then
    if ! systemctl "$@"; then
      warn "systemctl $* falló"
    fi
  else
    warn "systemd no disponible: systemctl $* omitido"
  fi
}

configure_bascula_ui_service() {
  local unit="/etc/systemd/system/bascula-ui.service"
  local override_dir="${unit}.d"
  local override_file="${override_dir}/override.conf"
  local target_uid
  local tmp_file
  local previous_umask

  target_uid="$(id -u "${TARGET_USER}" 2>/dev/null || id -u pi 2>/dev/null || printf '%s' '1000')"

  install -d -m 0755 "${override_dir}"

  previous_umask="$(umask)"
  umask 022
  tmp_file="$(mktemp "${override_dir}/override.conf.tmp.XXXXXX")"
  cat > "${tmp_file}" <<EOF
[Unit]
After=network-online.target bascula-miniweb.service systemd-user-sessions.service
Wants=network-online.target bascula-miniweb.service
StartLimitIntervalSec=0

[Service]
ExecStart=
ExecStartPre=
User=${TARGET_USER}
Group=${TARGET_GROUP}
Environment=HOME=${TARGET_HOME}
Environment=USER=${TARGET_USER}
Environment=DISPLAY=:0
Environment=XDG_RUNTIME_DIR=/run/user/${target_uid}
PermissionsStartOnly=yes
ExecStartPre=/bin/sh -c 'install -d -m0700 -o ${TARGET_USER} -g ${TARGET_GROUP} /run/user/${target_uid} && \
  install -d -m0755 -o ${TARGET_USER} -g ${TARGET_GROUP} /var/log/bascula && \
  install -o ${TARGET_USER} -g ${TARGET_GROUP} -m0644 /dev/null /var/log/bascula/ui.log && \
  rm -f /tmp/.X0-lock'
ExecStart=/usr/bin/startx ${BASCULA_CURRENT_LINK}/.xinitrc -- :0 vt1 -nocursor
Restart=always
RestartSec=3
EOF
  sed -i 's/\r$//' "${tmp_file}"
  if [[ $(tail -c1 "${tmp_file}" 2>/dev/null || printf '\n') != $'\n' ]]; then
    printf '\n' >> "${tmp_file}"
  fi
  umask "${previous_umask}"

  if [[ -f "${override_file}" ]] && cmp -s "${tmp_file}" "${override_file}"; then
    log "Override sin cambios"
  else
    install -m0644 "${tmp_file}" "${override_file}"
    log "Override actualizado"
  fi
  rm -f "${tmp_file}"

  if [[ "${HAS_SYSTEMD}" -eq 1 && "${ALLOW_SYSTEMD:-1}" -eq 1 ]]; then
    systemctl daemon-reload
    if ! systemd-analyze verify bascula-ui.service; then
      log_err "verify falló"
      journalctl -u bascula-ui -b -n 200 || true
      exit 1
    fi
    log "systemd-analyze verify bascula-ui.service ok"

    if ! systemctl enable --now bascula-miniweb.service; then
      log_err "No se pudo habilitar bascula-miniweb.service"
      systemctl status bascula-miniweb.service --no-pager || true
      exit 1
    fi

    local backend_ready=0
    if command -v curl >/dev/null 2>&1; then
      for _ in {1..15}; do
        if curl -sf http://127.0.0.1:8080/health >/dev/null; then
          backend_ready=1
          break
        fi
        sleep 1
      done
      if (( backend_ready == 1 )); then
        log "Backend miniweb saludable"
      else
        log_warn "Backend miniweb no respondió en http://127.0.0.1:8080/health"
      fi
    else
      log_warn "curl no disponible para verificar miniweb"
    fi

    if [[ -x "${SCRIPT_DIR}/test-x-kms.sh" ]]; then
      log "Ejecutando verificación KMS (/dev/dri)..."
      "${SCRIPT_DIR}/test-x-kms.sh"
    else
      warn "scripts/test-x-kms.sh no disponible o sin permisos de ejecución"
    fi

    # Confirmar presencia de /dev/dri (necesario para X/Chromium)
    if [ ! -d /dev/dri ]; then
      echo "[inst][error] No se detecta /dev/dri; probablemente falta el overlay KMS."
      echo "[inst][hint] Revisa /boot/firmware/config.txt y asegúrate de tener dtoverlay=vc4-kms-v3d-pi5"
      exit 1
    fi

    if ! systemctl enable bascula-ui.service; then
      log_err "No se pudo habilitar bascula-ui.service"
      systemctl status bascula-ui.service --no-pager || true
      exit 1
    fi

    if ! systemctl restart bascula-ui.service; then
      log_err "No se pudo reiniciar bascula-ui.service"
      journalctl -u bascula-ui.service -n 50 || true
      exit 1
    fi

    if ! systemctl is-active --quiet bascula-ui.service; then
      log_err "bascula-ui no activo"
      systemctl status bascula-ui --no-pager -l || true
      exit 1
    fi
    log "UI activa"
  else
    warn "systemd no disponible o ALLOW_SYSTEMD!=1; se omitió verificación/reinicio de bascula-ui.service"
  fi

  local kiosk_procs
  if kiosk_procs="$(pgrep -a -f 'Xorg|startx|openbox|chromium' 2>/dev/null)"; then
    log "Procesos kiosk detectados:"
    printf '%s\n' "${kiosk_procs}"
  else
    warn "No se detectaron procesos kiosk (Xorg/startx/openbox/chromium)"
    if [[ "${HAS_SYSTEMD}" -eq 1 && "${ALLOW_SYSTEMD:-1}" -eq 1 ]]; then
      journalctl -u bascula-ui.service -n 50 || true
    fi
  fi

  if command -v curl >/dev/null 2>&1; then
    log "miniweb status (curl http://127.0.0.1:8080/api/miniweb/status):"
    if ! curl -sS http://127.0.0.1:8080/api/miniweb/status; then
      warn "No se pudo consultar miniweb status"
    fi
  else
    warn "curl no disponible para consultar miniweb status"
  fi
}

safe_install() {
  local src="$1"
  local dst="$2"
  if [ -e "${src}" ] && [ -e "${dst}" ]; then
    local src_real dst_real
    src_real=$(readlink -f "${src}" 2>/dev/null || echo "")
    dst_real=$(readlink -f "${dst}" 2>/dev/null || echo "")
    if [[ -n "${src_real}" && -n "${dst_real}" && "${src_real}" == "${dst_real}" ]]; then
      echo "[inst][info] skip install: ${dst} ya es el mismo fichero"
      return 0
    fi
  fi
  install -m 0755 "${src}" "${dst}"
}

install_x735() {
  echo "[inst] [X735] Configurando soporte x735 (fan/power)…"

  if ! command -v git >/dev/null 2>&1; then
    if [[ "${NET_OK:-0}" -eq 1 ]]; then
      ensure_pkg git || warn "[X735] No se pudo instalar git"
    else
      echo "[inst] [X735][warn] git no disponible y sin red; los servicios se configurarán en cuanto esté disponible"
    fi
  fi

  # Sello de idempotencia
  install -d -m 0755 /var/lib

  # Script ensure (se reintenta en cada boot hasta ver PWM)
  install -d -m 0755 /usr/local/sbin
  install -d -m 0755 /etc/systemd/system

  # X735 ensure: instalar, habilitar y EJECUTAR ahora
  install -m 0755 system/os/x735-ensure.sh /usr/local/sbin/x735-ensure.sh
  install -m 0644 system/os/x735-ensure.service /etc/systemd/system/x735-ensure.service || true
  chmod +x /usr/local/sbin/x735-ensure.sh

  if [ -d /run/systemd/system ]; then
    systemctl daemon-reload
    systemctl enable x735-ensure.service || true
    systemctl start x735-ensure.service || true
    systemctl enable --now x735-fan.service 2>/dev/null || true
    systemctl enable --now x735-pwr.service 2>/dev/null || true
    systemctl is-active --quiet x735-ensure.service && echo "[inst] ✓ X735 ensure ejecutado (sin reboot)"
    systemctl is-active --quiet x735-fan.service && echo "[inst] ✓ X735 fan activo"
    systemctl is-active --quiet x735-pwr.service && echo "[inst] ✓ X735 power activo"
  else
    /usr/local/sbin/x735-ensure.sh --oneshot || /usr/local/sbin/x735-ensure.sh || true
  fi

  echo "[inst] ✓ X735 configurado (ensure service instalado)"
}

# --- Configuration variables ---
TARGET_USER="${SUDO_USER:-pi}"
TARGET_ENTRY="$(getent passwd "$TARGET_USER" || true)"
if [[ -z "${TARGET_ENTRY}" ]]; then
  warn "Usuario ${TARGET_USER} no encontrado; usando $(id -un)"
  TARGET_USER="$(id -un)"
  TARGET_ENTRY="$(getent passwd "$TARGET_USER" || true)"
fi

TARGET_GROUP="${TARGET_USER}"
if [[ -n "${TARGET_ENTRY}" ]]; then
  TARGET_GID="$(printf '%s' "${TARGET_ENTRY}" | cut -d: -f4)"
  TARGET_HOME="$(printf '%s' "${TARGET_ENTRY}" | cut -d: -f6)"
  if [[ -n "${TARGET_GID}" ]]; then
    TARGET_GROUP="$(getent group "${TARGET_GID}" | cut -d: -f1)"
  fi
else
  TARGET_HOME="${HOME:-/root}"
fi

if [[ -z "${TARGET_HOME}" ]]; then
  err "No se pudo determinar el home de ${TARGET_USER}"
  exit 1
fi

# Asegura que el grupo existe; si el gid no se resolvió usa el del usuario
if [[ -z "${TARGET_GROUP}" ]] || ! getent group "${TARGET_GROUP}" &>/dev/null; then
  TARGET_GROUP="$(id -gn "${TARGET_USER}")"
fi

BASCULA_ROOT="/opt/bascula"
BASCULA_RELEASES_DIR="${BASCULA_ROOT}/releases"
BASCULA_CURRENT_LINK="${BASCULA_ROOT}/current"
CFG_DIR="${TARGET_HOME}/.bascula"
CFG_PATH="${CFG_DIR}/config.json"
STATE_DIR="/var/lib/bascula"
STATE_FILE="${STATE_DIR}/scale.json"
LOG_DIR="/var/log/bascula"
INSTALL_LOG="${LOG_DIR}/install.log"

AP_IFACE="wlan0"
AP_GATEWAY="192.168.4.1"
AP_SSID="${AP_SSID:-Bascula-AP}"
AP_PASS="${AP_PASS:-Bascula1234}"
AP_NAME="${AP_NAME:-BasculaAP}"
AP_POOL_START="${AP_POOL_START:-192.168.4.20}"
AP_POOL_END="${AP_POOL_END:-192.168.4.99}"

BOOTDIR="/boot/firmware"
[[ ! -d "${BOOTDIR}" ]] && BOOTDIR="/boot"
CONF="${BOOTDIR}/config.txt"

log "============================================"
log "  Instalación Completa - Báscula Digital Pro"
log "============================================"
log "Target user      : $TARGET_USER ($TARGET_GROUP)"
log "Target home      : $TARGET_HOME"
log "OTA current link : $BASCULA_CURRENT_LINK"
log "AP (NM)          : SSID=${AP_SSID} PASS=<oculto> IFACE=${AP_IFACE}"

# Check internet connection
log "[1/20] Verificando conexión a Internet..."
if ! ping -c 1 google.com &> /dev/null; then
    warn "Sin conexión a Internet. Instalación limitada."
    NET_OK=0
else
    log "✓ Conexión verificada"
    NET_OK=1
fi

# Detect architecture
ARCH=$(uname -m)
if [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "armv7l" ]; then
    warn "No se detectó arquitectura ARM. Este script está diseñado para Raspberry Pi."
fi

# Update system
log "[2/20] Actualizando el sistema..."
if [[ "${NET_OK}" -eq 1 ]]; then
    if ! apt-get update -y; then
        warn "apt-get update falló; continúa con el resto de la instalación"
    elif ! apt-get upgrade -y; then
        warn "apt-get upgrade falló; continúa con el resto de la instalación"
    else
        log "✓ Sistema actualizado"
    fi
else
    warn "Sin red: omitiendo apt-get update/upgrade"
fi

# Install base system packages
log "[3/20] Instalando dependencias del sistema..."
if [[ "${NET_OK}" -eq 1 ]]; then
    BASE_PACKAGES=(
        git curl ca-certificates build-essential cmake pkg-config
        python3 python3-venv python3-pip python3-dev python3-tk python3-numpy python3-serial
        python3-pil python3-pil.imagetk python3-xdg
        x11-xserver-utils xserver-xorg-legacy xinit openbox
        fonts-dejavu-core fonts-noto-core
        libjpeg-dev zlib1g-dev libpng-dev
        alsa-utils pulseaudio sox ffmpeg
        libzbar0 gpiod python3-rpi.gpio
        network-manager dnsmasq-base dnsutils jq sqlite3 tesseract-ocr tesseract-ocr-spa espeak-ng
        uuid-runtime
    )
    if apt_install "${BASE_PACKAGES[@]}"; then
        log "✓ Dependencias base instaladas"
    else
        warn "No se pudieron instalar todas las dependencias base"
    fi

    # Ensure global dnsmasq daemon is never installed/active (only dnsmasq-base needed)
    log "Asegurando que dnsmasq global no esté activo..."
    if [[ "${HAS_SYSTEMD}" -eq 1 ]]; then
      systemctl disable --now dnsmasq 2>/dev/null || true
      systemctl mask dnsmasq 2>/dev/null || true
    else
      warn "systemd no disponible: omitiendo systemctl para dnsmasq"
    fi
    apt-get -y purge dnsmasq 2>/dev/null || true
    # Install only dnsmasq-base (library for NetworkManager)
    ensure_pkg dnsmasq-base
    log "✓ dnsmasq-base instalado (dnsmasq global removido)"

    ensure_pkg xorg
    ensure_pkg unclutter
    ensure_pkg python3-serial
else
    warn "Sin red: omitiendo la instalación de dependencias base"
    warn "Instala manualmente python3-serial para el backend UART"
fi

CHROME_PKG=""
if apt_candidate_exists chromium; then
  CHROME_PKG="chromium"
fi
if apt_candidate_exists chromium-browser; then
  CHROME_PKG="${CHROME_PKG:-chromium-browser}"
fi

if [[ -n "${CHROME_PKG}" ]]; then
  if [[ "${NET_OK}" -eq 1 ]]; then
    ensure_pkg "${CHROME_PKG}"
  fi
  log "✓ Paquete Chromium seleccionado: ${CHROME_PKG}"
else
  fail "No se encontró paquete Chromium disponible en apt-cache"
fi

POLKIT_PKG=""
if apt_candidate_exists policykit-1; then
  POLKIT_PKG="policykit-1"
fi
if apt_candidate_exists polkitd; then
  POLKIT_PKG="${POLKIT_PKG:-polkitd}"
fi

if [[ -n "${POLKIT_PKG}" && "${NET_OK}" -eq 1 ]]; then
  ensure_pkg "${POLKIT_PKG}"
  log "✓ Paquete Polkit seleccionado: ${POLKIT_PKG}"
elif [[ -n "${POLKIT_PKG}" ]]; then
  log "✓ Paquete Polkit detectado: ${POLKIT_PKG}"
else
  warn "No se encontró paquete Polkit disponible en apt-cache"
fi

STARTX_BIN="$(command -v startx || command -v xinit || true)"
if [[ -z "${STARTX_BIN}" ]]; then
  fail "Falta startx/xinit tras la instalación"
fi
log "✓ Binario X detectado: ${STARTX_BIN}"

if ! command -v openbox >/dev/null 2>&1; then
  fail "Falta openbox tras la instalación"
fi

CHROME_BIN="$(command -v chromium || command -v chromium-browser || true)"
if [[ -z "${CHROME_BIN}" ]]; then
  fail "Falta Chromium tras la instalación"
fi
log "✓ Binario Chromium detectado: ${CHROME_BIN}"

POLICY_DIR="/etc/chromium/policies/managed"
POLICY_PATH="${POLICY_DIR}/bascula_policy.json"
install -d -m 0755 "${POLICY_DIR}"
cat <<'EOF' > "${POLICY_PATH}.tmp"
{
  "AudioCaptureAllowed": true,
  "VideoCaptureAllowed": true,
  "AutoplayAllowed": true,
  "DefaultAudioCaptureSetting": 1,
  "DefaultVideoCaptureSetting": 1,
  "URLAllowlist": [
    "http://127.0.0.1:8080",
    "http://localhost:8080"
  ]
}
EOF
install -m 0644 "${POLICY_PATH}.tmp" "${POLICY_PATH}"
rm -f "${POLICY_PATH}.tmp"
log "✓ Política gestionada de Chromium actualizada en ${POLICY_PATH}"

log "Configurando GPIO para HX711 y persistencia de báscula..."
if [[ "${NET_OK}" -eq 1 ]]; then
  ensure_pkg python3-lgpio
else
  warn "Sin red: instala python3-lgpio manualmente para habilitar el backend lgpio"
fi

if [[ "${NET_OK}" -eq 1 ]]; then
  if apt_candidate_exists python3-pigpio; then
    ensure_pkg python3-pigpio
  else
    log "python3-pigpio no disponible en apt-cache; se omite instalación"
  fi
  if apt_candidate_exists pigpiod; then
    ensure_pkg pigpiod
  else
    log "pigpiod no disponible en apt-cache; se omite instalación"
  fi
else
  log "Sin red: omitiendo instalación opcional de python3-pigpio/pigpiod"
fi

PIGPIOD_SERVICE_FILE=""
for candidate in /lib/systemd/system/pigpiod.service /etc/systemd/system/pigpiod.service; do
  if [[ -f "${candidate}" ]]; then
    PIGPIOD_SERVICE_FILE="${candidate}"
    break
  fi
done

if [[ -n "${PIGPIOD_SERVICE_FILE}" ]]; then
  log "Servicio pigpiod detectado; habilitando si es posible"
  systemctl_safe enable pigpiod
  systemctl_safe start pigpiod
else
  log "Servicio pigpiod no disponible; se omite enable/start"
fi

if getent group pigpio >/dev/null 2>&1; then
  ensure_user_in_group "${TARGET_USER}" pigpio
else
  log "Grupo pigpio no encontrado; se omite adición de ${TARGET_USER}"
fi

mkdir -p "${STATE_DIR}"
chown "${TARGET_USER}:${TARGET_GROUP}" "${STATE_DIR}" 2>/dev/null || true
if [[ ! -f "${STATE_FILE}" ]]; then
  cat > "${STATE_FILE}" <<'EOF'
{
  "calibration_factor": 1.0,
  "tare_offset": 0.0
}
EOF
  log "Archivo de estado de báscula inicializado en ${STATE_FILE}"
fi
chmod 664 "${STATE_FILE}" 2>/dev/null || true
chown "${TARGET_USER}:${TARGET_GROUP}" "${STATE_FILE}" 2>/dev/null || true

mkdir -p "${LOG_DIR}"
touch "${LOG_DIR}/app.log"
touch "${INSTALL_LOG}"
chown "${TARGET_USER}:${TARGET_GROUP}" "${LOG_DIR}" 2>/dev/null || true
chown "${TARGET_USER}:${TARGET_GROUP}" "${LOG_DIR}/app.log" 2>/dev/null || true
chown "${TARGET_USER}:${TARGET_GROUP}" "${INSTALL_LOG}" 2>/dev/null || true
chmod 664 "${LOG_DIR}/app.log" 2>/dev/null || true
chmod 664 "${INSTALL_LOG}" 2>/dev/null || true

# Ensure NetworkManager service is enabled and running
log "[3a/20] Reinstalando NetworkManager..."
if [[ "${NET_OK}" -eq 1 ]]; then
    if ! apt-get install -y network-manager; then
        warn "No se pudo reinstalar NetworkManager"
    fi
else
    warn "Sin red: omitiendo reinstalación de NetworkManager"
fi
systemctl_safe enable NetworkManager --now
systemctl_safe enable NetworkManager-wait-online.service

# Install camera dependencies
log "[4/20] Instalando dependencias de cámara..."
if [[ "${NET_OK}" -eq 1 ]]; then
    if apt-get install -y rpicam-apps libcamera-apps v4l-utils python3-picamera2; then
        log "✓ Dependencias de cámara instaladas"
    else
        warn "No se pudieron instalar dependencias de cámara"
    fi
else
    warn "Sin red: omitiendo dependencias de cámara"
fi

log "[4a/20] Instalando herramientas de audio..."
if [[ "${NET_OK}" -eq 1 ]]; then
    if apt-get install -y alsa-utils pulseaudio sox ffmpeg; then
        log "✓ Herramientas de audio instaladas"
    else
        warn "No se pudieron instalar herramientas de audio"
    fi
else
    warn "Sin red: omitiendo herramientas de audio"
fi

ensure_vosk_es() {
  set -euo pipefail
  local dest_dir="/opt/vosk"
  local model_dir="${dest_dir}/es-small"
  local tmp_zip="/tmp/vosk-es-small.$$"
  local url="https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip"
  local expected_hash="09b239888f633ef2f0b4e09736e3d9936acfd810bc65d53fad45261762c6511f"

  mkdir -p "${dest_dir}"

  if [[ -d "${model_dir}" ]]; then
    log "[install] Modelo Vosk ES ya presente"
    return
  fi

  if [[ "${NET_OK}" != "1" ]]; then
    warn "Sin red: omitiendo descarga de modelo Vosk"
    return
  fi

  log "[install] Descargando modelo Vosk ES (small)"
  rm -f "${tmp_zip}" "${tmp_zip}.zip"
  tmp_zip="${tmp_zip}.zip"
  if ! curl -fsSL -o "${tmp_zip}" "${url}"; then
    warn "No se pudo descargar el modelo Vosk ES; la URL podría haber cambiado"
    rm -f "${tmp_zip}"
    return
  fi

  if [[ ! -s "${tmp_zip}" ]]; then
    warn "Modelo Vosk ES descargado vacío; revisa la URL"
    rm -f "${tmp_zip}"
    return
  fi

  local file_hash
  file_hash="$(sha256sum "${tmp_zip}" | awk '{print $1}')"
  if [[ "${file_hash}" != "${expected_hash}" ]]; then
    err "[install] ERROR checksum voz Vosk: esperado ${expected_hash}, obtenido ${file_hash}"
    rm -f "${tmp_zip}"
    return
  fi

  mkdir -p "${dest_dir}"/tmp_extract
  if unzip -q "${tmp_zip}" -d "${dest_dir}"/tmp_extract; then
    rm -f "${tmp_zip}"
    if [[ -d "${dest_dir}"/tmp_extract/vosk-model-small-es-0.42 ]]; then
      mv "${dest_dir}"/tmp_extract/vosk-model-small-es-0.42 "${model_dir}"
      log "✓ Modelo Vosk ES instalado"
    else
      warn "No se encontró el directorio esperado tras descomprimir Vosk"
    fi
  else
    warn "No se pudo descomprimir el modelo Vosk"
  fi
  rm -rf "${dest_dir}"/tmp_extract || true
}

ensure_vosk_es || true

# Install Node.js
log "[5/20] Instalando Node.js..."
if ! command -v node &> /dev/null; then
    if [[ "${NET_OK}" -eq 1 ]]; then
        if curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; then
            if apt-get install -y nodejs; then
                log "✓ Node.js $(node --version) instalado"
            else
                warn "No se pudo instalar Node.js"
            fi
        else
            warn "No se pudo descargar el instalador de NodeSource"
        fi
    else
        warn "Sin red: omitiendo instalación de Node.js"
    fi
else
    log "✓ Node.js $(node --version) instalado"
fi

# Configure hardware permissions
log "[6/20] Configurando permisos de hardware..."
HARDWARE_GROUPS=(video render input dialout i2c gpio audio netdev)
for grp in "${HARDWARE_GROUPS[@]}"; do
  if getent group "${grp}" >/dev/null 2>&1; then
    usermod -aG "${grp}" "${TARGET_USER}" || warn "No se pudo añadir ${TARGET_USER} al grupo ${grp}"
  else
    warn "Grupo ${grp} no existe en el sistema; omitiendo"
  fi
done
if ! usermod -aG video,render,input,dialout "${TARGET_USER}"; then
  warn "No se pudieron añadir grupos básicos de hardware a ${TARGET_USER}"
fi
log "✓ Usuario ${TARGET_USER} añadido a grupos disponibles"

# Garantiza acceso a UART para usuario pi
ensure_user_in_group "pi" "dialout"

# Configure boot config
log "[7/20] Configurando boot/config.txt..."

if [[ ! -f "${CONF}" ]]; then
  warn "No se encontró ${CONF}; omitiendo configuración de arranque"
elif [[ "${SKIP_HARDWARE_CONFIG:-0}" == "1" ]]; then
  warn "SKIP_HARDWARE_CONFIG=1, saltando modificación de config.txt"
elif grep -qi "raspberry pi" /proc/device-tree/model 2>/dev/null; then
  disable_cloud_init || true
  if ! configure_pi_boot_hardware; then
    warn "No se pudo completar la autoconfiguración de hardware"
  fi
else
  warn "Equipo no identificado como Raspberry Pi; omitiendo autoconfiguración de hardware"
fi

ensure_enable_uart "${CONF}"

configure_hifiberry_audio
configure_usb_microphone

install -m 0755 "${SCRIPT_DIR}/test-audio.sh" /usr/local/bin/bascula-test-audio
/usr/local/bin/bascula-test-audio || true

# --- KMS check (Pi5) ---
if grep -q "Raspberry Pi 5" /proc/device-tree/model 2>/dev/null; then
  CONFIG_FILE="${BOOTDIR}/config.txt"
  if [[ ! -f "${CONFIG_FILE}" ]]; then
    echo "[inst][warn] ${CONFIG_FILE} no existe; no se puede insertar overlay vc4-kms-v3d-pi5"
  elif ! grep -qE "^dtoverlay=vc4-kms-v3d-pi5" "${CONFIG_FILE}"; then
    echo "[inst][warn] Overlay vc4-kms-v3d-pi5 ausente; insertando..."
    if printf '%s\n' "dtoverlay=vc4-kms-v3d-pi5" >> "${CONFIG_FILE}"; then
      overlay_added_msg="[inst][info] Overlay añadido; se aplicará tras reinicio."
      echo "${overlay_added_msg}"
      OVERLAY_ADDED=1
      if [[ -n "${INSTALL_LOG}" ]]; then
        printf '%s\n' "${overlay_added_msg}" >> "${INSTALL_LOG}" 2>/dev/null || true
      fi
    else
      echo "[inst][error] No se pudo escribir dtoverlay=vc4-kms-v3d-pi5 en ${CONFIG_FILE}"
    fi
  else
    echo "[inst][ok] Overlay vc4-kms-v3d-pi5 ya presente."
  fi
else
  echo "[inst][info] Dispositivo no Pi5; se omite overlay KMS."
fi

# Disable Bluetooth UART
if [[ "${HAS_SYSTEMD}" -eq 1 ]]; then
  if systemctl list-unit-files | grep -q '^hciuart.service'; then
    systemctl disable --now hciuart 2>/dev/null || warn "No se pudo deshabilitar hciuart"
  else
    log "hciuart.service no existe; nada que deshabilitar"
  fi
else
  warn "systemd no disponible: hciuart no puede deshabilitarse en esta sesión"
fi
systemctl_safe disable --now serial-getty@ttyAMA0.service
systemctl_safe disable --now serial-getty@ttyS0.service

# Run fix-serial script
log "Ejecutando fix-serial.sh..."
bash "${SCRIPT_DIR}/fix-serial.sh" || warn "fix-serial.sh falló, continuar de todos modos"
log "✓ Serial configurado"

# Configure Xwrapper
log "[8/20] Configurando Xwrapper..."
for config in /etc/Xwrapper.config /etc/X11/Xwrapper.config; do
    install -D -m 0644 /dev/null "${config}"
    cat > "${config}" <<'EOF'
allowed_users=anybody
needs_root_rights=yes
EOF
done
if [[ -f /usr/lib/xorg/Xorg ]]; then
  chown root:root /usr/lib/xorg/Xorg || warn "No se pudo ajustar propietario de Xorg"
  chmod 4755 /usr/lib/xorg/Xorg || warn "No se pudo ajustar permisos de Xorg"
else
  warn "/usr/lib/xorg/Xorg no existe; omitiendo ajustes de permisos"
fi
echo "xserver-xorg-legacy xserver-xorg-legacy/allowed_users select Anybody" | debconf-set-selections
DEBIAN_FRONTEND=noninteractive dpkg-reconfigure xserver-xorg-legacy || true
log "✓ Xwrapper configurado"

# Configure Xorg to use KMS/modesetting instead of fbdev
log "[8b/20] Configurando Xorg para KMS (modesetting driver)..."
# Remove fbdev driver if installed to prevent framebuffer mode
apt-get purge -y xserver-xorg-video-fbdev 2>/dev/null || true
apt-get autoremove -y || true

# Remove any fbdev config files
rm -f /usr/share/X11/xorg.conf.d/*fbdev*.conf /etc/X11/xorg.conf.d/*fbdev*.conf 2>/dev/null || true

# Force modesetting driver (KMS/DRM) for Raspberry Pi 5
install -d -m 0755 /etc/X11/xorg.conf.d
cat > /etc/X11/xorg.conf.d/10-modesetting.conf <<'EOF'
Section "Device"
  Identifier "Modesetting"
  Driver "modesetting"
  Option "AccelMethod" "glamor"
EndSection
EOF

log "✓ Xorg configurado para KMS (modesetting)"

# Configure Xorg to use correct DRM card (vc4 = card1)
log "[8c/20] Configurando Xorg para usar card1 (vc4)..."
cat > /etc/X11/xorg.conf.d/10-modesetting.conf <<'EOF'
Section "Device"
  Identifier "vc4"
  Driver "modesetting"
  Option "AccelMethod" "glamor"
  Option "kmsdev" "/dev/dri/card1"
EndSection

Section "Screen"
  Identifier "Screen0"
  Device "vc4"
EndSection
EOF
log "✓ Xorg configurado para DRM card1"

# Configure Polkit rules
log "[9/20] Configurando Polkit..."
install -d -m 0755 /etc/polkit-1/rules.d

ensure_user_in_group "${TARGET_USER}" netdev
if [[ "${TARGET_USER}" != "pi" ]]; then
  ensure_user_in_group pi netdev
fi

POLKIT_RULE_SRC="${PROJECT_ROOT}/packaging/polkit/49-nmcli.rules"
if [[ -f "${POLKIT_RULE_SRC}" ]]; then
  install -m 0644 "${POLKIT_RULE_SRC}" /etc/polkit-1/rules.d/49-nmcli.rules
else
  warn "No se encontró ${POLKIT_RULE_SRC}; creando regla básica"
  install -m 0644 /dev/null /etc/polkit-1/rules.d/49-nmcli.rules
    cat > /etc/polkit-1/rules.d/49-nmcli.rules <<'EOF'
polkit.addRule(function(action, subject) {
  if (subject.isInGroup("netdev") || subject.user == "pi") {
    if (action.id == "org.freedesktop.NetworkManager.settings.modify.system") {
      return polkit.Result.YES;
    }
    if (action.id == "org.freedesktop.NetworkManager.settings.modify.own") {
      return polkit.Result.YES;
    }
    if (action.id == "org.freedesktop.NetworkManager.network-control") {
      return polkit.Result.YES;
    }
    if (action.id == "org.freedesktop.NetworkManager.wifi.scan") {
      return polkit.Result.YES;
    }
    if (action.id == "org.freedesktop.NetworkManager.enable-disable-wifi") {
      return polkit.Result.YES;
    }
  }
});
EOF
fi

cat > /etc/polkit-1/rules.d/51-bascula-systemd.rules <<EOF
polkit.addRule(function(action, subject) {
  var id = action.id;
  var unit = action.lookup("unit") || "";
  function allowed(u) {
    return u == "bascula-miniweb.service" || u == "bascula-ui.service" || u == "ocr-service.service";
  }
  if ((subject.user == "${TARGET_USER}" || subject.isInGroup("${TARGET_GROUP}")) &&
      (id == "org.freedesktop.systemd1.manage-units" ||
       id == "org.freedesktop.systemd1.restart-unit" ||
       id == "org.freedesktop.systemd1.start-unit" ||
       id == "org.freedesktop.systemd1.stop-unit") &&
      allowed(unit)) {
    return polkit.Result.YES;
  }
});
EOF

if id -u pi >/dev/null 2>&1 && ! id -nG pi | tr ' ' '\n' | grep -qw netdev; then
  fail "pi no pertenece a netdev tras la instalación"
fi

if [[ -f /etc/polkit-1/rules.d/49-nmcli.rules ]]; then
  log "Regla Polkit 49-nmcli.rules instalada"
else
  fail "No se encontró /etc/polkit-1/rules.d/49-nmcli.rules"
fi

# === Bascula AP profile + polkit + recargas ===
set -e

# Instalar siempre la regla polkit (ya creada antes)
if [ -f system/os/10-bascula-nm.rules ]; then
  install -D -m 0644 system/os/10-bascula-nm.rules /etc/polkit-1/rules.d/10-bascula-nm.rules
else
  warn "No se encontró system/os/10-bascula-nm.rules; instalando regla básica"
  cat >/etc/polkit-1/rules.d/10-bascula-nm.rules <<'EOF'
polkit.addRule(function(action, subject) {
  if (subject.user === "pi") {
    if (action.id.startsWith("org.freedesktop.NetworkManager.")) {
      return polkit.Result.YES;
    }
    if (action.id.startsWith("org.freedesktop.NetworkManager.settings.")) {
      return polkit.Result.YES;
    }
  }
});
EOF
fi

# Configurar el perfil AP de provisión (persistente y estable)
if command -v nmcli >/dev/null 2>&1; then
  log "Asegurando perfil AP ${AP_NAME} (solo provisión)"

  rfkill unblock wifi || true
  nmcli radio wifi on || true

  install -d -m 0700 /etc/NetworkManager/system-connections
  target_ap_path="/etc/NetworkManager/system-connections/${AP_NAME}.nmconnection"

  ap_uuid=""
  if [[ -f "${target_ap_path}" ]]; then
    ap_uuid="$(awk -F= 'tolower($1)=="uuid"{print $2; exit}' "${target_ap_path}" | tr -d '[:space:]' || true)"
  fi
  if [[ -z "${ap_uuid}" ]]; then
    if command -v uuidgen >/dev/null 2>&1; then
      ap_uuid="$(uuidgen)"
    else
      ap_uuid="$(python3 -c 'import uuid; print(uuid.uuid4())')"
    fi
  fi

  tmp_ap_cfg="$(mktemp)"
  cat >"${tmp_ap_cfg}" <<EOF
[connection]
id=${AP_NAME}
uuid=${ap_uuid}
type=wifi
interface-name=${AP_IFACE}
autoconnect=false
autoconnect-priority=-999
autoconnect-retries=0
permissions=user:root

[wifi]
mode=ap
ssid=${AP_SSID}
band=bg
channel=1
hidden=true

[wifi-security]
key-mgmt=wpa-psk
psk=${AP_PASS}
proto=rsn
pmf=1

[ipv4]
method=shared
address1=${AP_GATEWAY}/24,${AP_GATEWAY}
never-default=true

[ipv6]
method=ignore
EOF
  install -m 0600 "${tmp_ap_cfg}" "${target_ap_path}"
  rm -f "${tmp_ap_cfg}"
  chmod 600 "${target_ap_path}" || warn "No se pudieron ajustar permisos de ${target_ap_path}"
  chown root:root "${target_ap_path}" || warn "No se pudo ajustar propietario de ${target_ap_path}"

  if ! nmcli connection reload >/dev/null 2>&1; then
    warn "No se pudo recargar conexiones NM tras actualizar ${AP_NAME}"
  fi

  if ! nmcli con load "${target_ap_path}" >/dev/null 2>&1; then
    warn "No se pudo cargar ${AP_NAME} desde ${target_ap_path}"
  fi

  nmcli con modify "${AP_NAME}" \
    connection.id "${AP_NAME}" \
    connection.interface-name "${AP_IFACE}" \
    connection.autoconnect no \
    connection.autoconnect-priority -999 \
    connection.autoconnect-retries 0 \
    connection.permissions "user:root" \
    802-11-wireless.mode ap \
    802-11-wireless.ssid "${AP_SSID}" \
    802-11-wireless.band bg \
    802-11-wireless.channel 1 \
    802-11-wireless.hidden yes \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.proto rsn \
    802-11-wireless-security.pmf 1 \
    wifi-sec.psk "${AP_PASS}" \
    ipv4.method shared \
    ipv4.addresses "${AP_GATEWAY}/24 ${AP_GATEWAY}" \
    ipv4.never-default yes \
    ipv6.method ignore >/dev/null 2>&1 || warn "No se pudieron fijar parámetros de ${AP_NAME}"

  while IFS=: read -r name uuid filename; do
    [[ "${name}" != "${AP_NAME}" ]] && continue
    [[ -z "${uuid}" ]] && continue
    [[ "${filename}" == "${target_ap_path}" ]] && continue
    nmcli con delete uuid "${uuid}" >/dev/null 2>&1 || true
  done < <(nmcli -t -f NAME,UUID,FILENAME con show 2>/dev/null || true)

  if [[ "${HAS_SYSTEMD}" -eq 1 ]]; then
    systemctl disable --now dnsmasq 2>/dev/null || true
  fi

  verify_line="$(nmcli -t -f NAME,AUTOCONNECT,AUTOCONNECT-PRIORITY,FILENAME con show 2>/dev/null | grep "^${AP_NAME}:" || true)"
  if [[ -n "${verify_line}" ]]; then
    log "[inst] BasculaAP verificada: ${verify_line}"
  else
    warn "No se pudo verificar BasculaAP en la salida de nmcli"
  fi
else
  warn "nmcli no disponible; no se pudo configurar ${AP_NAME}"
fi

WPA_SUPP_CONF="/etc/wpa_supplicant/wpa_supplicant.conf"
if [[ -f "${WPA_SUPP_CONF}" ]] && grep -qE '^\s*network=' "${WPA_SUPP_CONF}"; then
  BACKUP_PATH="${WPA_SUPP_CONF}.preinstall"
  if [[ ! -f "${BACKUP_PATH}" ]]; then
    cp "${WPA_SUPP_CONF}" "${BACKUP_PATH}" || warn "No se pudo crear copia de ${WPA_SUPP_CONF}"
  fi
  SOURCE_PATH="${BACKUP_PATH}"
  [[ -f "${SOURCE_PATH}" ]] || SOURCE_PATH="${WPA_SUPP_CONF}"
  log "Limpiando redes preconfiguradas en ${WPA_SUPP_CONF}"
  awk 'BEGIN{network_seen=0} {if($0 ~ /^\s*network=/){network_seen=1;exit} print}' "${SOURCE_PATH}" >"${WPA_SUPP_CONF}" || true
  cat >>"${WPA_SUPP_CONF}" <<'EOF'

# Redes Wi-Fi preconfiguradas eliminadas por el instalador de Báscula
# Añade nuevas redes mediante la interfaz de usuario.
EOF
  chmod 600 "${WPA_SUPP_CONF}" || true
fi

if [[ -f "${WPA_SUPP_CONF}" ]]; then
  if ! grep -qE '^\s*country=ES\b' "${WPA_SUPP_CONF}"; then
    if grep -qE '^\s*country=' "${WPA_SUPP_CONF}"; then
      if sed -i 's/^\s*country=.*/country=ES/' "${WPA_SUPP_CONF}"; then
        log "Actualizado country=ES en ${WPA_SUPP_CONF}"
      else
        warn "No se pudo actualizar la directiva country en ${WPA_SUPP_CONF}"
      fi
    else
      if sed -i '1icountry=ES' "${WPA_SUPP_CONF}"; then
        log "Añadido country=ES a ${WPA_SUPP_CONF}"
      else
        warn "No se pudo añadir country=ES a ${WPA_SUPP_CONF}"
      fi
    fi
  fi
fi

# Si hay systemd, recargar polkit/NM
if [[ "${HAS_SYSTEMD}" -eq 1 ]]; then
  systemctl list-unit-files | grep -q '^polkit\.service' && systemctl reload polkit || true
  systemctl list-unit-files | grep -q '^NetworkManager\.service' && systemctl reload NetworkManager || true
else
  warn "systemd no disponible: omitiendo recarga de polkit y NetworkManager"
fi

# Nota: La UI, al conectar a una nueva Wi-Fi, deberá:
#  - crear/actualizar esa conexión con autoconnect=yes y prioridad 120
#  - mantener BasculaAP con autoconnect=no (para no competir)

if command -v nmcli >/dev/null 2>&1; then
  while IFS= read -r PRECONF_UUID; do
    [[ -z "${PRECONF_UUID}" ]] && continue
    NAME=$(nmcli -g connection.id connection show "${PRECONF_UUID}" 2>/dev/null || true)
    if [[ -n "${NAME}" && "${NAME,,}" == *preconfig* ]]; then
      log "Eliminando perfil Wi-Fi preconfigurado: ${NAME}"
      nmcli connection delete "${PRECONF_UUID}" >/dev/null 2>&1 || true
    fi
  done < <(nmcli -t -f UUID connection show 2>/dev/null | sed 's/^UUID://')

  nmcli dev status || true
  nmcli -t -f NAME,AUTOCONNECT,AUTOCONNECT-PRIORITY,FILENAME con show | grep -E 'BasculaAP|802-11-wireless' || true
fi

if ! nmcli general status >/dev/null 2>&1; then
  err "ERR: nmcli no responde"
  exit 1
fi

if ! runuser -l "${TARGET_USER}" -c "nmcli device wifi list" >/dev/null 2>&1; then
  fail "nmcli device wifi list falló para ${TARGET_USER} sin sudo"
fi
log "✓ nmcli usable sin sudo para ${TARGET_USER}"

log "Chequeos rápidos de nmcli (PolicyKit)..."
set +e
__nmcli_wifi_status_output="$(nmcli -t -f WIFI general status 2>&1)"
__nmcli_wifi_status_rc=$?
set -e
if [[ ${__nmcli_wifi_status_rc} -ne 0 ]]; then
  if printf '%s' "${__nmcli_wifi_status_output}" | grep -qiE "(not authorized|access denied|permission denied)"; then
    fail "PolicyKit denegó 'nmcli -t -f WIFI general status': ${__nmcli_wifi_status_output}"
  else
    warn "nmcli WIFI status devolvió código ${__nmcli_wifi_status_rc}: ${__nmcli_wifi_status_output}"
  fi
else
  log "nmcli WIFI status: ${__nmcli_wifi_status_output}"
fi

set +e
__nmcli_wifi_list_output="$(nmcli -t -f SSID,SECURITY,SIGNAL device wifi list ifname wlan0 --rescan yes 2>&1)"
__nmcli_wifi_list_rc=$?
set -e
if [[ ${__nmcli_wifi_list_rc} -ne 0 ]]; then
  if printf '%s' "${__nmcli_wifi_list_output}" | grep -qiE "(not authorized|access denied|permission denied)"; then
    fail "PolicyKit denegó 'nmcli device wifi list': ${__nmcli_wifi_list_output}"
  else
    warn "nmcli device wifi list devolvió código ${__nmcli_wifi_list_rc}: ${__nmcli_wifi_list_output}"
  fi
else
  log "Listado Wi-Fi detectado correctamente"
fi

log "✓ Polkit configurado"

# Create config.json
log "[10/20] Creando configuración por defecto..."
install -d -m 0755 -o "${TARGET_USER}" -g "${TARGET_GROUP}" "${CFG_DIR}"
if [[ ! -s "${CFG_PATH}" ]]; then
  cat > "${CFG_PATH}" <<'PY'
{
  "general": {
    "sound_enabled": true,
    "volume": 70,
    "tts_enabled": true
  },
  "scale": {
    "port": "/dev/serial0",
    "baud": 115200,
    "hx711_dt": 5,
    "hx711_sck": 6,
    "calib_factor": 1.0,
    "smoothing": 5,
    "decimals": 0,
    "unit": "g",
    "ml_factor": 1.0
  },
  "network": {
    "miniweb_enabled": true,
    "miniweb_port": 8080,
    "miniweb_pin": ""
  },
  "diabetes": {
    "diabetes_enabled": false,
    "ns_url": "",
    "ns_token": "",
    "hypo_alarm": 70,
    "hyper_alarm": 180,
    "mode_15_15": false,
    "insulin_ratio": 12.0,
    "insulin_sensitivity": 50.0,
    "target_glucose": 110
  },
  "audio": {
    "audio_device": "default"
  }
}
PY
  chown "${TARGET_USER}:${TARGET_GROUP}" "${CFG_PATH}" || true
fi
log "✓ Configuración creada en ${CFG_PATH}"

# OTA: Setup release directory structure
log "[11/20] Configurando estructura OTA..."
install -d -m 0755 "${BASCULA_RELEASES_DIR}"
if [[ ! -e "${BASCULA_CURRENT_LINK}" ]]; then
  DEST="${BASCULA_RELEASES_DIR}/v1"
  log "Copiando proyecto a ${DEST}..."
  install -d -m 0755 "${DEST}"
  (cd "${PROJECT_ROOT}" && tar --exclude .git --exclude .venv --exclude __pycache__ --exclude '*.pyc' --exclude node_modules -cf - .) | tar -xf - -C "${DEST}"
  ln -s "${DEST}" "${BASCULA_CURRENT_LINK}"
  log "✓ Release v1 creado"
fi
chown -R "${TARGET_USER}:${TARGET_GROUP}" "${BASCULA_ROOT}"
log "✓ Estructura OTA configurada"

# Setup Python virtual environment
log "[12/20] Configurando entorno Python..."
cd "${BASCULA_CURRENT_LINK}"
if [[ ! -d ".venv" ]]; then
  set +e
  runuser -l "${TARGET_USER}" -c "python3 -m venv '${BASCULA_CURRENT_LINK}/.venv'"
  create_rc=$?
  set -e
  if [[ ${create_rc} -ne 0 ]]; then
    warn "No se pudo crear la venv como ${TARGET_USER}; intentando como root"
    python3 -m venv .venv
  fi
fi
VENV_DIR="${BASCULA_CURRENT_LINK}/.venv"
chown -R "${TARGET_USER}:${TARGET_GROUP}" "${VENV_DIR}" || warn "No se pudo ajustar el propietario de la venv"
VENV_PY="${VENV_DIR}/bin/python"
VENV_PIP="${VENV_DIR}/bin/pip"

# Allow venv to see system packages (picamera2)
VENV_SITE="$(${VENV_PY} -c 'import sysconfig; print(sysconfig.get_paths().get("purelib"))')"
if [ -n "${VENV_SITE}" ] && [ -d "${VENV_SITE}" ]; then
  echo "/usr/lib/python3/dist-packages" > "${VENV_SITE}/system_dist.pth"
fi

export PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_ROOT_USER_ACTION=ignore PIP_PREFER_BINARY=1
export PIP_INDEX_URL="https://www.piwheels.org/simple"
export PIP_EXTRA_INDEX_URL="https://pypi.org/simple"

REQUIREMENTS_FILE="${BASCULA_CURRENT_LINK}/requirements.txt"

if [[ "${NET_OK}" -eq 1 ]]; then
  if ! sudo -H -u "${TARGET_USER}" env \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PIP_PREFER_BINARY=1 \
    PIP_INDEX_URL="${PIP_INDEX_URL}" \
    PIP_EXTRA_INDEX_URL="${PIP_EXTRA_INDEX_URL}" \
    "${VENV_PY}" -m pip install --upgrade pip wheel setuptools; then
    fail "No se pudo actualizar pip/wheel/setuptools en la venv"
  fi
  if [[ -f "${REQUIREMENTS_FILE}" ]]; then
    if ! sudo -H -u "${TARGET_USER}" env \
      PIP_DISABLE_PIP_VERSION_CHECK=1 \
      PIP_ROOT_USER_ACTION=ignore \
      PIP_PREFER_BINARY=1 \
      PIP_INDEX_URL="${PIP_INDEX_URL}" \
      PIP_EXTRA_INDEX_URL="${PIP_EXTRA_INDEX_URL}" \
      "${VENV_PIP}" install -r "${REQUIREMENTS_FILE}"; then
      fail "No se pudieron instalar las dependencias Python desde requirements.txt"
    fi
  else
    fail "No se encontró ${REQUIREMENTS_FILE}; instala las dependencias manualmente"
  fi
else
  warn "Sin red: omitiendo instalación de dependencias Python (se verificará la venv existente)"
fi

if ! sudo -H -u "${TARGET_USER}" "${VENV_PY}" - <<'PY'
import rapidfuzz
import fastapi
import uvicorn
print("py_deps_ok")
PY
then
  err "[ERROR] Dependencias Python faltantes"
  exit 1
fi

log "✓ Entorno Python configurado"

# Install Piper TTS
log "[13/20] Instalando Piper TTS..."
install -d -m 0755 /opt/piper/models /opt/piper/bin
if ! command -v piper >/dev/null 2>&1; then
  PIPER_BIN_URL=""
  case "${ARCH}" in
    aarch64) PIPER_BIN_URL="https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_aarch64.tar.gz" ;;
    armv7l) PIPER_BIN_URL="https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_armv7l.tar.gz" ;;
  esac
  if [[ -n "${PIPER_BIN_URL}" && "${NET_OK}" = "1" ]]; then
    TMP_TGZ="/tmp/piper_bin_$$.tgz"
    if curl -fL --retry 2 -m 20 -o "${TMP_TGZ}" "${PIPER_BIN_URL}" 2>/dev/null; then
      tar -xzf "${TMP_TGZ}" -C /opt/piper/bin || true
      rm -f "${TMP_TGZ}" || true
      F_BIN="$(find /opt/piper/bin -maxdepth 2 -type f -name 'piper' | head -n1)"
      if [[ -n "${F_BIN}" ]]; then
        chmod +x "${F_BIN}" || true
        ln -sf "${F_BIN}" /usr/local/bin/piper || true
      fi
    fi
  fi
fi

# Download Spanish voice models with checksum validation
VOICE_DIR="/opt/bascula/voices"
install -d -m 0755 "${VOICE_DIR}"

declare -A VOICE_HASHES=(
  ["es_ES-carlfm-x_low.onnx"]="d69677323a907cd4963f42b29c20a98b5d6bfa7f3e64df339915e4650c00d125"
  ["es_ES-carlfm-x_low.onnx.json"]="d9bdfa9ff01eb2bc9e62e7d2593939d1e4c4d8eb7cf75f972731539d12399966"
  ["es_ES-davefx-medium.onnx"]="6658b03b1a6c316ee4c265a9896abc1393353c2d9e1bca7d66c2c442e222a917"
  ["es_ES-davefx-medium.onnx.json"]="0e0dda87c732f6f38771ff274a6380d9252f327dca77aa2963d5fbdf9ec54842"
  ["es_ES-sharvard-medium.onnx"]="40febfb1679c69a4505ff311dc136e121e3419a13a290ef264fdf43ddedd0fb1"
  ["es_ES-sharvard-medium.onnx.json"]="7438c9b699c72b0c3388dae1b68d3f364dc66a2150fe554a1c11f03372957b2c"
)

VOICE_BASE_URL="https://github.com/DanielGTdiabetes/bascula-cam/releases/download/voices-v1"

for voice in "${!VOICE_HASHES[@]}"; do
  dest="${VOICE_DIR}/${voice}"
  expected_hash="${VOICE_HASHES[${voice}]}"
  if [[ -s "${dest}" ]]; then
    current_hash="$(sha256sum "${dest}" 2>/dev/null | awk '{print $1}')"
    if [[ "${current_hash}" == "${expected_hash}" ]]; then
      log "[info] Voz ${voice} ya instalada con checksum válido"
      continue
    fi
    warn "Checksum de ${voice} no coincide; re-descargando"
    rm -f "${dest}"
  fi

  if [[ "${NET_OK}" != "1" ]]; then
    warn "Sin red: omitiendo descarga de ${voice}"
    continue
  fi

  tmpfile="/tmp/${voice}.tmp.$$"
  rm -f "${tmpfile}"
  log "Descargando voz: ${voice}"
  if ! curl -fsSL -o "${tmpfile}" "${VOICE_BASE_URL}/${voice}"; then
    rm -f "${tmpfile}"
    warn "No se pudo descargar ${voice} (saltando)"
    continue
  fi

  if [[ ! -s "${tmpfile}" ]]; then
    rm -f "${tmpfile}"
    warn "Archivo ${voice} descargado vacío"
    continue
  fi

  file_hash="$(sha256sum "${tmpfile}" | awk '{print $1}')"
  if [[ "${file_hash}" != "${expected_hash}" ]]; then
    rm -f "${tmpfile}"
    err "[install] ERROR checksum voice ${voice}: esperado ${expected_hash}, obtenido ${file_hash}"
    continue
  fi

  install -m 0644 "${tmpfile}" "${dest}"
  rm -f "${tmpfile}"
  log "✓ Voz ${voice} instalada con checksum verificado"
done

install -d -m 0755 /opt/piper
if [[ ! -e /opt/piper/models && ! -L /opt/piper/models ]]; then
  ln -s /opt/bascula/voices /opt/piper/models
fi

# Create say.sh wrapper
cat > /usr/local/bin/say.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
TEXT="${*:-Prueba de voz}"
VOICE="${PIPER_VOICE:-es_ES-sharvard-medium}"
MODEL=""
CONFIG=""
for BASE in /opt/bascula/voices /opt/piper/models; do
  if [[ -f "${BASE}/${VOICE}.onnx" ]]; then
    MODEL="${BASE}/${VOICE}.onnx"
    CONFIG="${BASE}/${VOICE}.onnx.json"
    break
  fi
done
BIN="$(command -v piper || echo "/opt/piper/bin/piper")"

if [[ -x "${BIN}" && -n "${MODEL}" && -f "${MODEL}" && -f "${CONFIG}" ]]; then
  echo -n "${TEXT}" | "${BIN}" -m "${MODEL}" -c "${CONFIG}" --length-scale 1.0 --noise-scale 0.5 | aplay -q -r 22050 -f S16_LE -t raw -
else
  espeak-ng -v es -s 170 "${TEXT}" >/dev/null 2>&1 || true
fi
EOF
chmod 0755 /usr/local/bin/say.sh
log "✓ Piper TTS instalado"

install_x735

# Setup OCR service
log "[14/20] Configurando servicio OCR..."
install -d -m 0755 /opt/ocr-service
cat > /opt/ocr-service/app.py <<'PY'
import io
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse, PlainTextResponse
from PIL import Image
import pytesseract

app = FastAPI(title="OCR Service", version="1.0")

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.get("/")
async def root():
    return PlainTextResponse("ok")

@app.post("/ocr")
async def ocr_endpoint(file: UploadFile = File(...), lang: str = Form("spa")):
    try:
        data = await file.read()
        img = Image.open(io.BytesIO(data))
        txt = pytesseract.image_to_string(img, lang=lang)
        return JSONResponse({"ok": True, "text": txt})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
PY

cat > /etc/systemd/system/ocr-service.service <<EOF
[Unit]
Description=Bascula OCR Service
After=network.target

[Service]
Type=simple
User=${TARGET_USER}
Group=${TARGET_GROUP}
WorkingDirectory=/opt/ocr-service
ExecStart=${VENV_DIR}/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8078
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl_safe daemon-reload
systemctl_safe enable ocr-service.service
systemctl_safe restart ocr-service.service
log "✓ Servicio OCR configurado"

# Setup Frontend (build if node_modules exists)
log "[15/20] Configurando frontend..."
cd "${BASCULA_CURRENT_LINK}"
if [[ -f "package.json" ]]; then
  if [[ -f ".env.device" ]]; then
    cp -f .env.device .env
  fi
  npm install || warn "npm install falló, continuar con backend"
  if command -v node >/dev/null 2>&1; then
    if ! node scripts/generate-service-worker.mjs; then
      warn "No se pudo generar service worker"
    fi
  else
    warn "Node.js no disponible para generar service worker"
  fi
  npm run build || warn "npm build falló"
  log "✓ Frontend compilado"
fi

# Install and configure Nginx
log "[16/20] Instalando y configurando Nginx..."
if [[ "${NET_OK}" -eq 1 ]]; then
  if ! apt-get install -y nginx; then
    warn "No se pudo instalar Nginx"
  fi
else
  warn "Sin red: omitiendo instalación de Nginx"
fi
systemctl_safe enable nginx
install -d -m 0755 /etc/nginx/sites-available /etc/nginx/sites-enabled
cat > /etc/nginx/sites-available/bascula <<'EOF'
server {
    listen 80 default_server;
    server_name _;
    root /opt/bascula/current/dist;
    index index.html;

    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    # PWA/SPA
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Archivos estáticos
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Proxy principal hacia FastAPI
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Compatibilidad rutas legacy sin /api
    location /camera/  { proxy_pass http://127.0.0.1:8080/api/camera/;  include proxy_params; }
    location /voice/   { proxy_pass http://127.0.0.1:8080/api/voice/;   include proxy_params; }
    location /miniweb/ { proxy_pass http://127.0.0.1:8080/api/miniweb/; include proxy_params; }
    location /net/     { proxy_pass http://127.0.0.1:8080/api/net/;     include proxy_params; }

    # WebSocket
    location /ws/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
    }

    # Exponer solo /tmp para la última captura
    location ^~ /tmp/ {
        alias /tmp/;
        default_type image/jpeg;
        autoindex off;
        add_header Cache-Control "no-store";
        allow 127.0.0.1;
        allow ::1;
        deny all;
    }
}
EOF
if command -v sudo >/dev/null 2>&1; then
  sudo tee /etc/nginx/sites-enabled/bascula >/dev/null <<'EOF'
server {
    listen 80 default_server;
    server_name _;
    root /opt/bascula/current/dist;
    index index.html;

    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    # PWA/SPA
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Archivos estáticos
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Proxy principal hacia FastAPI
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Compatibilidad rutas legacy sin /api
    location /camera/  { proxy_pass http://127.0.0.1:8080/api/camera/;  include proxy_params; }
    location /voice/   { proxy_pass http://127.0.0.1:8080/api/voice/;   include proxy_params; }
    location /miniweb/ { proxy_pass http://127.0.0.1:8080/api/miniweb/; include proxy_params; }
    location /net/     { proxy_pass http://127.0.0.1:8080/api/net/;     include proxy_params; }

    # WebSocket
    location /ws/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
    }

    # Exponer solo /tmp para la última captura
    location ^~ /tmp/ {
        alias /tmp/;
        default_type image/jpeg;
        autoindex off;
        add_header Cache-Control "no-store";
        allow 127.0.0.1;
        allow ::1;
        deny all;
    }
}
EOF
else
  cat <<'EOF' > /etc/nginx/sites-enabled/bascula
server {
    listen 80 default_server;
    server_name _;
    root /opt/bascula/current/dist;
    index index.html;

    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    # PWA/SPA
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Archivos estáticos
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Proxy principal hacia FastAPI
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Compatibilidad rutas legacy sin /api
    location /camera/  { proxy_pass http://127.0.0.1:8080/api/camera/;  include proxy_params; }
    location /voice/   { proxy_pass http://127.0.0.1:8080/api/voice/;   include proxy_params; }
    location /miniweb/ { proxy_pass http://127.0.0.1:8080/api/miniweb/; include proxy_params; }
    location /net/     { proxy_pass http://127.0.0.1:8080/api/net/;     include proxy_params; }

    # WebSocket
    location /ws/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
    }

    # Exponer solo /tmp para la última captura
    location ^~ /tmp/ {
        alias /tmp/;
        default_type image/jpeg;
        autoindex off;
        add_header Cache-Control "no-store";
        allow 127.0.0.1;
        allow ::1;
        deny all;
    }
}
EOF
fi
rm -f /etc/nginx/sites-enabled/default
if command -v sudo >/dev/null 2>&1; then
  if ! sudo nginx -t; then
    warn "Configuración de Nginx con errores"
  else
    sudo systemctl reload nginx || warn "No se pudo recargar Nginx"
  fi
else
  if ! nginx -t; then
    warn "Configuración de Nginx con errores"
  else
    systemctl_safe reload nginx
  fi
fi
log "✓ Nginx configurado"

# Create mini-web backend service
log "[17/20] Configurando servicio mini-web..."
install -d -m 0755 -o "${TARGET_USER}" -g "${TARGET_GROUP}" "${CFG_DIR}"

SYSTEMD_SRC="${PROJECT_ROOT}/packaging/systemd/bascula-miniweb.service"
if [[ ! -f "${SYSTEMD_SRC}" ]]; then
  err "No se encontró ${SYSTEMD_SRC}"
  exit 1
fi

install -m 0644 "${SYSTEMD_SRC}" /etc/systemd/system/bascula-miniweb.service
log "✓ Mini-web backend configurado"

# Install AP ensure service and script
log "[17a/20] Configurando servicio de arranque de AP..."
AP_ENSURE_SERVICE_INSTALLED=0

AP_ENSURE_SCRIPT_SRC="${PROJECT_ROOT}/scripts/bascula-ap-ensure.sh"
AP_ENSURE_SCRIPT_DST="${BASCULA_CURRENT_LINK}/scripts/bascula-ap-ensure.sh"
if [[ -f "${AP_ENSURE_SCRIPT_SRC}" ]]; then
  install -d "${BASCULA_CURRENT_LINK}/scripts"
  safe_install "${AP_ENSURE_SCRIPT_SRC}" "${AP_ENSURE_SCRIPT_DST}"
  chown "${TARGET_USER}:${TARGET_GROUP}" "${AP_ENSURE_SCRIPT_DST}" || true
  log "✓ Script bascula-ap-ensure.sh desplegado en ${AP_ENSURE_SCRIPT_DST}"
else
  warn "No se encontró scripts/bascula-ap-ensure.sh"
fi

install -d /etc/systemd/system
if [[ -f "${PROJECT_ROOT}/systemd/bascula-ap-ensure.service" ]]; then
  install -m 0644 "${PROJECT_ROOT}/systemd/bascula-ap-ensure.service" /etc/systemd/system/bascula-ap-ensure.service
  AP_ENSURE_SERVICE_INSTALLED=1
elif [[ -f "${PROJECT_ROOT}/system/os/bascula-ap-ensure.service" ]]; then
  warn "Usando servicio heredado de system/os/"
  install -m 0644 "${PROJECT_ROOT}/system/os/bascula-ap-ensure.service" /etc/systemd/system/bascula-ap-ensure.service
  AP_ENSURE_SERVICE_INSTALLED=1
else
  warn "No se encontró definición de servicio bascula-ap-ensure"
fi

if [[ "${HAS_SYSTEMD}" -eq 1 ]]; then
  if ! systemctl daemon-reload; then
    warn "systemctl daemon-reload falló"
  fi
  systemctl disable --now bascula-ap-ensure.timer 2>/dev/null || true
  if [[ "${AP_ENSURE_SERVICE_INSTALLED}" -eq 1 ]]; then
    if systemctl enable --now bascula-ap-ensure.service bascula-miniweb.service; then
      log "✓ Servicios bascula-ap-ensure y bascula-miniweb habilitados"
    else
      warn "No se pudieron habilitar bascula-ap-ensure/bascula-miniweb"
      systemctl status bascula-ap-ensure.service --no-pager || true
      systemctl status bascula-miniweb.service --no-pager || true
    fi
  else
    warn "Servicio bascula-ap-ensure no instalado; habilitando solo bascula-miniweb"
    if systemctl enable --now bascula-miniweb.service; then
      log "✓ Servicio bascula-miniweb habilitado"
    else
      warn "No se pudo habilitar bascula-miniweb.service"
      systemctl status bascula-miniweb.service --no-pager || true
    fi
  fi
else
  warn "systemd no disponible: BasculaAP dependerá de connection.autoconnect"
fi

# Setup UI kiosk service
log "[18/20] Configurando servicio UI kiosk..."

# Copiar .xinitrc del proyecto al home del usuario
if [[ -f "${BASCULA_CURRENT_LINK}/.xinitrc" ]]; then
  cp "${BASCULA_CURRENT_LINK}/.xinitrc" "${TARGET_HOME}/.xinitrc"
  chmod +x "${TARGET_HOME}/.xinitrc"
  chown "${TARGET_USER}:${TARGET_GROUP}" "${TARGET_HOME}/.xinitrc"
  log "✓ .xinitrc copiado desde el proyecto"
else
  warn ".xinitrc no encontrado en el proyecto, creando uno básico"
  cat > "${TARGET_HOME}/.xinitrc" <<EOF
#!/bin/sh
set -e
xset s off
xset -dpms
xset s noblank
unclutter -idle 0.5 -root &
openbox &
sleep 2
CHROME_BIN="\$(command -v ${CHROME_PKG} 2>/dev/null || command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || printf '%s' '${CHROME_BIN}')"
exec "\${CHROME_BIN}" \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --enable-features=OverlayScrollbar \
  --disable-translate \
  --disable-features=TranslateUI \
  --disk-cache-dir=/dev/null \
  --overscroll-history-navigation=0 \
  --disable-pinch \
  --check-for-update-interval=31536000 \
  http://localhost:8080
EOF
  chmod +x "${TARGET_HOME}/.xinitrc"
  chown "${TARGET_USER}:${TARGET_GROUP}" "${TARGET_HOME}/.xinitrc"
fi

# Instalar servicio bascula-ui actualizado
SERVICE_FILE="${BASCULA_CURRENT_LINK}/systemd/bascula-ui.service"
TARGET_UID="$(id -u "${TARGET_USER}" 2>/dev/null || id -u pi 2>/dev/null || 1000)"
if [[ -f "${SERVICE_FILE}" ]]; then
  TMP_SERVICE_FILE="$(mktemp)"
  sed -e "s|User=pi|User=${TARGET_USER}|g" \
      -e "s|Group=pi|Group=${TARGET_GROUP}|g" \
      -e "s|/opt/bascula/current|${BASCULA_CURRENT_LINK}|g" \
      -e "s|Environment=HOME=/home/pi|Environment=HOME=${TARGET_HOME}|g" \
      -e "s|Environment=USER=pi|Environment=USER=${TARGET_USER}|g" \
      -e "s|Environment=XDG_RUNTIME_DIR=/run/user/1000|Environment=XDG_RUNTIME_DIR=/run/user/${TARGET_UID}|g" \
      -e "s|-o pi -g pi|-o ${TARGET_USER} -g ${TARGET_GROUP}|g" \
      -e "s|chown pi:pi|chown ${TARGET_USER}:${TARGET_GROUP}|g" \
      "${SERVICE_FILE}" > "${TMP_SERVICE_FILE}"
  install -m 0644 "${TMP_SERVICE_FILE}" /etc/systemd/system/bascula-ui.service
  rm -f "${TMP_SERVICE_FILE}"
  log "✓ bascula-ui.service actualizado"
else
  cat > /etc/systemd/system/bascula-ui.service <<EOF
[Unit]
Description=Bascula Digital Pro - UI (Chromium kiosk)
After=systemd-user-sessions.service network-online.target sound.target bascula-miniweb.service
Wants=network-online.target sound.target bascula-miniweb.service
Requires=bascula-miniweb.service
Conflicts=getty@tty1.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=${TARGET_USER}
Group=${TARGET_GROUP}
WorkingDirectory=${BASCULA_CURRENT_LINK}
Environment=HOME=${TARGET_HOME}
Environment=USER=${TARGET_USER}
Environment=DISPLAY=:0
Environment=XDG_RUNTIME_DIR=/run/user/${TARGET_UID}
StandardOutput=journal
StandardError=journal
PermissionsStartOnly=yes
ExecStart=/usr/bin/startx ${BASCULA_CURRENT_LINK}/.xinitrc -- :0 vt1 -nocursor
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  log "✓ bascula-ui.service generado por defecto"
fi

if [[ "${HAS_SYSTEMD}" -eq 1 ]]; then
  if [[ "${ALLOW_SYSTEMD:-1}" -eq 1 ]]; then
    systemctl disable --now bascula-app.service 2>/dev/null || true
    systemctl mask bascula-app.service 2>/dev/null || true
    rm -f /etc/systemd/system/multi-user.target.wants/bascula-app.service 2>/dev/null || true
    rm -f /etc/systemd/system/bascula-app.service 2>/dev/null || true
    systemctl_safe disable getty@tty1.service
  else
    warn "ALLOW_SYSTEMD!=1: se omitió la habilitación de servicios"
  fi
else
  warn "systemd no disponible: bascula-ui.service no se habilitó"
fi

configure_bascula_ui_service

# Chromium managed policies
log "Configurando políticas de Chromium..."
install -d -m 0755 /etc/chromium/policies/managed
cat > /etc/chromium/policies/managed/bascula_policy.json <<'EOF'
{
  "AudioCaptureAllowed": true,
  "VideoCaptureAllowed": true,
  "AutoplayAllowed": true,
  "DefaultAudioCaptureSetting": 1,
  "DefaultVideoCaptureSetting": 1,
  "URLAllowlist": ["http://127.0.0.1:8080", "http://localhost:8080"]
}
EOF
log "✓ Políticas de Chromium configuradas"

# Setup tmpfiles
log "[19/20] Configurando tmpfiles..."
if [[ -f "${PROJECT_ROOT}/systemd/tmpfiles.d/bascula.conf" ]]; then
  install -m 0644 "${PROJECT_ROOT}/systemd/tmpfiles.d/bascula.conf" /etc/tmpfiles.d/bascula.conf
else
  warn "systemd/tmpfiles.d/bascula.conf no encontrado en el repositorio"
fi
if [[ -f "${PROJECT_ROOT}/systemd/tmpfiles.d/bascula-x11.conf" ]]; then
  install -m 0644 "${PROJECT_ROOT}/systemd/tmpfiles.d/bascula-x11.conf" /etc/tmpfiles.d/bascula-x11.conf
fi
if [[ "${HAS_SYSTEMD}" -eq 1 && "${ALLOW_SYSTEMD:-1}" -eq 1 ]]; then
  systemd-tmpfiles --create /etc/tmpfiles.d/bascula.conf || true
  systemd-tmpfiles --create /etc/tmpfiles.d/bascula-x11.conf || true
else
  warn "tmpfiles no ejecutado (systemd o ALLOW_SYSTEMD deshabilitado)"
fi
log "✓ tmpfiles configurado"

# Final permissions
log "[20/20] Ajustando permisos finales..."
install -d -m 0755 -o "${TARGET_USER}" -g "${TARGET_GROUP}" /var/log/bascula
chown -R "${TARGET_USER}:${TARGET_GROUP}" "${BASCULA_ROOT}" /opt/ocr-service
log "✓ Permisos ajustados"

post_install_hardware_checks

# Quick nmcli verification (logging only)
if command -v nmcli >/dev/null 2>&1; then
  log "Verificación rápida NetworkManager (no bloqueante)..."
  nmcli dev status || true
  nmcli -t -f NAME,TYPE,DEVICE con show || true
  nmcli -g connection.interface-name,802-11-wireless.mode,ipv4.method,ipv4.addresses,ipv4.gateway,ipv4.dns con show "${AP_NAME}" || true
else
  warn "nmcli no disponible para verificación rápida"
fi

# Final message
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
log "============================================"
log "  ¡Instalación Completada!"
log "============================================"
log "Sistema instalado con éxito:"
log "  ✅ Estructura OTA en: ${BASCULA_CURRENT_LINK}"
log "  ✅ Config en: ${CFG_PATH}"
log "  ✅ Audio I2S + Piper TTS"
log "  ✅ Camera Module 3 + OCR"
log "  ✅ Nginx + Mini-web + UI kiosk"
log_warn "═══════════════════════════════════════════"
log_warn "  ⚠ REINICIO REQUERIDO"
log_warn "═══════════════════════════════════════════"
log "  sudo reboot"
log "Después del reinicio, acceder a:"
log "  http://${IP:-<IP>} o http://localhost"
log "  Mini-Web: visita http://${IP:-<IP>}:8080 · PIN: consulta /api/miniweb/pin en AP o mira la pantalla"
log "Comandos útiles:"
log "  journalctl -u bascula-miniweb.service -f"
log "  journalctl -u bascula-ui.service -f"
log "  journalctl -u ocr-service.service -f"
log "  journalctl -u x735-fan.service -f    # monitorear ventilador"
log "  libcamera-hello  # probar cámara"
log "  say.sh 'Hola'    # probar voz"
log "  x735off          # apagar el sistema de forma segura"
log "Instalación finalizada"
log "Backend de báscula predeterminado: UART (ESP32 en /dev/serial0)"
systemctl_safe status bascula-miniweb --no-pager -l
systemctl_safe status bascula-ui --no-pager -l
if command -v ss >/dev/null 2>&1; then
  ss -ltnp | grep 8080 || true
else
  warn "Herramienta 'ss' no disponible; omitiendo comprobación de puertos"
fi

# --- Bascula: instalar/activar services idempotente (sin tocar AP) ---
install_services() {
  set -euo pipefail

  # Copiar units del repo (solo los nuestros)
  install -m 0644 systemd/bascula-miniweb.service /etc/systemd/system/bascula-miniweb.service
  install -m 0644 systemd/bascula-backend.service  /etc/systemd/system/bascula-backend.service

  if [ -f systemd/bascula-ui.service ]; then
    local tmp_service="$(mktemp)"
    local target_uid
    target_uid="$(id -u "${TARGET_USER}" 2>/dev/null || id -u pi 2>/dev/null || 1000)"
    sed -e "s|User=pi|User=${TARGET_USER}|g" \
        -e "s|Group=pi|Group=${TARGET_GROUP}|g" \
        -e "s|/opt/bascula/current|${BASCULA_CURRENT_LINK}|g" \
        -e "s|Environment=HOME=/home/pi|Environment=HOME=${TARGET_HOME}|g" \
        -e "s|Environment=USER=pi|Environment=USER=${TARGET_USER}|g" \
        -e "s|Environment=XDG_RUNTIME_DIR=/run/user/1000|Environment=XDG_RUNTIME_DIR=/run/user/${target_uid}|g" \
        -e "s|-o pi -g pi|-o ${TARGET_USER} -g ${TARGET_GROUP}|g" \
        -e "s|chown pi:pi|chown ${TARGET_USER}:${TARGET_GROUP}|g" \
        systemd/bascula-ui.service > "${tmp_service}"
    install -m 0644 "${tmp_service}" /etc/systemd/system/bascula-ui.service
    rm -f "${tmp_service}"
  fi
  if [ -f systemd/tmpfiles.d/bascula.conf ]; then
    install -m 0644 systemd/tmpfiles.d/bascula.conf /etc/tmpfiles.d/bascula.conf
  fi
  if [ -f systemd/tmpfiles.d/bascula-x11.conf ]; then
    install -m 0644 systemd/tmpfiles.d/bascula-x11.conf /etc/tmpfiles.d/bascula-x11.conf
  fi

  configure_miniweb_audio_env

  if [[ "${ALLOW_SYSTEMD:-1}" -eq 1 ]]; then
    systemctl daemon-reload
    systemctl disable --now bascula-app.service 2>/dev/null || true
    systemctl mask bascula-app.service 2>/dev/null || true
    rm -f /etc/systemd/system/multi-user.target.wants/bascula-app.service 2>/dev/null || true
    rm -f /etc/systemd/system/bascula-app.service 2>/dev/null || true

    systemctl enable bascula-miniweb bascula-backend || true
    systemctl is-active --quiet bascula-miniweb || systemctl start bascula-miniweb
    systemctl is-active --quiet bascula-backend  || systemctl start bascula-backend

    systemd-tmpfiles --create /etc/tmpfiles.d/bascula.conf || true
    systemd-tmpfiles --create /etc/tmpfiles.d/bascula-x11.conf || true
  else
    echo "[install] ALLOW_SYSTEMD!=1; units copiados pero no habilitados"
  fi

  echo "[install] services ok: miniweb:8080, backend:8081, ui:kiosk"

  configure_bascula_ui_service
}

# Llamada protegida (no afecta a AP/timers)
SERVICES_INSTALLED=0
if [ -f systemd/bascula-miniweb.service ] && [ -f systemd/bascula-backend.service ] && [ -f systemd/bascula-ui.service ]; then
  install_services
  SERVICES_INSTALLED=1
else
  echo "[install] aviso: faltan units en systemd/ (miniweb/backend/ui); no se instalaron"
fi

if [[ ${SERVICES_INSTALLED} -eq 1 && "${HAS_SYSTEMD}" -eq 1 ]]; then
  systemctl daemon-reload || warn "systemctl daemon-reload falló"
  if systemctl restart bascula-miniweb; then
    sleep 5
    if ! curl -fsS http://127.0.0.1:8080/health >/dev/null; then
      err "[ERROR] miniweb no responde"
      exit 1
    fi
    run_audio_io_self_tests 0 1
  else
    err "[ERROR] No se pudo reiniciar bascula-miniweb"
    exit 1
  fi
fi

if [[ ${OVERLAY_ADDED} -eq 1 && -n "${INSTALL_LOG}" ]]; then
  if grep -q "Overlay añadido" "${INSTALL_LOG}" 2>/dev/null; then
    echo "[inst][info] Reiniciando para aplicar vc4-kms-v3d-pi5..."
    if [[ "${HAS_SYSTEMD}" -eq 1 ]]; then
      systemctl disable bascula-ui.service 2>/dev/null || true
    fi
    reboot
  fi
fi
# --- Fin bloque ---
# Pruebas manuales de referencia:
# Ver entorno del servicio
# systemctl show -p Environment bascula-miniweb
# Probar reproducción con alias
# aplay -D bascula_out -r 44100 -f S16_LE -c 2 -d 1 /dev/zero
# Probar fallback directo
# aplay -D hw:1,0 -r 44100 -f S16_LE -c 2 -d 1 /dev/zero
# Tono de 1 kHz (verificación fina)
# speaker-test -D bascula_out -t sine -f 1000 -r 44100 -c 2 -l 1

echo "== PRUEBA CÁMARA =="
if command -v jq >/dev/null 2>&1; then
  curl -fsS -X POST http://localhost:8080/api/camera/capture-to-file | jq . \
    || echo "[WARN] cámara no disponible o backend no iniciado"
else
  echo "[WARN] jq no encontrado; omitiendo formateo JSON"
  curl -fsS -X POST http://localhost:8080/api/camera/capture-to-file \
    || echo "[WARN] cámara no disponible o backend no iniciado"
fi

curl -fsSI http://localhost/tmp/camera-capture.jpg \
  || echo "[WARN] cámara no disponible o backend no iniciado"
