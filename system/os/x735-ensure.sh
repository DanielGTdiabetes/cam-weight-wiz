#!/usr/bin/env bash
set -euo pipefail

STAMP=/var/lib/x735-setup.done
LOG()  { printf "[x735] %s\n" "$*"; }
WARN() { printf "[x735][warn] %s\n" "$*"; }

MODE="normal"
if [[ ${1:-} == "--oneshot" ]]; then
  MODE="oneshot"
  shift || true
fi

install -d -m 0755 /var/lib

HAS_SYSTEMD=0
if [[ -d /run/systemd/system ]]; then
  HAS_SYSTEMD=1
fi

PWMCHIP=""
for c in /sys/class/pwm/pwmchip2 /sys/class/pwm/pwmchip1 /sys/class/pwm/pwmchip0; do
  if [[ -d "${c}" ]]; then
    PWMCHIP="${c##*/}"
    break
  fi
done

if [[ -z "${PWMCHIP}" ]]; then
  WARN "PWM no disponible todavía; reintentar más tarde"
  exit 0
fi

if [[ ! -d /opt/x735-script/.git ]]; then
  install -d -m 0755 /opt
  if [[ -d /opt/x735-script && ! -L /opt/x735-script ]]; then
    rm -rf /opt/x735-script || true
  fi
  git clone https://github.com/geekworm-com/x735-script /opt/x735-script || true
fi

cd /opt/x735-script 2>/dev/null || exit 0
chmod +x *.sh || true

sed -i "s/pwmchip[0-9]\\+/${PWMCHIP}/g" x735-fan.sh 2>/dev/null || true

./install-fan-service.sh || true
./install-pwr-service.sh || true

FAN_UNIT=""
PWR_UNIT=""

for candidate in /etc/systemd/system/x735-fan.service /lib/systemd/system/x735-fan.service; do
  if [[ -f "${candidate}" ]]; then
    FAN_UNIT="${candidate}"
    break
  fi
done
if [[ -z "${FAN_UNIT}" && -f x735-fan.service ]]; then
  install -D -m 0644 x735-fan.service /etc/systemd/system/x735-fan.service
  FAN_UNIT="/etc/systemd/system/x735-fan.service"
  LOG "x735-fan.service instalado manualmente en /etc/systemd/system"
fi

for candidate in /etc/systemd/system/x735-pwr.service /lib/systemd/system/x735-pwr.service; do
  if [[ -f "${candidate}" ]]; then
    PWR_UNIT="${candidate}"
    break
  fi
done
if [[ -z "${PWR_UNIT}" && -f x735-pwr.service ]]; then
  install -D -m 0644 x735-pwr.service /etc/systemd/system/x735-pwr.service
  PWR_UNIT="/etc/systemd/system/x735-pwr.service"
  LOG "x735-pwr.service instalado manualmente en /etc/systemd/system"
fi

if [[ -f x735-fan.sh && ! -x /usr/local/bin/x735-fan.sh ]]; then
  install -D -m 0755 x735-fan.sh /usr/local/bin/x735-fan.sh
  LOG "x735-fan.sh copiado a /usr/local/bin"
fi

if [[ -f pwm_fan_control.py && ! -f /usr/local/bin/pwm_fan_control.py ]]; then
  install -D -m 0644 pwm_fan_control.py /usr/local/bin/pwm_fan_control.py
  LOG "pwm_fan_control.py copiado a /usr/local/bin"
fi

if [[ -f xPWR.sh && ! -x /usr/local/bin/xPWR.sh ]]; then
  install -D -m 0755 xPWR.sh /usr/local/bin/xPWR.sh
  LOG "xPWR.sh copiado a /usr/local/bin"
fi

if [[ "${HAS_SYSTEMD}" -eq 1 ]]; then
  systemctl daemon-reload 2>/dev/null || true
  if [[ -n "${FAN_UNIT}" || -f /lib/systemd/system/x735-fan.service || -f /etc/systemd/system/x735-fan.service ]]; then
    systemctl enable --now x735-fan.service 2>/dev/null || WARN "No se pudo habilitar/iniciar x735-fan.service"
  else
    WARN "Unidad x735-fan.service no encontrada tras la instalación"
  fi
  if [[ -n "${PWR_UNIT}" || -f /lib/systemd/system/x735-pwr.service || -f /etc/systemd/system/x735-pwr.service ]]; then
    systemctl enable --now x735-pwr.service 2>/dev/null || WARN "No se pudo habilitar/iniciar x735-pwr.service"
  else
    WARN "Unidad x735-pwr.service no encontrada tras la instalación"
  fi
elif [[ "${MODE}" == "oneshot" ]]; then
  WARN "systemd no disponible; fan/power se habilitarán al primer arranque"
fi

touch "${STAMP}"
LOG "X735 listo (pwmchip=${PWMCHIP})"
