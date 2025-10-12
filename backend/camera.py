"""Camera API exposing Picamera2 headless captures."""
from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from typing import Dict

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, Response

from backend.camera_service import (
    CameraBusyError,
    CameraOperationError,
    CameraTimeoutError,
    CameraUnavailableError,
    get_camera_service,
)


CAPTURE_DIRECTORY = Path(os.getenv("BASCULA_CAPTURES_DIR", "/run/bascula/captures"))
CAPTURE_FILENAME = "camera-capture.jpg"
CAPTURE_PATH = CAPTURE_DIRECTORY / CAPTURE_FILENAME
CAPTURE_URL = f"/captures/{CAPTURE_FILENAME}"


router = APIRouter(prefix="/api/camera", tags=["camera"])

LOG = logging.getLogger("bascula.camera.api")


def _camera_error_response(status_code: int, reason: str, message: str):
    detail = {"ok": False, "error": reason, "detail": message}
    return JSONResponse(detail, status_code=status_code)


def _capture_payload(size: int, full: bool) -> Dict[str, object]:
    return {
        "ok": True,
        "url": CAPTURE_URL,
        "path": CAPTURE_URL,
        "size": size,
        "full": bool(full),
    }


def _last_capture_metadata() -> Dict[str, object]:
    size = _capture_size()
    return {"ok": size > 0, "url": CAPTURE_URL, "path": CAPTURE_URL, "size": size}


def _capture_size() -> int:
    try:
        return CAPTURE_PATH.stat().st_size
    except FileNotFoundError:
        return 0


@router.get("/info")
def camera_info():
    try:
        service = get_camera_service()
        properties = service.get_camera_info()
    except CameraUnavailableError as exc:
        LOG.warning("No hay cámara disponible: %s", exc, exc_info=False)
        return _camera_error_response(503, "camera_unavailable", str(exc))

    response = {
        "ok": True,
        "Model": properties.get("Model"),
        "Rotation": properties.get("Rotation"),
        "PixelArraySize": properties.get("PixelArraySize"),
    }
    response["lastCapture"] = _last_capture_metadata()
    return response


@router.get("/status")
def camera_status():
    metadata = _last_capture_metadata()
    try:
        service = get_camera_service()
        properties = service.get_camera_info()
    except CameraUnavailableError as exc:
        payload = {
            "ok": False,
            "error": "camera_unavailable",
            "detail": str(exc),
            "lastCapture": metadata,
        }
        return JSONResponse(payload, status_code=200)

    response = {
        "ok": True,
        "model": properties.get("Model"),
        "rotation": properties.get("Rotation"),
        "pixelArraySize": properties.get("PixelArraySize"),
        "lastCapture": metadata,
    }
    return response


def _capture_bytes(full: bool, timeout_ms: int = 2000) -> bytes:
    service = get_camera_service()
    try:
        return service.capture_bytes(full=full, timeout_ms=timeout_ms)
    except CameraBusyError as exc:
        LOG.exception("La cámara está ocupada: %s", exc)
        raise HTTPException(status_code=409, detail={"error": "camera_busy", "message": str(exc)}) from exc
    except CameraUnavailableError as exc:
        LOG.warning("Cámara no disponible: %s", exc, exc_info=False)
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
    """Captura para depuración guardando la imagen en un directorio controlado."""
    capture_dir = CAPTURE_PATH.parent
    capture_dir.mkdir(parents=True, exist_ok=True)
    filename = CAPTURE_PATH
    service = get_camera_service()
    try:
        result = service.capture_jpeg(str(filename), full=full)
    except CameraBusyError as exc:
        LOG.exception("La cámara está ocupada: %s", exc)
        return _camera_error_response(409, "camera_busy", str(exc))
    except CameraUnavailableError as exc:
        LOG.warning("Cámara no disponible: %s", exc, exc_info=False)
        return _camera_error_response(503, "camera_unavailable", str(exc))
    except CameraTimeoutError as exc:
        LOG.exception("La captura superó el tiempo de espera: %s", exc)
        return _camera_error_response(504, "camera_timeout", str(exc))
    except CameraOperationError as exc:
        LOG.exception("Error en la captura: %s", exc)
        return _camera_error_response(500, "camera_failure", str(exc))
    try:
        shutil.chown(filename, group="www-data")
    except LookupError:
        LOG.debug("Grupo www-data no disponible para %s", filename, exc_info=True)
    except OSError:
        LOG.warning("No se pudo asignar grupo www-data a %s", filename, exc_info=True)
    try:
        filename.chmod(0o660)
    except OSError:
        LOG.warning("No se pudieron ajustar permisos de %s", filename, exc_info=True)
    file_size = int(result.get("size", 0)) if isinstance(result, dict) else 0
    if file_size <= 0:
        try:
            file_size = filename.stat().st_size
        except OSError:
            file_size = 0
    payload = _capture_payload(size=file_size, full=full)
    if isinstance(result, dict) and result.get("via"):
        payload["via"] = result["via"]
    LOG.info("capture_to_file: saved %s size=%s", filename, payload["size"])
    return payload
