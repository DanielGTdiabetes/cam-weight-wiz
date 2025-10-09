import pytest

requests = pytest.importorskip("requests")


@pytest.fixture(scope="module")
def openapi_json() -> dict:
    try:
        response = requests.get("http://localhost:8080/openapi.json", timeout=10)
        response.raise_for_status()
    except requests.RequestException as exc:  # pragma: no cover - entorno sin backend activo
        pytest.skip(f"Backend de cámara no disponible en :8080: {exc}")
    return response.json()


def test_openapi_includes_camera_routes(openapi_json: dict) -> None:
    paths = openapi_json.get("paths") or {}

    assert "/api/camera/info" in paths
    assert "get" in paths["/api/camera/info"]

    assert "/api/camera/capture" in paths
    assert "post" in paths["/api/camera/capture"]

    assert "/api/camera/capture-to-file" in paths
    capture_to_file = paths["/api/camera/capture-to-file"]
    assert "post" in capture_to_file
    assert "get" not in capture_to_file


def test_camera_endpoints_exist(openapi_json: dict) -> None:
    paths = openapi_json.get("paths") or {}
    assert "/api/camera/capture-to-file" in paths
    assert "/api/camera/last.jpg" in paths
