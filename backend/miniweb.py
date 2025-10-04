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
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List, Union

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
AP_DEFAULT_PASSWORD = "bascula2025"
WIFI_INTERFACE = "wlan0"

CFG_DIR.mkdir(parents=True, exist_ok=True)

# ---------- Estado global ----------
ScaleServiceType = Union[HX711Service, SerialScaleService]
scale_service: Optional[ScaleServiceType] = None
_LAST_AP_ACTION_TS = 0.0

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


def _nmcli(args: List[str], timeout: int = 15) -> subprocess.CompletedProcess:
    if not _nmcli_available():
        raise FileNotFoundError(str(NMCLI_BIN))
    return subprocess.run([str(NMCLI_BIN), *args], capture_output=True, text=True, timeout=timeout)


async def _nmcli_async(args: list[str], timeout: int = 15) -> subprocess.CompletedProcess:
    """Run nmcli in a worker thread to avoid blocking the event loop."""
    return await asyncio.to_thread(_nmcli, args, timeout)


def _classify_nmcli_failure(res: subprocess.CompletedProcess) -> tuple[int, str, str]:
    """
    Mapea el error de nmcli a (status_http, code_api, msg_humano).
    Conserva compatibilidad con códigos previos.
    """

    out = (res.stdout or "").strip()
    err = (res.stderr or "").strip()
    txt = f"{out}\n{err}".lower()

    # Autorización / polkit
    if "not authorized" in txt or "requires authorization" in txt or "not privileged" in txt:
        return 403, "NMCLI_NOT_AUTHORIZED", "Acceso denegado por PolicyKit/NetworkManager."

    # Secretos/PSK requeridos (WPA)
    if "secrets were required" in txt or "secrets are required" in txt or "no key available" in txt:
        return 400, "NMCLI_SECRETS_REQUIRED", "La red requiere contraseña (WPA/WPA2)."

    # SSID no encontrado
    if "no network with ssid" in txt or "no suitable device found to create connection" in txt:
        return 404, "NMCLI_SSID_NOT_FOUND", "No se encontró el SSID en el escaneo."

    # Dispositivo no disponible
    if "no such device" in txt or "device not managed" in txt:
        return 500, "NM_DEVICE_UNAVAILABLE", "Interfaz Wi-Fi no disponible."

    # Ya hay conexión activa / conflicto de estado
    if "already a connection active" in txt or "connection is already active" in txt:
        return 409, "NM_ALREADY_ACTIVE", "La conexión ya está activa."

    # Tiempo de espera DHCP/IP
    if "activation failed" in txt and "dhcp" in txt:
        return 504, "NM_DHCP_TIMEOUT", "Timeout obteniendo IP por DHCP."

    # Genérico
    return 400, "WIFI_UP_FAILED", (err or out or "Fallo al activar la conexión Wi-Fi.")


def _nmcli_get_values(args: List[str], timeout: int = 5) -> List[str]:
    try:
        res = _nmcli(args, timeout=timeout)
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


def _wifi_connection_exists(connection_name: str) -> bool:
    value = _nmcli_get_first_value(["-g", "NAME", "connection", "show", connection_name], timeout=5)
    return value is not None


def _set_connection_autoconnect_value(connection_name: str, enabled: bool) -> None:
    value = "yes" if enabled else "no"
    LOG_NETWORK.info("Setting autoconnect=%s for '%s'", value, connection_name)
    res = _nmcli([
        "connection",
        "modify",
        connection_name,
        "connection.autoconnect",
        value,
    ], timeout=5)
    if res.returncode != 0:
        message = (res.stderr or res.stdout).strip()
        raise RuntimeError(message)


def _configure_wifi_security(connection_name: str, secured: bool, password: Optional[str]) -> None:
    if secured:
        LOG_NETWORK.info("Configuring WPA-PSK for '%s'", connection_name)
        res_keymgmt = _nmcli([
            "connection",
            "modify",
            connection_name,
            "802-11-wireless-security.key-mgmt",
            "wpa-psk",
        ], timeout=5)
        if res_keymgmt.returncode != 0:
            message = (res_keymgmt.stderr or res_keymgmt.stdout).strip()
            raise RuntimeError(message)
        res_psk = _nmcli([
            "connection",
            "modify",
            connection_name,
            "802-11-wireless-security.psk",
            password or "",
        ], timeout=5)
        if res_psk.returncode != 0:
            message = (res_psk.stderr or res_psk.stdout).strip()
            raise RuntimeError(message)
    else:
        LOG_NETWORK.info("Configuring open network for '%s'", connection_name)
        res_keymgmt = _nmcli([
            "connection",
            "modify",
            connection_name,
            "802-11-wireless-security.key-mgmt",
            "",
        ], timeout=5)
        if res_keymgmt.returncode != 0:
            message = (res_keymgmt.stderr or res_keymgmt.stdout).strip()
            raise RuntimeError(message)
        res_psk = _nmcli([
            "connection",
            "modify",
            connection_name,
            "802-11-wireless-security.psk",
            "",
        ], timeout=5)
        if res_psk.returncode != 0:
            message = (res_psk.stderr or res_psk.stdout).strip()
            raise RuntimeError(message)


def _ensure_wifi_profile(ssid: str, password: Optional[str], secured: bool) -> None:
    connection_exists = _wifi_connection_exists(ssid)
    LOG_NETWORK.info("%s Wi-Fi profile for '%s'", "Updating" if connection_exists else "Creating", ssid)

    if not connection_exists:
        create_res = _nmcli([
            "connection",
            "add",
            "type",
            "wifi",
            "ifname",
            WIFI_INTERFACE,
            "con-name",
            ssid,
            "ssid",
            ssid,
        ], timeout=15)
        if create_res.returncode != 0:
            message = (create_res.stderr or create_res.stdout).strip()
            raise RuntimeError(message)

    modify_base = _nmcli([
        "connection",
        "modify",
        ssid,
        "connection.interface-name",
        WIFI_INTERFACE,
        "ipv4.method",
        "auto",
        "ipv6.method",
        "ignore",
    ], timeout=10)
    if modify_base.returncode != 0:
        message = (modify_base.stderr or modify_base.stdout).strip()
        raise RuntimeError(message)

    _set_connection_autoconnect_value(ssid, True)
    _configure_wifi_security(ssid, secured, password)


async def _wait_for_wifi_activation(timeout_s: float = 45.0) -> tuple[bool, Optional[str]]:
    """Poll nmcli asynchronously until wlan0 is connected with an IPv4 address."""
    deadline = time.monotonic() + timeout_s
    attempt = 0

    while time.monotonic() < deadline:
        attempt += 1
        LOG_NETWORK.info("Polling Wi-Fi activation (attempt %s)", attempt)

        try:
            res_state = await _nmcli_async(["-g", "GENERAL.STATE", "device", "show", WIFI_INTERFACE], timeout=5)
            state_txt = (res_state.stdout or "").strip()
            state_num_txt = state_txt.split(" ", 1)[0] if state_txt else ""
            state_code = int(state_num_txt) if state_num_txt.isdigit() else None

            res_ip = await _nmcli_async(["-g", "IP4.ADDRESS", "device", "show", WIFI_INTERFACE], timeout=5)
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
        LOG_NETWORK.info("Restoring autoconnect=yes for '%s'", AP_CONNECTION_ID)
        await _nmcli_async(
            [
                "connection",
                "modify",
                AP_CONNECTION_ID,
                "connection.autoconnect",
                "yes",
            ],
            timeout=5,
        )
    except Exception as exc:
        LOG_NETWORK.warning("Failed to set BasculaAP autoconnect back to yes: %s", exc)

    try:
        LOG_NETWORK.info("Bringing up '%s' after failure", AP_CONNECTION_ID)
        await _nmcli_async(["connection", "up", AP_CONNECTION_ID], timeout=20)
    except Exception as exc:
        LOG_NETWORK.warning("Failed to bring up BasculaAP after failure: %s", exc)
def wifi_connected() -> bool:
    return _wifi_client_connected()


def ethernet_carrier(ifname: str = "eth0") -> bool:
    if _iface_has_carrier(ifname):
        return True

    try:
        res = _nmcli(["-t", "-f", "DEVICE,TYPE,STATE", "device", "status"], timeout=5)
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
        res = _nmcli(["-t", "-f", "DEVICE,TYPE,STATE", "device"])
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
    try:
        res = _nmcli(["-t", "-f", "NAME,TYPE,ACTIVE", "connection", "show", "--active"])
    except Exception:
        return False
    if res.returncode != 0:
        return False
    for line in res.stdout.splitlines():
        name, typ, active = (line.split(":") + ["", "", ""])[:3]
        if name == AP_CONNECTION_ID and typ == "802-11-wireless" and active.lower() == "yes":
            return True
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
    except Exception:
        pass
    _nmcli(["connection", "up", AP_CONNECTION_ID])
    return True


def set_autoconnect(name: str, yes_no: bool, priority: int) -> None:
    value = "yes" if yes_no else "no"
    try:
        res = _nmcli(
            [
                "con",
                "modify",
                name,
                "connection.autoconnect",
                value,
                "connection.autoconnect-priority",
                str(priority),
            ],
            timeout=5,
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
        res = _nmcli(args, timeout=timeout)
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
            _nmcli(["dev", "wifi", "rescan"], timeout=5)
        except subprocess.TimeoutExpired:
            pass

        result = _nmcli(
            ["-t", "--escape", "yes", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "dev", "wifi", "list"],
            timeout=10,
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
        res = _nmcli(["con", "delete", connection_id], timeout=5)
        if res.returncode not in (0, 10):
            message = (res.stderr or res.stdout).strip().lower()
            if "unknown" not in message and "not found" not in message:
                raise RuntimeError((res.stderr or res.stdout).strip())
    except FileNotFoundError:
        raise PermissionError("NMCLI_NOT_AVAILABLE")


def _disconnect_connection(connection_id: str) -> None:
    try:
        _nmcli(["con", "down", connection_id], timeout=5)
    except Exception:
        pass


def ensure_ap_profile() -> None:
    if not _nmcli_available():
        raise PermissionError("NMCLI_NOT_AVAILABLE")

    try:
        existing = _nmcli(["con", "show", AP_CONNECTION_ID], timeout=5)
        if existing.returncode == 0:
            return
    except FileNotFoundError:
        raise PermissionError("NMCLI_NOT_AVAILABLE")

    create_res = _nmcli(
        [
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
        ],
        timeout=10,
    )
    if create_res.returncode not in (0, 4):
        message = (create_res.stderr or create_res.stdout).strip()
        lower = message.lower()
        if "already exists" not in lower and "exists" not in lower:
            raise RuntimeError(message)

    modify_res = _nmcli(
        [
            "con",
            "modify",
            AP_CONNECTION_ID,
            "connection.autoconnect",
            "no",
            "connection.autoconnect-priority",
            "-999",
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
        ],
        timeout=10,
    )
    if modify_res.returncode != 0:
        raise RuntimeError((modify_res.stderr or modify_res.stdout).strip())

    if AP_DEFAULT_PASSWORD:
        secret_ap_res = _nmcli(
            [
                "con",
                "modify",
                AP_CONNECTION_ID,
                "wifi-sec.key-mgmt",
                "wpa-psk",
                "wifi-sec.psk",
                AP_DEFAULT_PASSWORD,
            ],
            timeout=5,
        )
        if secret_ap_res.returncode != 0:
            raise RuntimeError((secret_ap_res.stderr or secret_ap_res.stdout).strip())
    else:
        open_ap_res = _nmcli(
            ["con", "modify", AP_CONNECTION_ID, "wifi-sec.key-mgmt", "none"],
            timeout=5,
        )
        if open_ap_res.returncode != 0:
            raise RuntimeError((open_ap_res.stderr or open_ap_res.stdout).strip())


def _ethernet_connected() -> bool:
    try:
        res = _nmcli(["-t", "-f", "DEVICE,TYPE,STATE", "device", "status"], timeout=5)
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
        res = _nmcli(["-t", "-f", "802-11-wireless.ssid", "con", "show", connection_name], timeout=5)
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
        res = _nmcli(["-t", "--escape", "yes", "-f", "IN-USE,SSID", "dev", "wifi", "list"], timeout=5)
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

    connected = bool(wlan_ip and active_connection and active_connection != AP_CONNECTION_ID)

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


@app.post("/api/miniweb/connect")
@app.post("/api/miniweb/connect-wifi")
async def connect_wifi(credentials: WifiCredentials):
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

    try:
        _ensure_wifi_profile(ssid, sanitized_password if credentials.secured else None, credentials.secured)
    except PermissionError as exc:
        code = str(exc)
        if code == "NMCLI_NOT_AVAILABLE":
            raise HTTPException(
                status_code=503,
                detail={"code": code, "message": "nmcli no está instalado"},
            ) from exc
        raise HTTPException(status_code=400, detail={"code": code}) from exc
    except RuntimeError as exc:
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
        raise HTTPException(status_code=400, detail=message) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail="nmcli no disponible") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    try:
        try:
            await _nmcli_async(
                [
                    "connection",
                    "modify",
                    AP_CONNECTION_ID,
                    "connection.autoconnect",
                    "no",
                ],
                timeout=5,
            )
        except Exception as exc:
            LOG_NETWORK.warning("Failed to set BasculaAP autoconnect=no: %s", exc)

        try:
            LOG_NETWORK.info("Bringing down '%s'", AP_CONNECTION_ID)
            res_down = await _nmcli_async(["connection", "down", AP_CONNECTION_ID], timeout=10)
            if res_down.returncode not in (0, 10):
                LOG_NETWORK.warning(
                    "Could not bring down BasculaAP: %s",
                    (res_down.stderr or res_down.stdout or "").strip(),
                )
        except Exception as exc:
            LOG_NETWORK.warning("Error bringing down BasculaAP: %s", exc)

        LOG_NETWORK.info("Activating Wi-Fi connection '%s'", ssid)
        up_res = await _nmcli_async(["connection", "up", ssid, "ifname", WIFI_INTERFACE], timeout=25)
        if up_res.returncode != 0:
            LOG_NETWORK.warning(
                "nmcli up failed for '%s': %s",
                ssid,
                (up_res.stderr or up_res.stdout or "").strip(),
            )
            await _nmcli_async(["connection", "modify", AP_CONNECTION_ID, "connection.autoconnect", "yes"])
            await _nmcli_async(["connection", "up", AP_CONNECTION_ID])

            status, code, msg = _classify_nmcli_failure(up_res)
            raise HTTPException(
                status_code=status,
                detail={
                    "code": code,
                    "message": msg,
                    "stdout": (up_res.stdout or "").strip(),
                    "stderr": (up_res.stderr or "").strip(),
                },
            )

        ok, ip_address = await _wait_for_wifi_activation(timeout_s=45.0)
        if ok and ip_address:
            LOG_NETWORK.info("Wi-Fi '%s' connected with IP %s", ssid, ip_address)
            return {"connected": True, "ssid": ssid, "ip": ip_address, "ap_active": False}

        LOG_NETWORK.warning("Timed out waiting for Wi-Fi '%s' activation", ssid)
        await _nmcli_async(["connection", "modify", AP_CONNECTION_ID, "connection.autoconnect", "yes"])
        await _nmcli_async(["connection", "up", AP_CONNECTION_ID])
        raise HTTPException(status_code=504, detail={"code": "WIFI_ACTIVATION_TIMEOUT", "ssid": ssid})
    except HTTPException:
        raise
    except PermissionError as exc:
        code = str(exc)
        if code == "NMCLI_NOT_AVAILABLE":
            raise HTTPException(
                status_code=503,
                detail={"code": code, "message": "nmcli no está instalado"},
            ) from exc
        await _reactivate_ap_after_failure()
        raise HTTPException(status_code=400, detail={"code": code}) from exc
    except RuntimeError as exc:
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
        raise HTTPException(status_code=400, detail=message) from exc
    except FileNotFoundError as exc:
        await _reactivate_ap_after_failure()
        raise HTTPException(status_code=503, detail="nmcli no disponible") from exc
    except Exception as exc:
        await _reactivate_ap_after_failure()
        raise HTTPException(status_code=500, detail=str(exc)) from exc


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
        # Desactiva autoconnect de Wi-Fi cliente si procede (opcional)
        _bring_up_ap(debounce_sec=0.0)
        return {"success": True, "ap_active": _ap_active()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"AP error: {exc}") from exc


@app.post("/api/network/disable-ap")
async def disable_ap():
    try:
        res = _nmcli(["connection", "down", AP_CONNECTION_ID])
        if res.returncode not in (0, 10):
            raise RuntimeError((res.stderr or res.stdout).strip())
        return {"success": True, "ap_active": _ap_active()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"AP disable error: {exc}") from exc


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

                # NO asumir instant = grams; solo usarlo si el backend lo proporciona
                instant = data.get("instant", None)

                # Priorizar valor del backend si viene
                stable_value = data.get("stable", None)

                # Fallback conservador: solo calcular si hay 'instant' distinto y 'grams'
                if stable_value is None:
                    if instant is not None and grams is not None:
                        try:
                            # Umbral conservador; ajustable vía config si se desea
                            stable_value = abs(float(instant) - float(grams)) <= 1.0
                        except Exception:
                            stable_value = False
                    else:
                        # Sin datos suficientes, no afirmar estabilidad
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
