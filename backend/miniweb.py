# backend/miniweb.py
# (Codex: escribir archivo COMPLETO, sin "...", listo para ejecutar)
from __future__ import annotations
import os
import json
import logging
import subprocess
import socket
import fcntl
import struct
import ipaddress
import random
import string
import asyncio
import time
import threading
import shlex
import tempfile
import traceback
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any, List, Union, Sequence, Set, AsyncGenerator, Tuple, TYPE_CHECKING
from copy import deepcopy
from urllib.parse import urlparse

from contextlib import asynccontextmanager
from pathlib import Path

import httpx

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse, PlainTextResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Settings service
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))
from backend.app.services.settings_service import get_settings_service

HX711_IMPORT_ERROR: Optional[Exception] = None
try:
    from backend.scale_service import HX711Service as _HX711Service  # type: ignore
except Exception as exc:  # pragma: no cover - fallback en runtime
    HX711_IMPORT_ERROR = exc
    _HX711Service = None  # type: ignore

SERIAL_IMPORT_ERROR: Optional[Exception] = None
try:
    from backend.serial_scale_service import SerialScaleService as _SerialScaleService  # type: ignore
except Exception as exc:  # pragma: no cover - fallback en runtime
    SERIAL_IMPORT_ERROR = exc
    _SerialScaleService = None  # type: ignore

if TYPE_CHECKING:
    from backend.scale_service import HX711Service as HX711ServiceType
    from backend.serial_scale_service import SerialScaleService as SerialScaleServiceType
else:  # pragma: no cover - pistas de tipo solo en desarrollo
    HX711ServiceType = Any
    SerialScaleServiceType = Any

HX711Service = _HX711Service  # type: ignore
SerialScaleService = _SerialScaleService  # type: ignore

_HX711_AVAILABLE = HX711Service is not None
_SERIAL_AVAILABLE = SerialScaleService is not None
_LOGGED_HX711_WARNING = False
_LOGGED_SERIAL_WARNING = False
from backend.voice import router as voice_router
from backend.camera import router as camera_router
from backend.wake import router as wake_router, init_wake_if_enabled

# ---------- Constantes y paths ----------
BASE_DIR = Path(__file__).resolve().parent.parent
DIST_DIR = BASE_DIR / "dist"

CFG_DIR = Path(os.getenv("BASCULA_CFG_DIR", Path.home() / ".bascula"))
PIN_PATH = CFG_DIR / "miniweb_pin"
CONFIG_PATH = CFG_DIR / "config.json"

# WebSocket connections for real-time sync
_settings_ws_connections: Set[WebSocket] = set()
_settings_ws_lock = threading.Lock()
DEFAULT_DT_PIN = 5
DEFAULT_SCK_PIN = 6
DEFAULT_SAMPLE_RATE = 20.0
DEFAULT_FILTER_WINDOW = 12
DEFAULT_CALIBRATION_FACTOR = 1.0
DEFAULT_SERIAL_DEVICE = "/dev/serial0"
DEFAULT_SERIAL_BAUD = 115200

LOG_SCALE = logging.getLogger("bascula.scale")
LOG_NETWORK = logging.getLogger("bascula.network")
LOG_OTA = logging.getLogger("bascula.ota")
LOG_MINIWEB = logging.getLogger("bascula.miniweb")
LOG_APP = logging.getLogger("bascula.app")

LOG_DIR = Path("/var/log/bascula")
MINIWEB_LOG_PATH = LOG_DIR / "miniweb.log"
APP_LOG_PATH = LOG_DIR / "app.log"
SETTINGS_RELOAD_SERVICE = "bascula-backend.service"


def _ensure_log_dir() -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
    except Exception:
        LOG_MINIWEB.debug("No se pudo preparar el directorio de logs", exc_info=True)


def _write_log_line(path: Path, message: str) -> None:
    try:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(message + "\n")
    except Exception:
        LOG_MINIWEB.warning("No se pudo escribir en %s", path, exc_info=True)


def _log_settings_event(event: str, **context: Any) -> None:
    payload: Dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event,
    }
    if context:
        payload.update(context)
    try:
        serialized = json.dumps(payload, ensure_ascii=False, default=str)
    except Exception:
        serialized = str(payload)
    LOG_MINIWEB.info(serialized)
    _ensure_log_dir()
    _write_log_line(MINIWEB_LOG_PATH, serialized)
    _write_log_line(APP_LOG_PATH, serialized)


OTA_RELEASES_DIR = Path("/opt/bascula/releases")
OTA_CURRENT_LINK = Path("/opt/bascula/current")
OTA_LOG_PATH = Path("/var/log/bascula/ota.log")
OTA_STATE_PATH = Path("/opt/bascula/data/ota-state.json")
OTA_REPO_URL = "https://github.com/DanielGTdiabetes/cam-weight-wiz"

_OTA_STATE_LOCK = threading.Lock()
_OTA_WORKER_LOCK = threading.Lock()
_ota_state: Dict[str, Any] = {}
_ota_worker_thread: Optional[threading.Thread] = None

NMCLI_BIN = Path("/usr/bin/nmcli")
NM_CONNECTIONS_DIR = Path("/etc/NetworkManager/system-connections")
HOME_CONNECTION_ID = "BasculaHome"
AP_CONNECTION_ID = "BasculaAP"
AP_DEFAULT_SSID = "Bascula-AP"
AP_DEFAULT_PASSWORD = "Bascula1234"
WIFI_INTERFACE = "wlan0"
AP_NM_PROFILE_PATH = BASE_DIR / "system" / "os" / "nm" / "BasculaAP.nmconnection"
AP_ENSURE_SCRIPT_PATH = BASE_DIR / "system" / "os" / "bascula-ap-ensure.sh"
AP_DEFAULT_IP = "192.168.4.1"
AP_DEFAULT_CONFIG_PATH = "/config"


def _parse_trusted_hosts(raw: str | None) -> Set[str]:
    if not raw:
        return set()
    hosts: Set[str] = set()
    for chunk in raw.split(","):
        value = chunk.strip()
        if not value:
            continue
        hosts.add(value)
    return hosts


def _parse_trusted_networks(raw: str | None) -> Set[ipaddress._BaseNetwork]:
    networks: Set[ipaddress._BaseNetwork] = set()
    if not raw:
        return networks
    for chunk in raw.split(","):
        candidate = chunk.strip()
        if not candidate:
            continue
        try:
            network = ipaddress.ip_network(candidate, strict=False)
        except ValueError:
            LOG_NETWORK.warning("Ignorando red confiable inválida: %s", candidate)
            continue
        networks.add(network)
    return networks


_TRUSTED_HOSTS = _parse_trusted_hosts(os.getenv("BASCULA_MINIWEB_TRUSTED_HOSTS"))
_TRUSTED_NETWORKS = _parse_trusted_networks(os.getenv("BASCULA_MINIWEB_TRUSTED_SUBNETS"))

CFG_DIR.mkdir(parents=True, exist_ok=True)

# ---------- Estado global ----------
ScaleServiceType = Union[HX711ServiceType, SerialScaleServiceType]
scale_service: Optional[ScaleServiceType] = None
_LAST_AP_ACTION_TS = 0.0
_LAST_WIFI_CONNECT_REQUEST: Optional[str] = None

_net_event_subscribers: Dict[int, Tuple["asyncio.Queue[bytes]", asyncio.AbstractEventLoop]] = {}
_net_event_lock = threading.Lock()

_last_weight_lock = threading.Lock()
_last_weight_value: Optional[float] = None
_last_weight_ts: Optional[datetime] = None

# ---------- Modelos ----------
class CalibrationPayload(BaseModel):
    known_grams: float


class CalibrationApplyPayload(BaseModel):
    reference_grams: float


class OTAApplyPayload(BaseModel):
    target: Optional[str] = None


# ---------- Helpers ----------
def _load_json(path: Path) -> Optional[Dict[str, Any]]:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            return None
    return None


def _save_json(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
    finally:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except Exception:
            LOG_MINIWEB.debug("No se pudo eliminar el temporal %s", tmp_path, exc_info=True)


def _normalize_http_url(raw: str) -> str:
    candidate = raw.strip()
    if not candidate:
        return ""
    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(candidate)
    return candidate.rstrip("/")


def _reload_backend_service() -> Tuple[bool, Optional[str]]:
    commands = [
        ["sudo", "systemctl", "reload", SETTINGS_RELOAD_SERVICE],
        ["systemctl", "reload", SETTINGS_RELOAD_SERVICE],
    ]
    last_error: Optional[str] = None
    for command in commands:
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                check=False,
                timeout=20,
            )
        except FileNotFoundError:
            continue
        except subprocess.TimeoutExpired:
            return False, "timeout"
        if result.returncode == 0:
            return True, None
        last_error = result.stderr.strip() or result.stdout.strip() or f"returncode={result.returncode}"
    return False, last_error or "command_unavailable"


def _apply_settings_changes(changed_fields: Sequence[str], **metadata: Any) -> None:
    if not changed_fields:
        return
    payload: Dict[str, Any] = {"fields": sorted(set(changed_fields))}
    if metadata:
        payload.update(metadata)
    _log_settings_event("settings.updated", **payload)
    success, error = _reload_backend_service()
    if success:
        _log_settings_event("settings.reload", status="success", service=SETTINGS_RELOAD_SERVICE)
    else:
        _log_settings_event(
            "settings.reload",
            status="error",
            service=SETTINGS_RELOAD_SERVICE,
            error=error,
        )


def _nm_escape_value(value: str) -> str:
    sanitized = (
        value.replace("\\", "\\\\")
        .replace("\x00", "")
        .replace("\r", "")
        .replace("\n", "\\n")
        .replace('"', '\\"')
    )
    return f'"{sanitized}"'


def _write_nm_profile(path: Path, ssid: str, password: str, secured: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        existing_lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        existing_lines = []
    except Exception:
        existing_lines = []

    escaped_ssid = _nm_escape_value(ssid)
    escaped_psk = _nm_escape_value(password)

    new_lines: list[str] = []
    replaced_ssid = False
    replaced_psk = False

    for raw_line in existing_lines:
        line = raw_line.strip("\n")
        key, _, current_value = line.partition("=")
        key = key.strip()

        if key.lower() == "ssid":
            new_lines.append(f"ssid={escaped_ssid}")
            replaced_ssid = True
            continue

        if key.lower() == "psk":
            if secured:
                new_lines.append(f"psk={escaped_psk}")
                replaced_psk = True
            # Para redes abiertas omitimos la línea
            continue

        new_lines.append(line if current_value else key)

    if not replaced_ssid:
        new_lines.append(f"ssid={escaped_ssid}")

    if secured:
        if not replaced_psk:
            new_lines.append(f"psk={escaped_psk}")
    else:
        new_lines = [line for line in new_lines if not line.lower().startswith("psk=")]

    content = "\n".join(new_lines) + "\n"
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(content, encoding="utf-8")
    os.chmod(tmp_path, 0o600)
    os.replace(tmp_path, path)


def _extract_openai_api_key(config: Optional[Dict[str, Any]]) -> str:
    if not isinstance(config, dict):
        return ""

    candidates: List[Optional[str]] = [
        config.get("openai_api_key"),
    ]

    integrations = config.get("integrations")
    if isinstance(integrations, dict):
        candidates.append(integrations.get("openai_api_key"))
        candidates.append(integrations.get("chatgpt_api_key"))

    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return ""


def _extract_nightscout_credentials(config: Optional[Dict[str, Any]]) -> Tuple[str, str]:
    if not isinstance(config, dict):
        return "", ""

    url = ""
    token = ""

    raw_url = config.get("nightscout_url")
    raw_token = config.get("nightscout_token")

    if isinstance(raw_url, str):
        url = raw_url.strip()
    if isinstance(raw_token, str):
        token = raw_token.strip()

    nightscout_section = config.get("nightscout")
    if isinstance(nightscout_section, dict):
        section_url = nightscout_section.get("url")
        section_token = nightscout_section.get("token") or nightscout_section.get("api_token")
        if not url and isinstance(section_url, str):
            url = section_url.strip()
        if not token and isinstance(section_token, str):
            token = section_token.strip()

    diabetes = config.get("diabetes")
    if isinstance(diabetes, dict):
        if not url and isinstance(diabetes.get("ns_url"), str):
            url = diabetes["ns_url"].strip()
        if not token and isinstance(diabetes.get("ns_token"), str):
            token = diabetes["ns_token"].strip()

    return url, token


def _build_settings_payload(config: Dict[str, Any]) -> Dict[str, Any]:
    service = get_settings_service(CONFIG_PATH)
    base_payload = service.get_for_client(include_secrets=False)
    payload: Dict[str, Any]
    if isinstance(base_payload, dict):
        payload = deepcopy(base_payload)
    else:
        payload = {}

    openai_key = _extract_openai_api_key(config)
    nightscout_url, nightscout_token = _extract_nightscout_credentials(config)

    raw_ui_cfg = config.get("ui") if isinstance(config.get("ui"), dict) else {}
    raw_flags = raw_ui_cfg.get("flags") if isinstance(raw_ui_cfg, dict) else {}
    flags: Dict[str, Any] = {}
    if isinstance(raw_flags, dict):
        for key, value in raw_flags.items():
            flags[str(key)] = bool(value)
    offline_mode = _resolve_offline_mode(config)

    ui_cfg = payload.get("ui") if isinstance(payload.get("ui"), dict) else {}
    ui_cfg["flags"] = flags
    ui_cfg["offline_mode"] = offline_mode
    payload["ui"] = ui_cfg

    tts_cfg = config.get("tts") if isinstance(config.get("tts"), dict) else {}
    payload["tts"] = tts_cfg

    scale_cfg = config.get("scale") if isinstance(config.get("scale"), dict) else {}
    payload["scale"] = scale_cfg

    serial_device = config.get("serial_device", DEFAULT_SERIAL_DEVICE)
    serial_baud = config.get("serial_baud", DEFAULT_SERIAL_BAUD)
    try:
        serial_baud_int = int(serial_baud)
    except (TypeError, ValueError):
        serial_baud_int = DEFAULT_SERIAL_BAUD
    payload["serial"] = {"device": serial_device, "baud": serial_baud_int}

    try:
        network_status = _get_wifi_status(config)
    except Exception as exc:
        LOG_NETWORK.debug("No se pudo obtener estado de red: %s", exc)
        network_status = None

    network_cfg = payload.get("network") if isinstance(payload.get("network"), dict) else {}
    network_cfg["status"] = network_status
    network_cfg.setdefault("ap", {"ssid": AP_DEFAULT_SSID, "ip": AP_DEFAULT_IP})
    payload["network"] = network_cfg

    payload["openai"] = {"hasKey": bool(openai_key)}

    payload["nightscout"] = {"url": nightscout_url, "hasToken": bool(nightscout_token)}

    integrations_cfg = config.get("integrations") if isinstance(config.get("integrations"), dict) else {}
    integrations = {
        key: value
        for key, value in integrations_cfg.items()
        if key not in {"openai_api_key", "chatgpt_api_key", "nightscout_token"}
    }
    payload["integrations"] = integrations

    return payload


def _response_error_payload(response: httpx.Response) -> Any:
    try:
        data = response.json()
        return data
    except Exception:
        return response.text


def _default_config() -> Dict[str, Any]:
    return {
        "scale_backend": "uart",
        "serial_device": DEFAULT_SERIAL_DEVICE,
        "serial_baud": DEFAULT_SERIAL_BAUD,
        "scale": {
            "dt": DEFAULT_DT_PIN,
            "sck": DEFAULT_SCK_PIN,
            "calibration_factor": DEFAULT_CALIBRATION_FACTOR,
            "sample_rate_hz": DEFAULT_SAMPLE_RATE,
            "filter_window": DEFAULT_FILTER_WINDOW,
        },
        "openai_api_key": "",
        "nightscout": {"url": "", "token": ""},
        "nightscout_url": "",
        "nightscout_token": "",
        "integrations": {
            "openai_api_key": "",
        },
        "diabetes": {
            "ns_url": "",
            "ns_token": "",
        },
        "ui": {
            "flags": {},
            "offline_mode": False,
            "sound_enabled": True,
        },
    }


def _migrate_legacy_nightscout(config: Dict[str, Any]) -> bool:
    def _first_non_empty(values: list[Any]) -> str:
        for value in values:
            if isinstance(value, str):
                trimmed = value.strip()
                if trimmed:
                    return trimmed
        return ""

    changed = False

    existing_url = config.get("nightscout_url")
    existing_token = config.get("nightscout_token")
    current_url = existing_url.strip() if isinstance(existing_url, str) else ""
    current_token = existing_token.strip() if isinstance(existing_token, str) else ""

    legacy_urls: list[str] = []
    legacy_tokens: list[str] = []

    network_cfg = config.get("network")
    if isinstance(network_cfg, dict):
        nested = network_cfg.get("nightscout")
        if isinstance(nested, dict):
            for candidate in (
                nested.get("url"),
                nested.get("nightscout_url"),
                nested.get("ns_url"),
            ):
                if isinstance(candidate, str) and candidate.strip():
                    legacy_urls.append(candidate.strip())
            for candidate in (
                nested.get("token"),
                nested.get("nightscout_token"),
                nested.get("ns_token"),
                nested.get("api_token"),
            ):
                if isinstance(candidate, str) and candidate.strip():
                    legacy_tokens.append(candidate.strip())

        for key in ("nightscout_url", "ns_url", "url"):
            value = network_cfg.get(key)
            if isinstance(value, str) and value.strip():
                legacy_urls.append(value.strip())
        for key in ("nightscout_token", "ns_token", "token"):
            value = network_cfg.get(key)
            if isinstance(value, str) and value.strip():
                legacy_tokens.append(value.strip())

        removed_any = False
        if "nightscout" in network_cfg:
            network_cfg.pop("nightscout", None)
            removed_any = True
        for key in ("nightscout_url", "nightscout_token", "ns_url", "ns_token", "url", "token"):
            if key in network_cfg:
                network_cfg.pop(key, None)
                removed_any = True
        if removed_any:
            changed = True

    current_section = config.get("nightscout")
    section_url = ""
    section_token = ""
    if isinstance(current_section, dict):
        raw_section_url = current_section.get("url")
        raw_section_token = current_section.get("token") or current_section.get("api_token")
        if isinstance(raw_section_url, str) and raw_section_url.strip():
            section_url = raw_section_url.strip()
            legacy_urls.insert(0, section_url)
        if isinstance(raw_section_token, str) and raw_section_token.strip():
            section_token = raw_section_token.strip()
            legacy_tokens.insert(0, section_token)

    final_url = _first_non_empty([current_url, section_url, *legacy_urls])
    final_token = _first_non_empty([current_token, section_token, *legacy_tokens])

    if final_url != current_url:
        config["nightscout_url"] = final_url
        changed = True
    if final_token != current_token:
        config["nightscout_token"] = final_token
        changed = True

    nightscout_cfg = current_section if isinstance(current_section, dict) else {}
    if nightscout_cfg.get("url") != final_url:
        nightscout_cfg["url"] = final_url
        changed = True
    if nightscout_cfg.get("token") != final_token:
        nightscout_cfg["token"] = final_token
        changed = True
    config["nightscout"] = nightscout_cfg

    diabetes_cfg = config.get("diabetes") if isinstance(config.get("diabetes"), dict) else {}
    if diabetes_cfg.get("ns_url") != final_url:
        diabetes_cfg["ns_url"] = final_url
        changed = True
    if diabetes_cfg.get("ns_token") != final_token:
        diabetes_cfg["ns_token"] = final_token
        changed = True
    config["diabetes"] = diabetes_cfg

    integrations_cfg = config.get("integrations") if isinstance(config.get("integrations"), dict) else {}
    if integrations_cfg.get("nightscout_url") != final_url:
        integrations_cfg["nightscout_url"] = final_url
        changed = True
    if integrations_cfg.get("nightscout_token") != final_token:
        integrations_cfg["nightscout_token"] = final_token
        changed = True
    config["integrations"] = integrations_cfg

    return changed


def _load_config() -> Dict[str, Any]:
    config = _load_json(CONFIG_PATH)
    if not isinstance(config, dict):
        config = {}

    defaults = _default_config()
    changed = False

    for key, value in defaults.items():
        if isinstance(value, dict):
            current = config.get(key)
            if not isinstance(current, dict):
                config[key] = json.loads(json.dumps(value))
                changed = True
            else:
                for sub_key, sub_value in value.items():
                    if sub_key not in current:
                        current[sub_key] = sub_value
                        changed = True
        else:
            if key not in config:
                config[key] = value
                changed = True

    if _migrate_legacy_nightscout(config):
        changed = True

    if changed:
        _save_json(CONFIG_PATH, config)
    return config


def _gen_pin() -> str:
    return "".join(random.choices(string.digits, k=4))


def _load_pin() -> Optional[str]:
    try:
        if PIN_PATH.exists():
            value = PIN_PATH.read_text().strip()
            if value.isdigit() and len(value) == 4:
                return value
    except Exception:
        return None
    return None


def _write_pin(pin: str) -> None:
    try:
        CFG_DIR.mkdir(parents=True, exist_ok=True)
        PIN_PATH.write_text(pin)
        os.chmod(PIN_PATH, 0o600)
    except Exception:
        pass


def _default_ota_state() -> Dict[str, Any]:
    return {
        "status": "idle",
        "started_at": 0,
        "finished_at": 0,
        "current": "unknown",
        "target": "",
        "message": "",
        "progress": 0,
    }


def _normalize_ota_state(raw: Dict[str, Any] | None) -> Dict[str, Any]:
    state = _default_ota_state()
    if not isinstance(raw, dict):
        return state

    allowed_status = {"idle", "running", "success", "error"}
    status = str(raw.get("status", state["status"]))
    if status not in allowed_status:
        status = state["status"]

    def _to_int(value: Any) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0

    def _to_progress(value: Any) -> int:
        prog = _to_int(value)
        return max(0, min(100, prog))

    message = str(raw.get("message", ""))[:300]
    current = str(raw.get("current", state["current"]))
    target = str(raw.get("target", state["target"]))

    state.update(
        {
            "status": status,
            "started_at": _to_int(raw.get("started_at", state["started_at"])),
            "finished_at": _to_int(raw.get("finished_at", state["finished_at"])),
            "current": current,
            "target": target,
            "message": message,
            "progress": _to_progress(raw.get("progress", state["progress"])),
        }
    )
    return state


def _atomic_write_json(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    os.replace(tmp_path, path)


def _load_ota_state_from_disk() -> Dict[str, Any]:
    try:
        raw = json.loads(OTA_STATE_PATH.read_text())
    except FileNotFoundError:
        return _default_ota_state()
    except Exception:
        return _default_ota_state()
    return _normalize_ota_state(raw)


def _write_ota_state_to_disk(state: Dict[str, Any]) -> None:
    try:
        _atomic_write_json(OTA_STATE_PATH, state)
    except Exception as exc:
        LOG_OTA.warning("No se pudo escribir ota-state.json: %s", exc)


class _OTAEventManager:
    def __init__(self) -> None:
        self._listeners: list[tuple[asyncio.Queue[str], asyncio.AbstractEventLoop]] = []
        self._lock = threading.Lock()

    def register(self, queue: asyncio.Queue[str], loop: asyncio.AbstractEventLoop) -> None:
        with self._lock:
            self._listeners.append((queue, loop))

    def unregister(self, queue: asyncio.Queue[str]) -> None:
        with self._lock:
            self._listeners = [item for item in self._listeners if item[0] is not queue]

    def broadcast(self, payload: str) -> None:
        with self._lock:
            listeners = list(self._listeners)
        for queue, loop in listeners:
            loop.call_soon_threadsafe(queue.put_nowait, payload)


_ota_event_manager = _OTAEventManager()


def _format_sse(event: str, data: Dict[str, Any]) -> str:
    return f"event: {event}\n" f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def _append_ota_log(message: str) -> None:
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S%z")
    line = f"{timestamp} {message.strip()}"
    try:
        OTA_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with OTA_LOG_PATH.open("a", encoding="utf-8") as fp:
            fp.write(line + "\n")
    except Exception as exc:
        LOG_OTA.warning("No se pudo escribir en el log OTA: %s", exc)
    try:
        payload = _format_sse("log", {"line": line})
        _ota_event_manager.broadcast(payload)
    except RuntimeError:
        # No event loop running yet
        pass


def _tail_file(path: Path, max_lines: int) -> str:
    if max_lines <= 0:
        return ""
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fp:
            from collections import deque

            buffer = deque(fp, maxlen=max_lines)
    except FileNotFoundError:
        return ""
    except Exception as exc:
        LOG_OTA.warning("No se pudo leer el log OTA: %s", exc)
        return ""
    return "".join(buffer)


def _get_current_release_label() -> str:
    try:
        if OTA_CURRENT_LINK.exists():
            resolved = OTA_CURRENT_LINK.resolve()
            git_dir = resolved if resolved.is_dir() else resolved.parent
            cmd = ["git", "-C", str(git_dir), "rev-parse", "--short", "HEAD"]
            proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
            if proc.returncode == 0:
                return proc.stdout.strip() or resolved.name
            return resolved.name
    except Exception as exc:
        LOG_OTA.debug("No se pudo determinar release actual: %s", exc)
    return "unknown"


def _get_repo_head_commit(path: Path) -> str | None:
    try:
        proc = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        )
    except Exception as exc:
        LOG_OTA.debug("No se pudo obtener commit en %s: %s", path, exc)
        return None
    if proc.returncode == 0:
        commit = proc.stdout.strip()
        return commit or None
    return None


def _discover_latest_remote_commit() -> str | None:
    cmd = ["git", "ls-remote", OTA_REPO_URL, "main"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=30)
    except Exception as exc:
        LOG_OTA.warning("No se pudo consultar el último commit remoto: %s", exc)
        return None
    if proc.returncode != 0:
        LOG_OTA.warning("git ls-remote devolvió código %s", proc.returncode)
        return None
    output = proc.stdout.strip()
    if not output:
        return None
    commit = output.split()[0]
    return commit if commit else None


def ota_check_for_updates() -> Dict[str, Any]:
    current_version = _get_current_release_label()
    try:
        current_commit = _get_repo_head_commit(OTA_CURRENT_LINK.resolve())
    except Exception:
        current_commit = None
    if not current_commit:
        current_commit = _get_repo_head_commit(OTA_CURRENT_LINK)

    result: Dict[str, Any] = {
        "current_version": current_version,
        "available_version": current_version,
        "available": False,
    }

    try:
        connectivity = _nm_connectivity()
    except Exception:
        connectivity = None

    if connectivity not in {"full"}:
        result["reason"] = "offline"
        if connectivity:
            result["connectivity"] = connectivity
        return result

    latest_commit = _discover_latest_remote_commit()
    if not latest_commit:
        result["reason"] = "unreachable"
        return result

    latest_short = latest_commit[:7]
    result["available_version"] = latest_short

    if current_commit:
        if latest_commit.startswith(current_commit):
            return result
        if current_commit.startswith(latest_commit):
            return result

    if latest_short != current_version or (current_commit and current_commit != latest_commit):
        result["available"] = True

    return result


def _run_logged_command(
    cmd: Sequence[str],
    *,
    cwd: Path | None = None,
    check: bool = True,
    input_text: str | None = None,
) -> int:
    display = " ".join(shlex.quote(part) for part in cmd)
    LOG_OTA.info("[ota] Ejecutando: %s", display)
    _append_ota_log(f"[ota] Ejecutando: {display}")
    process = subprocess.Popen(
        list(cmd),
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.PIPE if input_text is not None else None,
        text=True,
    )
    if input_text is not None and process.stdin:
        try:
            process.stdin.write(input_text)
            process.stdin.close()
        except Exception:
            pass
    if process.stdout:
        for raw_line in process.stdout:
            line = raw_line.rstrip()
            if line:
                LOG_OTA.info("[ota] %s", line)
            _append_ota_log(f"[ota] {line}")
    returncode = process.wait()
    if returncode != 0:
        msg = f"Comando falló (exit {returncode}): {display}"
        LOG_OTA.error("[ota] %s", msg)
        _append_ota_log(f"[ota] {msg}")
        if check:
            raise RuntimeError(msg)
    return returncode


def _run_smoke_tests() -> None:
    tests: list[tuple[str, Sequence[str]]] = [
        ("health", ["curl", "-fsS", "http://127.0.0.1:8080/health"]),
        ("openapi", ["curl", "-fsS", "http://127.0.0.1:8080/openapi.json"]),
    ]
    for label, cmd in tests:
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=15)
        except Exception as exc:
            LOG_OTA.warning("[ota] Smoke test %s no se pudo ejecutar: %s", label, exc)
            _append_ota_log(f"[ota] Smoke test {label} no se pudo ejecutar: {exc}")
            continue
        if proc.returncode != 0:
            LOG_OTA.warning(
                "[ota] Smoke test %s falló con código %s", label, proc.returncode
            )
            _append_ota_log(
                f"[ota] Smoke test {label} falló (exit {proc.returncode}): {proc.stdout.strip()} {proc.stderr.strip() if proc.stderr else ''}"
            )
            continue
        output = proc.stdout.strip()
        if label == "openapi":
            try:
                data = json.loads(output)
                if "paths" not in data:
                    raise ValueError("paths ausente")
                _append_ota_log("[ota] Smoke test openapi: paths detectados")
            except Exception as exc:
                LOG_OTA.warning("[ota] Smoke test openapi con advertencia: %s", exc)
                _append_ota_log(f"[ota] Smoke test openapi advertencia: {exc}")
        else:
            _append_ota_log(f"[ota] Smoke test {label}: OK")


def _ota_worker(target: Optional[str]) -> None:
    global _ota_worker_thread
    started_at = int(time.time())
    current_release = _get_current_release_label()
    latest_commit = _discover_latest_remote_commit() if not target else None
    target_label = target or (latest_commit or "main")

    _update_ota_state(
        {
            "status": "running",
            "started_at": started_at,
            "finished_at": 0,
            "current": current_release,
            "target": target_label,
            "message": "Preparando actualización",
            "progress": 0,
        }
    )

    _append_ota_log(
        f"[ota] Iniciando job: current={current_release} target={target_label}"
    )

    release_dir: Optional[Path] = None

    try:
        OTA_RELEASES_DIR.mkdir(parents=True, exist_ok=True)
        release_dir = OTA_RELEASES_DIR / datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")

        _update_ota_state({"progress": 10, "message": "Clonando repositorio"})
        _run_logged_command(
            [
                "git",
                "clone",
                "--branch",
                "main",
                "--depth",
                "1",
                OTA_REPO_URL,
                str(release_dir),
            ]
        )
        _update_ota_state({"progress": 30, "message": "Repositorio clonado"})

        checkout_ref = target if target else None
        if checkout_ref:
            _update_ota_state({"message": f"Ajustando a {checkout_ref}"})
            _run_logged_command(
                ["git", "-C", str(release_dir), "fetch", "--depth", "1", "origin", checkout_ref]
            )
            _run_logged_command(
                ["git", "-C", str(release_dir), "checkout", checkout_ref]
            )

        head_commit = _get_repo_head_commit(release_dir)
        if head_commit:
            _update_ota_state({"target": head_commit})

        install_script = release_dir / "scripts" / "install-all.sh"
        if not install_script.exists():
            raise FileNotFoundError(f"No se encontró {install_script}")

        _append_ota_log("[ota] Validando preinstalación")
        _update_ota_state({"progress": 40, "message": "Validando instalación"})

        _update_ota_state({"progress": 60, "message": "Instalando actualización"})
        _run_logged_command(["sudo", "bash", "scripts/install-all.sh"], cwd=release_dir)

        _update_ota_state({"progress": 80, "message": "Activando versión"})
        _run_logged_command(["sudo", "ln", "-sfn", str(release_dir), str(OTA_CURRENT_LINK)])
        _run_logged_command(["sudo", "systemctl", "daemon-reload"])
        _run_logged_command(
            ["sudo", "systemctl", "restart", "bascula-ui"], check=False
        )

        _update_ota_state({"progress": 90, "message": "Verificando servicios"})
        _run_smoke_tests()

        final_release = _get_current_release_label()
        _update_ota_state(
            {
                "status": "success",
                "finished_at": int(time.time()),
                "progress": 100,
                "current": final_release,
                "message": "OTA aplicada",
            }
        )
        _append_ota_log("[ota] OTA finalizada correctamente")
        LOG_OTA.info("[ota] Programando reinicio de miniweb")
        _append_ota_log("[ota] Reinicio de miniweb programado")
        _schedule_miniweb_restart()
    except Exception as exc:
        error_message = str(exc)
        truncated = error_message[:300]
        _append_ota_log(f"[ota] ERROR: {error_message}")
        tb_text = traceback.format_exc()
        for line in tb_text.strip().splitlines():
            _append_ota_log(f"[ota] {line}")
        _update_ota_state(
            {
                "status": "error",
                "finished_at": int(time.time()),
                "message": truncated,
            }
        )
    finally:
        with _OTA_WORKER_LOCK:
            _ota_worker_thread = None


def _start_ota_worker(target: Optional[str]) -> bool:
    global _ota_worker_thread
    with _OTA_WORKER_LOCK:
        if _ota_worker_thread is not None:
            if _ota_worker_thread.is_alive():
                return False
            _ota_worker_thread = None
        thread = threading.Thread(target=_ota_worker, args=(target,), daemon=True)
        _ota_worker_thread = thread
        thread.start()
        return True


def _schedule_miniweb_restart(delay_seconds: float = 1.0) -> None:
    def _restart() -> None:
        try:
            time.sleep(delay_seconds)
            LOG_OTA.info("[ota] Reiniciando miniweb tras completar OTA")
            try:
                _append_ota_log("[ota] Reiniciando miniweb tras completar OTA")
            except Exception:
                pass
            subprocess.run(
                ["sudo", "systemctl", "restart", "bascula-miniweb"],
                check=False,
            )
        except Exception as exc:
            LOG_OTA.error("[ota] Error al reiniciar miniweb: %s", exc)
            try:
                _append_ota_log(f"[ota] Error al reiniciar miniweb: {exc}")
            except Exception:
                pass

    threading.Thread(target=_restart, daemon=True).start()


def _update_ota_state(changes: Dict[str, Any]) -> Dict[str, Any]:
    global _ota_state
    with _OTA_STATE_LOCK:
        current_state = dict(_ota_state)
        current_state.update(changes)
        current_state = _normalize_ota_state(current_state)
        _ota_state = current_state
    _write_ota_state_to_disk(current_state)
    try:
        _ota_event_manager.broadcast(_format_sse("state", current_state))
    except RuntimeError:
        pass
    return current_state


def _get_ota_state() -> Dict[str, Any]:
    with _OTA_STATE_LOCK:
        return dict(_ota_state)


with _OTA_STATE_LOCK:
    _ota_state = _load_ota_state_from_disk()
    if _ota_state.get("status") == "running":
        recovery_message = "Servicio miniweb reiniciado durante OTA"
        _ota_state = _normalize_ota_state(
            {
                **_ota_state,
                "status": "error",
                "message": recovery_message,
                "finished_at": int(time.time()),
            }
        )
        _write_ota_state_to_disk(_ota_state)
        try:
            _append_ota_log(f"[ota] {recovery_message}")
        except Exception:
            pass

def _get_or_create_pin() -> str:
    pin = _load_pin()
    if pin:
        return pin
    pin = _gen_pin()
    _write_pin(pin)
    return pin


def _coerce_int(value: Any, default: int, label: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        LOG_SCALE.warning("Invalid %s value %s; using %s", label, value, default)
        return default


def _coerce_float(value: Any, default: float, label: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        LOG_SCALE.warning("Invalid %s value %s; using %s", label, value, default)
        return default


def _get_scale_service() -> Optional[ScaleServiceType]:
    return scale_service


def _init_scale_service() -> ScaleServiceType:
    config = _load_config()
    backend = str(config.get("scale_backend", "uart")).strip().lower()
    if backend not in {"gpio", "uart"}:
        LOG_SCALE.warning("Backend de báscula desconocido '%s'; usando UART", backend)
        backend = "uart"

    if backend == "gpio":
        if not _HX711_AVAILABLE or HX711Service is None:
            global _LOGGED_HX711_WARNING
            if not _LOGGED_HX711_WARNING:
                LOG_SCALE.warning(
                    "HX711Service no disponible; usando backend UART (%s)",
                    HX711_IMPORT_ERROR,
                )
                _LOGGED_HX711_WARNING = True
            backend = "uart"
        else:
            scale_cfg_raw = config.get("scale")
            scale_cfg = scale_cfg_raw if isinstance(scale_cfg_raw, dict) else {}
            dt_pin = _coerce_int(scale_cfg.get("dt", DEFAULT_DT_PIN), DEFAULT_DT_PIN, "scale.dt")
            sck_pin = _coerce_int(scale_cfg.get("sck", DEFAULT_SCK_PIN), DEFAULT_SCK_PIN, "scale.sck")
            sample_rate = _coerce_float(
                scale_cfg.get("sample_rate_hz", DEFAULT_SAMPLE_RATE), DEFAULT_SAMPLE_RATE, "scale.sample_rate_hz"
            )
            filter_window = _coerce_int(
                scale_cfg.get("filter_window", DEFAULT_FILTER_WINDOW), DEFAULT_FILTER_WINDOW, "scale.filter_window"
            )
            calibration_factor = _coerce_float(
                scale_cfg.get("calibration_factor", DEFAULT_CALIBRATION_FACTOR),
                DEFAULT_CALIBRATION_FACTOR,
                "scale.calibration_factor",
            )

            LOG_SCALE.info(
                "Inicializando báscula con backend GPIO (dt=%s, sck=%s, sample_rate=%.2f)",
                dt_pin,
                sck_pin,
                sample_rate,
            )
            service = HX711Service(
                dt_pin=dt_pin,
                sck_pin=sck_pin,
                sample_rate_hz=sample_rate,
                filter_window=filter_window,
                calibration_factor=calibration_factor,
            )
            service.start()
            return service

    device = str(config.get("serial_device", DEFAULT_SERIAL_DEVICE) or DEFAULT_SERIAL_DEVICE)
    baud_value = config.get("serial_baud", DEFAULT_SERIAL_BAUD)
    baud = _coerce_int(baud_value, DEFAULT_SERIAL_BAUD, "serial_baud")

    if not _SERIAL_AVAILABLE or SerialScaleService is None:
        global _LOGGED_SERIAL_WARNING
        if not _LOGGED_SERIAL_WARNING:
            LOG_SCALE.error("SerialScaleService no disponible: %s", SERIAL_IMPORT_ERROR)
            _LOGGED_SERIAL_WARNING = True
        raise RuntimeError("serial_backend_unavailable")

    LOG_SCALE.info(
        "Inicializando báscula con backend UART (device=%s, baud=%s)",
        device,
        baud,
    )
    service = SerialScaleService(device=device, baud=baud)
    service.start()
    return service


def _iface_has_carrier(ifname: str) -> bool:
    try:
        with open(f"/sys/class/net/{ifname}/carrier", "r") as f:
            return f.read().strip() == "1"
    except Exception:
        return False


def _get_iface_ip(ifname: str) -> str | None:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        return socket.inet_ntoa(
            fcntl.ioctl(
                s.fileno(),
                0x8915,
                struct.pack('256s', ifname[:15].encode()),
            )[20:24]
        )
    except Exception:
        return None
    finally:
        s.close()


def get_iface_ip(ifname: str) -> Optional[str]:
    return _get_iface_ip(ifname)


def _nmcli_available() -> bool:
    return NMCLI_BIN.exists()


def _redact_nmcli_args(args: Sequence[str]) -> str:
    redacted: list[str] = []
    skip_next = False
    for item in args:
        if skip_next:
            redacted.append("******")
            skip_next = False
            continue
        if item in {"wifi-sec.psk", "802-11-wireless-security.psk", "password", "psk"}:
            redacted.append(item)
            skip_next = True
            continue
        if any(item.startswith(prefix + "=") for prefix in ("wifi-sec.psk", "802-11-wireless-security.psk", "password", "psk")):
            key = item.split("=", 1)[0]
            redacted.append(f"{key}=******")
            continue
        redacted.append(item)
    return " ".join(shlex.quote(part) for part in redacted)


def _prepare_nmcli_args(*cmd_parts: Sequence[str] | str) -> list[str]:
    if len(cmd_parts) == 1 and isinstance(cmd_parts[0], (list, tuple)):
        parts = cmd_parts[0]
    else:
        parts = cmd_parts

    prepared = [str(part) for part in parts]
    if prepared and prepared[0] == "nmcli":
        prepared[0] = str(NMCLI_BIN)
    return prepared


def _run_nmcli_command(
    *cmd_parts: Sequence[str] | str,
    check: bool = True,
    ok_codes: Set[int] | None = None,
    timeout: int = 30,
) -> subprocess.CompletedProcess:
    if not _nmcli_available():
        raise FileNotFoundError(str(NMCLI_BIN))

    args = _prepare_nmcli_args(*cmd_parts)

    if not args:
        raise ValueError("nmcli command requires at least one argument")

    ok_codes = ok_codes or {0}
    if 0 not in ok_codes:
        ok_codes = set(ok_codes)
        ok_codes.add(0)

    cmd_str_safe = _redact_nmcli_args(args)
    LOG_NETWORK.debug("nmcli %s", cmd_str_safe)

    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode not in ok_codes:
        raise subprocess.CalledProcessError(
            result.returncode,
            cmd_str_safe,
            output=result.stdout,
            stderr=result.stderr,
        )

    if result.returncode not in ok_codes:
        LOG_NETWORK.debug("nmcli allowed code %s", result.returncode)

    if result.stdout:
        LOG_NETWORK.debug("nmcli stdout: %s", result.stdout.strip())
    if result.stderr:
        LOG_NETWORK.debug("nmcli stderr: %s", result.stderr.strip())

    return result


def _run_nmcli_text(
    cmd: Sequence[str] | str,
    *,
    check: bool = True,
    ok_codes: Set[int] | None = None,
    timeout: int = 30,
) -> str:
    result = _run_nmcli_command(
        cmd,
        check=check,
        ok_codes=ok_codes,
        timeout=timeout,
    )
    return result.stdout or ""


def _run_nmcli_bool(
    cmd: Sequence[str] | str,
    *,
    match: str,
    timeout: int = 30,
) -> bool:
    text = _run_nmcli_text(cmd, check=False, timeout=timeout)
    for line in text.splitlines():
        if line.strip() == match:
            return True
    return False


async def _run_nmcli_async(
    *cmd_parts: Sequence[str] | str,
    check: bool = True,
    ok_codes: Set[int] | None = None,
    timeout: int = 30,
) -> subprocess.CompletedProcess:
    args = _prepare_nmcli_args(*cmd_parts)
    return await asyncio.to_thread(
        _run_nmcli_command,
        args,
        check=check,
        ok_codes=ok_codes,
        timeout=timeout,
    )


def _nmcli_args(*parts: str) -> list[str]:
    return [str(NMCLI_BIN), *parts]


def _queue_put_nowait(queue: "asyncio.Queue[bytes]", message: bytes) -> None:
    try:
        queue.put_nowait(message)
    except asyncio.QueueFull:
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
        try:
            queue.put_nowait(message)
        except asyncio.QueueFull:
            pass


def _emit_net_event(event_type: str, payload: Dict[str, Any] | None = None) -> None:
    if not event_type:
        return

    payload = payload or {}
    try:
        data_str = json.dumps(payload, ensure_ascii=False)
    except Exception:
        data_str = "{}"

    message = f"event: {event_type}\ndata: {data_str}\n\n".encode("utf-8")

    with _net_event_lock:
        subscribers = list(_net_event_subscribers.items())

    if not subscribers:
        return

    for key, (queue, loop) in subscribers:
        try:
            loop.call_soon_threadsafe(_queue_put_nowait, queue, message)
        except RuntimeError:
            with _net_event_lock:
                _net_event_subscribers.pop(key, None)


def _emit_network_status_update(config: Optional[Dict[str, Any]] | None = None) -> None:
    try:
        status = _get_wifi_status(config)
    except PermissionError:
        return
    except Exception as exc:
        LOG_NETWORK.debug("No se pudo obtener el estado de red para SSE: %s", exc)
        return

    _emit_net_event("status", status)


async def _run_command_ignore_errors(*cmd: str, timeout: float | None = None) -> None:
    if not cmd:
        return

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        LOG_NETWORK.debug("Comando no encontrado: %s", cmd[0])
        return
    except Exception as exc:
        LOG_NETWORK.debug("No se pudo lanzar %s: %s", cmd, exc)
        return

    try:
        if timeout is not None and timeout > 0:
            await asyncio.wait_for(process.communicate(), timeout=timeout)
        else:
            await process.communicate()
    except asyncio.TimeoutError:
        process.kill()
        await process.communicate()
    except Exception as exc:
        LOG_NETWORK.debug("Error esperando comando %s: %s", cmd, exc)


async def _wait_for_wifi_ip(*, timeout: float = 12.0, interval: float = 0.5) -> Optional[str]:
    deadline = time.monotonic() + max(timeout, 1.0)
    last_error: Exception | None = None

    while time.monotonic() < deadline:
        try:
            ip_res = await _run_nmcli_async(
                _nmcli_args("-t", "-g", "IP4.ADDRESS", "device", "show", WIFI_INTERFACE),
                timeout=5,
                check=False,
            )
            if ip_res.returncode == 0 and ip_res.stdout:
                ip_line = ip_res.stdout.strip().splitlines()[0]
                if ip_line:
                    candidate = ip_line.split("/")[0].strip()
                    if candidate and not _ip_is_ap_subnet(candidate):
                        return candidate
        except PermissionError:
            raise
        except Exception as exc:
            last_error = exc
            LOG_NETWORK.debug("Error obteniendo IP Wi-Fi: %s", exc)

        fallback_ip = get_iface_ip(WIFI_INTERFACE)
        if fallback_ip and not _ip_is_ap_subnet(fallback_ip):
            return fallback_ip

        await asyncio.sleep(interval)

    if last_error:
        LOG_NETWORK.debug("Timeout esperando IP Wi-Fi: %s", last_error)
    return None


def _systemctl_is_active(service: str) -> Optional[bool]:
    try:
        result = subprocess.run(
            ["systemctl", "is-active", service],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except FileNotFoundError:
        return None
    except Exception as exc:
        LOG_NETWORK.debug("systemctl is-active %s falló: %s", service, exc)
        return None

    status = (result.stdout or "").strip().lower()
    if result.returncode == 0:
        return status == "active"

    if status in {"inactive", "failed", "deactivating", "activating", "unknown"}:
        return False

    return None


async def _net_events_generator(request: Request) -> AsyncGenerator[bytes, None]:
    queue: "asyncio.Queue[bytes]" = asyncio.Queue(maxsize=16)
    loop = asyncio.get_running_loop()

    with _net_event_lock:
        _net_event_subscribers[id(queue)] = (queue, loop)

    try:
        keepalive = 15.0
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=keepalive)
            except asyncio.TimeoutError:
                if await request.is_disconnected():
                    break
                yield b": keep-alive\n\n"
                continue
            yield item
    finally:
        with _net_event_lock:
            _net_event_subscribers.pop(id(queue), None)


def _classify_nmcli_failure(res: subprocess.CompletedProcess) -> tuple[int, str, str]:
    """
    Mapea el error de nmcli a (status_http, code_api, msg_humano).
    Conserva compatibilidad con códigos previos.
    """

    out = (res.stdout or "").strip()
    err = (res.stderr or "").strip()
    txt = f"{out}\n{err}".lower()

    if "not authorized" in txt or "requires authorization" in txt or "not privileged" in txt:
        return 403, "NMCLI_NOT_AUTHORIZED", err or out or "Acceso denegado por NetworkManager."

    if "secrets were required" in txt or "secrets are required" in txt or "no key available" in txt:
        return 400, "NMCLI_SECRETS_REQUIRED", "NetworkManager requiere una contraseña válida."

    return 400, "wifi_up_failed", err or out or "Fallo al activar la conexión Wi-Fi."


def _nmcli_get_values(args: List[str], timeout: int = 5) -> List[str]:
    try:
        res = _run_nmcli_command(
            _nmcli_args(*args),
            check=False,
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise PermissionError("NMCLI_NOT_AVAILABLE") from exc

    if res.returncode != 0:
        return []

    return [line.strip() for line in res.stdout.splitlines() if line.strip()]


def _nmcli_get_first_value(args: List[str], timeout: int = 5) -> Optional[str]:
    values = _nmcli_get_values(args, timeout=timeout)
    if not values:
        return None
    return values[0]


async def _list_connection_entries(name: str) -> list[dict[str, str]]:
    try:
        res = await _run_nmcli_async(
            _nmcli_args(
                "-t",
                "--separator",
                "|",
                "-f",
                "NAME,UUID",
                "connection",
                "show",
            ),
            timeout=10,
            check=False,
        )
    except FileNotFoundError as exc:
        raise PermissionError("NMCLI_NOT_AVAILABLE") from exc

    if res.returncode != 0:
        return []

    entries: list[dict[str, str]] = []
    for line in (res.stdout or "").splitlines():
        if not line:
            continue
        parts = line.split("|")
        if len(parts) < 2:
            continue
        entry_name = parts[0].strip()
        uuid = parts[1].strip()
        if entry_name == name and uuid:
            entries.append({"name": entry_name, "uuid": uuid})
    return entries


async def _get_active_connection_uuid(name: str) -> Optional[str]:
    try:
        res = await _run_nmcli_async(
            _nmcli_args(
                "-t",
                "--separator",
                "|",
                "-f",
                "NAME,UUID",
                "connection",
                "show",
                "--active",
            ),
            timeout=5,
            check=False,
        )
    except FileNotFoundError as exc:
        raise PermissionError("NMCLI_NOT_AVAILABLE") from exc

    if res.returncode != 0:
        return None

    for line in (res.stdout or "").splitlines():
        if not line:
            continue
        parts = line.split("|")
        if len(parts) < 2:
            continue
        entry_name = parts[0].strip()
        uuid = parts[1].strip()
        if entry_name == name and uuid:
            return uuid
    return None


def _ip_is_ap_subnet(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip) in ipaddress.ip_network("192.168.4.0/24")
    except Exception:
        return False


async def _cleanup_nmcli_duplicates(connection_id: str, persistent_path: Path | None) -> None:
    try:
        res = await _run_nmcli_async(
            _nmcli_args("-t", "-f", "NAME,UUID,FILENAME", "con", "show"),
            check=False,
        )
    except FileNotFoundError as exc:
        raise PermissionError("NMCLI_NOT_AVAILABLE") from exc

    if res.returncode not in {0}:
        txt = f"{res.stdout or ''}\n{res.stderr or ''}".lower()
        if "not authorized" in txt:
            raise PermissionError("NMCLI_NOT_AUTHORIZED")

    stdout = (res.stdout or "").strip()
    if not stdout:
        return

    persistent_resolved: Path | None = None
    if persistent_path is not None:
        try:
            persistent_resolved = persistent_path.resolve()
        except Exception:
            persistent_resolved = None

    for line in stdout.splitlines():
        parts = line.split(":", 2)
        if len(parts) < 3:
            continue
        name, uuid, filename = parts
        if name != connection_id:
            continue
        if persistent_resolved is not None and filename:
            try:
                if Path(filename).resolve() == persistent_resolved:
                    continue
            except Exception:
                pass
        await _run_nmcli_async(
            _nmcli_args("con", "delete", "uuid", uuid),
            check=False,
            ok_codes={0, 10},
        )


async def _export_connection_profile(connection_id: str, target_path: Path) -> Path:
    target_path.parent.mkdir(parents=True, exist_ok=True)

    fd, tmp_name = tempfile.mkstemp(
        dir=str(target_path.parent),
        prefix=f".{connection_id}.",
        suffix=".nmconnection",
    )
    os.close(fd)
    tmp_path = Path(tmp_name)

    try:
        await _run_nmcli_async(
            _nmcli_args("con", "export", connection_id, str(tmp_path)),
            check=True,
        )
        await asyncio.to_thread(os.chmod, tmp_path, 0o600)
        await asyncio.to_thread(os.replace, tmp_path, target_path)
    finally:
        if tmp_path.exists():
            try:
                await asyncio.to_thread(os.unlink, tmp_path)
            except FileNotFoundError:
                pass

    await _run_nmcli_async(
        _nmcli_args("con", "load", str(target_path)),
        check=False,
    )
    return target_path


@dataclass
class _ClientProfileState:
    name: str
    autoconnect: str  # "yes"/"no"
    priority: str  # str numérica o ""


async def _list_client_profiles_state() -> list[_ClientProfileState]:
    cp = await _run_nmcli_async(
        _nmcli_args(
            "-t",
            "-f",
            "NAME,TYPE,AUTOCONNECT,AUTOCONNECT-PRIORITY",
            "con",
            "show",
        ),
        check=True,
    )
    out = (cp.stdout or "").strip().splitlines()
    res: list[_ClientProfileState] = []
    for line in out:
        parts = line.split(":")
        if len(parts) < 4:
            continue
        name, ctype, autocon, prio = parts[0], parts[1], parts[2], parts[3]
        if ctype == "802-11-wireless" and name != AP_CONNECTION_ID:
            res.append(
                _ClientProfileState(
                    name=name,
                    autoconnect=autocon or "no",
                    priority=prio or "0",
                )
            )
    return res


async def _down_active_wifi_clients() -> list[str]:
    cp = await _run_nmcli_async(
        _nmcli_args(
            "-t",
            "-f",
            "NAME,TYPE,DEVICE,STATE",
            "con",
            "show",
            "--active",
        ),
        check=False,
    )
    downed: list[str] = []
    for line in (cp.stdout or "").strip().splitlines():
        parts = line.split(":")
        if len(parts) < 4:
            continue
        name, ctype, dev, _state = parts[0], parts[1], parts[2], parts[3]
        if ctype == "802-11-wireless" and dev == WIFI_INTERFACE and name != AP_CONNECTION_ID:
            downed.append(name)
            await _run_nmcli_async(
                _nmcli_args("con", "down", name),
                check=False,
                ok_codes={0, 10},
            )
    return downed


async def _create_or_update_wifi_profile(
    ssid: str, password: Optional[str], secured: bool
) -> Path:
    LOG_NETWORK.info("Creating NetworkManager profile for '%s'", ssid)

    if secured and not password:
        raise RuntimeError("password_required")

    try:
        await _run_nmcli_async(
            _nmcli_args("con", "delete", ssid),
            check=False,
            ok_codes={0, 10},
        )
        await _cleanup_nmcli_duplicates(ssid, None)

        add_args = [
            "con",
            "add",
            "type",
            "wifi",
            "ifname",
            WIFI_INTERFACE,
            "con-name",
            ssid,
            "ssid",
            ssid,
            "ipv4.method",
            "auto",
        ]
        if secured:
            add_args.extend(
                ["wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", password or ""]
            )
        else:
            add_args.extend(["wifi-sec.key-mgmt", "none"])

        await _run_nmcli_async(_nmcli_args(*add_args))

        if not secured:
            await _run_nmcli_async(
                _nmcli_args("con", "modify", ssid, "wifi-sec.psk", "")
            )

        await _run_nmcli_async(
            _nmcli_args("con", "modify", ssid, "connection.autoconnect", "yes")
        )
        await _run_nmcli_async(
            _nmcli_args(
                "con",
                "modify",
                ssid,
                "connection.autoconnect-priority",
                "200",
            )
        )
        await _run_nmcli_async(
            _nmcli_args("con", "modify", ssid, "connection.permissions", "")
        )
        await _run_nmcli_async(
            _nmcli_args(
                "con", "modify", ssid, "connection.interface-name", WIFI_INTERFACE
            )
        )

        profile_path: Optional[Path] = None
        res_filename = await _run_nmcli_async(
            _nmcli_args(
                "-g",
                "connection.filename",
                "con",
                "show",
                ssid,
            ),
            check=False,
        )
        if res_filename.returncode == 0:
            for line in (res_filename.stdout or "").splitlines():
                candidate = line.strip()
                if candidate:
                    profile_path = Path(candidate)
                    break

        if profile_path and profile_path.exists():
            if not str(profile_path).startswith(str(NM_CONNECTIONS_DIR)):
                NM_CONNECTIONS_DIR.mkdir(parents=True, exist_ok=True)
                target_path = NM_CONNECTIONS_DIR / profile_path.name
                await asyncio.to_thread(os.replace, profile_path, target_path)
                profile_path = target_path
        else:
            NM_CONNECTIONS_DIR.mkdir(parents=True, exist_ok=True)
            profile_path = NM_CONNECTIONS_DIR / f"{ssid}.nmconnection"

        await _export_connection_profile(ssid, profile_path)
        await asyncio.to_thread(
            _write_nm_profile,
            profile_path,
            ssid,
            (password or "") if secured else "",
            secured,
        )
        await _cleanup_nmcli_duplicates(ssid, profile_path)
        return profile_path
    except FileNotFoundError as exc:
        raise PermissionError("NMCLI_NOT_AVAILABLE") from exc


async def _prepare_ap_for_wifi_connection() -> Optional[str]:
    try:
        res = await _run_nmcli_async(
            _nmcli_args(
                "connection",
                "modify",
                AP_CONNECTION_ID,
                "connection.autoconnect",
                "no",
                "connection.autoconnect-priority",
                "0",
            ),
            timeout=5,
            check=False,
        )
        if res.returncode != 0:
            LOG_NETWORK.debug(
                "Setting autoconnect=no for %s returned %s", AP_CONNECTION_ID, res.returncode
            )
    except FileNotFoundError as exc:
        raise PermissionError("NMCLI_NOT_AVAILABLE") from exc
    except Exception as exc:
        LOG_NETWORK.warning("Could not set autoconnect=no for %s: %s", AP_CONNECTION_ID, exc)

    try:
        entries = await _list_connection_entries(AP_CONNECTION_ID)
    except PermissionError:
        raise
    except Exception as exc:
        LOG_NETWORK.debug("Failed to list connections for %s: %s", AP_CONNECTION_ID, exc)
        entries = []

    if not entries:
        return None

    try:
        active_uuid = await _get_active_connection_uuid(AP_CONNECTION_ID)
    except PermissionError:
        raise
    except Exception as exc:
        LOG_NETWORK.debug("Could not determine active UUID for %s: %s", AP_CONNECTION_ID, exc)
        active_uuid = None

    keep_uuid = active_uuid or entries[0]["uuid"]

    for entry in entries:
        uuid = entry["uuid"]
        try:
            res_mod = await _run_nmcli_async(
                _nmcli_args(
                    "connection",
                    "modify",
                    "uuid",
                    uuid,
                    "connection.autoconnect",
                    "no",
                    "connection.autoconnect-priority",
                    "0",
                ),
                timeout=5,
                check=False,
            )
            if res_mod.returncode != 0:
                LOG_NETWORK.debug(
                    "Setting autoconnect=no for AP uuid %s returned %s", uuid, res_mod.returncode
                )
        except Exception as exc:
            LOG_NETWORK.warning("Could not disable autoconnect for AP uuid %s: %s", uuid, exc)

    for entry in entries:
        uuid = entry["uuid"]
        try:
            res_down = await _run_nmcli_async(
                _nmcli_args("connection", "down", "uuid", uuid),
                timeout=10,
                check=False,
                ok_codes={0, 10},
            )
            if res_down.returncode not in (0, 10):
                LOG_NETWORK.debug(
                    "Down command for AP uuid %s returned %s", uuid, res_down.returncode
                )
        except Exception as exc:
            LOG_NETWORK.warning("Could not bring down AP uuid %s: %s", uuid, exc)

    for entry in entries:
        uuid = entry["uuid"]
        if keep_uuid and uuid == keep_uuid:
            continue
        try:
            res_del = await _run_nmcli_async(
                _nmcli_args("connection", "delete", "uuid", uuid),
                timeout=5,
                check=False,
            )
            if res_del.returncode != 0:
                LOG_NETWORK.debug(
                    "Deleting duplicate AP uuid %s returned %s", uuid, res_del.returncode
                )
        except Exception as exc:
            LOG_NETWORK.warning("Could not delete duplicate AP uuid %s: %s", uuid, exc)

    return keep_uuid


async def _ensure_ap_autoconnect_disabled(keep_uuid: Optional[str]) -> None:
    targets: list[list[str]] = []
    if keep_uuid:
        targets.append(["uuid", keep_uuid])
    targets.append([AP_CONNECTION_ID])

    for target in targets:
        args = [
            "connection",
            "modify",
            *target,
            "connection.autoconnect",
            "no",
            "connection.autoconnect-priority",
            "0",
        ]
        try:
            res = await _run_nmcli_async(
                _nmcli_args(*args),
                timeout=5,
                check=False,
            )
            if res.returncode != 0:
                LOG_NETWORK.debug(
                    "Keeping autoconnect=no for %s returned %s",
                    target[-1],
                    res.returncode,
                )
        except FileNotFoundError as exc:
            raise PermissionError("NMCLI_NOT_AVAILABLE") from exc
        except Exception as exc:
            LOG_NETWORK.warning(
                "Could not ensure autoconnect=no for %s: %s", target[-1], exc
            )


async def _wait_for_wifi_activation(timeout_s: float = 45.0) -> tuple[bool, Optional[str]]:
    """Poll nmcli asynchronously until wlan0 is connected with an IPv4 address."""
    deadline = time.monotonic() + timeout_s
    attempt = 0

    while time.monotonic() < deadline:
        attempt += 1
        LOG_NETWORK.info("Polling Wi-Fi activation (attempt %s)", attempt)

        try:
            res_state = await _run_nmcli_async(
                _nmcli_args("-g", "GENERAL.STATE", "device", "show", WIFI_INTERFACE),
                timeout=5,
                check=False,
            )
            state_txt = (res_state.stdout or "").strip()
            state_num_txt = state_txt.split(" ", 1)[0] if state_txt else ""
            state_code = int(state_num_txt) if state_num_txt.isdigit() else None

            res_ip = await _run_nmcli_async(
                _nmcli_args("-g", "IP4.ADDRESS", "device", "show", WIFI_INTERFACE),
                timeout=5,
                check=False,
            )
            lines = [ln.strip() for ln in (res_ip.stdout or "").splitlines() if ln.strip()]
            ip4 = None
            for ln in lines:
                ip4 = ln.split("/", 1)[0]
                if ip4:
                    break

            LOG_NETWORK.info("State=%s IP=%s", state_txt or "", ip4 or "")

            if (state_code is not None and state_code >= 100) and ip4:
                return True, ip4
        except Exception:
            LOG_NETWORK.debug("Transient error while polling nmcli", exc_info=True)

        await asyncio.sleep(1.5)

    return False, None


async def _reactivate_ap_after_failure() -> None:
    try:
        LOG_NETWORK.info(
            "Reactivating '%s' tras fallo y manteniendo autoconnect=no", AP_CONNECTION_ID
        )
        await _run_nmcli_async(
            _nmcli_args(
                "connection",
                "modify",
                AP_CONNECTION_ID,
                "connection.autoconnect",
                "no",
                "connection.autoconnect-priority",
                "0",
            ),
            timeout=5,
            check=False,
            ok_codes={0, 10},
        )
    except Exception as exc:
        LOG_NETWORK.debug("Could not enforce autoconnect=no on %s: %s", AP_CONNECTION_ID, exc)

    try:
        LOG_NETWORK.info("Bringing up '%s' after failure", AP_CONNECTION_ID)
        await _run_nmcli_async(
            _nmcli_args("connection", "up", AP_CONNECTION_ID),
            timeout=20,
            check=False,
        )
    except Exception as exc:
        LOG_NETWORK.warning("Failed to bring up BasculaAP after failure: %s", exc)
def wifi_connected() -> bool:
    return _wifi_client_connected()


def ethernet_carrier(ifname: str = "eth0") -> bool:
    if _iface_has_carrier(ifname):
        return True

    try:
        res = _run_nmcli_command(
            _nmcli_args("-t", "-f", "DEVICE,TYPE,STATE", "device", "status"),
            timeout=5,
            check=False,
        )
    except FileNotFoundError:
        return False
    except Exception:
        return False

    if res.returncode != 0:
        return False

    for line in res.stdout.strip().splitlines():
        if not line:
            continue
        parts = line.split(":")
        if len(parts) < 3:
            continue
        device, dev_type, state = parts[0], parts[1], parts[2].lower()
        if device != ifname:
            continue
        if dev_type == "ethernet" and state.startswith("connected"):
            return True
    return False


def _wifi_client_connected() -> bool:
    """Return True if wlan0 is associated to a Wi-Fi network."""

    try:
        _, state_connected = _get_wifi_device_state()
    except PermissionError:
        return False

    if not state_connected:
        return False

    try:
        active_connection_raw = _nmcli_get_first_value(
            [
                "-g",
                "GENERAL.CONNECTION",
                "device",
                "show",
                WIFI_INTERFACE,
            ],
            timeout=5,
        )
    except PermissionError:
        return False
    except Exception:
        active_connection_raw = None

    active_connection = None
    if active_connection_raw and active_connection_raw not in {"", "--"}:
        active_connection = active_connection_raw

    if not active_connection or active_connection == AP_CONNECTION_ID:
        return False

    wlan_ip = None
    try:
        wlan_ip_raw = _nmcli_get_first_value(
            [
                "-g",
                "IP4.ADDRESS",
                "device",
                "show",
                WIFI_INTERFACE,
            ],
            timeout=5,
        )
    except PermissionError:
        return False
    except Exception:
        wlan_ip_raw = None

    if wlan_ip_raw:
        wlan_ip = wlan_ip_raw.split("/", 1)[0].strip()
    if not wlan_ip:
        wlan_ip = get_iface_ip(WIFI_INTERFACE)

    if wlan_ip and _ip_is_ap_subnet(wlan_ip):
        return False

    return True


def _nm_active_ap() -> bool:
    try:
        return _run_nmcli_bool(
            [
                "nmcli",
                "-t",
                "-f",
                "NAME,DEVICE",
                "con",
                "show",
                "--active",
            ],
            match=f"{AP_CONNECTION_ID}:{WIFI_INTERFACE}",
            timeout=5,
        )
    except FileNotFoundError as exc:
        raise PermissionError("NMCLI_NOT_AVAILABLE") from exc
    except Exception as exc:
        LOG_NETWORK.debug("_nm_active_ap fallback due to error: %s", exc)
        return False


def _nm_connectivity() -> str:
    try:
        raw = _run_nmcli_text(
            ["nmcli", "-g", "CONNECTIVITY", "general"],
            check=False,
            timeout=5,
        )
    except FileNotFoundError as exc:
        raise PermissionError("NMCLI_NOT_AVAILABLE") from exc
    except Exception as exc:
        LOG_NETWORK.debug("_nm_connectivity failed: %s", exc)
        return "unknown"

    state = raw.strip().lower()
    if not state:
        return "unknown"
    if state not in {"full", "limited", "portal", "none", "unknown"}:
        return "unknown"
    return state


def _nm_has_saved_wifi_profiles() -> bool:
    try:
        out = _run_nmcli_text(
            [
                "nmcli",
                "-t",
                "-f",
                "TYPE,AUTOCONNECT",
                "connection",
                "show",
            ],
            check=False,
            timeout=5,
        )
    except FileNotFoundError as exc:
        raise PermissionError("NMCLI_NOT_AVAILABLE") from exc
    except Exception as exc:
        LOG_NETWORK.debug("_nm_has_saved_wifi_profiles failed: %s", exc)
        return False

    for line in out.splitlines():
        parts = line.split(":")
        if len(parts) < 2:
            continue
        typ, autoconnect = parts[0], parts[1]
        if typ == "802-11-wireless" and autoconnect.lower() == "yes":
            return True
    return False


def _read_nm_ap_ssid() -> Optional[str]:
    path = AP_NM_PROFILE_PATH
    try:
        content = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except Exception as exc:
        LOG_NETWORK.debug("Failed to read AP nmconnection: %s", exc)
        return None

    section: Optional[str] = None
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip().lower()
            continue
        if section == "wifi":
            key, sep, value = line.partition("=")
            if key.strip().lower() == "ssid" and sep:
                ssid = value.strip()
                if ssid:
                    return ssid
    return None


def _read_script_ap_ssid() -> Optional[str]:
    path = AP_ENSURE_SCRIPT_PATH
    try:
        content = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except Exception as exc:
        LOG_NETWORK.debug("Failed to read AP ensure script: %s", exc)
        return None

    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if not line.startswith("AP_SSID"):
            continue

        default_match = re.search(r"\$\{AP_SSID:-([^}]+)\}", line)
        if default_match:
            candidate = default_match.group(1).strip()
            if candidate:
                return candidate

        simple_match = re.search(r"AP_SSID\s*=\s*['\"]([^'\"]+)['\"]", line)
        if simple_match:
            candidate = simple_match.group(1).strip()
            if candidate and not candidate.startswith("${"):
                return candidate
    return None


def _resolve_ap_ssid() -> str:
    for reader in (_read_nm_ap_ssid, _read_script_ap_ssid):
        value = reader()
        if isinstance(value, str) and value.strip():
            return value.strip()
    return AP_DEFAULT_SSID


def _ap_active() -> bool:
    """Check if BasculaAP is active and properly configured as AP mode."""
    try:
        if _nm_active_ap():
            return True
    except PermissionError:
        pass
    except Exception as exc:
        LOG_NETWORK.debug("_ap_active nmcli detection failed: %s", exc)

    try:
        # Check active connections
        res = _run_nmcli_command(
            _nmcli_args("-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"),
            timeout=5,
            check=False,
        )
        if res.returncode != 0:
            return False

        ap_is_active = False
        for line in res.stdout.splitlines():
            parts = line.split(":")
            if len(parts) < 3:
                continue
            name, typ, device = parts[0], parts[1], parts[2]
            if name == AP_CONNECTION_ID and typ == "802-11-wireless" and device == WIFI_INTERFACE:
                ap_is_active = True
                break

        if not ap_is_active:
            return False

        # Verify it's actually in AP mode and has correct IP
        try:
            mode_res = _run_nmcli_command(
                _nmcli_args(
                    "-t",
                    "-g",
                    "802-11-wireless.mode",
                    "connection",
                    "show",
                    AP_CONNECTION_ID,
                ),
                timeout=5,
                check=False,
            )
            if mode_res.returncode == 0:
                mode = (mode_res.stdout or "").strip()
                if mode != "ap":
                    return False

            ip_res = _run_nmcli_command(
                _nmcli_args("-t", "-g", "IP4.ADDRESS", "device", "show", WIFI_INTERFACE),
                timeout=5,
                check=False,
            )
            if ip_res.returncode == 0:
                ip_line = (ip_res.stdout or "").strip().split("\n")[0] if ip_res.stdout else ""
                if ip_line:
                    ip = ip_line.split("/")[0]
                    # Should be 192.168.4.1
                    if not ip.startswith("192.168.4."):
                        return False
        except Exception:
            pass

        return True
    except Exception:
        return False


def _get_wifi_device_state() -> tuple[Optional[str], bool]:
    """Return raw NetworkManager state for wlan0 and whether it is connected."""

    try:
        values = _nmcli_get_values(["-t", "-f", "DEVICE,STATE", "dev"], timeout=5)
    except PermissionError:
        raise
    except Exception:
        return None, False

    state_raw: Optional[str] = None
    for line in values:
        parts = line.split(":", 1)
        if not parts:
            continue
        device = parts[0]
        if device != WIFI_INTERFACE:
            continue
        state_raw = parts[1] if len(parts) > 1 else ""
        break

    if state_raw is None:
        return None, False

    normalized = state_raw.strip().lower()
    return state_raw, normalized.startswith("connected")


def _bring_up_ap(debounce_sec: float = 30.0) -> bool:
    global _LAST_AP_ACTION_TS
    now = time.time()
    if now - _LAST_AP_ACTION_TS < debounce_sec:
        return False
    if _iface_has_carrier("eth0") or _wifi_client_connected():
        return False
    if _ap_active():
        return False
    _LAST_AP_ACTION_TS = now
    try:
        ensure_ap_profile()
    except Exception as exc:
        LOG_NETWORK.warning("Failed to ensure AP profile: %s", exc)

    # Disconnect wlan0 before activating AP
    try:
        LOG_NETWORK.info("Disconnecting %s before activating AP", WIFI_INTERFACE)
        _run_nmcli_command(
            _nmcli_args("device", "disconnect", WIFI_INTERFACE),
            timeout=5,
            check=False,
        )
    except Exception as exc:
        LOG_NETWORK.debug("Failed to disconnect %s: %s", WIFI_INTERFACE, exc)

    # Verify AP profile has correct settings
    try:
        mode_res = _run_nmcli_command(
            _nmcli_args(
                "-t",
                "-g",
                "802-11-wireless.mode",
                "connection",
                "show",
                AP_CONNECTION_ID,
            ),
            timeout=5,
            check=False,
        )
        if mode_res.returncode == 0:
            mode = (mode_res.stdout or "").strip()
            if mode != "ap":
                LOG_NETWORK.warning("AP profile mode is '%s', fixing to 'ap'", mode)
                _run_nmcli_command(
                    _nmcli_args(
                        "connection",
                        "modify",
                        AP_CONNECTION_ID,
                        "802-11-wireless.mode",
                        "ap",
                    ),
                    timeout=5,
                )

        ipv4_res = _run_nmcli_command(
            _nmcli_args(
                "-t",
                "-g",
                "ipv4.method",
                "connection",
                "show",
                AP_CONNECTION_ID,
            ),
            timeout=5,
            check=False,
        )
        if ipv4_res.returncode == 0:
            ipv4_method = (ipv4_res.stdout or "").strip()
            if ipv4_method != "shared":
                LOG_NETWORK.warning("AP profile ipv4.method is '%s', fixing to 'shared'", ipv4_method)
                _run_nmcli_command(
                    _nmcli_args(
                        "connection",
                        "modify",
                        AP_CONNECTION_ID,
                        "ipv4.method",
                        "shared",
                    ),
                    timeout=5,
                )
    except Exception as exc:
        LOG_NETWORK.warning("Failed to verify AP profile settings: %s", exc)

    try:
        res = _run_nmcli_command(
            _nmcli_args("connection", "up", AP_CONNECTION_ID),
            timeout=15,
            check=False,
        )
        if res.returncode != 0:
            err_msg = (res.stderr or res.stdout or "").strip()
            LOG_NETWORK.error("Failed to activate %s: %s", AP_CONNECTION_ID, err_msg)
            return False
        LOG_NETWORK.info("AP %s activated successfully", AP_CONNECTION_ID)
        return True
    except Exception as exc:
        LOG_NETWORK.error("Exception activating AP: %s", exc)
        return False


def set_autoconnect(name: str, yes_no: bool, priority: int) -> None:
    value = "yes" if yes_no else "no"
    try:
        res = _run_nmcli_command(
            _nmcli_args(
                "con",
                "modify",
                name,
                "connection.autoconnect",
                value,
                "connection.autoconnect-priority",
                str(priority),
            ),
            timeout=5,
            check=False,
        )
    except FileNotFoundError as exc:
        raise PermissionError("NMCLI_NOT_AVAILABLE") from exc

    if res.returncode != 0:
        message = (res.stderr or res.stdout).strip().lower()
        if "unknown" in message or "not found" in message:
            return
        raise RuntimeError((res.stderr or res.stdout).strip())


def bring_up(name: str, ifname: Optional[str] = None, timeout: int = 30) -> None:
    args = ["con", "up", name]
    if ifname:
        args.extend(["ifname", ifname])
    try:
        res = _run_nmcli_command(
            _nmcli_args(*args),
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise PermissionError("NMCLI_NOT_AVAILABLE") from exc

    if res.returncode != 0:
        raise RuntimeError((res.stderr or res.stdout).strip())


def _is_ap_mode_legacy() -> bool:
    """Fallback heurístico: IP clásica de AP en NM: 192.168.4.1/24 en wlan0."""
    ip = _get_iface_ip(WIFI_INTERFACE)
    if not ip:
        return False
    try:
        return ipaddress.ip_address(ip) in ipaddress.ip_network("192.168.4.0/24")
    except Exception:
        return False


def _is_ap_active() -> bool:
    try:
        if _ap_active():
            return True
    except Exception:
        pass
    return _is_ap_mode_legacy()


def _extract_client_host(request: Request) -> Optional[str]:
    forwarded_for = request.headers.get("x-forwarded-for") if request.headers else None
    if forwarded_for:
        primary = forwarded_for.split(",")[0].strip()
        if primary:
            return primary
    real_ip = request.headers.get("x-real-ip") if request.headers else None
    if real_ip:
        candidate = real_ip.strip()
        if candidate:
            return candidate
    if request.client and request.client.host:
        return request.client.host
    return None


def _host_in_trusted_set(host: str) -> bool:
    normalized = host.strip()
    if not normalized:
        return False
    if normalized in {"localhost", "127.0.0.1", "::1"}:
        return True
    if normalized in _TRUSTED_HOSTS:
        return True
    try:
        ip_obj = ipaddress.ip_address(normalized)
    except ValueError:
        return False
    if ip_obj.is_loopback:
        return True
    for network in _TRUSTED_NETWORKS:
        if ip_obj in network:
            return True
    return False


def _is_trusted_client(client_host: Optional[str]) -> bool:
    if not client_host:
        return False
    if _host_in_trusted_set(client_host):
        return True
    mapped = client_host
    if client_host.startswith("::ffff:"):
        mapped = client_host.split(":")[-1]
        return _host_in_trusted_set(mapped)
    return False


def _allow_pin_disclosure(client_host: Optional[str]) -> bool:
    if _is_trusted_client(client_host):
        return True
    if os.getenv("BASCULA_ALLOW_PIN_READ", "0") == "1":
        return True
    return _is_ap_active()


def _nm_unescape(value: str) -> str:
    """Deshace el escaping estilo nmcli (\: y \\)."""
    return value.replace("\\\\", "\\").replace("\\:", ":").strip()


def _list_networks() -> List[Dict[str, Any]]:
    """Devuelve lista de redes Wi-Fi visibles usando nmcli."""
    try:
        try:
            _run_nmcli_command(
                _nmcli_args("dev", "wifi", "rescan"),
                timeout=5,
                check=False,
            )
        except subprocess.TimeoutExpired:
            pass

        result = _run_nmcli_command(
            _nmcli_args(
                "-t",
                "--escape",
                "yes",
                "-f",
                "IN-USE,SSID,SIGNAL,SECURITY",
                "dev",
                "wifi",
                "list",
            ),
            timeout=10,
            check=False,
        )
        if result.returncode != 0:
            err = (result.stderr or result.stdout).strip()
            if "not authorized" in err.lower():
                raise PermissionError("NMCLI_NOT_AUTHORIZED")
            raise RuntimeError(err)

        networks: List[Dict[str, Any]] = []
        for line in result.stdout.strip().splitlines():
            if not line:
                continue
            parts = line.split(":")
            if len(parts) < 4:
                continue
            in_use_flag, raw_ssid, signal_part, security_part = parts[0], parts[1], parts[2], parts[3]
            ssid = _nm_unescape(raw_ssid)
            if not ssid:
                continue
            try:
                signal = int(signal_part.strip())
            except ValueError:
                signal = 0
            security = _nm_unescape(security_part)
            normalized_security = security or ""
            secured = bool(normalized_security and normalized_security.upper() != "NONE")
            networks.append(
                {
                    "ssid": ssid,
                    "signal": signal,
                    "sec": normalized_security,
                    "in_use": in_use_flag.strip() == "*",
                    "secured": secured,
                }
            )

        networks.sort(key=lambda item: item["signal"], reverse=True)
        unique: Dict[str, Dict[str, Any]] = {}
        for net in networks:
            if net["ssid"] not in unique:
                unique[net["ssid"]] = net
        return list(unique.values())
    except FileNotFoundError:
        raise PermissionError("NMCLI_NOT_AVAILABLE")
    except PermissionError:
        raise
    except Exception as exc:
        raise RuntimeError(str(exc))


def _remove_profiles_for_ssid(ssid: str) -> None:
    if not NM_CONNECTIONS_DIR.exists():
        return
    for profile_path in NM_CONNECTIONS_DIR.glob("*.nmconnection"):
        try:
            content = profile_path.read_text()
        except Exception:
            continue
        if f"ssid={ssid}" not in content:
            continue
        connection_id: Optional[str] = None
        for line in content.splitlines():
            if line.startswith("id="):
                connection_id = line.split("=", 1)[1].strip()
                break
        if connection_id:
            try:
                _remove_connection(connection_id)
            except Exception:
                pass


def _remove_connection(connection_id: str) -> None:
    try:
        res = _run_nmcli_command(
            _nmcli_args("con", "delete", connection_id),
            timeout=5,
            check=False,
            ok_codes={0, 10},
        )
        if res.returncode not in (0, 10):
            message = (res.stderr or res.stdout).strip().lower()
            if "unknown" not in message and "not found" not in message:
                raise RuntimeError((res.stderr or res.stdout).strip())
    except FileNotFoundError:
        raise PermissionError("NMCLI_NOT_AVAILABLE")


def _disconnect_connection(connection_id: str) -> None:
    try:
        _run_nmcli_command(
            _nmcli_args("con", "down", connection_id),
            timeout=5,
            check=False,
            ok_codes={0, 10},
        )
    except Exception:
        pass


def ensure_ap_profile() -> None:
    if not _nmcli_available():
        raise PermissionError("NMCLI_NOT_AVAILABLE")

    connection_exists = False
    try:
        existing = _run_nmcli_command(
            _nmcli_args("con", "show", AP_CONNECTION_ID),
            timeout=5,
            check=False,
        )
        connection_exists = existing.returncode == 0
    except FileNotFoundError:
        raise PermissionError("NMCLI_NOT_AVAILABLE")

    if not connection_exists:
        create_res = _run_nmcli_command(
            _nmcli_args(
                "con",
                "add",
                "type",
                "wifi",
                "ifname",
                WIFI_INTERFACE,
                "con-name",
                AP_CONNECTION_ID,
                "ssid",
                AP_DEFAULT_SSID,
            ),
            timeout=10,
            check=False,
        )
        if create_res.returncode not in (0, 4):
            message = (create_res.stderr or create_res.stdout).strip()
            lower = message.lower()
            if "already exists" not in lower and "exists" not in lower:
                raise RuntimeError(message)

    modify_res = _run_nmcli_command(
        _nmcli_args(
            "con",
            "modify",
            AP_CONNECTION_ID,
            "connection.autoconnect",
            "no",
            "connection.autoconnect-priority",
            "0",
            "connection.interface-name",
            WIFI_INTERFACE,
            "802-11-wireless.ssid",
            AP_DEFAULT_SSID,
            "802-11-wireless.mode",
            "ap",
            "802-11-wireless.band",
            "bg",
            "802-11-wireless.channel",
            "1",
            "wifi-sec.key-mgmt",
            "wpa-psk",
            "wifi-sec.proto",
            "rsn",
            "802-11-wireless-security.pmf",
            "2",
            "ipv4.method",
            "shared",
            "ipv4.addresses",
            "192.168.4.1/24",
            "ipv4.gateway",
            "192.168.4.1",
            "ipv4.never-default",
            "yes",
            "ipv6.method",
            "ignore",
        ),
        timeout=10,
    )
    if modify_res.returncode != 0:
        raise RuntimeError((modify_res.stderr or modify_res.stdout).strip())

    secret_ap_res = _run_nmcli_command(
        _nmcli_args(
            "con",
            "modify",
            AP_CONNECTION_ID,
            "wifi-sec.psk",
            AP_DEFAULT_PASSWORD,
        ),
        timeout=5,
    )
    if secret_ap_res.returncode != 0:
        raise RuntimeError((secret_ap_res.stderr or secret_ap_res.stdout).strip())


def _ethernet_connected() -> bool:
    try:
        res = _run_nmcli_command(
            _nmcli_args("-t", "-f", "DEVICE,TYPE,STATE", "device", "status"),
            timeout=5,
            check=False,
        )
    except FileNotFoundError:
        raise PermissionError("NMCLI_NOT_AVAILABLE")
    except Exception:
        return False

    if res.returncode != 0:
        return False

    for line in res.stdout.strip().splitlines():
        if not line:
            continue
        parts = line.split(":")
        if len(parts) < 3:
            continue
        device, dev_type, state = parts[0], parts[1], parts[2]
        if dev_type == "ethernet" and state.lower().startswith("connected"):
            return True
    return False


def _connection_ssid(connection_name: str) -> Optional[str]:
    try:
        res = _run_nmcli_command(
            _nmcli_args("-t", "-f", "802-11-wireless.ssid", "con", "show", connection_name),
            timeout=5,
            check=False,
        )
    except Exception:
        return None

    if res.returncode != 0:
        return None

    for line in res.stdout.strip().splitlines():
        if not line:
            continue
        parts = line.split(":", 1)
        if len(parts) == 2:
            return _nm_unescape(parts[1])
        return _nm_unescape(parts[0])
    return None


def _current_wifi_ssid() -> Optional[str]:
    try:
        res = _run_nmcli_command(
            _nmcli_args("-t", "--escape", "yes", "-f", "IN-USE,SSID", "dev", "wifi", "list"),
            timeout=5,
            check=False,
        )
    except Exception:
        return None

    if res.returncode != 0:
        return None

    for line in res.stdout.strip().splitlines():
        if not line:
            continue
        parts = line.split(":")
        if len(parts) < 2:
            continue
        if parts[0].strip() == "*":
            return _nm_unescape(parts[1])
    return None


def _resolve_offline_mode(config: Optional[Dict[str, Any]] | None = None) -> bool:
    source: Dict[str, Any] = {}
    if isinstance(config, dict):
        source = config
    else:
        try:
            source = _load_config()
        except Exception:
            source = {}

    ui_cfg = source.get("ui")
    if isinstance(ui_cfg, dict):
        offline_value = ui_cfg.get("offline_mode")
        if isinstance(offline_value, bool):
            return offline_value
        if isinstance(offline_value, (int, float)):
            return bool(offline_value)
        if isinstance(offline_value, str):
            normalized = offline_value.strip().lower()
            if normalized in {"1", "true", "yes", "on"}:
                return True
            if normalized in {"0", "false", "no", "off"}:
                return False

    legacy_value = source.get("offline_mode")
    if isinstance(legacy_value, bool):
        return legacy_value
    if isinstance(legacy_value, (int, float)):
        return bool(legacy_value)
    if isinstance(legacy_value, str):
        normalized = legacy_value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False

    return False


def _determine_effective_mode(
    *,
    ethernet_connected: bool,
    wifi_connected: bool,
    offline_mode_enabled: bool,
    internet_available: bool,
) -> str:
    if offline_mode_enabled:
        return "offline"

    if not ethernet_connected and not wifi_connected:
        return "ap"

    if not internet_available:
        return "offline"

    return "kiosk"


def _get_wifi_status(config: Optional[Dict[str, Any]] | None = None) -> Dict[str, Any]:
    ap_active = _nm_active_ap()
    connectivity = _nm_connectivity()
    saved_wifi_profiles = _nm_has_saved_wifi_profiles()

    eth_ip = get_iface_ip("eth0")

    try:
        ethernet_active = _ethernet_connected()
    except PermissionError:
        ethernet_active = False

    try:
        _, wifi_state_connected = _get_wifi_device_state()
    except PermissionError:
        raise
    except Exception:
        wifi_state_connected = False

    try:
        active_connection_raw = _nmcli_get_first_value([
            "-g",
            "GENERAL.CONNECTION",
            "device",
            "show",
            WIFI_INTERFACE,
        ], timeout=5)
    except PermissionError:
        raise
    except Exception:
        active_connection_raw = None

    active_connection = None
    if active_connection_raw and active_connection_raw != "--":
        active_connection = active_connection_raw

    try:
        wlan_ip_raw = _nmcli_get_first_value([
            "-g",
            "IP4.ADDRESS",
            "device",
            "show",
            WIFI_INTERFACE,
        ], timeout=5)
    except PermissionError:
        raise
    except Exception:
        wlan_ip_raw = None

    wlan_ip = None
    if wlan_ip_raw:
        wlan_ip = wlan_ip_raw.split("/", 1)[0].strip()
    if not wlan_ip:
        wlan_ip = get_iface_ip(WIFI_INTERFACE)

    ip_is_ap = bool(wlan_ip and _ip_is_ap_subnet(wlan_ip))
    wifi_connected = bool(
        wifi_state_connected
        and active_connection
        and active_connection != AP_CONNECTION_ID
        and not ip_is_ap
    )
    wifi_ip: Optional[str] = wlan_ip if wlan_ip and not ip_is_ap else None

    ssid: Optional[str] = None
    if active_connection:
        if active_connection == AP_CONNECTION_ID:
            ssid = AP_DEFAULT_SSID
        else:
            ssid = _connection_ssid(active_connection) or _current_wifi_ssid() or active_connection

    if not ssid and ap_active:
        ssid = AP_DEFAULT_SSID
    elif not ssid and not wifi_connected:
        ssid = _current_wifi_ssid()

    if wifi_connected:
        ap_active = False

    ap_service_active = _systemctl_is_active("bascula-ap-ensure.service")
    if ap_service_active is True and not wifi_connected:
        ap_active = True

    ip_address: Optional[str] = None
    if eth_ip:
        ip_address = eth_ip
    elif wifi_ip:
        ip_address = wifi_ip
    elif ap_active and wlan_ip:
        ip_address = wlan_ip

    internet_available = connectivity == "full"
    ethernet_has_ip = bool(eth_ip and ethernet_active)

    offline_mode_enabled = _resolve_offline_mode(config)

    effective_mode = _determine_effective_mode(
        ethernet_connected=bool(ethernet_active),
        wifi_connected=bool(wifi_connected),
        offline_mode_enabled=offline_mode_enabled,
        internet_available=internet_available,
    )

    mode = effective_mode

    has_lan_connectivity = bool(ethernet_has_ip or wifi_connected or wifi_ip)
    should_activate_ap = bool(ap_active and not has_lan_connectivity and not ethernet_active)

    status: Dict[str, Any] = {
        "ok": True,
        "mode": mode,
        "effective_mode": effective_mode,
        "wifi": {
            "connected": wifi_connected,
            "ssid": ssid,
            "ip": wifi_ip,
        },
        "connected": wifi_connected,
        "ssid": ssid,
        "ip": wlan_ip,
        "ip_address": ip_address,
        "ap_active": ap_active,
        "ethernet_connected": ethernet_active,
        "interface": WIFI_INTERFACE,
        "active_connection": active_connection,
        "should_activate_ap": should_activate_ap,
        "connectivity": connectivity,
        "saved_wifi_profiles": saved_wifi_profiles,
        "internet": internet_available,
        "online": bool(internet_available or wifi_connected or ethernet_has_ip),
        "offline_mode": offline_mode_enabled,
    }

    if ap_service_active is not None:
        status["ap_service_active"] = ap_service_active

    return status


def _schedule_reboot(delay_minutes: int = 1) -> None:
    try:
        subprocess.Popen(["/sbin/shutdown", "-r", f"+{delay_minutes}"])
        return
    except FileNotFoundError:
        try:
            subprocess.Popen(["shutdown", "-r", f"+{delay_minutes}"])
            return
        except FileNotFoundError:
            pass
    except Exception as exc:
        print(f"⚠️ No se pudo programar el reinicio: {exc}")

    try:
        subprocess.Popen(["/usr/sbin/shutdown", "-r", f"+{delay_minutes}"])
    except Exception as exc:
        print(f"⚠️ No se pudo ejecutar shutdown: {exc}")


async def init_scale() -> None:
    global scale_service
    if scale_service is not None:
        return
    try:
        scale_service = _init_scale_service()
    except Exception as exc:
        LOG_SCALE.error("Failed to start scale service: %s", exc)
        scale_service = None


async def close_scale() -> None:
    global scale_service
    if scale_service is None:
        return
    try:
        scale_service.stop()
    except Exception as exc:
        LOG_SCALE.error("Failed to stop scale service: %s", exc)
    finally:
        scale_service = None


def _coerce_timestamp(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        candidate = value.strip()
        if candidate.endswith("Z"):
            candidate = f"{candidate[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(candidate)
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    return None


def _get_cached_weight() -> Tuple[Optional[float], Optional[datetime]]:
    with _last_weight_lock:
        return _last_weight_value, _last_weight_ts


def _update_last_weight(value: Optional[float], ts: Optional[datetime]) -> None:
    global _last_weight_value, _last_weight_ts
    with _last_weight_lock:
        previous_value = _last_weight_value
        previous_ts = _last_weight_ts
        if previous_value == value and previous_ts == ts:
            return
        _last_weight_value = value
        _last_weight_ts = ts
    LOG_SCALE.info(
        "[scale] last_weight updated: value=%s ts=%s",
        value,
        ts.isoformat() if ts else None,
    )


def _extract_weight_payload(data: Dict[str, Any]) -> Tuple[Optional[float], Optional[datetime]]:
    raw_value = data.get("grams")
    if raw_value is None:
        raw_value = data.get("weight")

    try:
        numeric_value = float(raw_value) if raw_value is not None else None
    except (TypeError, ValueError):
        numeric_value = None

    ts_value = _coerce_timestamp(data.get("ts"))
    return numeric_value, ts_value


def _read_scale_snapshot() -> Tuple[Dict[str, Any], Optional[float], Optional[datetime]]:
    service = _get_scale_service()
    if service is None or not hasattr(service, "get_reading"):
        cached_value, cached_ts = _get_cached_weight()
        return {"ok": False, "reason": "service_not_initialized"}, cached_value, cached_ts

    try:
        raw = service.get_reading()
    except Exception as exc:  # pragma: no cover - defensive
        LOG_SCALE.error("Failed to get scale reading: %s", exc)
        cached_value, cached_ts = _get_cached_weight()
        return {"ok": False, "reason": "exception"}, cached_value, cached_ts

    data: Dict[str, Any] = raw if isinstance(raw, dict) else {}
    value, ts_value = _extract_weight_payload(data)

    if data.get("ok"):
        if ts_value is None:
            ts_value = datetime.now(timezone.utc)
        _update_last_weight(value, ts_value)
        if ts_value and "ts" not in data:
            data["ts"] = ts_value.isoformat()
        return data, value, ts_value

    cached_value, cached_ts = _get_cached_weight()
    if value is None:
        value = cached_value
    if ts_value is None:
        ts_value = cached_ts
    return data, value, ts_value


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Solo levantar AP en frío si procede
    try:
        _bring_up_ap(debounce_sec=30.0)
    except Exception as exc:
        LOG_SCALE.warning("No se pudo activar AP en arranque: %s", exc)

    await init_scale()
    yield
    await close_scale()


app = FastAPI(lifespan=lifespan)

# CORS abierto (LAN)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

init_wake_if_enabled(app)

app.include_router(voice_router)
app.include_router(camera_router)
app.include_router(wake_router)


@app.get("/health")
async def health() -> Dict[str, bool]:
    return {"ok": True}

@app.get("/api/scale/status")
async def api_scale_status():
    service = _get_scale_service()
    if service is None:
        config = _load_config()
        backend = str(config.get("scale_backend", "uart")).strip().lower()
        if backend not in {"gpio", "uart"}:
            backend = "uart"
        return {"ok": False, "backend": backend, "reason": "service_not_initialized"}
    status = dict(service.get_status())
    if "backend" not in status:
        status["backend"] = (
            "gpio"
            if _HX711_AVAILABLE and HX711Service is not None and isinstance(service, HX711Service)
            else "uart"
        )
    return status


@app.get("/api/scale/read")
async def api_scale_read():
    data, _, _ = _read_scale_snapshot()
    return data


@app.get("/api/scale/weight")
async def api_scale_weight():
    _, value, ts_value = _read_scale_snapshot()
    if value is None and ts_value is None:
        value, ts_value = _get_cached_weight()
    ts_str = ts_value.isoformat() if ts_value else None
    return {"value": value, "ts": ts_str}


@app.get("/api/scale/events")
async def api_scale_events(request: Request) -> StreamingResponse:
    client_host = request.client.host if request.client else "unknown"

    async def event_stream() -> AsyncGenerator[str, None]:
        LOG_SCALE.info("[sse] client connected: %s", client_host)
        last_sent_value: Optional[float] = None
        has_sent_initial = False
        last_emit = 0.0
        last_keepalive = time.monotonic()
        hysteresis = 10.0  # 10 g ≈ 0.01 kg
        min_interval = 0.15

        try:
            while True:
                if await request.is_disconnected():
                    break

                _, value, ts_value = _read_scale_snapshot()
                ts_str = ts_value.isoformat() if ts_value else None
                now = time.monotonic()

                should_emit = False
                if not has_sent_initial:
                    should_emit = True
                elif value is None:
                    should_emit = last_sent_value is not None
                elif last_sent_value is None:
                    should_emit = True
                else:
                    should_emit = abs(value - last_sent_value) >= hysteresis

                if should_emit and now - last_emit >= min_interval:
                    payload = json.dumps({"value": value, "ts": ts_str})
                    yield "event: weight\n"
                    yield f"data: {payload}\n\n"
                    last_sent_value = value
                    has_sent_initial = True
                    last_emit = now
                    last_keepalive = now
                elif now - last_keepalive >= 1.0:
                    yield ": keep-alive\n\n"
                    last_keepalive = now

                await asyncio.sleep(0.1)
        except asyncio.CancelledError:  # pragma: no cover - stream cancelled by client
            pass
        finally:
            LOG_SCALE.info("[sse] client disconnected: %s", client_host)

    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)


@app.post("/api/scale/tare")
async def api_scale_tare():
    service = _get_scale_service()
    if service is None:
        LOG_SCALE.info("Tare stub response (no scale service configured)")
        return {"ok": True}
    result = service.tare()
    if result.get("ok"):
        LOG_SCALE.info("Tare command processed: offset=%s", result.get("tare_offset"))
    else:
        LOG_SCALE.warning("Tare command failed: %s", result.get("reason"))
    return result


@app.post("/api/scale/calibrate")
async def api_scale_calibrate(payload: CalibrationPayload):
    service = _get_scale_service()
    if service is None:
        return {"ok": False, "reason": "service_not_initialized"}
    result = service.calibrate(payload.known_grams)
    if result.get("ok"):
        LOG_SCALE.info(
            "Calibration updated via API: factor=%s tare=%s",
            result.get("calibration_factor"),
            result.get("tare_offset"),
        )
    else:
        LOG_SCALE.warning("Calibration failed: %s", result.get("reason"))
    return result


@app.post("/api/scale/calibrate/apply")
async def api_scale_calibrate_apply(payload: CalibrationApplyPayload):
    service = _get_scale_service()
    if service is None:
        LOG_SCALE.info("Calibration apply stub response (no scale service configured)")
        return {"ok": True}

    calibrate_method = getattr(service, "calibrate_apply", None)
    if callable(calibrate_method):
        result = calibrate_method(payload.reference_grams)
    else:
        result = service.calibrate(payload.reference_grams)

    if result.get("ok"):
        LOG_SCALE.info(
            "Calibration apply processed: factor=%s",
            result.get("calibration_factor"),
        )
    else:
        LOG_SCALE.warning("Calibration apply failed: %s", result.get("reason"))
    return result


@app.get("/api/ota/check")
async def api_ota_check():
    return ota_check_for_updates()


@app.post("/api/ota/apply")
async def api_ota_apply(payload: OTAApplyPayload | None = None):
    target = (payload.target or "").strip() if payload else ""
    target_value = target or None
    state = _get_ota_state()
    if state.get("status") == "running":
        return JSONResponse({"reason": "busy"}, status_code=409)

    if not _start_ota_worker(target_value):
        return JSONResponse({"reason": "busy"}, status_code=409)

    LOG_OTA.info("[ota] apply solicitado (target=%s)", target_value or "latest")
    _append_ota_log(f"[ota] apply solicitado target={target_value or 'latest'}")
    return {"ok": True, "job": "ota"}


@app.get("/api/ota/status")
async def api_ota_status():
    return _get_ota_state()


@app.get("/api/ota/logs")
async def api_ota_logs(lines: int = 400):
    try:
        line_count = int(lines)
    except (TypeError, ValueError):
        line_count = 400
    line_count = max(1, min(line_count, 2000))
    text = _tail_file(OTA_LOG_PATH, line_count)
    return PlainTextResponse(text)


@app.get("/api/ota/events")
async def api_ota_events(request: Request) -> StreamingResponse:
    async def event_stream() -> AsyncGenerator[str, None]:
        queue: asyncio.Queue[str] = asyncio.Queue()
        loop = asyncio.get_running_loop()
        _ota_event_manager.register(queue, loop)
        try:
            await queue.put(_format_sse("state", _get_ota_state()))
            while True:
                if await request.is_disconnected():
                    break
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=5.0)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                yield message
        finally:
            _ota_event_manager.unregister(queue)

    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)


# ---------- Static SPA ----------
if DIST_DIR.exists():
    assets_dir = DIST_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/manifest.json", response_class=FileResponse)
    async def manifest():
        return DIST_DIR / "manifest.json"

    @app.get("/service-worker.js", response_class=FileResponse)
    async def service_worker():
        return DIST_DIR / "service-worker.js"

    @app.get("/favicon.ico", response_class=FileResponse)
    async def favicon():
        return DIST_DIR / "favicon.ico"

    @app.get("/icon-192.png", response_class=FileResponse)
    async def icon_192():
        return DIST_DIR / "icon-192.png"

    @app.get("/icon-512.png", response_class=FileResponse)
    async def icon_512():
        return DIST_DIR / "icon-512.png"

    @app.get("/robots.txt", response_class=FileResponse)
    async def robots():
        return DIST_DIR / "robots.txt"

    @app.get("/", response_class=FileResponse)
    async def root_index():
        return DIST_DIR / "index.html"

    @app.get("/config", response_class=FileResponse)
    async def config_index():
        return DIST_DIR / "index.html"


class PinVerification(BaseModel):
    pin: str


class WifiCredentials(BaseModel):
    ssid: str
    password: Optional[str] = None
    secured: Optional[bool] = None
    open: Optional[bool] = None
    sec: Optional[str] = None
    pin: Optional[str] = None


class NetworkConnectRequest(BaseModel):
    ssid: str
    psk: Optional[str] = None
    open: Optional[bool] = None
    pin: Optional[str] = None


class OpenAISettingsPayload(BaseModel):
    apiKey: Optional[str] = None


class NightscoutSettingsPayload(BaseModel):
    url: Optional[str] = None
    token: Optional[str] = None


class SettingsTestOpenAI(BaseModel):
    apiKey: Optional[str] = None
    pin: Optional[str] = None


class SettingsTestNightscout(BaseModel):
    url: Optional[str] = None
    token: Optional[str] = None
    pin: Optional[str] = None


class SettingsUpdatePayload(BaseModel):
    pin: Optional[str] = None
    openai: Optional[OpenAISettingsPayload] = None
    nightscout: Optional[NightscoutSettingsPayload] = None
    ui: Optional[Dict[str, Any]] = None
    tts: Optional[Dict[str, Any]] = None
    scale: Optional[Dict[str, Any]] = None
    serial: Optional[Dict[str, Any]] = None
    integrations: Optional[Dict[str, Any]] = None
    network: Optional[Dict[str, Any]] = None
    openai_api_key: Optional[str] = None
    nightscout_url: Optional[str] = None
    nightscout_token: Optional[str] = None


# ---------- PIN persistente ----------
CURRENT_PIN = _get_or_create_pin()

# Rate limit básico en memoria (por IP)
FAILED_ATTEMPTS: Dict[str, List[datetime]] = {}
MAX_ATTEMPTS = 10
WINDOW = timedelta(minutes=10)


def _check_rate_limit(ip: str):
    now = datetime.utcnow()
    history = FAILED_ATTEMPTS.get(ip, [])
    history = [t for t in history if now - t <= WINDOW]
    FAILED_ATTEMPTS[ip] = history
    if len(history) >= MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="Too many attempts, try later")


def _register_fail(ip: str):
    FAILED_ATTEMPTS.setdefault(ip, []).append(datetime.utcnow())


def _clear_failures(ip: str):
    if ip in FAILED_ATTEMPTS:
        FAILED_ATTEMPTS.pop(ip, None)


def _ensure_pin_valid_for_request(request: Request, provided_pin: Optional[str]) -> None:
    client_host = _extract_client_host(request)
    if _is_trusted_client(client_host):
        return

    pin = (provided_pin or "").strip()
    if not pin:
        auth_header = request.headers.get("Authorization", "") if hasattr(request, "headers") else ""
        if isinstance(auth_header, str) and auth_header.lower().startswith("basculapin "):
            pin = auth_header.split(" ", 1)[1].strip()
    if not pin:
        raise HTTPException(
            status_code=403,
            detail={"code": "pin_required", "message": "PIN requerido para cambios remotos"},
        )

    ip_key = client_host or "unknown"
    _check_rate_limit(ip_key)
    if pin != CURRENT_PIN:
        _register_fail(ip_key)
        raise HTTPException(
            status_code=403,
            detail={"code": "invalid_pin", "message": "PIN incorrecto"},
        )

    _clear_failures(ip_key)


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/api/miniweb/pin")
async def get_pin(request: Request):
    client_host = _extract_client_host(request)
    if _allow_pin_disclosure(client_host):
        return {"pin": CURRENT_PIN}
    raise HTTPException(status_code=403, detail="Not allowed")


@app.post("/api/miniweb/verify-pin")
async def verify_pin(data: PinVerification, request: Request):
    client_host = _extract_client_host(request)
    ip = client_host or "unknown"
    _check_rate_limit(ip)
    pin = (data.pin or "").strip()
    if pin == CURRENT_PIN:
        _clear_failures(ip)
        return {"success": True}
    _register_fail(ip)
    raise HTTPException(status_code=403, detail="Invalid PIN")


@app.get("/api/settings")
async def get_settings():
    """Get current settings without secrets"""
    config = _load_config()
    return _build_settings_payload(config)


@app.options("/api/settings")
async def options_settings() -> Response:
    allowed = "GET, POST, OPTIONS"
    response = Response(status_code=204)
    response.headers["Allow"] = allowed
    response.headers["Access-Control-Allow-Methods"] = allowed
    response.headers["Access-Control-Allow-Headers"] = "*"
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Vary"] = "Origin"
    return response


@app.post("/api/settings")
async def update_settings(payload: SettingsUpdatePayload, request: Request):
    """Update settings and broadcast changes via WebSocket"""
    client_host = _extract_client_host(request)
    trusted_client = _is_trusted_client(client_host)
    try:
        raw_payload = payload.dict(exclude_unset=True)  # type: ignore[attr-defined]
    except Exception:
        raw_payload = payload.dict() if hasattr(payload, "dict") else {}

    requires_pin = any(
        getattr(payload, field) is not None
        for field in ("openai", "nightscout", "ui", "tts", "scale", "serial", "integrations", "network")
    )
    if not requires_pin:
        network_payload = raw_payload.get("network") if isinstance(raw_payload, dict) else None
        diabetes_payload = raw_payload.get("diabetes") if isinstance(raw_payload, dict) else None
        if (
            "openai_api_key" in raw_payload
            or (isinstance(network_payload, dict) and "openai_api_key" in network_payload)
            or "nightscout_url" in raw_payload
            or "nightscout_token" in raw_payload
            or (isinstance(diabetes_payload, dict) and any(key in diabetes_payload for key in ("nightscout_url", "nightscout_token")))
        ):
            requires_pin = True
    if requires_pin or (payload.pin is not None and not trusted_client):
        _ensure_pin_valid_for_request(request, payload.pin)

    requested_fields = [
        field
        for field in ("openai", "nightscout", "ui", "tts", "scale", "serial", "integrations", "network")
        if getattr(payload, field) is not None
    ]
    if "openai_api_key" in raw_payload or (
        isinstance(raw_payload.get("network"), dict) and "openai_api_key" in raw_payload["network"]
    ):
        if "openai" not in requested_fields:
            requested_fields.append("openai")
    if (
        "nightscout_url" in raw_payload
        or "nightscout_token" in raw_payload
        or (
            isinstance(raw_payload.get("diabetes"), dict)
            and any(key in raw_payload["diabetes"] for key in ("nightscout_url", "nightscout_token"))
        )
        or (
            isinstance(raw_payload.get("nightscout"), dict)
            and ("url" in raw_payload["nightscout"] or "token" in raw_payload["nightscout"])
        )
    ):
        if "nightscout" not in requested_fields:
            requested_fields.append("nightscout")
    if requested_fields:
        _log_settings_event(
            "settings.request",
            fields=requested_fields,
            client=client_host,
            trusted=trusted_client,
        )

    service = get_settings_service(CONFIG_PATH)
    config = _load_config()
    updates: Dict[str, Any] = {}
    changed_sections: Set[str] = set()
    change_metadata: Dict[str, Any] = {}
    changed = False
    previous_offline_mode = _resolve_offline_mode(config)
    offline_mode_changed = False

    OPENAI_SENTINEL = object()
    openai_candidate = OPENAI_SENTINEL
    openai_section = raw_payload.get("openai")
    if isinstance(openai_section, dict) and "apiKey" in openai_section:
        openai_candidate = openai_section.get("apiKey")
    elif isinstance(raw_payload.get("network"), dict) and "openai_api_key" in raw_payload["network"]:
        openai_candidate = raw_payload["network"].get("openai_api_key")
    elif "openai_api_key" in raw_payload:
        openai_candidate = raw_payload.get("openai_api_key")

    if openai_candidate is not OPENAI_SENTINEL:
        if openai_candidate == "__stored__":
            api_key = _extract_openai_api_key(config)
        elif openai_candidate is None:
            api_key = ""
        else:
            api_key = str(openai_candidate).strip()

        current_key = _extract_openai_api_key(config)
        if current_key != api_key:
            changed_sections.add("openai")
            change_metadata["openai_has_key"] = bool(api_key)
            changed = True

        network_cfg = config.get("network")
        if not isinstance(network_cfg, dict):
            network_cfg = {}
        network_cfg["openai_api_key"] = api_key
        config["network"] = network_cfg

        network_updates = updates.get("network")
        if not isinstance(network_updates, dict):
            network_updates = {}
        network_updates["openai_api_key"] = api_key
        updates["network"] = network_updates

        config["openai_api_key"] = api_key
        integrations = config.get("integrations")
        if not isinstance(integrations, dict):
            integrations = {}
        integrations["openai_api_key"] = api_key
        integrations["chatgpt_api_key"] = api_key
        config["integrations"] = integrations

    NS_SENTINEL = object()
    nightscout_url_candidate = NS_SENTINEL
    nightscout_token_candidate = NS_SENTINEL

    nightscout_section = raw_payload.get("nightscout")
    if isinstance(nightscout_section, dict):
        if "url" in nightscout_section:
            nightscout_url_candidate = nightscout_section.get("url")
        if "token" in nightscout_section:
            nightscout_token_candidate = nightscout_section.get("token")

    diabetes_section = raw_payload.get("diabetes")
    if isinstance(diabetes_section, dict):
        if nightscout_url_candidate is NS_SENTINEL and "nightscout_url" in diabetes_section:
            nightscout_url_candidate = diabetes_section.get("nightscout_url")
        if nightscout_token_candidate is NS_SENTINEL and "nightscout_token" in diabetes_section:
            nightscout_token_candidate = diabetes_section.get("nightscout_token")

    if nightscout_url_candidate is NS_SENTINEL and "nightscout_url" in raw_payload:
        nightscout_url_candidate = raw_payload.get("nightscout_url")
    if nightscout_token_candidate is NS_SENTINEL and "nightscout_token" in raw_payload:
        nightscout_token_candidate = raw_payload.get("nightscout_token")

    nightscout_provided = (
        nightscout_url_candidate is not NS_SENTINEL or nightscout_token_candidate is not NS_SENTINEL
    )

    if nightscout_provided:
        current_url, current_token = _extract_nightscout_credentials(config)
        url = current_url
        token = current_token

        if nightscout_url_candidate is not NS_SENTINEL:
            if nightscout_url_candidate == "__stored__":
                url = current_url
            else:
                candidate_url = str(nightscout_url_candidate or "").strip()
                if candidate_url:
                    try:
                        url = _normalize_http_url(candidate_url)
                    except ValueError:
                        _log_settings_event(
                            "settings.validation_failed",
                            field="nightscout.url",
                            reason="invalid_http_url",
                            attempted_value=candidate_url,
                        )
                        raise HTTPException(
                            status_code=422,
                            detail={"code": "invalid_url", "field": "nightscout.url"},
                        )
                else:
                    url = ""

        if nightscout_token_candidate is not NS_SENTINEL:
            if nightscout_token_candidate == "__stored__":
                token = current_token
            elif nightscout_token_candidate is None:
                token = ""
            else:
                token = str(nightscout_token_candidate).strip()

        if url != current_url or token != current_token:
            changed_sections.add("nightscout")
            change_metadata["nightscout_url"] = url
            change_metadata["nightscout_has_token"] = bool(token)
            changed = True

        diabetes_updates = updates.get("diabetes")
        if not isinstance(diabetes_updates, dict):
            diabetes_updates = {}
        diabetes_updates["nightscout_url"] = url
        diabetes_updates["nightscout_token"] = token
        diabetes_updates["diabetes_enabled"] = bool(url)
        updates["diabetes"] = diabetes_updates

        config["nightscout_url"] = url
        config["nightscout_token"] = token

        nightscout_cfg = config.get("nightscout")
        if not isinstance(nightscout_cfg, dict):
            nightscout_cfg = {}
        nightscout_cfg["url"] = url
        nightscout_cfg["token"] = token
        config["nightscout"] = nightscout_cfg

        diabetes_cfg = config.get("diabetes")
        if not isinstance(diabetes_cfg, dict):
            diabetes_cfg = {}
        diabetes_cfg["ns_url"] = url
        diabetes_cfg["ns_token"] = token
        diabetes_cfg["diabetes_enabled"] = bool(url)
        config["diabetes"] = diabetes_cfg

        integrations_cfg = config.get("integrations")
        if not isinstance(integrations_cfg, dict):
            integrations_cfg = {}
        integrations_cfg["nightscout_url"] = url
        integrations_cfg["nightscout_token"] = token
        config["integrations"] = integrations_cfg

    if payload.ui:
        ui_cfg = config.get("ui", {})
        if not isinstance(ui_cfg, dict):
            ui_cfg = {}
        
        section_changed = False
        flags_updates = payload.ui.get("flags") if isinstance(payload.ui, dict) else None
        if isinstance(flags_updates, dict):
            existing_flags = ui_cfg.get("flags", {})
            if not isinstance(existing_flags, dict):
                existing_flags = {}
            for key, value in flags_updates.items():
                key_str = str(key)
                normalized = bool(value)
                if existing_flags.get(key_str) != normalized:
                    section_changed = True
                existing_flags[key_str] = normalized
            ui_cfg["flags"] = existing_flags
        
        if isinstance(payload.ui, dict):
            for key, value in payload.ui.items():
                if key == "flags":
                    continue
                if key == "offline_mode":
                    if isinstance(value, bool):
                        normalized_offline = value
                    elif isinstance(value, (int, float)):
                        normalized_offline = bool(value)
                    elif isinstance(value, str):
                        normalized_offline = value.strip().lower() in {"1", "true", "yes", "on"}
                    else:
                        normalized_offline = False
                    if ui_cfg.get("offline_mode") != normalized_offline:
                        section_changed = True
                        if normalized_offline != previous_offline_mode:
                            change_metadata["offline_mode"] = normalized_offline
                        offline_mode_changed = offline_mode_changed or (
                            normalized_offline != previous_offline_mode
                        )
                    ui_cfg["offline_mode"] = normalized_offline
                    continue
                if ui_cfg.get(key) != value:
                    section_changed = True
                ui_cfg[key] = value

        if section_changed:
            changed_sections.add("ui")
            updates["ui"] = ui_cfg
            changed = True
        config["ui"] = ui_cfg

    if payload.tts and isinstance(payload.tts, dict):
        existing_tts = config.get("tts") if isinstance(config.get("tts"), dict) else {}
        section_changed = False
        for key, value in payload.tts.items():
            if existing_tts.get(key) != value:
                section_changed = True
            existing_tts[key] = value
        if section_changed:
            changed = True
            changed_sections.add("tts")
        config["tts"] = existing_tts

    if payload.scale and isinstance(payload.scale, dict):
        existing_scale = config.get("scale") if isinstance(config.get("scale"), dict) else {}
        section_changed = False
        for key, value in payload.scale.items():
            if existing_scale.get(key) != value:
                section_changed = True
            existing_scale[key] = value
        if section_changed:
            changed = True
            changed_sections.add("scale")
        config["scale"] = existing_scale

    if payload.serial and isinstance(payload.serial, dict):
        section_changed = False
        device = payload.serial.get("device")
        if isinstance(device, str):
            new_device = device.strip()
            if new_device and new_device != config.get("serial_device"):
                config["serial_device"] = new_device
                section_changed = True
        baud = payload.serial.get("baud")
        if baud is not None:
            try:
                new_baud = int(baud)
                if new_baud != config.get("serial_baud"):
                    config["serial_baud"] = new_baud
                    section_changed = True
            except (TypeError, ValueError):
                pass
        if section_changed:
            changed = True
            changed_sections.add("serial")

    if payload.integrations and isinstance(payload.integrations, dict):
        current_integrations = config.get("integrations")
        if not isinstance(current_integrations, dict):
            current_integrations = {}
        section_changed = False
        for key, value in payload.integrations.items():
            if current_integrations.get(key) != value:
                section_changed = True
            current_integrations[key] = value
        if section_changed:
            changed = True
            changed_sections.add("integrations")
        config["integrations"] = current_integrations

    if changed:
        _save_json(CONFIG_PATH, config)
        if offline_mode_changed:
            _emit_network_status_update(config)
        _apply_settings_changes(list(changed_sections), **change_metadata)
        
        # Broadcast cambios via WebSocket (fire and forget)
        asyncio.create_task(_broadcast_settings_change(changed_sections, change_metadata))
    elif requested_fields:
        _log_settings_event(
            "settings.no_change",
            fields=requested_fields,
            client=client_host,
            trusted=trusted_client,
        )

    return _build_settings_payload(config)


@app.get("/api/settings/health")
async def settings_health():
    service = get_settings_service(CONFIG_PATH)
    try:
        settings = service.load()
        meta = getattr(settings, "meta", None)
        version = int(getattr(meta, "version", 0)) if meta is not None else 0
        updated_at = getattr(meta, "updated_at", None) if meta is not None else None
    except Exception as exc:
        return JSONResponse(status_code=500, content={"ok": False, "message": str(exc)})

    config_path = CONFIG_PATH
    config_dir = config_path.parent
    dir_exists = config_dir.exists()
    file_exists = config_path.exists()

    can_read = False
    can_write = False

    try:
        if file_exists:
            can_read = os.access(config_path, os.R_OK)
            can_write = os.access(config_path, os.W_OK)
        else:
            can_read = dir_exists and os.access(config_dir, os.R_OK)
            can_write = dir_exists and os.access(config_dir, os.W_OK)
    except Exception:
        can_read = False
        can_write = False

    return {
        "ok": True,
        "version": version,
        "updated_at": updated_at,
        "can_read": bool(can_read),
        "can_write": bool(can_write),
    }


async def _broadcast_settings_change(changed_fields: Set[str], metadata: Dict[str, Any]) -> None:
    """Broadcast settings changes to all connected WebSocket clients"""
    if not _settings_ws_connections:
        return
    
    config = _load_config()
    payload_data = _build_settings_payload(config)
    version = payload_data.get("meta", {}).get("version", 0) if isinstance(payload_data.get("meta"), dict) else 0
    
    message = json.dumps({
        "type": "settings.changed",
        "version": version,
        "fields": list(changed_fields),
        "metadata": metadata,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
    
    disconnected: List[WebSocket] = []
    
    with _settings_ws_lock:
        for ws in list(_settings_ws_connections):
            try:
                await ws.send_text(message)
            except Exception:
                disconnected.append(ws)
        
        for ws in disconnected:
            _settings_ws_connections.discard(ws)


@app.websocket("/ws/updates")
async def websocket_settings_updates(websocket: WebSocket):
    """WebSocket endpoint for real-time settings synchronization"""
    await websocket.accept()
    
    with _settings_ws_lock:
        _settings_ws_connections.add(websocket)
    
    try:
        config = _load_config()
        initial_settings = _build_settings_payload(config)
        await websocket.send_json({
            "type": "settings.initial",
            "data": initial_settings,
        })
        
        while True:
            try:
                message = await websocket.receive_text()
                if message == "ping":
                    await websocket.send_text("pong")
            except WebSocketDisconnect:
                break
            except Exception:
                break
    finally:
        with _settings_ws_lock:
            _settings_ws_connections.discard(websocket)


@app.post("/api/settings/test/openai")
async def settings_test_openai(payload: SettingsTestOpenAI, request: Request):
    _ensure_pin_valid_for_request(request, payload.pin)
    config = _load_config()
    candidate_key = (payload.apiKey or "").strip()
    api_key = candidate_key or _extract_openai_api_key(config)
    if not api_key:
        return {"ok": False, "reason": "missing_api_key"}

    headers = {"Authorization": f"Bearer {api_key}"}
    models_url = os.getenv("OPENAI_MODELS_URL", "https://api.openai.com/v1/models")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(models_url, headers=headers, params={"limit": 1})
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        payload = _response_error_payload(exc.response)
        return JSONResponse(
            status_code=exc.response.status_code,
            content={"ok": False, "reason": "http_error", "details": payload},
        )
    except httpx.RequestError as exc:
        return JSONResponse(
            status_code=502,
            content={"ok": False, "reason": "network_error", "details": str(exc)},
        )
    except Exception as exc:  # pragma: no cover - defensivo
        return JSONResponse(
            status_code=500,
            content={"ok": False, "reason": "unexpected_error", "details": str(exc)},
        )

    data = response.json()
    first_model = None
    models = data.get("data")
    if isinstance(models, list) and models:
        candidate = models[0]
        if isinstance(candidate, dict):
            first_model = candidate.get("id")

    return {"ok": True, "model": first_model}


async def _execute_nightscout_test_request(url: str, token: str) -> Tuple[int, Dict[str, Any]]:
    if not url:
        return 422, {"ok": False, "status": 422, "message": "missing_url"}

    normalized_url = url.rstrip("/")
    headers = {"API-SECRET": token} if token else {}
    endpoint = f"{normalized_url}/api/v1/status.json"

    try:
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
            response = await client.get(endpoint, headers=headers)
    except httpx.TimeoutException:
        return 504, {"ok": False, "status": 504, "message": "timeout"}
    except httpx.RequestError as exc:
        return 502, {"ok": False, "status": 502, "message": str(exc)}

    status_code = response.status_code
    try:
        payload = response.json()
    except Exception:
        payload = response.text

    if response.is_success:
        return status_code, {"ok": True, "status": status_code, "details": payload}

    return status_code, {"ok": False, "status": status_code, "details": payload, "message": "http_error"}


async def _perform_nightscout_test(
    request: Request,
    url: Optional[str],
    token: Optional[str],
    pin: Optional[str],
    *,
    source: str,
) -> Any:
    _ensure_pin_valid_for_request(request, pin)
    config = _load_config()
    current_url, current_token = _extract_nightscout_credentials(config)
    target_url = (url or current_url).strip()
    target_token = (token or current_token).strip()

    status_code, content = await _execute_nightscout_test_request(target_url, target_token)
    _log_settings_event(
        "nightscout.test",
        ok=content.get("ok", False),
        status=status_code,
        has_url=bool(target_url),
        has_token=bool(target_token),
        source=source,
    )
    if content.get("ok"):
        return content
    return JSONResponse(status_code=status_code, content=content)


@app.get("/api/nightscout/test")
async def api_nightscout_test(
    request: Request,
    url: Optional[str] = None,
    token: Optional[str] = None,
    pin: Optional[str] = None,
):
    return await _perform_nightscout_test(request, url, token, pin, source="get")


@app.post("/api/settings/test/nightscout")
async def settings_test_nightscout(payload: SettingsTestNightscout, request: Request):
    return await _perform_nightscout_test(
        request,
        payload.url,
        payload.token,
        payload.pin,
        source="legacy_post",
    )


@app.get("/api/miniweb/scan-networks")
async def scan_networks():
    try:
        nets = _list_networks()
        return {"networks": nets}
    except PermissionError as exc:
        code = str(exc)
        if code == "NMCLI_NOT_AUTHORIZED":
            raise HTTPException(status_code=403, detail={"code": code}) from exc
        if code == "NMCLI_NOT_AVAILABLE":
            raise HTTPException(status_code=503, detail={"code": code}) from exc
        raise HTTPException(status_code=400, detail={"code": code}) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/net/events")
async def net_events(request: Request):
    generator = _net_events_generator(request)
    headers = {"Cache-Control": "no-cache"}
    return StreamingResponse(generator, media_type="text/event-stream", headers=headers)


def _map_wifi_connect_failure(res: subprocess.CompletedProcess) -> tuple[int, str]:
    out = (res.stdout or "").strip().lower()
    err = (res.stderr or "").strip().lower()
    txt = f"{out}\n{err}"

    if "not authorized" in txt or "requires authorization" in txt or "not privileged" in txt:
        return 403, "NMCLI_NOT_AUTHORIZED"

    if "no network with ssid" in txt or "not found" in txt:
        return 400, "ssid_not_found"

    if "wrong password" in txt or "bad password" in txt or "secrets were required" in txt or "invalid wifi password" in txt:
        return 400, "wrong_password"

    if "timed out" in txt or "timeout" in txt:
        return 400, "timeout"

    return 400, "wifi_up_failed"


async def _handle_wifi_connect(credentials: WifiCredentials) -> Dict[str, Any]:
    ssid = credentials.ssid.strip()
    if not ssid:
        raise HTTPException(status_code=422, detail="ssid_required")

    if len(ssid.encode("utf-8")) > 32:
        raise HTTPException(status_code=422, detail="ssid_too_long")

    password_raw = credentials.password or ""
    sanitized_password = (
        password_raw.replace("\x00", "")
        .replace("\r", "")
        .replace("\n", "")
    )

    explicit_open = credentials.open
    secured_flag = credentials.secured

    if explicit_open is True:
        resolved_secured = False
    elif explicit_open is False:
        resolved_secured = True
    elif secured_flag is not None:
        resolved_secured = bool(secured_flag)
    else:
        resolved_secured = bool(sanitized_password)

    if resolved_secured:
        if not sanitized_password:
            raise HTTPException(status_code=422, detail="password_required")
        if len(sanitized_password) > 63:
            raise HTTPException(status_code=422, detail="password_too_long")
    else:
        sanitized_password = ""

    LOG_NETWORK.info("wifi_connect attempt for SSID '%s' (secured=%s)", ssid, resolved_secured)

    global _LAST_WIFI_CONNECT_REQUEST
    _LAST_WIFI_CONNECT_REQUEST = ssid

    def _emit_wifi_failed_event_from_detail(detail: Any) -> None:
        payload: Dict[str, Any] = {"ssid": ssid}
        if isinstance(detail, dict):
            code = detail.get("code")
            message = detail.get("message")
            if code:
                payload["code"] = code
            if message:
                payload["message"] = message
        elif isinstance(detail, str):
            payload["message"] = detail
        _emit_net_event("wifi_failed", payload)

    try:
        # 1. Bajar AP primero (no bloquear)
        try:
            LOG_NETWORK.info("Bringing down AP before connecting to Wi-Fi")
            await _run_nmcli_async(
                _nmcli_args("con", "down", AP_CONNECTION_ID),
                check=False,
                ok_codes={0, 10},
            )
            await _run_nmcli_async(
                _nmcli_args("con", "modify", AP_CONNECTION_ID, "connection.autoconnect", "no"),
                check=False,
                ok_codes={0, 10},
            )
        except Exception as exc:
            LOG_NETWORK.debug("Failed to disable AP (non-fatal): %s", exc)

        # 2. Crear/actualizar perfil Wi-Fi
        try:
            await _create_or_update_wifi_profile(
                ssid,
                sanitized_password if resolved_secured else None,
                resolved_secured,
            )
        except PermissionError as exc:
            code = str(exc)
            if code == "NMCLI_NOT_AVAILABLE":
                raise HTTPException(
                    status_code=503,
                    detail={"code": code, "message": "nmcli no está instalado"},
                ) from exc
            if code == "NMCLI_NOT_AUTHORIZED":
                raise HTTPException(status_code=403, detail={"code": code}) from exc
            raise HTTPException(status_code=400, detail={"code": code}) from exc
        except RuntimeError as exc:
            raise HTTPException(
                status_code=400,
                detail={"code": "wifi_profile_failed", "message": str(exc)},
            ) from exc
        except subprocess.CalledProcessError as exc:
            LOG_NETWORK.warning(
                "Fallo al preparar perfil Wi-Fi %s: rc=%s err=%r",
                ssid,
                exc.returncode,
                (exc.stderr or exc.output or "")[-400:],
            )
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "wifi_profile_failed",
                    "message": (exc.stderr or exc.output or str(exc))[:500],
                },
            ) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=503, detail="nmcli no disponible") from exc
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

        # 3. Conectar como cliente (STA) con timeout de 25s
        try:
            await _run_nmcli_async(_nmcli_args("radio", "wifi", "on"), check=False)

            LOG_NETWORK.info("Activating Wi-Fi connection '%s'", ssid)
            up_result = await _run_nmcli_async(
                _nmcli_args("con", "up", ssid),
                timeout=25,
                check=False,
            )

            if up_result.returncode != 0:
                err_msg = (up_result.stderr or up_result.stdout or "").strip().lower()

                if "secrets were required" in err_msg or "no secrets" in err_msg:
                    raise HTTPException(status_code=400, detail={"code": "wrong_password", "message": "Contraseña incorrecta"})
                if "not found" in err_msg or "unknown" in err_msg:
                    raise HTTPException(status_code=400, detail={"code": "ssid_not_found", "message": f"SSID '{ssid}' no encontrado"})
                if "timeout" in err_msg or "timed out" in err_msg:
                    raise HTTPException(status_code=504, detail={"code": "timeout", "message": "Timeout al conectar"})

                raise HTTPException(status_code=400, detail={"code": "connection_failed", "message": err_msg[:200]})

        except HTTPException:
            raise
        except FileNotFoundError as exc:
            raise HTTPException(status_code=503, detail="nmcli no disponible") from exc
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

        # 4. Verificar asociación y conexión activa
        try:
            dev_check = await _run_nmcli_async(
                _nmcli_args("-t", "-f", "DEVICE,STATE,CONNECTION", "dev"),
                timeout=5,
                check=False,
            )

            associated = False
            for line in (dev_check.stdout or "").splitlines():
                parts = line.split(":")
                if len(parts) >= 3:
                    device, state, connection = parts[0], parts[1], parts[2]
                    if device == WIFI_INTERFACE and state.lower() == "connected" and connection.strip():
                        associated = True
                        break

            if not associated:
                raise HTTPException(status_code=400, detail={"code": "not_associated", "message": "No se pudo asociar con la red"})

            ssid_check = await _run_nmcli_async(
                _nmcli_args("-t", "-g", "GENERAL.CONNECTION", "dev", "show", WIFI_INTERFACE),
                timeout=5,
                check=False,
            )

            active_ssid = (ssid_check.stdout or "").strip()
            if not active_ssid or active_ssid == "--" or active_ssid == AP_CONNECTION_ID:
                raise HTTPException(status_code=400, detail={"code": "association_failed", "message": "Asociación fallida"})

            LOG_NETWORK.info("associated ssid=%s", active_ssid)

        except HTTPException:
            raise
        except Exception as exc:
            LOG_NETWORK.warning("Error verificando asociación: %s", exc)
            raise HTTPException(status_code=500, detail=str(exc)) from exc

        # 5. Confirmar IP real en wlan0
        ip_address = await _wait_for_wifi_ip(timeout=15.0)
        if not ip_address:
            raise HTTPException(
                status_code=504,
                detail={"code": "ip_not_assigned", "message": "No se obtuvo una IP válida de la red"},
            )

        if _ip_is_ap_subnet(ip_address):
            raise HTTPException(
                status_code=400,
                detail={"code": "ap_ip_detected", "message": "La IP obtenida pertenece al modo AP"},
            )

        LOG_NETWORK.info("Wi-Fi connected with IP %s", ip_address)

        # 6. Asegurar AP apagado y reiniciar kiosk
        await _run_command_ignore_errors("systemctl", "stop", "bascula-ap-ensure.service")

        try:
            await _run_nmcli_async(
                _nmcli_args("con", "down", AP_CONNECTION_ID),
                check=False,
                ok_codes={0, 10},
            )
        except Exception as exc:
            LOG_NETWORK.debug("No se pudo bajar el perfil %s: %s", AP_CONNECTION_ID, exc)

        try:
            await _run_nmcli_async(
                _nmcli_args("con", "down", AP_DEFAULT_SSID),
                check=False,
                ok_codes={0, 10},
            )
        except Exception as exc:
            LOG_NETWORK.debug("No se pudo bajar el perfil %s: %s", AP_DEFAULT_SSID, exc)

        await _run_command_ignore_errors("systemctl", "restart", "bascula-ui.service")

        payload = {"ssid": ssid, "ip": ip_address}
        _emit_net_event("wifi_connected", payload)

        return {
            "ok": True,
            "success": True,
            "connected": True,
            "ssid": ssid,
            "ip": ip_address,
            "ap_active": False,
            "message": f"Conectado a '{ssid}' exitosamente",
        }

    except HTTPException as exc:
        _emit_wifi_failed_event_from_detail(exc.detail)
        raise
    except Exception as exc:
        LOG_NETWORK.warning("wifi_connect unexpected error for %s: %s", ssid, exc)
        _emit_net_event("wifi_failed", {"ssid": ssid, "error": str(exc)})
        raise
    finally:
        _LAST_WIFI_CONNECT_REQUEST = None
        _emit_network_status_update()


@app.post("/api/miniweb/connect")
@app.post("/api/miniweb/connect-wifi")
async def connect_wifi(credentials: WifiCredentials, request: Request):
    _ensure_pin_valid_for_request(request, credentials.pin)
    return await _handle_wifi_connect(credentials)


@app.post("/api/network/connect")
async def network_connect(payload: NetworkConnectRequest, request: Request):
    creds = WifiCredentials(
        ssid=payload.ssid,
        password=payload.psk,
        open=payload.open,
        pin=payload.pin,
    )
    _ensure_pin_valid_for_request(request, payload.pin)
    return await _handle_wifi_connect(creds)


@app.get("/api/miniweb/status")
async def miniweb_status():
    try:
        return _get_wifi_status()
    except PermissionError as exc:
        code = str(exc)
        if code == "NMCLI_NOT_AVAILABLE":
            raise HTTPException(status_code=503, detail={"code": code}) from exc
        if code == "NMCLI_NOT_AUTHORIZED":
            raise HTTPException(status_code=403, detail={"code": code}) from exc
        raise HTTPException(status_code=400, detail={"code": code}) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/network/enable-ap")
async def enable_ap():
    try:
        prev = await _list_client_profiles_state()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail="nmcli no disponible") from exc

    try:
        await asyncio.to_thread(ensure_ap_profile)
    except PermissionError as exc:
        raise HTTPException(status_code=503, detail="nmcli no disponible") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    downed_clients: list[str] = []
    try:
        downed_clients = await _down_active_wifi_clients()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail="nmcli no disponible") from exc

    last_active_client = downed_clients[0] if downed_clients else None

    await _run_nmcli_async(
        _nmcli_args(
            "con",
            "modify",
            AP_CONNECTION_ID,
            "802-11-wireless.mode",
            "ap",
        ),
        check=False,
    )
    await _run_nmcli_async(
        _nmcli_args(
            "con",
            "modify",
            AP_CONNECTION_ID,
            "ipv4.method",
            "shared",
        ),
        check=False,
    )
    await _run_nmcli_async(
        _nmcli_args(
            "con",
            "modify",
            AP_CONNECTION_ID,
            "connection.interface-name",
            WIFI_INTERFACE,
        ),
        check=False,
    )
    await _run_nmcli_async(
        _nmcli_args(
            "con",
            "modify",
            AP_CONNECTION_ID,
            "connection.autoconnect",
            "no",
        ),
        check=False,
    )
    await _run_nmcli_async(
        _nmcli_args(
            "con",
            "modify",
            AP_CONNECTION_ID,
            "connection.autoconnect-priority",
            "0",
        ),
        check=False,
    )

    try:
        await _run_nmcli_async(
            _nmcli_args("con", "up", AP_CONNECTION_ID),
            check=True,
        )
        return {"ok": True}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail="nmcli no disponible") from exc
    except subprocess.CalledProcessError as e:
        restored_wifi = False
        for st in prev:
            await _run_nmcli_async(
                _nmcli_args(
                    "con",
                    "modify",
                    st.name,
                    "connection.autoconnect",
                    st.autoconnect,
                ),
                check=False,
            )
            if st.priority.isdigit():
                await _run_nmcli_async(
                    _nmcli_args(
                        "con",
                        "modify",
                        st.name,
                        "connection.autoconnect-priority",
                        st.priority,
                    ),
                    check=False,
                )
        try:
            sorted_prev = sorted(
                prev,
                key=lambda s: ((s.autoconnect == "yes"), int(s.priority or "0")),
                reverse=True,
            )
            attempted: set[str] = set()
            if last_active_client:
                attempted.add(last_active_client)
                try:
                    rc = await _run_nmcli_async(
                        _nmcli_args("con", "up", last_active_client),
                        check=False,
                    )
                    if rc.returncode == 0:
                        restored_wifi = True
                except Exception as restore_exc:
                    LOG_NETWORK.debug("Failed to restore last Wi-Fi %s: %s", last_active_client, restore_exc)
            if not restored_wifi:
                for s in sorted_prev:
                    if s.autoconnect == "yes" and s.name not in attempted:
                        rc = await _run_nmcli_async(
                            _nmcli_args("con", "up", s.name),
                            check=False,
                        )
                        if rc.returncode == 0:
                            restored_wifi = True
                            break
        except Exception:
            pass
        detail = (e.stderr or e.output or str(e))[:500]
        if restored_wifi:
            detail = f"Enable AP failed: {detail}; previous Wi-Fi restored"
        else:
            detail = f"Enable AP failed: {detail}"
        raise HTTPException(status_code=500, detail=detail)


@app.post("/api/network/disable-ap")
async def disable_ap():
    try:
        await _run_nmcli_async(
            _nmcli_args("con", "down", AP_CONNECTION_ID),
            check=False,
            ok_codes={0, 10},
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail="nmcli no disponible") from exc

    return {"ok": True}

@app.get("/api/ap/info")
async def ap_info():
    ssid = _resolve_ap_ssid()
    ip = _get_iface_ip(WIFI_INTERFACE) or AP_DEFAULT_IP
    http_port = 8080
    config_path = AP_DEFAULT_CONFIG_PATH

    payload: Dict[str, Any] = {
        "ssid": ssid,
        "ip": ip,
        "httpPort": http_port,
    }
    if config_path:
        payload["configPath"] = config_path
    return payload


@app.get("/api/network/status")
async def network_status():
    eth_up = _iface_has_carrier("eth0")
    ip_eth = _get_iface_ip("eth0")
    ip_wlan = _get_iface_ip(WIFI_INTERFACE)
    status = {
        "ethernet": {"carrier": eth_up, "ip": ip_eth},
        "wifi_client": {"connected": _wifi_client_connected(), "ip": ip_wlan},
        "ap": {"active": _ap_active(), "ssid": _resolve_ap_ssid()},
    }
    best_ip = ip_eth or ip_wlan or "192.168.12.1"
    status["bascula_url"] = f"http://{best_ip}:8080"
    return status


# ====== (opcional) WebSocket y tare/zero/scale como ya estaban si aplica ======
# Mantén aquí los endpoints ya existentes de báscula...
# ==============================================================================


# ====== WebSocket de báscula + /info ======
active_ws_clients: list[WebSocket] = []


@app.get("/info")
async def miniweb_info():
    host = "127.0.0.1"
    port = 8080
    return {
        "ok": True,
        "app": "Bascula Mini-Web",
        "version": "1.0",
        "hostname": os.uname().nodename if hasattr(os, "uname") else "bascula",
        "listen": {"host": host, "port": port},
        "endpoints": {
            "health": "/health",
            "info": "/info",
            "scale_read": "/api/scale/read",
            "ws_scale": "/ws/scale",
        },
        "settings": {"wsUrl": f"ws://{host}:{port}/ws/scale"},
    }


@app.websocket("/ws/scale")
async def ws_scale(websocket: WebSocket):
    await websocket.accept()
    active_ws_clients.append(websocket)
    try:
        while True:
            svc = _get_scale_service()
            if svc is None:
                await websocket.send_json({"ok": False, "reason": "service_not_initialized"})
                await asyncio.sleep(1.0)
                continue

            data = svc.get_reading() if hasattr(svc, "get_reading") else {}
            if data.get("ok"):
                grams = data.get("grams")

                stable_value = data.get("stable", None)
                if grams is None:
                    stable_value = False
                if stable_value is None:
                    stable_value = False

                payload = {
                    "ok": True,
                    "weight": float(grams) if grams is not None else 0.0,
                    "unit": "g",
                    "stable": bool(stable_value),
                    "ts": data.get("ts", time.time()),
                }
                ts_value = _coerce_timestamp(payload.get("ts"))
                if ts_value is None:
                    ts_value = datetime.now(timezone.utc)
                _update_last_weight(payload.get("weight"), ts_value)
                await websocket.send_json(payload)
            else:
                await websocket.send_json({"ok": False, **data})

            # Ritmo de emisión (fluido)
            cfg = _load_config()
            scale_cfg = cfg.get("scale", {}) if isinstance(cfg.get("scale"), dict) else {}

            def _as_float(v, default):
                try:
                    return float(v)
                except Exception:
                    return default

            # Permitir override específico para WS
            ws_rate_hz = _as_float(scale_cfg.get("ws_rate_hz"), None)
            sample_rate_hz = _as_float(scale_cfg.get("sample_rate_hz"), 20.0)
            emit_hz = ws_rate_hz if (ws_rate_hz and ws_rate_hz > 0) else sample_rate_hz

            # Intervalo entre 0.03s (≈33 Hz) y 0.2s (5 Hz)
            interval = 1.0 / emit_hz if emit_hz > 0 else 0.1
            interval = max(0.03, min(0.2, interval))
            await asyncio.sleep(interval)

    except WebSocketDisconnect:
        if websocket in active_ws_clients:
            active_ws_clients.remove(websocket)
    except Exception as exc:
        LOG_SCALE.error("WebSocket error: %s", exc)
        if websocket in active_ws_clients:
            active_ws_clients.remove(websocket)


# Mensaje de arranque útil
def _print_boot_banner():
    ip_candidates = []
    for iface in ("wlan0", "eth0"):
        ip = _get_iface_ip(iface)
        if ip:
            ip_candidates.append(f"http://{ip}:8080")
    print("============================================================")
    print("🌐 Mini-Web Configuration Server + Scale Backend")
    if ip_candidates:
        for url in ip_candidates:
            print(f"📍 Access URL: {url}")
    else:
        print("📍 Access URL: http://<device-ip>:8080")
    print(f"🔐 Mini-Web PIN: {CURRENT_PIN}")
    print("============================================================")


_print_boot_banner()
