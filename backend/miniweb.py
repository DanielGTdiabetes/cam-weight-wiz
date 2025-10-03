# backend/miniweb.py
# (Codex: escribir archivo COMPLETO, sin “...”, listo para ejecutar)
import os
import json
import subprocess
import ipaddress
import random
import string
from datetime import datetime, timedelta
from typing import Optional, Dict, Any

import serial  # keep existing behavior; ok if not present in some installs
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from contextlib import asynccontextmanager
from pathlib import Path

# ---------- Constantes y paths ----------
BASE_DIR = Path(__file__).resolve().parent.parent
DIST_DIR = BASE_DIR / "dist"

CFG_DIR = Path(os.getenv("BASCULA_CFG_DIR", Path.home() / ".bascula"))
PIN_PATH = CFG_DIR / "pin.json"
CONFIG_PATH = CFG_DIR / "config.json"
DEFAULT_SERIAL_PORT = "/dev/serial0"
DEFAULT_BAUD_RATE = 115200

CFG_DIR.mkdir(parents=True, exist_ok=True)

# ---------- Estado global ----------
scale_serial: Optional[serial.Serial] = None
active_connections: list[WebSocket] = []

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
    return ''.join(random.choices(string.digits, k=4))

def _load_pin() -> Optional[str]:
    data = _load_json(PIN_PATH) or {}
    pin = data.get("pin")
    if isinstance(pin, str) and len(pin) == 4 and pin.isdigit():
        return pin
    return None


def _write_pin(pin: str) -> None:
    CFG_DIR.mkdir(parents=True, exist_ok=True)
    _save_json(PIN_PATH, {"pin": pin, "created_at": datetime.utcnow().isoformat()})


def _get_or_create_pin() -> str:
    pin = _load_pin()
    if pin:
        return pin
    if os.getenv("BASCULA_RANDOM_PIN") == "1":
        pin = _gen_pin()
    else:
        pin = "1234"
    _write_pin(pin)
    return pin

def _get_iface_ip(iface: str) -> Optional[str]:
    try:
        out = subprocess.check_output(["ip", "-4", "addr", "show", iface], text=True)
        for line in out.splitlines():
            line = line.strip()
            # e.g. "inet 192.168.4.1/24 ..."
            if line.startswith("inet "):
                ip = line.split()[1].split("/")[0]
                return ip
    except Exception:
        return None
    return None

def _is_ap_mode_legacy() -> bool:
    """Fallback heurístico: IP clásica de AP en NM: 192.168.4.1/24 en wlan0."""
    ip = _get_iface_ip("wlan0")
    if not ip:
        return False
    try:
        return ipaddress.ip_address(ip) in ipaddress.ip_network("192.168.4.0/24")
    except Exception:
        return False


def _is_wlan0_shared_mode() -> bool:
    """Comprueba si wlan0 está en modo AP/shared mediante NetworkManager."""
    try:
        active = _nmcli(["-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"], timeout=10)
    except FileNotFoundError:
        return _is_ap_mode_legacy()
    except Exception:
        return _is_ap_mode_legacy()

    if active.returncode != 0:
        return _is_ap_mode_legacy()

    for line in active.stdout.strip().splitlines():
        parts = line.split(":")
        if len(parts) < 3:
            continue
        name, conn_type, device = parts[0], parts[1], parts[2]
        if device != "wlan0" or conn_type != "802-11-wireless":
            continue
        detail = _nmcli(["-t", "-f", "802-11-wireless.mode,ipv4.method", "connection", "show", name], timeout=10)
        if detail.returncode != 0:
            continue
        values: Dict[str, str] = {}
        for entry in detail.stdout.strip().splitlines():
            if ":" in entry:
                key, value = entry.split(":", 1)
                values[key.strip()] = value.strip()
        if values.get("802-11-wireless.mode") == "ap":
            return True
        if values.get("ipv4.method") == "shared":
            return True
    return _is_ap_mode_legacy()

def _nmcli(args: list[str], timeout: int = 15) -> subprocess.CompletedProcess:
    return subprocess.run(["nmcli", *args], capture_output=True, text=True, timeout=timeout)

def _split_nmcli(line: str, separator: str = "|") -> list[str]:
    values: list[str] = []
    current: list[str] = []
    escape = False
    for char in line:
        if escape:
            current.append(char)
            escape = False
            continue
        if char == "\\":
            escape = True
            continue
        if char == separator:
            values.append("".join(current))
            current = []
            continue
        current.append(char)
    values.append("".join(current))
    return values


def _list_networks() -> list[dict]:
    """Devuelve lista de redes Wi-Fi visibles usando nmcli."""
    try:
        rescan = _nmcli(["device", "wifi", "rescan"], timeout=20)
        if rescan.returncode != 0:
            err = (rescan.stderr or rescan.stdout).strip()
            if "not authorized" not in err.lower():
                raise RuntimeError(f"NMCLI_RESCAN_ERROR: {err}")
        res = _nmcli(
            [
                "-t",
                "--fields",
                "SSID,SIGNAL,SECURITY",
                "--separator",
                "|",
                "device",
                "wifi",
                "list",
            ],
            timeout=25,
        )
        if res.returncode != 0:
            err = (res.stderr or res.stdout).strip()
            if "not authorized" in err.lower():
                raise PermissionError("NMCLI_NOT_AUTHORIZED")
            raise RuntimeError(f"NMCLI_ERROR: {err}")

        networks = []
        for raw_line in res.stdout.strip().splitlines():
            if not raw_line:
                continue
            parts = _split_nmcli(raw_line)
            if not parts:
                continue
            ssid = parts[0]
            if not ssid:
                continue
            signal = 0
            if len(parts) > 1:
                try:
                    signal = int(parts[1])
                except ValueError:
                    signal = 0
            security = parts[2] if len(parts) > 2 else ""
            secured = bool(security and security.lower() != "--" and security.upper() != "NONE")
            networks.append({"ssid": ssid, "signal": signal, "secured": secured})
        networks.sort(key=lambda item: item["signal"], reverse=True)
        return networks
    except FileNotFoundError:
        raise PermissionError("NMCLI_NOT_AVAILABLE")
    except PermissionError:
        raise
    except Exception as exc:
        raise RuntimeError(str(exc))

def _disable_ap_nm():
    """Intenta desconectar wlan0 para liberar el interfaz antes de conectar a un STA."""
    try:
        _nmcli(["device", "disconnect", "wlan0"], timeout=10)
    except FileNotFoundError:
        pass


def _connect_wifi(ssid: str, password: str) -> None:
    """Configura una conexión Wi-Fi WPA2-PSK con nmcli siguiendo la receta solicitada."""
    if not ssid:
        raise ValueError("SSID is required")
    _disable_ap_nm()

    try:
        delete = _nmcli(["connection", "delete", ssid], timeout=10)
        if delete.returncode != 0:
            msg = (delete.stderr or delete.stdout).strip().lower()
            if "unknown connection" not in msg and "not found" not in msg:
                raise RuntimeError((delete.stderr or delete.stdout).strip())
    except FileNotFoundError:
        raise PermissionError("NMCLI_NOT_AVAILABLE")

    add_cmd = [
        "connection",
        "add",
        "type",
        "wifi",
        "ifname",
        "wlan0",
        "con-name",
        ssid,
        "ssid",
        ssid,
        "wifi-sec.key-mgmt",
        "wpa-psk",
        "wifi-sec.psk",
        password,
        "802-11-wireless.band",
        "bg",
        "802-11-wireless-security.proto",
        "rsn",
        "802-11-wireless-security.auth-alg",
        "open",
    ]

    add_res = _nmcli(add_cmd, timeout=25)
    if add_res.returncode != 0:
        msg = (add_res.stderr or add_res.stdout).strip()
        lower = msg.lower()
        if "secrets were required" in lower:
            raise PermissionError("NMCLI_SECRETS_REQUIRED")
        if "not authorized" in lower:
            raise PermissionError("NMCLI_NOT_AUTHORIZED")
        raise RuntimeError(msg)

    up_res = _nmcli(["connection", "up", ssid], timeout=45)
    if up_res.returncode != 0:
        msg = (up_res.stderr or up_res.stdout).strip()
        lower = msg.lower()
        if "secrets were required" in lower:
            raise PermissionError("NMCLI_SECRETS_REQUIRED")
        if "not authorized" in lower:
            raise PermissionError("NMCLI_NOT_AUTHORIZED")
        raise RuntimeError(msg)

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
def _dist_file(name: str) -> FileResponse:
    file_path = DIST_DIR / name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Archivo no disponible")
    return FileResponse(file_path)


if (DIST_DIR / "assets").exists():
    app.mount("/assets", StaticFiles(directory=DIST_DIR / "assets"), name="assets")


@app.get("/", response_class=FileResponse)
async def root_index():
    return _dist_file("index.html")


@app.get("/config", response_class=FileResponse)
async def config_index():
    return _dist_file("index.html")


@app.get("/manifest.json", response_class=FileResponse)
async def manifest():
    return _dist_file("manifest.json")


@app.get("/service-worker.js", response_class=FileResponse)
async def sw():
    return _dist_file("service-worker.js")


@app.get("/favicon.ico", response_class=FileResponse)
async def favicon():
    return _dist_file("favicon.ico")


@app.get("/icon-192.png", response_class=FileResponse)
async def icon192():
    return _dist_file("icon-192.png")


@app.get("/icon-512.png", response_class=FileResponse)
async def icon512():
    return _dist_file("icon-512.png")


@app.get("/robots.txt", response_class=FileResponse)
async def robots():
    return _dist_file("robots.txt")

# ---------- Models ----------
class PinVerification(BaseModel):
    pin: str

class WifiCredentials(BaseModel):
    ssid: str
    password: str

# ---------- PIN persistente ----------
CURRENT_PIN = _get_or_create_pin()

# Rate limit básico en memoria (por IP)
FAILED_ATTEMPTS: Dict[str, list[datetime]] = {}
MAX_ATTEMPTS = 10
WINDOW = timedelta(minutes=10)

def _check_rate_limit(ip: str):
    now = datetime.utcnow()
    history = FAILED_ATTEMPTS.get(ip, [])
    # purge
    history = [t for t in history if now - t <= WINDOW]
    FAILED_ATTEMPTS[ip] = history
    if len(history) >= MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="Too many attempts, try later")

def _register_fail(ip: str):
    FAILED_ATTEMPTS.setdefault(ip, []).append(datetime.utcnow())

def _allow_pin_disclosure() -> bool:
    if _is_wlan0_shared_mode():
        return True
    if os.getenv("BASCULA_ALLOW_PIN_READ") == "1":
        return True
    return False

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.get("/api/miniweb/pin")
async def get_pin():
    if not _allow_pin_disclosure():
        raise HTTPException(status_code=403, detail="PIN not available in this mode")
    return {"pin": CURRENT_PIN}

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
    except PermissionError as e:
        code = str(e)
        if code == "NMCLI_NOT_AUTHORIZED":
            raise HTTPException(status_code=403, detail={"code": "NMCLI_NOT_AUTHORIZED"})
        if code == "NMCLI_NOT_AVAILABLE":
            raise HTTPException(status_code=503, detail={"code": "NMCLI_NOT_AVAILABLE"})
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/miniweb/connect-wifi")
async def connect_wifi(credentials: WifiCredentials):
    try:
        _connect_wifi(credentials.ssid, credentials.password)
        return {"success": True, "message": "Conexión iniciada"}
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
        raise HTTPException(status_code=400, detail={"code": code, "message": "Error de permisos al configurar Wi-Fi."}) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail="nmcli no disponible") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

@app.get("/api/network/status")
async def network_status():
    # Minimal: si interfaz wlan0 tiene IP distinta de 192.168.4.1 asumimos STA
    wlan_ip = _get_iface_ip("wlan0")
    connected = False
    ssid = None
    try:
        out = _nmcli(["-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"])
        if out.returncode == 0:
            for line in out.stdout.splitlines():
                # NAME:TYPE:DEVICE
                parts = line.strip().split(":")
                if len(parts) >= 3 and parts[1] == "802-11-wireless" and parts[2] == "wlan0":
                    ssid = parts[0]
                    # Si no es la conexión AP/shared, lo damos por conectado
                    if wlan_ip and not _is_wlan0_shared_mode():
                        connected = True
                        break
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
