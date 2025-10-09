import os

import pytest
import requests


def test_camera_capture_ok():
    try:
        response = requests.post("http://localhost:8080/api/camera/capture-to-file")
    except requests.exceptions.RequestException as exc:
        pytest.skip(f"Camera capture API unavailable: {exc}")

    data = response.json()
    assert data["ok"] is True
    assert os.path.exists(data["path"])
    assert os.path.getsize(data["path"]) > 50000
