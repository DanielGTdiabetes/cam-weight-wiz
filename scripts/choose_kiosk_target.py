#!/usr/bin/env python3
"""Helper used by the kiosk launcher to determine which URL should be opened."""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Mapping, Optional

HEALTH_URL = os.environ.get("BASCULA_KIOSK_HEALTH_URL", "http://127.0.0.1:8080/health")
STATUS_URL = os.environ.get(
    "BASCULA_KIOSK_STATUS_URL", "http://127.0.0.1:8080/api/miniweb/status"
)
MODE_TARGETS: Mapping[str, str] = {
    "kiosk": "http://localhost/",
    "ap": "http://localhost/ap",
    "offline": "http://localhost/offline",
}
DEFAULT_TARGET = MODE_TARGETS["kiosk"]
FALLBACK_TARGET = "http://localhost/config"


def determine_target_url(data: Mapping[str, Any]) -> str:
    """Return the launcher URL for the provided status payload."""

    raw_mode = str(data.get("effective_mode") or data.get("mode") or "").strip().lower()
    return MODE_TARGETS.get(raw_mode, DEFAULT_TARGET)


def _load_mock_status() -> Optional[Mapping[str, Any]]:
    raw = os.environ.get("BASCULA_KIOSK_STATUS_JSON")
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if isinstance(data, Mapping):
        return data
    return None


def _wait_for_health(timeout: float = 15.0) -> bool:
    if os.environ.get("BASCULA_KIOSK_STATUS_JSON"):
        return True

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(HEALTH_URL, timeout=2) as response:  # noqa: S310
                status = getattr(response, "status", 200)
                if 200 <= status < 500:
                    return True
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
            time.sleep(1)
        except Exception:
            time.sleep(1)
    return False


def _fetch_status(timeout: float = 5.0) -> Optional[Mapping[str, Any]]:
    mock = _load_mock_status()
    if mock is not None:
        return mock

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(STATUS_URL, timeout=2) as response:  # noqa: S310
                return json.load(response)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError):
            time.sleep(1)
        except Exception:
            time.sleep(1)
    return None


def main() -> int:
    if _wait_for_health():
        status = _fetch_status()
        if isinstance(status, Mapping):
            target = determine_target_url(status)
            print(f"ready|{target}")
            return 0
    print(f"fallback|{FALLBACK_TARGET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
