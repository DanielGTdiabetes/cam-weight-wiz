import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import backend.miniweb as miniweb
import backend.app.services.settings_service as settings_module
from backend.app.services.settings_service import SettingsService


@pytest.fixture()
def miniweb_client(tmp_path: Path, monkeypatch):
    config_path = tmp_path / "config.json"
    cfg_dir = tmp_path
    pin_path = tmp_path / "miniweb_pin"

    service = SettingsService(config_path)

    monkeypatch.setattr(miniweb, "CONFIG_PATH", config_path)
    monkeypatch.setattr(miniweb, "CFG_DIR", cfg_dir)
    monkeypatch.setattr(miniweb, "PIN_PATH", pin_path)
    monkeypatch.setattr(miniweb, "CURRENT_PIN", "1234")
    monkeypatch.setattr(miniweb, "_settings_ws_connections", set())

    monkeypatch.setattr(settings_module, "_service_instance", None)

    def _get_service(_path=None):
        return service

    monkeypatch.setattr(settings_module, "get_settings_service", _get_service)
    monkeypatch.setattr(miniweb, "get_settings_service", _get_service)

    client = TestClient(miniweb.app)
    return client, service, config_path


def read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def test_get_settings_returns_defaults(miniweb_client):
    client, _service, _config_path = miniweb_client
    response = client.get("/api/settings")

    assert response.status_code == 200
    payload = response.json()
    assert "ui" in payload
    assert payload["ui"].get("offline_mode") is False
    assert "network" in payload
    assert payload["network"].get("ap", {}).get("ssid") == miniweb.AP_DEFAULT_SSID
    assert "openai" in payload and payload["openai"].get("hasKey") is False


def test_options_settings_allows_expected_methods(miniweb_client):
    client, _service, _config_path = miniweb_client
    response = client.options("/api/settings")

    assert response.status_code == 204
    allow_header = response.headers.get("allow")
    assert allow_header == "GET, POST, OPTIONS"


def test_post_settings_accepts_authorization_header(miniweb_client):
    client, service, config_path = miniweb_client

    response = client.post(
        "/api/settings",
        json={"openai_api_key": "sk-test"},
        headers={"Authorization": "BasculaPin 1234"},
    )

    assert response.status_code == 200
    stored = read_json(config_path)
    assert stored.get("openai_api_key") == "sk-test"
    assert service.load().network.openai_api_key == "sk-test"


def test_post_settings_updates_nightscout_from_diabetes_payload(miniweb_client):
    client, service, config_path = miniweb_client

    response = client.post(
        "/api/settings",
        json={"diabetes": {"nightscout_url": "https://example.com", "nightscout_token": "token"}},
        headers={"Authorization": "BasculaPin 1234"},
    )

    assert response.status_code == 200
    stored = read_json(config_path)
    assert stored.get("nightscout_url") == "https://example.com"
    assert stored.get("nightscout_token") == "token"
    loaded = service.load()
    assert loaded.diabetes.nightscout_url == "https://example.com"
    assert loaded.diabetes.nightscout_token == "token"


def test_settings_health_reports_ok(miniweb_client):
    client, _service, _config_path = miniweb_client

    response = client.get("/api/settings/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload.get("ok") is True
    assert "version" in payload
    assert "can_write" in payload
