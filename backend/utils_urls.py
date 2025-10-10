"""Utility helpers to resolve backend and miniweb base URLs."""
from __future__ import annotations

import os


def get_backend_base_url() -> str:
    """Return the backend base URL honoring environment overrides."""

    url = os.getenv("BACKEND_BASE_URL")
    if url:
        return url.rstrip("/")

    host = os.getenv("BASCULA_BACKEND_HOST", "127.0.0.1")
    port_value = os.getenv("BASCULA_BACKEND_PORT", "8081")
    try:
        port = int(port_value)
    except (TypeError, ValueError):
        port = 8081
    return f"http://{host}:{port}"


def get_miniweb_base_url() -> str:
    """Return the miniweb base URL honoring environment overrides."""

    url = os.getenv("MINIWEB_BASE_URL")
    if url:
        return url.rstrip("/")

    host = os.getenv("BASCULA_MINIWEB_HOST", "127.0.0.1")
    port_value = os.getenv("BASCULA_MINIWEB_PORT", "8080")
    try:
        port = int(port_value)
    except (TypeError, ValueError):
        port = 8080
    return f"http://{host}:{port}"
