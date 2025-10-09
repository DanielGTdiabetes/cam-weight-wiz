import os

import requests


CAPTURE_ENDPOINT = "http://localhost:8080/api/camera/capture-to-file"
CAPTURE_FILE_PATH = "/run/bascula/captures/camera-capture.jpg"
CAPTURE_URL = "http://localhost/captures/camera-capture.jpg"


def _request_capture() -> dict:
    response = requests.post(CAPTURE_ENDPOINT)
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["path"] == CAPTURE_FILE_PATH
    assert data["url"] == "/captures/camera-capture.jpg"
    return data


def test_camera_capture_ok():
    data = _request_capture()
    assert os.path.exists(data["path"])
    assert os.path.getsize(data["path"]) > 50000


def test_camera_capture_served_via_nginx():
    _request_capture()
    head_response = requests.head(CAPTURE_URL)
    assert head_response.status_code == 200
    assert head_response.headers.get("Content-Type", "").lower().startswith("image/jpeg")

    traversal = requests.get("http://localhost/captures/../../etc/passwd")
    assert traversal.status_code == 404

    forbidden = requests.get(
        CAPTURE_URL,
        headers={"X-Forwarded-For": "203.0.113.10"},
    )
    assert forbidden.status_code in {403, 444}
