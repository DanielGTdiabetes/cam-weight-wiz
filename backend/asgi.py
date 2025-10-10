"""ASGI application entrypoint for the Bascula backend."""
from __future__ import annotations

from backend.main import app as _app

# Re-export the FastAPI application created in backend.main so uvicorn can
# locate it via the dotted path ``backend.asgi:app``.
app = _app

__all__ = ["app"]
