from __future__ import annotations

import importlib
import pathlib
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def test_rapidocr_imports():
    for name in ("rapidocr_onnxruntime", "onnxruntime", "pyclipper", "shapely"):
        try:
            importlib.import_module(name)
        except ImportError as exc:
            if "libGL.so.1" in str(exc):
                pytest.skip("OpenCV runtime dependency (libGL.so.1) missing in test env")
            raise


def test_models_dir_defaults(monkeypatch):
    monkeypatch.delenv("BASCULA_OCR_MODELS_DIR", raising=False)
    module = importlib.reload(importlib.import_module("backend.ocr_models"))

    def _noop_mkdir(self: pathlib.Path, parents: bool = True, exist_ok: bool = True) -> None:
        return None

    monkeypatch.setattr(pathlib.Path, "mkdir", _noop_mkdir)
    path = module.ensure_ocr_models_dir()
    assert path == pathlib.Path("/opt/rapidocr/models")


@pytest.mark.parametrize(
    "det_name",
    ["det.onnx", "rapidocr_det_model.onnx"],
)
def test_ocr_health_missing_models(monkeypatch, tmp_path, det_name):
    pytest.importorskip("fastapi")
    pytest.importorskip("pyzbar")
    try:
        importlib.import_module("pyzbar.pyzbar")
    except ImportError as exc:
        pytest.skip(f"pyzbar runtime dependency missing: {exc}")
    from fastapi.testclient import TestClient

    monkeypatch.setenv("BASCULA_OCR_MODELS_DIR", str(tmp_path))
    monkeypatch.setenv("BASCULA_OCR_ENABLED", "true")

    from backend import ocr_service

    # Ensure no models exist -> expect missing_models response.
    ocr_service.reset_ocr_service_cache()
    from backend.asgi import app

    client = TestClient(app)
    response = client.get("/ocr/health")
    assert response.status_code == 503
    assert response.json().get("ocr") == "missing_models"

    # Create fake detection/reco models and stub RapidOCR to avoid heavy loading.
    (tmp_path / det_name).write_bytes(b"")
    (tmp_path / "rec.onnx").write_bytes(b"")

    class _DummyRapidOCR:
        def __init__(self, **kwargs):
            pass

        def __call__(self, array):
            return [], 0.0

    monkeypatch.setattr(ocr_service.RapidOCRService, "_import_rapidocr", lambda self: _DummyRapidOCR)
    ocr_service.reset_ocr_service_cache()

    client = TestClient(app)
    response = client.get("/ocr/health")
    assert response.status_code == 200
    assert response.json().get("ocr") == "ready"
