"""Camera API exposing capture and MJPEG streaming via Picamera2."""
from __future__ import annotations

import io
import threading
import time
from typing import Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response, StreamingResponse
from PIL import Image

try:  # pragma: no cover - optional dependency in runtime
    from picamera2 import Picamera2
except ImportError:  # pragma: no cover - runtime guard
    Picamera2 = None  # type: ignore


router = APIRouter(prefix="/api/camera", tags=["camera"])

_CAMERA_LOCK = threading.Lock()
_CAMERA_INSTANCE: Optional["Picamera2"] = None
_CAMERA_ERROR: Optional[str] = None


def _init_camera_if_needed() -> Optional["Picamera2"]:
    global _CAMERA_INSTANCE, _CAMERA_ERROR
    if _CAMERA_INSTANCE is not None:
        return _CAMERA_INSTANCE
    if Picamera2 is None:
        _CAMERA_ERROR = "picamera2_not_available"
        return None
    with _CAMERA_LOCK:
        if _CAMERA_INSTANCE is not None:
            return _CAMERA_INSTANCE
        try:
            cam = Picamera2()
            cfg = cam.create_preview_configuration(main={"size": (640, 480)})
            cam.configure(cfg)
            cam.start()
            _CAMERA_INSTANCE = cam
            _CAMERA_ERROR = None
        except Exception as exc:  # pragma: no cover
            _CAMERA_INSTANCE = None
            _CAMERA_ERROR = f"camera_init_failed: {exc}"[:200]
    return _CAMERA_INSTANCE


@router.get("/health")
def camera_health():
    cam = _init_camera_if_needed()
    return {"ok": cam is not None, "reason": _CAMERA_ERROR}


@router.get("/capture")
def capture_jpeg():
    cam = _init_camera_if_needed()
    if cam is None:
        return JSONResponse(
            {"ok": False, "reason": _CAMERA_ERROR or "camera_unavailable"},
            status_code=503,
        )
    try:
        with _CAMERA_LOCK:
            arr = cam.capture_array()
        buf = io.BytesIO()
        Image.fromarray(arr).save(buf, format="JPEG", quality=85)
        return Response(content=buf.getvalue(), media_type="image/jpeg")
    except Exception as exc:
        return JSONResponse(
            {"ok": False, "reason": f"capture_failed: {exc}"[:200]},
            status_code=503,
        )


@router.get("/stream")
def stream_mjpeg():
    cam = _init_camera_if_needed()
    if cam is None:
        return JSONResponse(
            {"ok": False, "reason": _CAMERA_ERROR or "camera_unavailable"},
            status_code=503,
        )
    boundary = b"--frame\r\n"

    def gen():
        while True:
            with _CAMERA_LOCK:
                arr = cam.capture_array()
            b = io.BytesIO()
            Image.fromarray(arr).save(b, format="JPEG", quality=80)
            yield boundary + b"Content-Type: image/jpeg\r\n\r\n" + b.getvalue() + b"\r\n"
            time.sleep(1 / 12)

    return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=frame")
