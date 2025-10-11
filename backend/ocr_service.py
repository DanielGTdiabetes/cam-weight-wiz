"""OCR runtime façade plus standalone FastAPI health service."""

from __future__ import annotations

from fastapi import FastAPI

from .ocr_runtime import (
    OCRDisabledError,
    OCRModelsMissingError,
    OCRRuntimeError,
    OCRServiceError,
    RapidOCRService,
    get_ocr_service,
    reset_ocr_service_cache,
)

__all__ = [
    "OCRServiceError",
    "OCRDisabledError",
    "OCRModelsMissingError",
    "OCRRuntimeError",
    "RapidOCRService",
    "get_ocr_service",
    "reset_ocr_service_cache",
    "app",
    "main",
]

app = FastAPI(title="Bascula OCR Service")


@app.get("/api/ocr/health")
async def ocr_health() -> dict[str, str]:
    """Return OCR service health information."""
    return {"status": "ok", "service": "ocr"}


def main() -> None:
    """Run the OCR FastAPI app via uvicorn."""
    import uvicorn

    uvicorn.run("backend.ocr_service:app", host="0.0.0.0", port=8091, reload=False)


if __name__ == "__main__":
    main()
