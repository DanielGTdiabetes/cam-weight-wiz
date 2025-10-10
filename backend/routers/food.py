"""Food scanning router for barcode/OCR nutrition extraction."""
from __future__ import annotations

import json
import math
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

import requests
from fastapi import APIRouter, HTTPException
from PIL import Image

try:
    # Pydantic v2
    from pydantic import BaseModel, Field, field_validator
    _PYDANTIC_V2 = True
except ImportError:
    # Pydantic v1 (no uso de pydantic.v1)
    from pydantic import BaseModel, Field, validator as field_validator
    _PYDANTIC_V2 = False


def pre_validator(*fields):
    if _PYDANTIC_V2:
        return field_validator(*fields, mode="before")
    return field_validator(*fields, pre=True)

ConfigDict = None
try:  # pragma: no cover - ConfigDict only exists in Pydantic v2
    from pydantic import ConfigDict as _ConfigDict
except Exception:
    pass
else:
    ConfigDict = _ConfigDict
from pyzbar.pyzbar import Decoded, decode

from backend.ocr_service import (
    OCRDisabledError,
    OCRModelsMissingError,
    OCRRuntimeError,
    get_ocr_service,
)

from backend.utils_urls import get_backend_base_url, get_miniweb_base_url

SCAN_DIR = Path("/var/lib/bascula/scans")
BACKEND_BASE_URL = get_backend_base_url()
MINIWEB_BASE_URL = get_miniweb_base_url()
CAMERA_CAPTURE_ENDPOINT = f"{MINIWEB_BASE_URL}/api/camera/capture-to-file"
SCALE_WEIGHT_ENDPOINT = f"{MINIWEB_BASE_URL}/api/scale/weight"
TTS_ENDPOINT = f"{MINIWEB_BASE_URL}/api/voice/tts/say"
OPENFOODFACTS_URL = "https://world.openfoodfacts.org/api/v2/product/{barcode}.json"

router = APIRouter()


class ScanRequest(BaseModel):
    """Payload for the /scan endpoint."""

    source_path: Optional[str] = Field(
        default=None,
        description="Existing image path to reuse instead of taking a new capture.",
    )
    rotate: int = Field(
        default=0,
        ge=0,
        le=359,
        description="Rotation angle in degrees applied before processing (0-359).",
    )

    @pre_validator("rotate")
    def _normalize_rotate(cls, v: Any) -> int:  # noqa: D417,N805
        try:
            iv = int(v)
        except (TypeError, ValueError) as exc:  # pragma: no cover - error path only
            raise ValueError("rotate must be an integer") from exc
        if iv < 0:
            raise ValueError("rotate must be greater than or equal to 0")
        return iv % 360

    if ConfigDict is not None:  # pragma: no cover - attribute differs across Pydantic versions
        model_config = ConfigDict(extra="ignore")
    else:  # pragma: no cover - fallback for Pydantic v1

        class Config:
            extra = "ignore"


@dataclass
class NutritionData:
    product: Dict[str, Any]
    nutrients_100g: Dict[str, Optional[float]]


def _model_to_dict(m: Any) -> Dict[str, Any]:
    if hasattr(m, "model_dump"):
        return m.model_dump()  # type: ignore[no-any-return]
    if hasattr(m, "dict"):
        return m.dict()  # type: ignore[no-any-return]
    return dict(m)


def _to_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str):
        normalized = value.strip()
        if not normalized:
            return None
        normalized = normalized.replace(",", ".")
        try:
            return float(normalized)
        except ValueError:
            pass
    return None


def _ensure_scan_dir() -> None:
    try:
        SCAN_DIR.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unable to prepare scan dir: {exc}") from exc

    try:
        import pwd
        import grp

        uid = pwd.getpwnam("pi").pw_uid  # type: ignore[attr-defined]
        gid = grp.getgrnam("pi").gr_gid  # type: ignore[attr-defined]
        os_stat = SCAN_DIR.stat()
        if os_stat.st_uid != uid or os_stat.st_gid != gid:
            SCAN_DIR.chown(uid, gid)
    except Exception:
        # Non-fatal: directory owner adjustment is best effort.
        pass


def _call_camera() -> str:
    try:
        response = requests.post(CAMERA_CAPTURE_ENDPOINT, timeout=5)
        response.raise_for_status()
        payload = response.json()
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Camera request failed: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="Invalid camera response") from exc

    if not payload.get("ok"):
        raise HTTPException(status_code=502, detail="Camera capture failed")

    path = payload.get("path")
    if not isinstance(path, str) or not path:
        raise HTTPException(status_code=502, detail="Camera response missing file path")
    return path


def _read_weight() -> Optional[float]:
    try:
        response = requests.get(SCALE_WEIGHT_ENDPOINT, timeout=1)
        response.raise_for_status()
        data = response.json()
        return _to_float(data.get("grams"))
    except Exception:
        return None


def _lookup_openfoodfacts(barcode: str) -> Optional[NutritionData]:
    url = OPENFOODFACTS_URL.format(barcode=barcode)
    try:
        response = requests.get(url, timeout=5)
        if response.status_code != 200:
            return None
        payload = response.json()
    except (requests.RequestException, ValueError):
        return None

    if payload.get("status") != 1:
        return None

    product = payload.get("product") or {}
    nutriments = product.get("nutriments") or {}

    kcal = _to_float(nutriments.get("energy-kcal_100g"))
    if kcal is None:
        kj = _to_float(nutriments.get("energy_100g"))
        if kj is not None:
            kcal = kj / 4.184

    brand = product.get("brands")
    if isinstance(brand, str):
        brand = brand.split(",")[0].strip() or None
    elif brand is not None:
        brand = str(brand)

    product_info = {
        "name": product.get("product_name") or product.get("generic_name") or None,
        "brand": brand,
        "nutriscore": product.get("nutriscore_grade"),
        "nova_group": product.get("nova_group"),
    }

    nutrients = {
        "kcal": kcal,
        "protein_g": _to_float(nutriments.get("proteins_100g")),
        "fat_g": _to_float(nutriments.get("fat_100g")),
        "carbs_g": _to_float(nutriments.get("carbohydrates_100g")),
        "sugars_g": _to_float(nutriments.get("sugars_100g")),
        "salt_g": _to_float(nutriments.get("salt_100g")),
    }

    return NutritionData(product=product_info, nutrients_100g=nutrients)


_KCAL_PATTERN = re.compile(r"(\d+(?:[.,]\d+)?)\s*(?:kcal|kilocalor[ií]as?)", re.IGNORECASE)
_PROT_PATTERN = re.compile(r"prote[íi]n(?:a|as)?.{0,16}?(\d+(?:[.,]\d+)?)\s*g", re.IGNORECASE)
_FAT_PATTERN = re.compile(r"grasas?.{0,16}?(\d+(?:[.,]\d+)?)\s*g", re.IGNORECASE)
_CARBS_PATTERN = re.compile(
    r"(?:carbohidratos|hidratos|carbohidr\.?).{0,16}?(\d+(?:[.,]\d+)?)\s*g",
    re.IGNORECASE,
)
_SUGAR_PATTERN = re.compile(r"az[úu]cares?.{0,16}?(\d+(?:[.,]\d+)?)\s*g", re.IGNORECASE)
_SALT_PATTERN = re.compile(r"(?:sal|sodio).{0,16}?(\d+(?:[.,]\d+)?)\s*g", re.IGNORECASE)
_NAME_PATTERN = re.compile(r"(?m)^[A-ZÁÉÍÓÚÜÑ0-9][A-ZÁÉÍÓÚÜÑ0-9\s\-]{3,}$")


def _ocr_extract(image: Image.Image) -> NutritionData:
    service = get_ocr_service()
    try:
        text = service.extract_text(image) or ""
    except OCRDisabledError as exc:
        raise HTTPException(status_code=503, detail="ocr_disabled") from exc
    except OCRModelsMissingError as exc:
        raise HTTPException(status_code=503, detail="ocr_missing_models") from exc
    except OCRRuntimeError as exc:
        raise HTTPException(status_code=500, detail=f"ocr_failed: {exc}") from exc

    def find_number(pattern: re.Pattern[str]) -> Optional[float]:
        match = pattern.search(text)
        if not match:
            return None
        return _to_float(match.group(1))

    product_name: Optional[str] = None
    for line in text.splitlines():
        line = line.strip()
        if len(line) > 3 and _NAME_PATTERN.match(line):
            product_name = line.title()
            break

    nutrients = {
        "kcal": find_number(_KCAL_PATTERN),
        "protein_g": find_number(_PROT_PATTERN),
        "fat_g": find_number(_FAT_PATTERN),
        "carbs_g": find_number(_CARBS_PATTERN),
        "sugars_g": find_number(_SUGAR_PATTERN),
        "salt_g": find_number(_SALT_PATTERN),
    }

    product = {
        "name": product_name,
        "brand": None,
        "nutriscore": None,
        "nova_group": None,
    }

    return NutritionData(product=product, nutrients_100g=nutrients)


def _decode_barcode(image: Image.Image) -> Optional[str]:
    try:
        decoded_items = decode(image)
    except Exception:
        decoded_items = []

    for item in decoded_items:
        if not isinstance(item, Decoded):
            continue
        try:
            value = item.data.decode("utf-8").strip()
        except Exception:
            continue
        if not value:
            continue
        return value
    return None


def _calculate_estimates(weight: Optional[float], nutrients: Dict[str, Optional[float]]) -> Optional[Dict[str, Optional[float]]]:
    if weight is None:
        return None
    kcal = nutrients.get("kcal")
    if kcal is None:
        return None

    factor = weight / 100.0
    estimates = {
        "kcal": kcal * factor,
        "protein_g": nutrients.get("protein_g") * factor if nutrients.get("protein_g") is not None else None,
        "fat_g": nutrients.get("fat_g") * factor if nutrients.get("fat_g") is not None else None,
        "carbs_g": nutrients.get("carbs_g") * factor if nutrients.get("carbs_g") is not None else None,
    }
    return estimates


def _save_results(image: Image.Image, metadata: Dict[str, Any], timestamp: str) -> Dict[str, str]:
    _ensure_scan_dir()

    thumb_path = SCAN_DIR / f"{timestamp}.jpg"
    json_path = SCAN_DIR / f"{timestamp}.json"

    try:
        width, height = image.size
        if width <= 0 or height <= 0:
            raise ValueError("Invalid image dimensions")
        ratio = 480.0 / float(width)
        new_height = max(1, int(round(height * ratio)))
        preview = image.copy().convert("RGB").resize((480, new_height))
        preview.save(thumb_path, "JPEG", quality=85)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unable to save thumbnail: {exc}") from exc

    saved = {"thumb": str(thumb_path), "json": str(json_path)}

    try:
        to_store = _model_to_dict(metadata)
        to_store["saved"] = saved
        with json_path.open("w", encoding="utf-8") as handle:
            json.dump(to_store, handle, ensure_ascii=False, indent=2)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unable to persist scan data: {exc}") from exc

    return saved


def _maybe_speak(product: Dict[str, Any], estimates: Optional[Dict[str, Optional[float]]]) -> None:
    name = product.get("name") or "producto"
    brand = product.get("brand")
    kcal = estimates.get("kcal") if isinstance(estimates, dict) else None

    message = f"Producto detectado: {name}"
    if brand:
        message += f" ({brand})"
    if isinstance(kcal, (int, float)) and not math.isnan(kcal):
        message += f". {kcal:.0f} kilocalorías estimadas."

    try:
        requests.post(TTS_ENDPOINT, params={"text": message}, timeout=2)
    except Exception:
        # TTS is optional; ignore failures.
        pass


@router.post("/scan")
def scan(request: ScanRequest) -> Dict[str, Any]:
    image_path = request.source_path or _call_camera()

    try:
        with Image.open(image_path) as img:
            img_converted = img.convert("RGB")
            if request.rotate:
                img_converted = img_converted.rotate(request.rotate, expand=True)
            image = img_converted.copy()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail="Image not found") from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unable to open image: {exc}") from exc

    barcode_value = _decode_barcode(image)
    nutrition: Optional[NutritionData] = None
    source = "ocr"

    if barcode_value:
        barcode_digits = barcode_value if re.fullmatch(r"\d{8,14}", barcode_value) else None
        if barcode_digits:
            off_data = _lookup_openfoodfacts(barcode_digits)
        else:
            off_data = None

        if off_data:
            nutrition = off_data
            source = "barcode"
        else:
            # Keep barcode but attempt OCR fallback
            nutrition = _ocr_extract(image)
            source = "ocr"
    else:
        nutrition = _ocr_extract(image)

    weight = _read_weight()
    nutrients = nutrition.nutrients_100g if nutrition else {}
    estimates = _calculate_estimates(weight, nutrients) if nutrition else None

    timestamp = time.strftime("%Y-%m-%d_%H%M%S")

    response_payload = {
        "ok": True,
        "source": source,
        "barcode": barcode_value,
        "image_path": image_path,
        "product": nutrition.product if nutrition else None,
        "nutrients_100g": nutrients if nutrition else None,
        "weight_g": weight,
        "estimates": estimates,
    }

    saved_paths = _save_results(image, response_payload, timestamp)
    response_payload["saved"] = saved_paths

    if nutrition and nutrition.product and nutrition.product.get("name"):
        _maybe_speak(nutrition.product, estimates)

    return response_payload


@router.get("/lookup")
def lookup(barcode: str) -> Dict[str, Any]:
    barcode = (barcode or "").strip()
    if not barcode:
        raise HTTPException(status_code=400, detail="barcode_required")

    result = _lookup_openfoodfacts(barcode)

    response: Dict[str, Any] = {
        "ok": True,
        "source": "barcode",
        "barcode": barcode,
        "image_path": None,
        "product": None,
        "nutrients_100g": None,
        "weight_g": None,
        "estimates": None,
        "saved": None,
    }

    if result:
        response["product"] = result.product
        response["nutrients_100g"] = result.nutrients_100g

    return response
