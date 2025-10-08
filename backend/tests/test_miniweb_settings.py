import json
import json
from pathlib import Path
from typing import Optional

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


def configure_pin_environment(
    monkeypatch,
    *,
    pin_required: bool,
    extra_cidrs: Optional[str] = None,
    trust_proxy: bool = False,
):
    monkeypatch.setattr(miniweb, "PIN_REQUIRED_FOR_REMOTE", pin_required)
    monkeypatch.setattr(miniweb, "TRUST_PROXY_FOR_CLIENT_IP", trust_proxy)
    networks = miniweb._load_pin_trusted_networks(extra_cidrs)
    monkeypatch.setattr(miniweb, "PIN_TRUSTED_NETWORKS", networks)


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


def test_post_settings_requires_pin(miniweb_client):
    client, service, _config_path = miniweb_client

    response = client.post("/api/settings", json={"openai_api_key": "sk-no-pin"})

    assert response.status_code == 403
    assert response.json() == {"error": "pin_required"}
    stored = service.load()
    assert stored.network.openai_api_key is None


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


def test_pin_bypass_on_lan_by_default(miniweb_client, monkeypatch):
    client, service, _config_path = miniweb_client

    configure_pin_environment(monkeypatch, pin_required=False)
    monkeypatch.setattr(miniweb, "_extract_client_host", lambda request: "192.168.1.50")

    response = client.post("/api/settings", json={"offline_mode": True})

    assert response.status_code == 200
    assert service.load().ui.offline_mode is True


def test_pin_still_requires_pin_outside_lan(miniweb_client, monkeypatch):
    client, service, _config_path = miniweb_client

    configure_pin_environment(monkeypatch, pin_required=False)
    monkeypatch.setattr(miniweb, "_extract_client_host", lambda request: "8.8.8.8")

    response = client.post("/api/settings", json={"offline_mode": False})

    assert response.status_code == 403
    assert response.json() == {"error": "pin_required"}
    assert service.load().ui.offline_mode is False


def test_pin_allowlist_custom_network(miniweb_client, monkeypatch):
    client, service, _config_path = miniweb_client

    configure_pin_environment(monkeypatch, pin_required=False, extra_cidrs="100.64.0.0/10")
    monkeypatch.setattr(miniweb, "_extract_client_host", lambda request: "100.64.1.2")

    response = client.post("/api/settings", json={"offline_mode": True})

    assert response.status_code == 200
    assert service.load().ui.offline_mode is True


def test_pin_proxy_headers_ignored_when_proxy_not_trusted(miniweb_client, monkeypatch):
    client, service, _config_path = miniweb_client

    configure_pin_environment(monkeypatch, pin_required=False, trust_proxy=False)

    def _extract_without_proxy_headers(request):
        return request.client.host

    monkeypatch.setattr(miniweb, "_extract_client_host", _extract_without_proxy_headers)

    response = client.post(
        "/api/settings",
        json={"offline_mode": False},
        headers={"X-Forwarded-For": "203.0.113.5"},
    )

    assert response.status_code == 403
    assert response.json() == {"error": "pin_required"}
    assert service.load().ui.offline_mode is False


def test_pin_proxy_headers_respected_when_trusted(miniweb_client, monkeypatch):
    client, service, _config_path = miniweb_client

    configure_pin_environment(monkeypatch, pin_required=False, trust_proxy=True)

    response = client.post(
        "/api/settings",
        json={"offline_mode": True},
        headers={"X-Forwarded-For": "192.168.1.23"},
    )

    assert response.status_code == 200
    assert service.load().ui.offline_mode is True


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


def test_post_settings_accepts_plain_payload(miniweb_client):
    client, service, _config_path = miniweb_client

    response = client.post(
        "/api/settings",
        json={"openai_api_key": "sk-plain"},
        headers={"Authorization": "BasculaPin 1234"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload.get("openai", {}).get("hasKey") is True
    stored = service.load()
    assert stored.network.openai_api_key == "sk-plain"
    assert stored.openai_api_key == "sk-plain"
    assert stored.integrations.get("openai_api_key") == "sk-plain"


def test_post_settings_accepts_plain_offline_mode(miniweb_client):
    client, service, _config_path = miniweb_client

    response = client.post(
        "/api/settings",
        json={"offline_mode": True},
        headers={"Authorization": "BasculaPin 1234"},
    )

    assert response.status_code == 200
    assert response.json().get("ui", {}).get("offline_mode") is True
    stored = service.load()
    assert stored.ui.offline_mode is True


def test_post_settings_rejects_invalid_plain_offline_mode(miniweb_client):
    client, _service, _config_path = miniweb_client

    response = client.post(
        "/api/settings",
        json={"offline_mode": "nope"},
        headers={"Authorization": "BasculaPin 1234"},
    )

    assert response.status_code == 422
    detail = response.json().get("detail")
    assert isinstance(detail, list) and detail
    first = detail[0]
    loc = first.get("loc")
    assert isinstance(loc, list) and loc[0] == "body" and loc[-1] == "offline_mode"
    assert "type_error.bool" in first.get("type", "")


def test_post_settings_rejects_invalid_offline_mode(miniweb_client):
    client, _service, _config_path = miniweb_client

    response = client.post(
        "/api/settings",
        json={"ui": {"offline_mode": "nope"}},
        headers={"Authorization": "BasculaPin 1234"},
    )

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert isinstance(detail, list) and detail
    first = detail[0]
    assert first["loc"] == ["body", "ui", "offline_mode"]
    assert first["type"] == "type_error.bool"


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
        json={"ui": {"sound_enabled": False}},
        headers={"Authorization": "BasculaPin 1234"},
    )
    assert response1.status_code == 200
    
    loaded1 = service.load()
    version1 = loaded1.meta.version

    # Second save
    response2 = client.post(
        "/api/settings",
        json={"ui": {"sound_enabled": True}},
        headers={"Authorization": "BasculaPin 1234"},
    )
    assert response2.status_code == 200
    
    loaded2 = service.load()
    version2 = loaded2.meta.version

    assert version2 > version1


def test_get_settings_masks_secret_values(miniweb_client):
    client, service, _config_path = miniweb_client

    service.save(
        {
            "network": {"openai_api_key": "sk-secret"},
            "diabetes": {"nightscout_url": "https://mask.me", "nightscout_token": "tok-secret"},
        }
    )

    response = client.get("/api/settings")

    assert response.status_code == 200
    payload = response.json()
    assert payload.get("network", {}).get("openai_api_key") == "__stored__"
    assert payload.get("openai", {}).get("apiKey") == "__stored__"
    assert payload.get("openai", {}).get("hasKey") is True
    assert payload.get("diabetes", {}).get("nightscout_url") == "__stored__"
    assert payload.get("diabetes", {}).get("nightscout_token") == "__stored__"
    assert payload.get("nightscout", {}).get("url") == "__stored__"
    assert payload.get("nightscout", {}).get("token") == "__stored__"
    assert payload.get("nightscout", {}).get("hasToken") is True
    assert payload.get("nightscout_url") == "__stored__"
    assert payload.get("nightscout_token") == "__stored__"


def test_settings_health_reports_ok(miniweb_client):
    client, _service, _config_path = miniweb_client

    response = client.get("/api/settings/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload.get("ok") is True
    assert "version" in payload
    assert "can_write" in payload
