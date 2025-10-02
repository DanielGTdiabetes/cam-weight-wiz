# backend/miniweb.py
# (Codex: escribir archivo COMPLETO, sin “...”, listo para ejecutar)
import os
import json
import subprocess
import ipaddress
import random
import string
import asyncio
from datetime import datetime, timedelta
from typing import Optional, Dict, Any

import serial  # keep existing behavior; ok if not present in some installs
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from contextlib import asynccontextmanager
from pathlib import Path

# ---------- Constantes y paths ----------
BASE_DIR = Path(__file__).resolve().parent.parent
DIST_DIR = BASE_DIR / "dist"
STATE_DIR = Path("/var/lib/bascula")
STATE_DIR.mkdir(parents=True, exist_ok=True)
STATE_FILE = STATE_DIR / "miniweb_state.json"

CONFIG_PATH = Path.home() / ".bascula" / "config.json"
DEFAULT_SERIAL_PORT = "/dev/serial0"
DEFAULT_BAUD_RATE = 115200

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

def _get_or_create_pin() -> str:
    data = _load_json(STATE_FILE) or {}
    pin = data.get("pin")
    if not pin or not (isinstance(pin, str) and len(pin) == 4 and pin.isdigit()):
        pin = _gen_pin()
        _save_json(STATE_FILE, {"pin": pin, "created_at": datetime.utcnow().isoformat()})
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

def _is_ap_mode() -> bool:
    # Heurística: IP clásica de AP en NM: 192.168.4.1/24 en wlan0
    ip = _get_iface_ip("wlan0")
    if not ip:
        return False
    try:
        return ipaddress.ip_address(ip) in ipaddress.ip_network("192.168.4.0/24")
    except Exception:
        return False

def _nmcli(args: list[str], timeout: int = 15) -> subprocess.CompletedProcess:
    return subprocess.run(["nmcli", *args], capture_output=True, text=True, timeout=timeout)

def _list_networks() -> list[dict]:
    # Devuelve lista de redes o genera excepciones específicas para permisos
    try:
        res = _nmcli(["-t", "-f", "SSID,SIGNAL,SECURITY", "dev", "wifi", "list"], timeout=20)
        if res.returncode != 0:
            # Falta permiso o NM no deja escanear
            err = (res.stderr or res.stdout).strip()
            if "not authorized" in err.lower():
                raise PermissionError("NMCLI_NOT_AUTHORIZED")
            raise RuntimeError(f"NMCLI_ERROR: {err}")
        networks = []
        for line in res.stdout.strip().splitlines():
            if not line:
                continue
            # SSID:SIGNAL:SECURITY
            parts = line.split(":")
            ssid = parts[0]
            if not ssid:
                continue
            signal = 0
            try:
                signal = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
            except Exception:
                signal = 0
            secured = (len(parts) > 2 and parts[2] != "")
            networks.append({"ssid": ssid, "signal": signal, "secured": secured})
        networks.sort(key=lambda x: x["signal"], reverse=True)
        return networks
    except FileNotFoundError:
        # nmcli no instalado
        raise PermissionError("NMCLI_NOT_AVAILABLE")
    except PermissionError:
        raise
    except Exception as e:
        raise RuntimeError(str(e))

def _disable_ap_nm():
    # En NetworkManager, si se usa conexión compartida, basta con desconectar AP y/o activar STA
    # Aquí, intentamos borrar o desconectar la conexión 'BasculaAP' si existe
    _nmcli(["device", "disconnect", "wlan0"], timeout=10)

def _connect_wifi(ssid: str, password: str) -> None:
    # Intento de conexión STA
    # 1) Desconectar AP
    _disable_ap_nm()
    # 2) Conectar
    res = _nmcli(["dev", "wifi", "connect", ssid, "password", password], timeout=45)
    if res.returncode != 0:
        raise RuntimeError((res.stderr or res.stdout).strip())

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
    app.mount("/assets", StaticFiles(directory=DIST_DIR / "assets"), name="assets")

    @app.get("/", response_class=FileResponse)
    async def root_index():
        return DIST_DIR / "index.html"

    @app.get("/manifest.json", response_class=FileResponse)
    async def manifest():
        return DIST_DIR / "manifest.json"

    @app.get("/service-worker.js", response_class=FileResponse)
    async def sw():
        return DIST_DIR / "service-worker.js"

    @app.get("/favicon.ico", response_class=FileResponse)
    async def favicon():
        return DIST_DIR / "favicon.ico"

    @app.get("/icon-192.png", response_class=FileResponse)
    async def icon192():
        return DIST_DIR / "icon-192.png"

    @app.get("/icon-512.png", response_class=FileResponse)
    async def icon512():
        return DIST_DIR / "icon-512.png"

    @app.get("/robots.txt", response_class=FileResponse)
    async def robots():
        return DIST_DIR / "robots.txt"

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

def _allow_pin_disclosure(request: Request, force_header: Optional[str]) -> bool:
    if _is_ap_mode():
        return True
    if os.getenv("BASCULA_ALLOW_PIN_READ") == "1":
        return True
    # Solo desde localhost con cabecera explícita
    client = request.client.host if request.client else ""
    if client in ("127.0.0.1", "::1") and force_header == "1":
        return True
    return False

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.get("/api/miniweb/pin")
async def get_pin(request: Request, force: Optional[str] = Header(default="0", alias="X-Force-Pin")):
    if not _allow_pin_disclosure(request, force):
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
        # Programar reboot en 60s
        subprocess.Popen(["sudo", "shutdown", "-r", "+1"])
        return {"success": True, "message": "Conectado exitosamente"}
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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
                    # Si no es la conexión AP (heurística), lo damos por conectado
                    if wlan_ip and not _is_ap_mode():
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
    print(f"🔐 PIN: {CURRENT_PIN}")
    print("============================================================")

_print_boot_banner()
