"""Camera API exposing Picamera2 headless captures."""
from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, Response

from backend.camera_service import (
    CameraBusyError,
    CameraOperationError,
    CameraTimeoutError,
    CameraUnavailableError,
    get_camera_service,
)


router = APIRouter(prefix="/api/camera", tags=["camera"])

LOG = logging.getLogger("bascula.camera.api")


def _camera_error_response(status_code: int, reason: str, message: str):
    detail = {"ok": False, "error": reason, "message": message}
    return JSONResponse(detail, status_code=status_code)


@router.get("/info")
def camera_info():
    try:
        service = get_camera_service()
        properties = service.get_camera_info()
    except CameraUnavailableError as exc:
        LOG.exception("No hay cámara disponible: %s", exc)
        return _camera_error_response(503, "camera_unavailable", str(exc))
    return {
        "Model": properties.get("Model"),
        "Rotation": properties.get("Rotation"),
        "PixelArraySize": properties.get("PixelArraySize"),
    }


def _capture_tmp_dir() -> Path:
    return Path(os.getenv("TMPDIR", "/tmp"))


def _capture_file_path() -> Path:
    return _capture_tmp_dir() / "camera-capture.jpg"


def _capture_bytes(full: bool, timeout_ms: int = 2000) -> bytes:
    service = get_camera_service()
    try:
        return service.capture_bytes(full=full, timeout_ms=timeout_ms)
    except CameraBusyError as exc:
        LOG.exception("La cámara está ocupada: %s", exc)
        raise HTTPException(status_code=409, detail={"error": "camera_busy", "message": str(exc)}) from exc
    except CameraUnavailableError as exc:
        LOG.exception("Cámara no disponible: %s", exc)
        raise HTTPException(status_code=503, detail={"error": "camera_unavailable", "message": str(exc)}) from exc
    except CameraTimeoutError as exc:
        LOG.exception("La captura superó el tiempo de espera: %s", exc)
        raise HTTPException(status_code=504, detail={"error": "camera_timeout", "message": str(exc)}) from exc
    except CameraOperationError as exc:
        LOG.exception("Error en la captura: %s", exc)
        raise HTTPException(status_code=500, detail={"error": "camera_failure", "message": str(exc)}) from exc


@router.post("/capture")
def camera_capture(full: bool = Query(False, description="Captura en resolución completa")):
    data = _capture_bytes(full=full)
    return Response(content=data, media_type="image/jpeg")


@router.api_route("/test", methods=["GET", "POST"])
def camera_test():
    try:
        data = _capture_bytes(full=False)
    except HTTPException as exc:
        payload = exc.detail if isinstance(exc.detail, dict) else {"error": "camera_failure"}
        payload.setdefault("ok", False)
        return JSONResponse(payload, status_code=exc.status_code)
    if not data:
        return JSONResponse({"ok": False, "error": "camera_failure"}, status_code=500)
    LOG.info("/api/camera/test capturó %d bytes", len(data))
    return {"ok": True, "message": "Captura exitosa", "size": len(data)}


@router.post("/capture-to-file")
def camera_capture_to_file(full: bool = Query(False, description="Captura en resolución completa")):
    """Captura para depuración guardando la imagen en /tmp."""
    filename = _capture_file_path()
    filename.parent.mkdir(parents=True, exist_ok=True)
    service = get_camera_service()
    try:
        result = service.capture_jpeg(str(filename), full=full)
    except CameraBusyError as exc:
        LOG.exception("La cámara está ocupada: %s", exc)
        return _camera_error_response(409, "camera_busy", str(exc))
    except CameraUnavailableError as exc:
        LOG.exception("Cámara no disponible: %s", exc)
        return _camera_error_response(503, "camera_unavailable", str(exc))
    except CameraTimeoutError as exc:
        LOG.exception("La captura superó el tiempo de espera: %s", exc)
        return _camera_error_response(504, "camera_timeout", str(exc))
    except CameraOperationError as exc:
        LOG.exception("Error en la captura: %s", exc)
        return _camera_error_response(500, "camera_failure", str(exc))
    return result


@router.get("/last.jpg")
def camera_last_capture():
    filename = _capture_file_path()
    if not filename.exists():
        return JSONResponse(
            {"ok": False, "error": "no_capture", "message": "No hay captura disponible"},
            status_code=404,
        )
    response = FileResponse(path=filename, media_type="image/jpeg")
    response.headers["Content-Disposition"] = "inline"
    response.headers["Cache-Control"] = "no-store, private"
    response.headers.setdefault("Pragma", "no-cache")
    return response
