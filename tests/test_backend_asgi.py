from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from fastapi.testclient import TestClient

OPTIONAL_MODULES = {
    "requests",
    "serial",
    "pytesseract",
    "PIL",
    "pyzbar",
    "rapidfuzz",
    "rapidocr",
    "rapidocr_onnxruntime",
    "sounddevice",
    "vosk",
    "zbar",
}


def _import_app():
    try:
        from backend.asgi import app  # type: ignore import-error
    except ModuleNotFoundError as exc:  # pragma: no cover - optional runtime deps
        if exc.name in OPTIONAL_MODULES:
            pytest.skip(f"backend.asgi depends on optional module: {exc.name}")
        raise
    except ImportError as exc:  # pragma: no cover - optional runtime deps
        message = str(exc)
        if any(name in message for name in OPTIONAL_MODULES):
            pytest.skip(f"backend.asgi optional dependency missing: {message}")
        raise
    return app


def test_health_endpoint_returns_ok_status():
    app = _import_app()
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    payload = response.json()
    assert isinstance(payload, dict)
    assert payload.get("status") in {"ok", "healthy"}
