from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import tests.test_backend_url_resolution  # noqa: F401  # Ensure dependency stubs are registered

from backend.utils_urls import get_backend_base_url


def test_backend_url_defaults(monkeypatch):
    for var in ("BACKEND_BASE_URL", "BASCULA_BACKEND_HOST", "BASCULA_BACKEND_PORT"):
        monkeypatch.delenv(var, raising=False)
    assert get_backend_base_url() == "http://127.0.0.1:8081"


def test_backend_url_env(monkeypatch):
    monkeypatch.setenv("BACKEND_BASE_URL", "http://pi.local:9000")
    assert get_backend_base_url() == "http://pi.local:9000"


def test_backend_url_env_parts(monkeypatch):
    monkeypatch.delenv("BACKEND_BASE_URL", raising=False)
    monkeypatch.setenv("BASCULA_BACKEND_HOST", "10.0.0.5")
    monkeypatch.setenv("BASCULA_BACKEND_PORT", "7001")
    assert get_backend_base_url() == "http://10.0.0.5:7001"
