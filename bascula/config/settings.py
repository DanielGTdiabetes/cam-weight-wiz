"""Default configuration values for the Báscula UI."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class UIConfig:
    """Feature toggles for the touchscreen interface."""

    tare_enabled: bool = True
    timers_enabled: bool = True
    audio_enabled: bool = True


__all__ = ["UIConfig"]
