from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, MutableMapping, Optional


def _normalize_bool(value: Any) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "t", "yes", "y", "on"}:
            return True
        if normalized in {"0", "false", "f", "no", "n", "off"}:
            return False
    return None


def _normalize_float(value: Any) -> Optional[float]:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return None
        trimmed = trimmed.replace(",", ".")
        try:
            return float(trimmed)
        except ValueError:
            return None
    return None


def _normalize_int(value: Any) -> Optional[int]:
    float_candidate = _normalize_float(value)
    if float_candidate is None:
        return None
    try:
        return int(round(float_candidate))
    except (TypeError, ValueError):
        return None


@dataclass
class VoiceSettings:
    speech_enabled: bool = True
    voice_id: Optional[str] = None


@dataclass
class DiabetesRule15Settings:
    enabled: bool = True


@dataclass
class DiabetesSettings:
    enabled: bool = False
    low_thresh: int = 70
    low_warn: int = 80
    high_thresh: int = 180
    rule_15: DiabetesRule15Settings = field(default_factory=DiabetesRule15Settings)
    nightscout_url: Optional[str] = None
    nightscout_token: Optional[str] = None


@dataclass
class AppSettings:
    voice: VoiceSettings = field(default_factory=VoiceSettings)
    diabetes: DiabetesSettings = field(default_factory=DiabetesSettings)


def load_settings(raw: Mapping[str, Any]) -> AppSettings:
    voice_cfg = raw.get("voice")
    if not isinstance(voice_cfg, Mapping):
        voice_cfg = {}

    general_cfg = raw.get("general")
    if not isinstance(general_cfg, Mapping):
        general_cfg = {}

    speech_enabled = _normalize_bool(voice_cfg.get("speech_enabled"))
    if speech_enabled is None:
        speech_enabled = _normalize_bool(general_cfg.get("tts_enabled"))
    if speech_enabled is None:
        speech_enabled = True

    voice_id = voice_cfg.get("voice_id")
    if not isinstance(voice_id, str) or not voice_id.strip():
        voice_id = None
    else:
        voice_id = voice_id.strip()

    diabetes_cfg = raw.get("diabetes")
    if not isinstance(diabetes_cfg, Mapping):
        diabetes_cfg = {}

    diabetes_enabled = _normalize_bool(diabetes_cfg.get("enabled"))
    if diabetes_enabled is None:
        diabetes_enabled = _normalize_bool(diabetes_cfg.get("diabetes_enabled"))
    if diabetes_enabled is None:
        diabetes_enabled = False

    low_thresh = _normalize_int(diabetes_cfg.get("low_thresh"))
    if low_thresh is None:
        low_thresh = _normalize_int(diabetes_cfg.get("hypo_alarm")) or 70

    low_warn = _normalize_int(diabetes_cfg.get("low_warn"))
    if low_warn is None:
        low_warn = max(low_thresh + 5, 80)

    high_thresh = _normalize_int(diabetes_cfg.get("high_thresh"))
    if high_thresh is None:
        high_thresh = _normalize_int(diabetes_cfg.get("hyper_alarm")) or 180

    rule_cfg = diabetes_cfg.get("rule_15")
    if isinstance(rule_cfg, Mapping):
        rule_enabled = _normalize_bool(rule_cfg.get("enabled"))
    else:
        rule_cfg = {}
        rule_enabled = None
    if rule_enabled is None:
        rule_enabled = True

    return AppSettings(
        voice=VoiceSettings(
            speech_enabled=bool(speech_enabled),
            voice_id=voice_id,
        ),
        diabetes=DiabetesSettings(
            enabled=bool(diabetes_enabled),
            low_thresh=int(low_thresh),
            low_warn=int(low_warn),
            high_thresh=int(high_thresh),
            rule_15=DiabetesRule15Settings(enabled=bool(rule_enabled)),
            nightscout_url=(
                diabetes_cfg.get("nightscout_url")
                if isinstance(diabetes_cfg.get("nightscout_url"), str)
                else None
            ),
            nightscout_token=(
                diabetes_cfg.get("nightscout_token")
                if isinstance(diabetes_cfg.get("nightscout_token"), str)
                else None
            ),
        ),
    )


def dump_settings(settings: AppSettings, target: MutableMapping[str, Any]) -> None:
    voice_cfg = target.setdefault("voice", {})
    if not isinstance(voice_cfg, MutableMapping):
        voice_cfg = {}
        target["voice"] = voice_cfg

    voice_cfg["speech_enabled"] = settings.voice.speech_enabled
    if settings.voice.voice_id:
        voice_cfg["voice_id"] = settings.voice.voice_id
    elif "voice_id" in voice_cfg:
        voice_cfg.pop("voice_id", None)

    diabetes_cfg = target.setdefault("diabetes", {})
    if not isinstance(diabetes_cfg, MutableMapping):
        diabetes_cfg = {}
        target["diabetes"] = diabetes_cfg

    diabetes_cfg["enabled"] = settings.diabetes.enabled
    diabetes_cfg["low_thresh"] = settings.diabetes.low_thresh
    diabetes_cfg["low_warn"] = settings.diabetes.low_warn
    diabetes_cfg["high_thresh"] = settings.diabetes.high_thresh

    rule_cfg = diabetes_cfg.setdefault("rule_15", {})
    if not isinstance(rule_cfg, MutableMapping):
        rule_cfg = {}
        diabetes_cfg["rule_15"] = rule_cfg
    rule_cfg["enabled"] = settings.diabetes.rule_15.enabled

    if settings.diabetes.nightscout_url:
        diabetes_cfg["nightscout_url"] = settings.diabetes.nightscout_url
    if settings.diabetes.nightscout_token:
        diabetes_cfg["nightscout_token"] = settings.diabetes.nightscout_token


__all__ = [
    "AppSettings",
    "VoiceSettings",
    "DiabetesSettings",
    "DiabetesRule15Settings",
    "load_settings",
    "dump_settings",
]
