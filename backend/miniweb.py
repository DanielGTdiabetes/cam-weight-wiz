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
import shlex
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List, Union, Sequence, Set

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.scale_service import HX711Service
from backend.serial_scale_service import SerialScaleService

# ---------- Constantes y paths ----------
BASE_DIR = Path(__file__).resolve().parent.parent
DIST_DIR = BASE_DIR / "dist"

CFG_DIR = Path(os.getenv("BASCULA_CFG_DIR", Path.home() / ".bascula"))
PIN_PATH = CFG_DIR / "miniweb_pin"
CONFIG_PATH = CFG_DIR / "config.json"
DEFAULT_DT_PIN = 5
DEFAULT_SCK_PIN = 6
DEFAULT_SAMPLE_RATE = 20.0
DEFAULT_FILTER_WINDOW = 12
DEFAULT_CALIBRATION_FACTOR = 1.0
DEFAULT_SERIAL_DEVICE = "/dev/serial0"
DEFAULT_SERIAL_BAUD = 115200

LOG_SCALE = logging.getLogger("bascula.scale")
LOG_NETWORK = logging.getLogger("bascula.network")

NMCLI_BIN = Path("/usr/bin/nmcli")
NM_CONNECTIONS_DIR = Path("/etc/NetworkManager/system-connections")
HOME_CONNECTION_ID = "BasculaHome"
AP_CONNECTION_ID = "BasculaAP"
AP_DEFAULT_SSID = "Bascula-AP"
AP_DEFAULT_PASSWORD = "Bascula1234"
WIFI_INTERFACE = "wlan0"

CFG_DIR.mkdir(parents=True, exist_ok=True)

# ---------- Estado global ----------
ScaleServiceType = Union[HX711Service, SerialScaleService]
scale_service: Optional[ScaleServiceType] = None
_LAST_AP_ACTION_TS = 0.0
_LAST_WIFI_CONNECT_REQUEST: Optional[str] = None

# ---------- Modelos ----------
class CalibrationPayload(BaseModel):
    known_grams: float

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
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2))


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
    }


def _load_config() -> Dict[str, Any]:
    config = _load_json(CONFIG_PATH)
    if not isinstance(config, dict):
        config = {}

    defaults = _default_config()
    changed = False

    for key, value in defaults.items():
        if key == "scale":
            scale_cfg = config.get("scale")
            if not isinstance(scale_cfg, dict):
                config["scale"] = value.copy()
                changed = True
            else:
                for scale_key, scale_value in value.items():
                    if scale_key not in scale_cfg:
                        scale_cfg[scale_key] = scale_value
                        changed = True
        else:
            if key not in config:
                config[key] = value
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


def _run_nmcli_command(
    args: Sequence[str],
    *,
    check: bool = True,
    ok_codes: Set[int] | None = None,
    timeout: int = 30,
) -> subprocess.CompletedProcess:
    if not _nmcli_available():
        raise FileNotFoundError(str(NMCLI_BIN))

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


async def _run_nmcli_async(
    args: Sequence[str],
    *,
    check: bool = True,
    ok_codes: Set[int] | None = None,
    timeout: int = 30,
) -> subprocess.CompletedProcess:
    return await asyncio.to_thread(
        _run_nmcli_command,
        args,
        check=check,
        ok_codes=ok_codes,
        timeout=timeout,
    )


def _nmcli_args(*parts: str) -> list[str]:
    return [str(NMCLI_BIN), *parts]


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


async def _down_active_wifi_clients() -> None:
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
    for line in (cp.stdout or "").strip().splitlines():
        parts = line.split(":")
        if len(parts) < 4:
            continue
        name, ctype, dev, _state = parts[0], parts[1], parts[2], parts[3]
        if ctype == "802-11-wireless" and dev == WIFI_INTERFACE and name != AP_CONNECTION_ID:
            await _run_nmcli_async(
                _nmcli_args("con", "down", name),
                check=False,
                ok_codes={0, 10},
            )
    await _run_nmcli_async(
        _nmcli_args("dev", "disconnect", WIFI_INTERFACE),
        check=False,
    )


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
                await _run_nmcli_async(
                    _nmcli_args("con", "load", str(profile_path)),
                    check=False,
                )
            await asyncio.to_thread(os.chmod, profile_path, 0o600)
            await _cleanup_nmcli_duplicates(ssid, profile_path)
            return profile_path

        NM_CONNECTIONS_DIR.mkdir(parents=True, exist_ok=True)
        fallback = NM_CONNECTIONS_DIR / f"{ssid}.nmconnection"
        return fallback
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
    try:
        res = _run_nmcli_command(
            _nmcli_args("-t", "-f", "DEVICE,TYPE,STATE", "device"),
            check=False,
        )
    except Exception:
        return False
    if res.returncode != 0:
        return False
    for line in res.stdout.splitlines():
        dev, typ, st = (line.split(":") + ["", "", ""])[:3]
        if dev == WIFI_INTERFACE and typ == "wifi" and st.lower() == "connected":
            return True
    return False


def _ap_active() -> bool:
    """Check if BasculaAP is active and properly configured as AP mode."""
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


def _allow_pin_disclosure(client_host: Optional[str]) -> bool:
    if client_host in {"127.0.0.1", "::1"}:
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

    try:
        existing = _run_nmcli_command(
            _nmcli_args("con", "show", AP_CONNECTION_ID),
            timeout=5,
            check=False,
        )
        if existing.returncode == 0:
            return
    except FileNotFoundError:
        raise PermissionError("NMCLI_NOT_AVAILABLE")

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
            "autoconnect",
            "no",
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
            "802-11-wireless.mode",
            "ap",
            "802-11-wireless.band",
            "bg",
            "ipv4.method",
            "shared",
            "ipv4.addresses",
            "192.168.4.1/24",
            "ipv6.method",
            "ignore",
        ),
        timeout=10,
    )
    if modify_res.returncode != 0:
        raise RuntimeError((modify_res.stderr or modify_res.stdout).strip())

    if AP_DEFAULT_PASSWORD:
        secret_ap_res = _run_nmcli_command(
            _nmcli_args(
                "con",
                "modify",
                AP_CONNECTION_ID,
                "wifi-sec.key-mgmt",
                "wpa-psk",
                "wifi-sec.psk",
                AP_DEFAULT_PASSWORD,
            ),
            timeout=5,
        )
        if secret_ap_res.returncode != 0:
            raise RuntimeError((secret_ap_res.stderr or secret_ap_res.stdout).strip())
    else:
        open_ap_res = _run_nmcli_command(
            _nmcli_args("con", "modify", AP_CONNECTION_ID, "wifi-sec.key-mgmt", "none"),
            timeout=5,
        )
        if open_ap_res.returncode != 0:
            raise RuntimeError((open_ap_res.stderr or open_ap_res.stdout).strip())


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


def _get_wifi_status() -> Dict[str, Any]:
    eth_ip = get_iface_ip("eth0")
    ap_active = _is_ap_active()

    try:
        ethernet_active = _ethernet_connected()
    except PermissionError:
        ethernet_active = False

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
    connected = bool(
        wlan_ip
        and not ip_is_ap
        and active_connection
        and active_connection != AP_CONNECTION_ID
    )

    ssid: Optional[str] = None
    if active_connection:
        if active_connection == AP_CONNECTION_ID:
            ssid = AP_DEFAULT_SSID
        else:
            ssid = _connection_ssid(active_connection) or _current_wifi_ssid() or active_connection

    if not ssid and ap_active:
        ssid = AP_DEFAULT_SSID
    elif not ssid and not connected:
        ssid = _current_wifi_ssid()

    if connected:
        ap_active = False

    should_activate_ap = not connected and not ethernet_active
    if connected:
        should_activate_ap = False

    ip_address: Optional[str] = None
    if eth_ip:
        ip_address = eth_ip
    elif connected and wlan_ip:
        ip_address = wlan_ip
    elif ap_active and wlan_ip:
        ip_address = wlan_ip

    return {
        "connected": connected,
        "ssid": ssid,
        "ip": wlan_ip,
        "ip_address": ip_address,
        "ap_active": ap_active,
        "ethernet_connected": ethernet_active,
        "interface": WIFI_INTERFACE,
        "active_connection": active_connection,
        "should_activate_ap": False if connected else should_activate_ap,
    }


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
        status["backend"] = "gpio" if isinstance(service, HX711Service) else "uart"
    return status


@app.get("/api/scale/read")
async def api_scale_read():
    service = _get_scale_service()
    if service is None:
        return {"ok": False, "reason": "service_not_initialized"}
    return service.get_reading()


@app.post("/api/scale/tare")
async def api_scale_tare():
    service = _get_scale_service()
    if service is None:
        return {"ok": False, "reason": "service_not_initialized"}
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
    secured: bool = True
    sec: Optional[str] = None


class NetworkConnectRequest(BaseModel):
    ssid: str
    psk: str


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


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/api/miniweb/pin")
async def get_pin(request: Request):
    client_host = request.client.host if request.client else ""
    if _allow_pin_disclosure(client_host):
        return {"pin": CURRENT_PIN}
    raise HTTPException(status_code=403, detail="Not allowed")


@app.post("/api/miniweb/verify-pin")
async def verify_pin(data: PinVerification, request: Request):
    ip = request.client.host if request.client else "unknown"
    _check_rate_limit(ip)
    if data.pin == CURRENT_PIN:
        return {"success": True}
    _register_fail(ip)
    raise HTTPException(status_code=403, detail="Invalid PIN")


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


async def _handle_wifi_connect(credentials: WifiCredentials) -> Dict[str, Any]:
    ssid = credentials.ssid.strip()
    if not ssid:
        raise HTTPException(status_code=422, detail="ssid_required")

    if len(ssid.encode("utf-8")) > 32:
        raise HTTPException(status_code=422, detail="ssid_too_long")

    password_raw = credentials.password or ""
    password = password_raw.strip()

    if credentials.secured:
        if not password:
            raise HTTPException(status_code=422, detail="password_required")
        if len(password) > 63:
            raise HTTPException(status_code=422, detail="password_too_long")

    sanitized_password = password.replace("\x00", "").replace("\r", "").replace("\n", "") if password else ""

    LOG_NETWORK.info("Received connect request for SSID '%s' (secured=%s)", ssid, credentials.secured)

    global _LAST_WIFI_CONNECT_REQUEST
    _LAST_WIFI_CONNECT_REQUEST = ssid

    try:
        await _create_or_update_wifi_profile(
            ssid,
            sanitized_password if credentials.secured else None,
            credentials.secured,
        )
    except PermissionError as exc:
        _LAST_WIFI_CONNECT_REQUEST = None
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
        _LAST_WIFI_CONNECT_REQUEST = None
        raise HTTPException(status_code=400, detail={"code": "wifi_profile_failed", "message": str(exc)}) from exc
    except subprocess.CalledProcessError as exc:
        _LAST_WIFI_CONNECT_REQUEST = None
        LOG_NETWORK.warning(
            "Fallo al preparar perfil Wi-Fi %s: rc=%s err=%r", ssid, exc.returncode, (exc.stderr or exc.output or "")[-400:]
        )
        raise HTTPException(
            status_code=400,
            detail={
                "code": "wifi_profile_failed",
                "message": (exc.stderr or exc.output or str(exc))[:500],
            },
        ) from exc
    except FileNotFoundError as exc:
        _LAST_WIFI_CONNECT_REQUEST = None
        raise HTTPException(status_code=503, detail="nmcli no disponible") from exc
    except Exception as exc:
        _LAST_WIFI_CONNECT_REQUEST = None
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    ap_disabled = False
    success = False

    try:
        await _run_nmcli_async(
            _nmcli_args("con", "modify", AP_CONNECTION_ID, "connection.autoconnect", "no"),
            check=False,
            ok_codes={0, 10},
        )

        down_res = await _run_nmcli_async(
            _nmcli_args("con", "down", AP_CONNECTION_ID),
            check=False,
            ok_codes={0, 10},
        )
        if down_res.returncode in {0, 10}:
            ap_disabled = True

        await _run_nmcli_async(_nmcli_args("radio", "wifi", "on"), check=False)

        LOG_NETWORK.info("Activating Wi-Fi connection '%s'", ssid)
        await _run_nmcli_async(_nmcli_args("con", "up", ssid))

        state_check = await _run_nmcli_async(
            _nmcli_args("-t", "-f", "STATE", "g"),
            check=False,
        )
        state_txt = (state_check.stdout or "").strip()
        if state_txt:
            LOG_NETWORK.debug("NetworkManager general state: %s", state_txt)

        ok, ip_address = await _wait_for_wifi_activation(timeout_s=45.0)
        if ok and ip_address:
            if _ip_is_ap_subnet(ip_address):
                LOG_NETWORK.warning(
                    "Wi-Fi '%s' obtained AP subnet IP %s; keeping AP disabled and reporting failure",
                    ssid,
                    ip_address,
                )
                if ap_disabled:
                    await _reactivate_ap_after_failure()
                raise HTTPException(
                    status_code=502,
                    detail={
                        "code": "WIFI_IP_AP_SUBNET",
                        "message": "NetworkManager asignó una IP de la red AP (192.168.4.x).",
                        "ip": ip_address,
                    },
                )

            LOG_NETWORK.info("Wi-Fi '%s' connected with IP %s", ssid, ip_address)
            await _run_nmcli_async(
                _nmcli_args("con", "down", AP_CONNECTION_ID),
                check=False,
                ok_codes={0, 10},
            )
            try:
                await _ensure_ap_autoconnect_disabled(None)
            except PermissionError as exc:
                LOG_NETWORK.warning("Could not persist BasculaAP autoconnect=no: %s", exc)
            success = True
            try:
                await asyncio.to_thread(
                    subprocess.run,
                    ["systemctl", "restart", "bascula-app"],
                    check=False,
                )
                LOG_NETWORK.info("Servicio bascula-app reiniciado tras conexión Wi-Fi exitosa")
            except Exception as exc:
                LOG_NETWORK.debug("No se pudo reiniciar bascula-app: %s", exc)
            _LAST_WIFI_CONNECT_REQUEST = None
            return {
                "success": True,
                "connected": True,
                "ssid": ssid,
                "ip": ip_address,
                "ap_active": False,
                "message": f"Conexión Wi-Fi '{ssid}' activada",
            }

        LOG_NETWORK.warning("Timed out waiting for Wi-Fi '%s' activation", ssid)
        if ap_disabled:
            await _reactivate_ap_after_failure()
        raise HTTPException(status_code=504, detail={"code": "WIFI_ACTIVATION_TIMEOUT", "ssid": ssid})
    except HTTPException:
        raise
    except PermissionError as exc:
        if ap_disabled:
            await _reactivate_ap_after_failure()
        code = str(exc)
        if code == "NMCLI_NOT_AVAILABLE":
            raise HTTPException(
                status_code=503,
                detail={"code": code, "message": "nmcli no está instalado"},
            ) from exc
        raise HTTPException(status_code=400, detail={"code": code}) from exc
    except RuntimeError as exc:
        if ap_disabled:
            await _reactivate_ap_after_failure()
        message = str(exc)
        lower = message.lower()
        if "not authorized" in lower:
            raise HTTPException(
                status_code=403,
                detail={"code": "NMCLI_NOT_AUTHORIZED", "message": message},
            ) from exc
        if "secrets were required" in lower:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "NMCLI_SECRETS_REQUIRED",
                    "message": "NetworkManager requiere secretos adicionales (comprueba la contraseña WPA).",
                },
            ) from exc
        raise HTTPException(status_code=400, detail={"code": "wifi_up_failed", "message": message}) from exc
    except subprocess.CalledProcessError as exc:
        LOG_NETWORK.warning(
            "Fallo al conectar SSID %s: rc=%s, out=%r, err=%r",
            ssid,
            exc.returncode,
            (exc.output or "")[-500:],
            (exc.stderr or "")[-500:],
        )
        if ap_disabled:
            await _reactivate_ap_after_failure()
        raise HTTPException(
            status_code=400,
            detail={
                "code": "wifi_up_failed",
                "message": (exc.stderr or exc.output or str(exc))[:500],
            },
        ) from exc
    except FileNotFoundError as exc:
        if ap_disabled:
            await _reactivate_ap_after_failure()
        raise HTTPException(status_code=503, detail="nmcli no disponible") from exc
    except Exception as exc:
        if ap_disabled:
            await _reactivate_ap_after_failure()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        if not success:
            _LAST_WIFI_CONNECT_REQUEST = None


@app.post("/api/miniweb/connect")
@app.post("/api/miniweb/connect-wifi")
async def connect_wifi(credentials: WifiCredentials):
    return await _handle_wifi_connect(credentials)


@app.post("/api/network/connect")
async def network_connect(payload: NetworkConnectRequest):
    creds = WifiCredentials(ssid=payload.ssid, password=payload.psk, secured=True)
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

    try:
        await _down_active_wifi_clients()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail="nmcli no disponible") from exc

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
            for s in sorted_prev:
                if s.autoconnect == "yes":
                    rc = await _run_nmcli_async(
                        _nmcli_args("con", "up", s.name),
                        check=False,
                    )
                    if rc.returncode == 0:
                        break
        except Exception:
            pass
        detail = (e.stderr or e.output or str(e))[:500]
        raise HTTPException(status_code=500, detail=f"Enable AP failed: {detail}")


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

@app.get("/api/network/status")
async def network_status():
    eth_up = _iface_has_carrier("eth0")
    ip_eth = _get_iface_ip("eth0")
    ip_wlan = _get_iface_ip(WIFI_INTERFACE)
    status = {
        "ethernet": {"carrier": eth_up, "ip": ip_eth},
        "wifi_client": {"connected": _wifi_client_connected(), "ip": ip_wlan},
        "ap": {"active": _ap_active(), "ssid": AP_DEFAULT_SSID},
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
