import os

import requests


CAPTURE_ENDPOINT = "http://localhost:8080/api/camera/capture-to-file"
CAPTURE_FILE_PATH = "/run/bascula/captures/camera-capture.jpg"


def _request_capture() -> dict:
    response = requests.post(CAPTURE_ENDPOINT)
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["url"] == "/captures/camera-capture.jpg"
    assert isinstance(data.get("size"), int)
    assert isinstance(data.get("full"), bool)
    return data


def test_camera_capture_ok():
    data = _request_capture()
    assert os.path.exists(CAPTURE_FILE_PATH)
    assert os.path.getsize(CAPTURE_FILE_PATH) > 50000


def test_camera_capture_file_written():
    data = _request_capture()
    assert os.path.exists(CAPTURE_FILE_PATH)
    assert data["size"] == os.path.getsize(CAPTURE_FILE_PATH)
