from __future__ import annotations

from pathlib import Path
import os

DEFAULT_OCR_MODELS = os.getenv("BASCULA_OCR_MODELS_DIR", "/opt/rapidocr/models")


def ensure_ocr_models_dir() -> Path:
    """Ensure the RapidOCR models directory exists and return it."""
    path = Path(DEFAULT_OCR_MODELS)
    path.mkdir(parents=True, exist_ok=True)
    return path
