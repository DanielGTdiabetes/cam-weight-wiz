"""Audio volume management endpoints using ALSA amixer."""
from __future__ import annotations

import json
import re
import subprocess
from typing import Optional

from fastapi import APIRouter, Query

router = APIRouter(prefix="/api/audio", tags=["audio"])

CARD_DEFAULT = "sndrpihifiberry"
CONTROL_DEFAULT = "Digital"


def _amixer_get_percent(card: str, control: str) -> Optional[int]:
    """Return the current volume percent for the ALSA control."""
    try:
        process = subprocess.run(
            ["amixer", "-M", "-c", card, "sget", control],
            capture_output=True,
            text=True,
            check=False,
        )
    except (OSError, ValueError):
        return None

    if process.returncode != 0:
        return None

    match = re.search(r"\[(\d+)%\]", process.stdout)
    if not match:
        return None

    try:
        return int(match.group(1))
    except (TypeError, ValueError):
        return None


def _amixer_set_percent(card: str, control: str, percent: int) -> int:
    """Set the ALSA control to the requested percent (clamped 0-100)."""
    clamped = max(0, min(100, int(percent)))
    try:
        subprocess.run(
            ["amixer", "-M", "-c", card, "sset", control, f"{clamped}%", "unmute"],
            capture_output=True,
            text=True,
            check=False,
        )
    except (OSError, ValueError):
        # Best effort; still return the intended clamped value.
        pass
    return clamped


@router.get("/volume")
def get_volume(card: str = CARD_DEFAULT, control: str = CONTROL_DEFAULT):
    percent = _amixer_get_percent(card, control)
    ok = percent is not None
    level = percent / 100.0 if ok else None
    return {
        "ok": ok,
        "card": card,
        "control": control,
        "percent": percent if ok else None,
        "level": level,
    }


@router.post("/volume")
def set_volume(
    level: float = Query(ge=0.0, le=1.0),
    card: str = CARD_DEFAULT,
    control: str = CONTROL_DEFAULT,
):
    percent = _amixer_set_percent(card, control, round(level * 100))
    return {
        "ok": True,
        "card": card,
        "control": control,
        "percent": percent,
        "level": percent / 100.0,
    }


__all__ = ["router"]
