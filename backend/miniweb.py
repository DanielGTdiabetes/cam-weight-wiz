# backend/miniweb.py
# (Codex: escribir archivo COMPLETO, sin "...", listo para ejecutar)
import os
import json
import subprocess
import ipaddress
import random
import string
import uuid
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List

import serial  # keep existing behavior; ok if not present in some installs
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ---------- Constantes y paths ----------
BASE_DIR = Path(__file__).resolve().parent.parent
DIST_DIR = BASE_DIR / "dist"

CFG_DIR = Path(os.getenv("BASCULA_CFG_DIR", Path.home() / ".bascula"))
PIN_PATH = CFG_DIR / "miniweb_pin"
CONFIG_PATH = CFG_DIR / "config.json"
DEFAULT_SERIAL_PORT = "/dev/serial0"
DEFAULT_BAUD_RATE = 115200

NMCLI_BIN = Path("/usr/bin/nmcli")
NM_CONNECTIONS_DIR = Path("/etc/NetworkManager/system-connections")
HOME_CONNECTION_ID = "BasculaHome"
AP_CONNECTION_ID = "BasculaAP"
AP_DEFAULT_SSID = "Bascula-AP"
AP_DEFAULT_PASSWORD = "bascula2025"
WIFI_INTERFACE = "wlan0"

CFG_DIR.mkdir(parents=True, exist_ok=True)

# ---------- Estado global ----------
scale_serial: Optional[serial.Serial] = None

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


def _list_networks() -> List[Dict[str, Any]]:
    """Devuelve lista de redes Wi-Fi visibles usando nmcli."""
    try:
        try:
            _nmcli(["dev", "wifi", "rescan"], timeout=5)
        except subprocess.TimeoutExpired:
            pass

        result = _nmcli(["-t", "-f", "SSID,SIGNAL,SECURITY", "dev", "wifi", "list"], timeout=10)
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
            if len(parts) < 2:
                continue
            ssid = parts[0].strip()
            if not ssid:
                continue
            signal_part = parts[1].strip()
            try:
                signal = int(signal_part)
            except ValueError:
                signal = 0
            security = parts[2].strip() if len(parts) > 2 else ""
            secured = bool(security and security.upper() != "NONE")
            networks.append({
                "ssid": ssid,
                "signal": signal,
                "secured": secured,
            })

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


def _ssid_to_slug(ssid: str) -> str:
    safe = "".join(c for c in ssid if c.isalnum() or c in ("-", "_", "."))
    return safe or "wifi"


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
        try:
            profile_path.unlink()
        except Exception:
            pass


def _write_nm_profile(ssid: str, password: str, ifname: str = WIFI_INTERFACE) -> Path:
    slug = _ssid_to_slug(ssid.lower())
    profile_path = NM_CONNECTIONS_DIR / f"{slug}.nmconnection"
    content = f"""[connection]
id={HOME_CONNECTION_ID}
uuid={uuid.uuid4()}
type=wifi
interface-name={ifname}
autoconnect=true
autoconnect-priority=100

[wifi]
ssid={ssid}
mode=infrastructure

[wifi-security]
key-mgmt=wpa-psk
psk={password}
auth-alg=open
proto=rsn

[ipv4]
method=auto

[ipv6]
method=ignore
"""
    NM_CONNECTIONS_DIR.mkdir(parents=True, exist_ok=True)
    profile_path.write_text(content)
    os.chmod(profile_path, 0o600)
    return profile_path


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

    NM_CONNECTIONS_DIR.mkdir(parents=True, exist_ok=True)
    ap_profile = NM_CONNECTIONS_DIR / f"{AP_CONNECTION_ID}.nmconnection"
    if ap_profile.exists():
        return

    content = f"""[connection]
id={AP_CONNECTION_ID}
uuid={uuid.uuid4()}
type=wifi
interface-name={WIFI_INTERFACE}
autoconnect=false

[wifi]
ssid={AP_DEFAULT_SSID}
mode=ap

[wifi-security]
key-mgmt=wpa-psk
psk={AP_DEFAULT_PASSWORD}

[ipv4]
method=shared

[ipv6]
method=ignore
"""
    ap_profile.write_text(content)
    os.chmod(ap_profile, 0o600)


def _connect_wifi(ssid: str, password: str) -> None:
    if not ssid:
        raise ValueError("SSID is required")
    if not password:
        raise ValueError("Password is required")

    if not _nmcli_available():
        raise PermissionError("NMCLI_NOT_AVAILABLE")

    _disconnect_connection(AP_CONNECTION_ID)
    _remove_connection(HOME_CONNECTION_ID)
    _remove_profiles_for_ssid(ssid)

    profile_path = _write_nm_profile(ssid, password)

    reload_res = _nmcli(["con", "reload"], timeout=5)
    if reload_res.returncode != 0:
        raise RuntimeError((reload_res.stderr or reload_res.stdout).strip())

    up_res = _nmcli(["con", "up", HOME_CONNECTION_ID], timeout=45)
    if up_res.returncode != 0:
        message = (up_res.stderr or up_res.stdout).strip()
        lower = message.lower()
        if "secrets were required" in lower:
            raise PermissionError("NMCLI_SECRETS_REQUIRED")
        if "not authorized" in lower:
            raise PermissionError("NMCLI_NOT_AUTHORIZED")
        raise RuntimeError(message)

    try:
        os.chmod(profile_path, 0o600)
    except Exception:
        pass


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


def _load_config() -> dict:
    cfg = _load_json(CONFIG_PATH) or {}
    return {
        "scale": {
            "port": cfg.get("scale", {}).get("port", DEFAULT_SERIAL_PORT),
            "baud": cfg.get("scale", {}).get("baud", DEFAULT_BAUD_RATE),
        }
    }


# ---------- Arranque / parada báscula ----------
async def init_scale():
    global scale_serial
    try:
        sc = _load_config()["scale"]
        scale_serial = serial.Serial(port=sc["port"], baudrate=sc["baud"], timeout=1)
        print(f"✅ Scale connected on {sc['port']} @ {sc['baud']}")
    except Exception as e:
        print(f"⚠️ Scale not connected: {e}")
        scale_serial = None


async def close_scale():
    global scale_serial
    if scale_serial and getattr(scale_serial, "is_open", False):
        try:
            scale_serial.close()
            print("Scale connection closed")
        except Exception:
            pass


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


# ---------- Models ----------
class PinVerification(BaseModel):
    pin: str


class WifiCredentials(BaseModel):
    ssid: str
    password: str


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


@app.post("/api/miniweb/connect-wifi")
async def connect_wifi(credentials: WifiCredentials):
    try:
        _connect_wifi(credentials.ssid.strip(), credentials.password.strip())
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
    wlan_ip = _get_iface_ip(WIFI_INTERFACE)
    connected = False
    ssid: Optional[str] = None

    try:
        res = _nmcli(["-t", "-f", "NAME,TYPE,DEVICE", "con", "show", "--active"], timeout=5)
        if res.returncode == 0:
            for line in res.stdout.splitlines():
                parts = line.split(":")
                if len(parts) < 3:
                    continue
                name, conn_type, device = parts[0], parts[1], parts[2]
                if conn_type != "802-11-wireless" or device != WIFI_INTERFACE:
                    continue
                ssid = name
                if name != AP_CONNECTION_ID and wlan_ip:
                    connected = True
                    break
    except FileNotFoundError:
        pass
    except Exception:
        pass

    return {"connected": connected, "ssid": ssid, "ip": wlan_ip}


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
