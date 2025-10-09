"""Thread-safe Picamera2 service for headless captures."""
from __future__ import annotations

import atexit
import errno
import io
import logging
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, Optional

try:  # pragma: no cover - dependency available only on target device
    import libcamera  # type: ignore[import]
except ImportError:  # pragma: no cover - runtime fallback when libcamera is missing
    class _TransformStub:  # type: ignore[misc,override]
        """Fallback Transform stub used when libcamera is unavailable."""

        def __init__(self, *args: Any, **kwargs: Any) -> None:  # noqa: D401 - simple stub
            self.args = args
            self.kwargs = kwargs

    class _LibcameraStub:  # type: ignore[misc,override]
        Transform = _TransformStub

    libcamera = _LibcameraStub()  # type: ignore[misc,assignment]

from PIL import Image

try:  # pragma: no cover - dependency available only on target device
    from picamera2 import Picamera2
except ImportError:  # pragma: no cover - runtime fallback when camera lib missing
    Picamera2 = None  # type: ignore[misc]


def _build_transform(rotation: int = 0) -> libcamera.Transform:
    """Return a safe transform without chained multiplications."""

    r = int(rotation or 0)
    if r % 360 == 180:
        return libcamera.Transform(hflip=False, vflip=True)
    return libcamera.Transform()


if TYPE_CHECKING:  # pragma: no cover - typing helper
    from libcamera import Transform as LibcameraTransform
else:
    LibcameraTransform = Any  # type: ignore[misc,assignment]

LOG_CAMERA = logging.getLogger("bascula.camera")


class CameraError(RuntimeError):
    """Base error for camera operations."""


class CameraUnavailableError(CameraError):
    """Raised when no camera is detected or Picamera2 is missing."""


class CameraBusyError(CameraError):
    """Raised when the camera device is busy."""


class CameraTimeoutError(CameraError):
    """Raised when a capture operation exceeds the configured timeout."""


class CameraOperationError(CameraError):
    """Raised for unrecoverable camera failures."""


class Picamera2Service:
    """Singleton service coordinating access to Picamera2 captures."""

    _instance: Optional["Picamera2Service"] = None
    _instance_lock = threading.Lock()

    def __init__(self) -> None:
        if Picamera2 is None:
            raise CameraUnavailableError("Picamera2 no está disponible en este entorno")
        self._camera: Optional[Picamera2] = None
        self._camera_lock = threading.RLock()
        self._configs: Dict[str, Any] = {}
        self._active_config: Optional[str] = None
        self._properties: Dict[str, Any] = {}
        self._transform: Optional[LibcameraTransform] = None
        self._warmup_delay = 0.2  # 200 ms para estabilizar tras iniciar la cámara
        self._closed = False
        LOG_CAMERA.debug("Picamera2Service inicializado")

    # ---------- Singleton helpers ----------
    @classmethod
    def instance(cls) -> "Picamera2Service":
        if cls._instance is not None:
            return cls._instance
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = cls()
                atexit.register(cls._instance.close)
        return cls._instance

    # ---------- Camera lifecycle ----------
    def _ensure_camera(self) -> Picamera2:
        if self._closed:
            raise CameraUnavailableError("La cámara se ha cerrado previamente")

        attempts = 0
        last_error: Optional[BaseException] = None

        while attempts < 2:
            attempts += 1
            with self._camera_lock:
                if self._camera is not None:
                    return self._camera

                temp_camera: Optional[Picamera2] = None
                try:
                    self._release_camera()
                    temp_camera = Picamera2()
                    self._properties = dict(getattr(temp_camera, "camera_properties", {}) or {})
                    rotation = self._resolve_rotation(self._properties.get("Rotation"))
                    self._transform = _build_transform(rotation or 0)
                    self._camera = temp_camera
                    self._configs.clear()
                    self._active_config = None
                    LOG_CAMERA.info(
                        "Picamera2 preparada: modelo=%s, rotación=%s",
                        self._properties.get("Model", "desconocido"),
                        rotation if rotation is not None else "sin especificar",
                    )
                    return temp_camera
                except (RuntimeError, CameraUnavailableError) as exc:
                    last_error = exc
                    LOG_CAMERA.exception(
                        "Fallo al inicializar Picamera2 (intento %d): %s",
                        attempts,
                        exc,
                    )
                    self._release_camera()
                except Exception as exc:  # pragma: no cover - hardware specific failure
                    last_error = exc
                    LOG_CAMERA.exception("Error inesperado al inicializar Picamera2: %s", exc)
                    self._release_camera()
                    raise CameraUnavailableError(str(exc)) from exc
                finally:
                    if temp_camera is not None and temp_camera is not self._camera:
                        try:
                            temp_camera.close()
                        except Exception:
                            LOG_CAMERA.debug("Error al cerrar la cámara temporal", exc_info=True)

            if attempts < 2:
                time.sleep(0.3)

        LOG_CAMERA.error("No se detectó cámara Picamera2 tras %d intentos", attempts)
        if last_error is not None:
            message = str(last_error) or "No se pudo inicializar la cámara"
            raise CameraUnavailableError(message) from last_error
        raise CameraUnavailableError("No se pudo inicializar la cámara")

    @staticmethod
    def _resolve_rotation(value: Any) -> Optional[int]:
        if isinstance(value, (int, float)):
            rotation = int(value)
            if rotation in {0, 90, 180, 270}:
                return rotation
        return None

    def _config_key(self, full: bool) -> str:
        return "full" if full else "fast"

    def _get_config(self, camera: Picamera2, full: bool) -> Any:
        key = self._config_key(full)
        if key in self._configs:
            return self._configs[key]
        size = (4608, 2592) if full else (2304, 1296)
        transform = self._transform or libcamera.Transform()
        config = camera.create_still_configuration(
            main={"size": size, "format": "RGB888"},
            raw=None,
            lores=None,
            buffer_count=1,
            transform=transform,
            display=None,
        )
        self._configs[key] = config
        LOG_CAMERA.debug("Configuración creada para %s: %s", key, size)
        return config

    def _prepare(self, full: bool) -> Picamera2:
        camera = self._ensure_camera()
        config = self._get_config(camera, full)
        try:
            camera.configure(config)
        except Exception as exc:
            self._handle_fatal_error("No se pudo configurar la cámara", exc)
            raise CameraOperationError("No se pudo configurar la cámara") from exc
        self._active_config = self._config_key(full)
        return camera

    def _perform_capture(self, camera: Picamera2) -> bytes:
        request = None
        array = None
        try:
            camera.start()
            time.sleep(self._warmup_delay)
            request = camera.capture_request()
            array = request.make_array("main")
        finally:
            if request is not None:
                try:
                    request.release()
                except Exception:
                    LOG_CAMERA.debug("No se pudo liberar la solicitud de captura", exc_info=True)
            try:
                camera.stop()
            except Exception:
                LOG_CAMERA.debug("Error al detener la cámara", exc_info=True)
        if array is None:
            raise CameraOperationError("No se pudo capturar la imagen")
        image = Image.fromarray(array)
        if image.mode != "RGB":
            image = image.convert("RGB")
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=90)
        return buffer.getvalue()

    @staticmethod
    def _is_busy_error(exc: BaseException) -> bool:
        if isinstance(exc, OSError) and getattr(exc, "errno", None) == errno.EBUSY:
            return True
        message = str(exc).lower()
        return "device or resource busy" in message or "ebusy" in message

    def _handle_fatal_error(self, message: str, exc: BaseException) -> None:
        LOG_CAMERA.exception("%s: %s", message, exc)
        self._safe_close()

    def _release_camera(self) -> None:
        camera = self._camera
        self._camera = None
        self._configs.clear()
        self._active_config = None
        self._properties = {}
        self._transform = None
        if camera is None:
            return
        try:
            camera.stop()
        except Exception:
            LOG_CAMERA.debug("Error al detener la cámara durante la liberación", exc_info=True)
        try:
            camera.close()
        except Exception:
            LOG_CAMERA.debug("Error al cerrar la cámara", exc_info=True)

    def _safe_close(self) -> None:
        self._release_camera()

    # ---------- Public API ----------
    def get_camera_info(self) -> Dict[str, Any]:
        with self._camera_lock:
            try:
                camera = self._ensure_camera()
                if not self._properties:
                    self._properties = dict(getattr(camera, "camera_properties", {}) or {})
                snapshot = dict(self._properties)
                return snapshot
            except CameraUnavailableError as exc:
                LOG_CAMERA.error("No se detectó cámara al solicitar información: %s", exc)
                raise
            finally:
                self._release_camera()

    def capture_bytes(self, full: bool = False, timeout_ms: int = 2000) -> bytes:
        deadline = time.monotonic() + max(timeout_ms, 1) / 1000.0
        attempts = 0
        last_error: Optional[BaseException] = None
        while attempts < 3:
            attempts += 1
            with self._camera_lock:
                try:
                    camera = self._prepare(full)
                    data = self._perform_capture(camera)
                    LOG_CAMERA.info(
                        "Captura completada (%s) - %d bytes", self._config_key(full), len(data)
                    )
                    return data
                except CameraUnavailableError as exc:
                    last_error = exc
                    LOG_CAMERA.warning(
                        "Cámara no disponible en captura (intento %d/3): %s",
                        attempts,
                        exc,
                    )
                    time.sleep(0.3)
                    continue
                except Exception as exc:
                    LOG_CAMERA.exception(
                        "Error en la captura (%s): %s",
                        type(exc).__name__,
                        exc,
                    )
                    last_error = exc
                    if self._is_busy_error(exc):
                        LOG_CAMERA.warning("Cámara ocupada, reintento %d/3", attempts)
                        if time.monotonic() >= deadline:
                            break
                        time.sleep(0.25)
                        continue
                    self._handle_fatal_error("Fallo en la captura", exc)
                    raise CameraOperationError("Fallo en la captura") from exc
                finally:
                    self._release_camera()
            if time.monotonic() >= deadline:
                break
            time.sleep(0.25)
        if isinstance(last_error, CameraUnavailableError):
            raise CameraUnavailableError(str(last_error)) from last_error
        if last_error and self._is_busy_error(last_error):
            raise CameraBusyError("La cámara está ocupada") from last_error
        raise CameraTimeoutError("La captura excedió el tiempo máximo permitido")

    def capture_jpeg(self, path: str, full: bool = False, timeout_ms: int = 2000) -> Dict[str, Any]:
        target = Path(path)
        data = self.capture_bytes(full=full, timeout_ms=timeout_ms)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return {"ok": True, "path": str(target), "size": len(data)}

    def close(self) -> None:
        with self._camera_lock:
            self._closed = True
            self._safe_close()
            LOG_CAMERA.info("Cámara liberada")


def get_camera_service() -> Picamera2Service:
    """Return the singleton camera service."""
    return Picamera2Service.instance()
