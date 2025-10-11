from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from threading import Lock
from typing import Iterable, Optional, Sequence, Tuple

from fastapi import FastAPI
from PIL import Image

from backend.ocr_models import ensure_ocr_models_dir


class OCRServiceError(RuntimeError):
    """Base error raised when the OCR service is unavailable."""


class OCRDisabledError(OCRServiceError):
    """Raised when OCR is disabled via environment configuration."""


class OCRModelsMissingError(OCRServiceError):
    """Raised when the configured RapidOCR models are missing."""


class OCRRuntimeError(OCRServiceError):
    """Raised when RapidOCR fails to run on the provided image."""


def _env_flag(value: Optional[str], default: bool = True) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class RapidOCRService:
    """Lazy RapidOCR runner with configurable model directory."""

    def __init__(
        self,
        *,
        enabled: Optional[bool] = None,
        models_dir: Optional[Path] = None,
    ) -> None:
        if enabled is None:
            enabled = _env_flag(os.getenv("BASCULA_OCR_ENABLED"), True)
        self._enabled = bool(enabled)
        self._models_dir = Path(models_dir) if models_dir else ensure_ocr_models_dir()
        self._engine = None
        self._lock = Lock()

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def models_dir(self) -> Path:
        return self._models_dir

    def _import_rapidocr(self):
        try:
            from rapidocr_onnxruntime import RapidOCR  # type: ignore import
        except ModuleNotFoundError as exc:  # pragma: no cover - runtime import guard
            raise OCRRuntimeError(f"rapidocr_onnxruntime not available: {exc}") from exc
        return RapidOCR

    def _select_model(self, keyword: str, candidates: Sequence[Path]) -> Optional[Path]:
        keyword = keyword.lower()
        for candidate in candidates:
            if keyword in candidate.stem.lower():
                return candidate
        return None

    def _resolve_model_paths(self) -> Tuple[Path, Path, Optional[Path]]:
        candidates = sorted(self.models_dir.glob("*.onnx"))
        if not candidates:
            raise OCRModelsMissingError(
                f"No se encontraron modelos .onnx en {self.models_dir}"
            )

        det_model = self._select_model("det", candidates)
        rec_model = self._select_model("rec", candidates)
        cls_model = self._select_model("cls", candidates)

        if det_model is None or rec_model is None:
            raise OCRModelsMissingError(
                "Modelos RapidOCR incompletos: se requiere detección (det*.onnx) y "
                "reconocimiento (rec*.onnx)."
            )
        return det_model, rec_model, cls_model

    def _load_engine(self):
        if not self.enabled:
            raise OCRDisabledError("OCR deshabilitado por BASCULA_OCR_ENABLED")

        if self._engine is not None:
            return self._engine

        with self._lock:
            if self._engine is not None:
                return self._engine

            RapidOCR = self._import_rapidocr()
            det_model, rec_model, cls_model = self._resolve_model_paths()
            kwargs = {
                "det_model_path": str(det_model),
                "rec_model_path": str(rec_model),
            }
            if cls_model is not None:
                kwargs["cls_model_path"] = str(cls_model)

            providers_env = os.getenv("BASCULA_OCR_PROVIDERS")
            if providers_env:
                providers = [item.strip() for item in providers_env.split(",") if item.strip()]
                if providers:
                    kwargs["providers"] = providers

            self._engine = RapidOCR(**kwargs)
        return self._engine

    def _result_to_text(self, result: Iterable[object]) -> str:
        texts: list[str] = []
        for entry in result or []:  # type: ignore[union-attr]
            text: Optional[str] = None
            if isinstance(entry, str):
                text = entry
            elif isinstance(entry, (list, tuple)):
                if len(entry) >= 2 and isinstance(entry[1], str):
                    text = entry[1]
                elif len(entry) >= 3 and isinstance(entry[2], str):
                    text = entry[2]
            if text:
                stripped = text.strip()
                if stripped:
                    texts.append(stripped)
        return "\n".join(texts)

    def extract_text(self, image: Image.Image) -> str:
        if not self.enabled:
            raise OCRDisabledError("OCR deshabilitado por BASCULA_OCR_ENABLED")

        engine = self._load_engine()
        try:
            import numpy as np  # type: ignore import
        except ModuleNotFoundError as exc:  # pragma: no cover - runtime guard
            raise OCRRuntimeError(f"numpy requerido para RapidOCR: {exc}") from exc

        array = np.asarray(image.convert("RGB"))
        try:
            result, _ = engine(array)
        except Exception as exc:  # pragma: no cover - runtime failures
            raise OCRRuntimeError(f"Ejecución RapidOCR falló: {exc}") from exc

        return self._result_to_text(result)

    def health_status(self) -> str:
        if not self.enabled:
            return "disabled"
        try:
            self._resolve_model_paths()
        except OCRModelsMissingError:
            return "missing_models"
        except Exception:
            return "error"
        try:
            self._import_rapidocr()
        except OCRRuntimeError:
            return "error"
        return "ready"


@lru_cache(maxsize=1)
def get_ocr_service() -> RapidOCRService:
    return RapidOCRService()


def reset_ocr_service_cache() -> None:
    get_ocr_service.cache_clear()  # type: ignore[attr-defined]


__all__ = [
    "OCRServiceError",
    "OCRDisabledError",
    "OCRModelsMissingError",
    "OCRRuntimeError",
    "RapidOCRService",
    "get_ocr_service",
    "reset_ocr_service_cache",
]


app = FastAPI(title="Bascula OCR Service")


@app.get("/api/ocr/health")
async def ocr_health() -> dict[str, str]:
    return {"status": "ok", "service": "ocr"}


def main() -> None:
    import uvicorn

    port = int(os.getenv("BASCULA_OCR_PORT", "8082"))
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
