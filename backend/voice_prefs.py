from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Dict

CFG_DIR = Path(os.getenv("BASCULA_CFG_DIR", Path.home() / ".bascula"))
CONFIG_PATH = CFG_DIR / "config.json"
STATE_PATH = CFG_DIR / "state.json"
VOICE_STATE_KEY = "voiceEnabled"


def _normalize_bool(value: Any) -> bool | None:
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


def _load_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_json(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass


def _read_state() -> Dict[str, Any]:
    return _load_json(STATE_PATH)


def _write_state(state: Dict[str, Any]) -> None:
    _save_json(STATE_PATH, state)


def get_voice_enabled_default() -> bool:
    config = _load_json(CONFIG_PATH)
    if isinstance(config, dict):
        voice_cfg = config.get("voice")
        if isinstance(voice_cfg, dict):
            normalized = _normalize_bool(voice_cfg.get("enabledDefault"))
            if normalized is not None:
                return normalized

        normalized = _normalize_bool(config.get("voice_enabled_default"))
        if normalized is not None:
            return normalized

    env_value = _normalize_bool(os.getenv("BASCULA_VOICE_DEFAULT", "1"))
    if env_value is not None:
        return env_value

    return True


def get_voice_enabled() -> bool:
    state = _read_state()
    normalized = _normalize_bool(state.get(VOICE_STATE_KEY))
    if normalized is not None:
        return normalized

    return get_voice_enabled_default()


def set_voice_enabled(enabled: bool) -> None:
    state = _read_state()
    state[VOICE_STATE_KEY] = bool(enabled)
    _write_state(state)
