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

if [[ "${HAS_SYSTEMD}" -eq 1 ]]; then
  systemctl enable --now x735-fan.service 2>/dev/null || true
  systemctl enable --now x735-pwr.service 2>/dev/null || true
elif [[ "${MODE}" == "oneshot" ]]; then
  WARN "systemd no disponible; fan/power se habilitarán al primer arranque"
fi

touch "${STAMP}"
LOG "X735 listo (pwmchip=${PWMCHIP})"
