import os

import requests


def test_camera_capture_ok():
    response = requests.post("http://localhost:8080/api/camera/capture-to-file")
    data = response.json()
    assert data["ok"] is True
    assert os.path.exists(data["path"])
    assert os.path.getsize(data["path"]) > 50000
