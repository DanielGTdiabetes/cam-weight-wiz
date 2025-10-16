"""Tests for backend base URL resolution logic."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import ModuleType

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    import fastapi  # type: ignore
    import fastapi.responses  # type: ignore
except ModuleNotFoundError:
    fastapi = ModuleType("fastapi")

    class _FakeRouter:
        def __init__(self, *args, **kwargs):
            pass

        def get(self, *args, **kwargs):
            def decorator(func):
                return func

            return decorator

        def post(self, *args, **kwargs):
            def decorator(func):
                return func

            return decorator

    class _FakeFastAPI:
        def on_event(self, *args, **kwargs):
            def decorator(func):
                return func

            return decorator

    class _FakeHTTPException(Exception):
        def __init__(self, status_code: int, detail: str):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    class _FakeRequest:
        async def is_disconnected(self) -> bool:
            return False

    fastapi.APIRouter = _FakeRouter  # type: ignore[attr-defined]
    fastapi.FastAPI = _FakeFastAPI  # type: ignore[attr-defined]
    fastapi.HTTPException = _FakeHTTPException  # type: ignore[attr-defined]
    fastapi.Request = _FakeRequest  # type: ignore[attr-defined]

    responses = ModuleType("fastapi.responses")

    class _FakeStreamingResponse:  # pragma: no cover - trivial stub
        def __init__(self, *args, **kwargs) -> None:
            pass

    responses.StreamingResponse = _FakeStreamingResponse  # type: ignore[attr-defined]

    sys.modules["fastapi"] = fastapi
    sys.modules["fastapi.responses"] = responses

try:
    import pydantic  # type: ignore
except ModuleNotFoundError:
    pydantic = ModuleType("pydantic")

    class _FakeBaseModel:  # pragma: no cover - trivial stub
        def __init__(self, **kwargs) -> None:
            for key, value in kwargs.items():
                setattr(self, key, value)

    pydantic.BaseModel = _FakeBaseModel  # type: ignore[attr-defined]
    sys.modules["pydantic"] = pydantic

try:
    import rapidfuzz  # type: ignore
except ModuleNotFoundError:
    rapidfuzz = ModuleType("rapidfuzz")

    class _FakeFuzzModule(ModuleType):
        @staticmethod
        def ratio(*_args, **_kwargs):  # pragma: no cover - trivial stub
            return 0

    rapidfuzz.fuzz = _FakeFuzzModule("rapidfuzz.fuzz")  # type: ignore[attr-defined]
    sys.modules["rapidfuzz"] = rapidfuzz

import backend.utils_urls as utils_urls


def _reset_env(monkeypatch):
    for key in [
        "BACKEND_BASE_URL",
        "BASCULA_API_URL",
        "BASCULA_BACKEND_HOST",
        "BASCULA_BACKEND_PORT",
    ]:
        monkeypatch.delenv(key, raising=False)

    importlib.reload(utils_urls)


def test_backend_base_url_prefers_explicit_env(monkeypatch):
    _reset_env(monkeypatch)
    monkeypatch.setenv("BACKEND_BASE_URL", "https://example.local/base/")

    importlib.reload(utils_urls)
    assert utils_urls.get_backend_base_url() == "https://example.local/base"


def test_backend_base_url_from_host_and_port(monkeypatch):
    _reset_env(monkeypatch)
    monkeypatch.setenv("BASCULA_BACKEND_HOST", "0.0.0.0")
    monkeypatch.setenv("BASCULA_BACKEND_PORT", "9001")

    importlib.reload(utils_urls)
    assert utils_urls.get_backend_base_url() == "http://0.0.0.0:9001"


def test_backend_base_url_defaults(monkeypatch):
    _reset_env(monkeypatch)

    importlib.reload(utils_urls)
    assert utils_urls.get_backend_base_url() == "http://127.0.0.1:8081"
