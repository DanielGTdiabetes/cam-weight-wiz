import importlib

from backend import utils_urls


def _clear_env(monkeypatch, keys):
    for key in keys:
        monkeypatch.delenv(key, raising=False)
    importlib.reload(utils_urls)


def test_miniweb_default(monkeypatch):
    _clear_env(monkeypatch, ["MINIWEB_BASE_URL", "BASCULA_MINIWEB_HOST", "BASCULA_MINIWEB_PORT"])
    assert utils_urls.get_miniweb_base_url() == "http://127.0.0.1:8080"


def test_backend_default(monkeypatch):
    _clear_env(monkeypatch, ["BACKEND_BASE_URL", "BASCULA_BACKEND_HOST", "BASCULA_BACKEND_PORT"])
    assert utils_urls.get_backend_base_url() == "http://127.0.0.1:8081"


def test_overrides(monkeypatch):
    monkeypatch.setenv("MINIWEB_BASE_URL", "http://pi:9090")
    monkeypatch.setenv("BACKEND_BASE_URL", "http://pi:7000")
    importlib.reload(utils_urls)
    assert utils_urls.get_miniweb_base_url() == "http://pi:9090"
    assert utils_urls.get_backend_base_url() == "http://pi:7000"
