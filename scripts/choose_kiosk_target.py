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

STATUS_URL = os.environ.get(
    "BASCULA_KIOSK_STATUS_URL", "http://127.0.0.1:8080/api/miniweb/status"
)
WAIT_SECONDS = float(os.environ.get("BASCULA_KIOSK_WAIT_S", "30") or "0")
PROBE_INTERVAL_MS = float(os.environ.get("BASCULA_KIOSK_PROBE_MS", "500") or "0")
PROBE_INTERVAL_S = max(PROBE_INTERVAL_MS, 50.0) / 1000.0
MODE_TARGETS: Mapping[str, str] = {
    "kiosk": "http://localhost/",
    "ap": "http://localhost/ap",
    "offline": "http://localhost/offline",
    "config": "http://localhost/config",
}
DEFAULT_TARGET = MODE_TARGETS["kiosk"]
FALLBACK_TARGET = DEFAULT_TARGET


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


def _fetch_status(timeout: float = WAIT_SECONDS) -> Optional[Mapping[str, Any]]:
    mock = _load_mock_status()
    if mock is not None:
        return mock

    deadline = time.monotonic() + timeout
    last_error: Optional[BaseException] = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(STATUS_URL, timeout=2) as response:  # noqa: S310
                status_code = getattr(response, "status", 200)
                if 200 <= status_code < 300:
                    try:
                        return json.load(response)
                    except json.JSONDecodeError as exc:  # noqa: TRY400
                        last_error = exc
                # Ignore non-2xx responses and continue polling
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
            last_error = exc
        except Exception as exc:  # pragma: no cover - defensive fallback
            last_error = exc
        time.sleep(PROBE_INTERVAL_S)
    return None


def main() -> int:
    status = _fetch_status()
    if isinstance(status, Mapping):
        target = determine_target_url(status)
        print(f"ready|{target}")
        return 0
    print(f"fallback|{FALLBACK_TARGET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
