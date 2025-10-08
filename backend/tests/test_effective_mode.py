import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.miniweb import _determine_effective_mode


@pytest.mark.parametrize(
    "ethernet_connected,wifi_connected,internet_available,offline_mode_enabled,expected",
    [
        # Internet available → always kiosk (auto-disable offline mode)
        (True, False, True, True, "kiosk"),
        (True, False, True, False, "kiosk"),
        # Connection without Internet → offline
        (True, False, False, True, "offline"),
        (True, False, False, False, "offline"),
        # WiFi with Internet → kiosk
        (False, True, True, True, "kiosk"),
        (False, True, True, False, "kiosk"),
        # WiFi without Internet → offline
        (False, True, False, True, "offline"),
        (False, True, False, False, "offline"),
        # No connection → AP mode
        (False, False, False, True, "ap"),
        (False, False, False, False, "ap"),
        (False, False, True, False, "ap"),
    ],
)
def test_determine_effective_mode(
    ethernet_connected: bool,
    wifi_connected: bool,
    internet_available: bool,
    offline_mode_enabled: bool,
    expected: str,
) -> None:
    assert (
        _determine_effective_mode(
            ethernet_connected=ethernet_connected,
            wifi_connected=wifi_connected,
            offline_mode_enabled=offline_mode_enabled,
            internet_available=internet_available,
        )
        == expected
    )
