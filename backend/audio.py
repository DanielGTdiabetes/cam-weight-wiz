"""Audio volume management endpoints using ALSA amixer."""
from __future__ import annotations

import os
import re
import subprocess
from typing import Iterable, Optional, Tuple

from fastapi import APIRouter, Query

router = APIRouter(prefix="/api/audio", tags=["audio"])

CARD_DEFAULT = os.getenv("AUDIO_CARD_DEFAULT", "sndrpihifiberry")
CONTROL_DEFAULT = os.getenv("AUDIO_CONTROL_DEFAULT", "DSP Volume")
CARD_FALLBACKS = tuple(dict.fromkeys([CARD_DEFAULT, "sndrpihifiberry", "0", "hw:0"]))
CONTROL_FALLBACKS = tuple(
    dict.fromkeys(
        [CONTROL_DEFAULT, "DSP Volume", "Digital", "Master"]
    )
)


def _candidates(base: str, fallbacks: Iterable[str]) -> Tuple[str, ...]:
    items = []
    if base:
        items.append(base)
    for candidate in fallbacks:
        if candidate and candidate not in items:
            items.append(candidate)
    return tuple(items)


def _amixer_get_percent(card: str, controls: Iterable[str]) -> Tuple[Optional[int], Optional[str]]:
    """Return the volume percent for the first control that succeeds."""
    for control in controls:
        try:
            process = subprocess.run(
                ["amixer", "-M", "-c", card, "sget", control],
                capture_output=True,
                text=True,
                check=False,
            )
        except (OSError, ValueError):
            continue

        if process.returncode != 0:
            continue

        match = re.search(r"\[(\d+)%\]", process.stdout)
        if not match:
            continue

        try:
            return int(match.group(1)), control
        except (TypeError, ValueError):
            continue

    return None, None


def _amixer_set_percent(card: str, controls: Iterable[str], percent: int) -> Tuple[int, Optional[str]]:
    """Set the ALSA control to the requested percent (clamped 0-100)."""
    clamped = max(0, min(100, int(percent)))
    for control in controls:
        try:
            subprocess.run(
                ["amixer", "-M", "-c", card, "sset", control, f"{clamped}%", "unmute"],
                capture_output=True,
                text=True,
                check=False,
            )
        except (OSError, ValueError):
            continue
        else:
            return clamped, control
    return clamped, None

@router.get("/volume")
def get_volume(card: str = CARD_DEFAULT, control: str = CONTROL_DEFAULT):
    cards = _candidates(card, CARD_FALLBACKS)
    controls = _candidates(control, CONTROL_FALLBACKS)

    percent = None
    control_used = None
    card_used = None

    for candidate_card in cards:
        percent, control_used = _amixer_get_percent(candidate_card, controls)
        if percent is not None:
            card_used = candidate_card
            break

    ok = percent is not None
    level = percent / 100.0 if ok else None
    return {
        "ok": ok,
        "card": card_used or card,
        "control": control_used or control,
        "percent": percent if ok else None,
        "level": level,
    }


@router.post("/volume")
def set_volume(
    level: float = Query(ge=0.0, le=1.0),
    card: str = CARD_DEFAULT,
    control: str = CONTROL_DEFAULT,
):
    cards = _candidates(card, CARD_FALLBACKS)
    controls = _candidates(control, CONTROL_FALLBACKS)

    percent_value = round(level * 100)
    final_percent = percent_value
    control_used = None
    card_used = None

    for candidate_card in cards:
        final_percent, control_used = _amixer_set_percent(candidate_card, controls, percent_value)
        if control_used:
            card_used = candidate_card
            break

    return {
        "ok": True,
        "card": card_used or card,
        "control": control_used or control,
        "percent": final_percent,
        "level": final_percent / 100.0,
    }


__all__ = ["router"]
