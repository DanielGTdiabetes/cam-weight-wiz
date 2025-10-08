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
        json={"network": {"openai_api_key": "sk-test"}},
        headers={"Authorization": "BasculaPin 1234"},
    )

    assert response.status_code == 200
    stored = service.load()
    assert stored.network.openai_api_key == "sk-test"


def test_post_settings_updates_nightscout_from_diabetes_payload(miniweb_client):
    client, service, config_path = miniweb_client

    response = client.post(
        "/api/settings",
        json={"diabetes": {"nightscout_url": "https://example.com", "nightscout_token": "token123"}},
        headers={"Authorization": "BasculaPin 1234"},
    )

    assert response.status_code == 200
    loaded = service.load()
    assert loaded.diabetes.nightscout_url == "https://example.com"
    assert loaded.diabetes.nightscout_token == "token123"


def test_post_settings_persists_to_disk(miniweb_client):
    """Verify settings are persisted using atomic write"""
    client, service, config_path = miniweb_client

    # Save OpenAI key
    response = client.post(
        "/api/settings",
        json={"network": {"openai_api_key": "sk-persist-test"}},
        headers={"Authorization": "BasculaPin 1234"},
    )
    assert response.status_code == 200

    # Reload from disk
    fresh_service = service.__class__(config_path)
    loaded = fresh_service.load()
    assert loaded.network.openai_api_key == "sk-persist-test"


def test_post_settings_updates_version_on_save(miniweb_client):
    """Verify meta.version increments on each save"""
    client, service, config_path = miniweb_client

    # First save
    response1 = client.post(
        "/api/settings",
        json={"ui": {"sound_enabled": True}},
        headers={"Authorization": "BasculaPin 1234"},
    )
    assert response1.status_code == 200
    
    loaded1 = service.load()
    version1 = loaded1.meta.version

    # Second save
    response2 = client.post(
        "/api/settings",
        json={"ui": {"sound_enabled": False}},
        headers={"Authorization": "BasculaPin 1234"},
    )
    assert response2.status_code == 200
    
    loaded2 = service.load()
    version2 = loaded2.meta.version
    
    assert version2 > version1


def test_settings_health_reports_ok(miniweb_client):
    client, _service, _config_path = miniweb_client

    response = client.get("/api/settings/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload.get("ok") is True
    assert "version" in payload
    assert "can_write" in payload
