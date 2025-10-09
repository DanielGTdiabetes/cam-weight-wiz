import pytest

requests = pytest.importorskip("requests")


def test_openapi_includes_camera_routes() -> None:
    try:
        response = requests.get("http://localhost:8080/openapi.json", timeout=10)
        response.raise_for_status()
    except requests.RequestException as exc:  # pragma: no cover - entorno sin backend activo
        pytest.skip(f"Backend de cámara no disponible en :8080: {exc}")
    schema = response.json()
    paths = schema.get("paths") or {}

    assert "/api/camera/info" in paths
    assert "get" in paths["/api/camera/info"]

    assert "/api/camera/capture" in paths
    assert "post" in paths["/api/camera/capture"]

    assert "/api/camera/capture-to-file" in paths
    capture_to_file = paths["/api/camera/capture-to-file"]
    assert "post" in capture_to_file
    assert "get" not in capture_to_file

    assert "/api/camera/last.jpg" in paths
    last_capture = paths["/api/camera/last.jpg"]
    assert "get" in last_capture


def test_camera_last_capture_serving_headers() -> None:
    url = "http://localhost:8080/api/camera/last.jpg"
    try:
        response = requests.get(url, timeout=10)
    except requests.RequestException as exc:  # pragma: no cover - entorno sin backend activo
        pytest.skip(f"Backend de cámara no disponible en :8080: {exc}")

    if response.status_code == 404:
        payload = response.json()
        assert payload.get("ok") is False
        assert payload.get("error") in {"no_capture", "capture_not_found"}
        return

    response.raise_for_status()
    assert response.headers.get("Content-Type", "").startswith("image/jpeg")
    cache_control = response.headers.get("Cache-Control", "")
    assert "no-store" in cache_control
