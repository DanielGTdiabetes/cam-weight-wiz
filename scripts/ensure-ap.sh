#!/usr/bin/env bash
#
# ensure-ap.sh - Ensure BasculaAP comes up when no other connectivity exists
#
set -euo pipefail

LOG() { logger -t bascula-ap-ensure "$@"; printf "[ap-ensure] %s\n" "$@"; }

AP_NAME="${AP_NAME:-BasculaAP}"
AP_IFACE="${AP_IFACE:-wlan0}"

# Check if we have active ethernet with IP
HAS_ETH=0
if ip -4 addr show | grep -E '^[0-9]+: eth' | grep -q 'inet '; then
  HAS_ETH=1
  LOG "Ethernet active with IP, skipping AP"
fi

# Check if we have active Wi-Fi client with IP (not AP mode)
HAS_WIFI_CLIENT=0
if command -v nmcli >/dev/null 2>&1; then
  ACTIVE_CONN=$(nmcli -t -g NAME,TYPE,DEVICE connection show --active 2>/dev/null || true)
  while IFS=: read -r NAME TYPE DEVICE; do
    if [[ "${TYPE}" == "802-11-wireless" ]] && [[ "${DEVICE}" == "${AP_IFACE}" ]]; then
      MODE=$(nmcli -t -g 802-11-wireless.mode connection show "${NAME}" 2>/dev/null || true)
      if [[ "${MODE}" != "ap" ]]; then
        # Check if it has IP
        if ip -4 addr show dev "${AP_IFACE}" | grep -q 'inet '; then
          HAS_WIFI_CLIENT=1
          LOG "Wi-Fi client active with IP: ${NAME}, skipping AP"
          break
        fi
      fi
    fi
  done <<< "${ACTIVE_CONN}"
fi

# If we have connectivity, don't start AP
if [[ "${HAS_ETH}" -eq 1 ]] || [[ "${HAS_WIFI_CLIENT}" -eq 1 ]]; then
  LOG "Connectivity available, AP not needed"
  exit 0
fi

# No connectivity, bring up AP
LOG "No connectivity detected, activating ${AP_NAME}"
if ! nmcli connection up "${AP_NAME}" 2>&1 | tee -a /var/log/bascula/ap-ensure.log; then
  LOG "Failed to activate ${AP_NAME}"
  exit 1
fi

LOG "${AP_NAME} activated successfully"
exit 0
