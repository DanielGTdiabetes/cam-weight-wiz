# backend/miniweb.py
# (Codex: escribir archivo COMPLETO, sin "...", listo para ejecutar)
from __future__ import annotations
import os
import json
import logging
import subprocess
import ipaddress
import random
import string
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.scale_service import HX711Service

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

LOG_SCALE = logging.getLogger("bascula.scale")

NMCLI_BIN = Path("/usr/bin/nmcli")
NM_CONNECTIONS_DIR = Path("/etc/NetworkManager/system-connections")
HOME_CONNECTION_ID = "BasculaHome"
AP_CONNECTION_ID = "BasculaAP"
AP_DEFAULT_SSID = "Bascula-AP"
AP_DEFAULT_PASSWORD = "bascula2025"
WIFI_INTERFACE = "wlan0"

CFG_DIR.mkdir(parents=True, exist_ok=True)

# ---------- Estado global ----------
scale_service: Optional[HX711Service] = None

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
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2))


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


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        LOG_SCALE.warning("Invalid integer for %s: %s", name, value)
        return default


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        LOG_SCALE.warning("Invalid float for %s: %s", name, value)
        return default


def _get_scale_service() -> Optional[HX711Service]:
    return scale_service


def _init_scale_service() -> HX711Service:
    dt_pin = _env_int("HX711_DT", DEFAULT_DT_PIN)
    sck_pin = _env_int("HX711_SCK", DEFAULT_SCK_PIN)
    sample_rate = _env_float("SAMPLE_RATE_HZ", DEFAULT_SAMPLE_RATE)
    filter_window = _env_int("SCALE_FILTER_WINDOW", DEFAULT_FILTER_WINDOW)
    calibration_factor = _env_float("CALIBRATION_FACTOR", DEFAULT_CALIBRATION_FACTOR)

    service = HX711Service(
        dt_pin=dt_pin,
        sck_pin=sck_pin,
        sample_rate_hz=sample_rate,
        filter_window=filter_window,
        calibration_factor=calibration_factor,
    )
    service.start()
    return service


def _get_iface_ip(iface: str) -> Optional[str]:
    try:
        out = subprocess.check_output(["ip", "-4", "addr", "show", iface], text=True)
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("inet "):
                ip = line.split()[1].split("/")[0]
                return ip
    except Exception:
        return None
    return None


def _nmcli_available() -> bool:
    return NMCLI_BIN.exists()


def _nmcli(args: List[str], timeout: int = 15) -> subprocess.CompletedProcess:
    if not _nmcli_available():
        raise FileNotFoundError(str(NMCLI_BIN))
    return subprocess.run([str(NMCLI_BIN), *args], capture_output=True, text=True, timeout=timeout)


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
        res = _nmcli(["-t", "-f", "NAME,TYPE,DEVICE", "con", "show", "--active"], timeout=5)
    except FileNotFoundError:
        return _is_ap_mode_legacy()
    except Exception:
        return _is_ap_mode_legacy()

    if res.returncode != 0:
        return _is_ap_mode_legacy()

    for line in res.stdout.strip().splitlines():
        if not line:
            continue
        parts = line.split(":")
        if len(parts) < 3:
            continue
        name, conn_type, device = parts[0], parts[1], parts[2]
        if name == AP_CONNECTION_ID and conn_type == "802-11-wireless" and device == WIFI_INTERFACE:
            return True
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


def _connect_wifi(ssid: str, password: Optional[str], secured: bool) -> None:
    ssid = ssid.strip()
    if not ssid:
        raise ValueError("SSID is required")

    if len(ssid.encode("utf-8")) > 32:
        raise ValueError("SSID demasiado largo")

    if secured:
        if not password or not password.strip():
            raise ValueError("Password is required")
        if len(password) > 63:
            raise ValueError("Password demasiado larga")
        sanitized_password = password.strip().replace("\x00", "").replace("\r", "").replace("\n", "")
    else:
        sanitized_password = None

    if not _nmcli_available():
        raise PermissionError("NMCLI_NOT_AVAILABLE")

    try:
        try:
            _nmcli(["radio", "wifi", "on"], timeout=5)
        except Exception:
            pass

        _disconnect_connection(AP_CONNECTION_ID)
        _remove_connection(HOME_CONNECTION_ID)
        _remove_profiles_for_ssid(ssid)

        add_res = _nmcli(
            [
                "con",
                "add",
                "type",
                "wifi",
                "ifname",
                WIFI_INTERFACE,
                "con-name",
                HOME_CONNECTION_ID,
                "autoconnect",
                "yes",
                "ssid",
                ssid,
            ],
            timeout=10,
        )
        if add_res.returncode not in (0, 4):
            message = (add_res.stderr or add_res.stdout).strip()
            lower = message.lower()
            if "already exists" not in lower and "exists" not in lower:
                raise RuntimeError(message)

        base_modify = [
            "con",
            "modify",
            HOME_CONNECTION_ID,
            "connection.autoconnect",
            "yes",
            "connection.autoconnect-priority",
            "100",
            "connection.interface-name",
            WIFI_INTERFACE,
            "ipv4.method",
            "auto",
            "ipv6.method",
            "ignore",
        ]
        base_res = _nmcli(base_modify, timeout=10)
        if base_res.returncode != 0:
            raise RuntimeError((base_res.stderr or base_res.stdout).strip())

        if secured and sanitized_password:
            secret_res = _nmcli(
                [
                    "con",
                    "modify",
                    HOME_CONNECTION_ID,
                    "wifi-sec.key-mgmt",
                    "wpa-psk",
                    "wifi-sec.psk",
                    sanitized_password,
                ],
                timeout=5,
            )
            if secret_res.returncode != 0:
                raise RuntimeError((secret_res.stderr or secret_res.stdout).strip())
        else:
            open_res = _nmcli(
                ["con", "modify", HOME_CONNECTION_ID, "wifi-sec.key-mgmt", "none"],
                timeout=5,
            )
            if open_res.returncode != 0:
                raise RuntimeError((open_res.stderr or open_res.stdout).strip())

        reload_res = _nmcli(["con", "reload"], timeout=5)
        if reload_res.returncode != 0:
            raise RuntimeError((reload_res.stderr or reload_res.stdout).strip())

        up_res = _nmcli(["con", "up", HOME_CONNECTION_ID, "ifname", WIFI_INTERFACE], timeout=45)
        if up_res.returncode != 0:
            message = (up_res.stderr or up_res.stdout).strip()
            lower = message.lower()
            if "secrets were required" in lower:
                raise PermissionError("NMCLI_SECRETS_REQUIRED")
            if "not authorized" in lower:
                raise PermissionError("NMCLI_NOT_AUTHORIZED")
            raise RuntimeError(message)
    except Exception:
        try:
            _remove_connection(HOME_CONNECTION_ID)
        except Exception:
            pass
        raise


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
    wlan_ip = _get_iface_ip(WIFI_INTERFACE)
    ap_active = _is_ap_active()
    ethernet_active = False
    try:
        ethernet_active = _ethernet_connected()
    except PermissionError:
        ethernet_active = False

    connected = False
    ssid: Optional[str] = None
    active_connection: Optional[str] = None

    try:
        res = _nmcli(["-t", "-f", "NAME,TYPE,DEVICE", "con", "show", "--active"], timeout=5)
        if res.returncode == 0:
            for line in res.stdout.strip().splitlines():
                if not line:
                    continue
                parts = line.split(":")
                if len(parts) < 3:
                    continue
                name, conn_type, device = parts[0], parts[1], parts[2]
                if conn_type != "802-11-wireless" or device != WIFI_INTERFACE:
                    continue
                active_connection = name
                if name == AP_CONNECTION_ID:
                    ssid = AP_DEFAULT_SSID
                else:
                    connected = True
                    ssid = _connection_ssid(name) or _current_wifi_ssid() or name
                break
    except FileNotFoundError:
        raise PermissionError("NMCLI_NOT_AVAILABLE")
    except Exception:
        pass

    if not ssid and ap_active:
        ssid = AP_DEFAULT_SSID
    elif not ssid and not connected:
        ssid = _current_wifi_ssid()

    should_activate_ap = not connected and not ethernet_active

    return {
        "connected": connected,
        "ssid": ssid,
        "ip": wlan_ip,
        "ap_active": ap_active,
        "ethernet_connected": ethernet_active,
        "interface": WIFI_INTERFACE,
        "active_connection": active_connection,
        "should_activate_ap": should_activate_ap,
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
        LOG_SCALE.error("Failed to start HX711 service: %s", exc)
        scale_service = None


async def close_scale() -> None:
    global scale_service
    if scale_service is None:
        return
    try:
        scale_service.stop()
    except Exception as exc:
        LOG_SCALE.error("Failed to stop HX711 service: %s", exc)
    finally:
        scale_service = None


@asynccontextmanager
async def lifespan(app: FastAPI):
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
        return {"ok": False, "reason": "service_not_initialized"}
    return service.get_status()


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
    try:
        password = credentials.password.strip() if credentials.password else None
        _connect_wifi(credentials.ssid, password, credentials.secured)
        _schedule_reboot()
        return {
            "success": True,
            "message": "Conexión iniciada. El dispositivo se reiniciará en 1 minuto para aplicar la red.",
        }
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except PermissionError as exc:
        code = str(exc)
        if code == "NMCLI_NOT_AVAILABLE":
            raise HTTPException(status_code=503, detail={"code": code, "message": "nmcli no está instalado"}) from exc
        if code == "NMCLI_SECRETS_REQUIRED":
            raise HTTPException(
                status_code=400,
                detail={
                    "code": code,
                    "message": "NetworkManager requiere secretos adicionales (comprueba la contraseña WPA).",
                },
            ) from exc
        if code == "NMCLI_NOT_AUTHORIZED":
            raise HTTPException(
                status_code=403,
                detail={"code": code, "message": "NetworkManager denegó la operación (PolicyKit)."},
            ) from exc
        raise HTTPException(status_code=400, detail={"code": code}) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail="nmcli no disponible") from exc
    except Exception as exc:
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
        ensure_ap_profile()
        _disconnect_connection(HOME_CONNECTION_ID)
        res = _nmcli(["con", "up", AP_CONNECTION_ID], timeout=20)
        if res.returncode != 0:
            raise RuntimeError((res.stderr or res.stdout).strip())
        return {"success": True}
    except PermissionError as exc:
        if str(exc) == "NMCLI_NOT_AVAILABLE":
            raise HTTPException(status_code=503, detail="nmcli no disponible") from exc
        raise HTTPException(status_code=403, detail="Permisos insuficientes para habilitar AP") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"AP error: {exc}") from exc


@app.post("/api/network/disable-ap")
async def disable_ap():
    try:
        _disconnect_connection(AP_CONNECTION_ID)
        return {"success": True}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"AP disable error: {exc}") from exc


@app.get("/api/network/status")
async def network_status():
    return await miniweb_status()


# ====== (opcional) WebSocket y tare/zero/scale como ya estaban si aplica ======
# Mantén aquí los endpoints ya existentes de báscula...
# ==============================================================================


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
