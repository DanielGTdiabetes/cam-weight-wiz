import json
import sys
from copy import deepcopy
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

if "serial" not in sys.modules:
    import types

    serial_module = types.ModuleType("serial")

    class SerialException(Exception):
        pass

    serial_module.SerialException = SerialException
    serial_module.Serial = object  # type: ignore[attr-defined]
    sys.modules["serial"] = serial_module

from backend.app.services.settings_service import SettingsService
from fastapi.testclient import TestClient

from backend.main import (
    app,
    _deep_merge_dict,
    _normalize_settings_payload,
    _synchronize_secret_aliases,
    _SECRET_PLACEHOLDER,
)


@pytest.fixture()
def settings_service(tmp_path: Path):
    config_path = tmp_path / "config.json"
    service = SettingsService(config_path)
    return service, config_path


@pytest.fixture()
def api_client(monkeypatch):
    async def _noop(*_args, **_kwargs):
        return None

    monkeypatch.setattr("backend.main.init_scale", _noop)
    monkeypatch.setattr("backend.main.close_scale", _noop)

    with TestClient(app) as client:
        yield client


def read_config(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def apply_updates(service: SettingsService, payload: dict) -> None:
    existing = service.load().dict()
    normalized = _normalize_settings_payload(payload, existing)
    merged = deepcopy(existing)
    _deep_merge_dict(merged, normalized)
    _synchronize_secret_aliases(merged)
    service._save_atomic(merged)


def test_legacy_payload_is_normalized(settings_service):
    service, config_path = settings_service

    apply_updates(
        service,
        {
            "openai": {"apiKey": "sk-test"},
            "nightscout": {"url": "https://example.com", "token": "secret"},
        },
    )

    config = read_config(config_path)
    assert config.get("network", {}).get("openai_api_key") == "sk-test"
    assert config.get("diabetes", {}).get("nightscout_url") == "https://example.com"
    assert config.get("diabetes", {}).get("nightscout_token") == "secret"


def test_placeholder_keeps_existing_secret(settings_service):
    service, config_path = settings_service

    apply_updates(
        service,
        {
            "network": {"openai_api_key": "sk-live"},
            "diabetes": {"nightscout_url": "https://ns.example", "nightscout_token": "tok"},
        },
    )

    apply_updates(
        service,
        {
            "network": {"openai_api_key": _SECRET_PLACEHOLDER},
            "diabetes": {
                "nightscout_url": _SECRET_PLACEHOLDER,
                "nightscout_token": _SECRET_PLACEHOLDER,
            },
        },
    )

    config = read_config(config_path)
    assert config.get("network", {}).get("openai_api_key") == "sk-live"
    assert config.get("diabetes", {}).get("nightscout_url") == "https://ns.example"
    assert config.get("diabetes", {}).get("nightscout_token") == "tok"


def test_get_masks_secret_values(settings_service):
    service, _ = settings_service

    apply_updates(
        service,
        {
            "network": {"openai_api_key": "sk-mask"},
            "diabetes": {"nightscout_url": "https://mask", "nightscout_token": "hidden"},
        },
    )

    payload = service.get_for_client(include_secrets=False)
    assert payload.get("network", {}).get("openai_api_key") == _SECRET_PLACEHOLDER
    assert payload.get("diabetes", {}).get("nightscout_url") == _SECRET_PLACEHOLDER
    assert payload.get("diabetes", {}).get("nightscout_token") == _SECRET_PLACEHOLDER


def test_default_sound_enabled_is_true(settings_service):
    service, _ = settings_service

    settings = service.load()

    assert settings.ui.sound_enabled is True


def test_sound_enabled_respects_saved_value(settings_service):
    service, _ = settings_service

    apply_updates(
        service,
        {
            "ui": {"sound_enabled": False},
        },
    )

    settings = service.load()

    assert settings.ui.sound_enabled is False


def test_options_settings_lists_expected_methods(api_client):
    response = api_client.options("/api/settings")

    assert response.status_code == 204
    assert response.headers.get("allow") == "GET, POST, OPTIONS"
    assert response.headers.get("access-control-allow-methods") == "GET, POST, OPTIONS"


def test_put_settings_is_not_allowed(api_client):
    response = api_client.put("/api/settings")

    assert response.status_code == 405
    allow = response.headers.get("allow", "")
    assert "POST" in allow
    assert "PUT" not in allow
