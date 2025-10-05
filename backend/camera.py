"""Camera API exposing capture and MJPEG streaming via Picamera2."""
from __future__ import annotations

import asyncio
import io
import threading
from typing import AsyncGenerator, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, StreamingResponse
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
    try:
        camera = Picamera2()
        config = camera.create_preview_configuration(main={"size": (640, 480)})
        camera.configure(config)
        camera.start()
        _CAMERA_INSTANCE = camera
        _CAMERA_ERROR = None
    except Exception as exc:  # pragma: no cover - hardware/runtime specific
        _CAMERA_ERROR = f"camera_init_failed: {exc}"[:200]
        _CAMERA_INSTANCE = None
    return _CAMERA_INSTANCE


def _require_camera() -> "Picamera2":
    camera = _init_camera_if_needed()
    if camera is None:
        raise HTTPException(status_code=503, detail=_CAMERA_ERROR or "camera_unavailable")
    return camera


def _capture_jpeg_bytes(camera: "Picamera2") -> bytes:
    with _CAMERA_LOCK:
        frame = camera.capture_array()
    image = Image.fromarray(frame)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=85)
    return buffer.getvalue()


@router.get("/capture")
async def capture_photo() -> Response:
    camera = _require_camera()
    jpeg_bytes = await asyncio.to_thread(_capture_jpeg_bytes, camera)
    return Response(content=jpeg_bytes, media_type="image/jpeg")


async def _mjpeg_generator(camera: "Picamera2") -> AsyncGenerator[bytes, None]:
    boundary = b"--frame"
    while True:
        frame_bytes = await asyncio.to_thread(_capture_jpeg_bytes, camera)
        payload = (
            boundary
            + b"\r\nContent-Type: image/jpeg\r\nContent-Length: "
            + str(len(frame_bytes)).encode()
            + b"\r\n\r\n"
            + frame_bytes
            + b"\r\n"
        )
        yield payload
        await asyncio.sleep(1 / 12)


@router.get("/stream")
async def stream_mjpeg() -> StreamingResponse:
    camera = _require_camera()
    generator = _mjpeg_generator(camera)
    media_type = "multipart/x-mixed-replace; boundary=frame"
    return StreamingResponse(generator, media_type=media_type)
