"""
Mini-Web Configuration Server + Scale Backend
- WiFi configuration in AP mode
- Serial communication with ESP32 scale
- WebSocket for real-time weight data
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import string
import subprocess
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import List, Optional

import serial
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Logging configuration
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("miniweb")

# ---------------------------------------------------------------------------
# Paths and constants
# ---------------------------------------------------------------------------
ROOT_DIR = Path(__file__).resolve().parent.parent
DIST_DIR = Path(os.environ.get("BASCULA_DIST_DIR", ROOT_DIR / "dist")).resolve()
ASSETS_DIR = DIST_DIR / "assets"
INDEX_FILE = DIST_DIR / "index.html"

CONFIG_PATH = Path(os.path.expanduser("~/.bascula/config.json"))
DEFAULT_SERIAL_PORT = "/dev/serial0"
DEFAULT_BAUD_RATE = 115200

AP_CONNECTION_NAME = os.environ.get("BASCULA_AP_CONNECTION", "BasculaAP")
WLAN_INTERFACE = os.environ.get("BASCULA_WLAN_INTERFACE", "wlan0")
AP_RESTORE_DELAY_SECONDS = int(os.environ.get("BASCULA_AP_RESTORE_DELAY", "90"))
SCAN_DELAY_AFTER_AP_DOWN = float(os.environ.get("BASCULA_SCAN_AP_SLEEP", "1.5"))

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
scale_serial: Optional[serial.Serial] = None
active_connections: list[WebSocket] = []
ap_restore_task: Optional[asyncio.Task] = None
ap_state_lock = asyncio.Lock()

# ---------------------------------------------------------------------------
# Configuration helpers
# ---------------------------------------------------------------------------
def load_config() -> dict:
    """Load configuration from JSON file."""
    if CONFIG_PATH.exists():
        try:
            with CONFIG_PATH.open("r", encoding="utf-8") as file:
                return json.load(file)
        except Exception as exc:  # pragma: no cover - logging only
            logger.warning("Error loading config %s: %s", CONFIG_PATH, exc)
    return {}


def save_config(config: dict) -> None:
    """Persist configuration to disk."""
    try:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with CONFIG_PATH.open("w", encoding="utf-8") as file:
            json.dump(config, file, indent=2)
    except Exception as exc:  # pragma: no cover - logging only
        logger.warning("Unable to write config %s: %s", CONFIG_PATH, exc)


def get_serial_config() -> dict:
    """Get serial port configuration."""
    config = load_config()
    return {
        "port": config.get("scale", {}).get("port", DEFAULT_SERIAL_PORT),
        "baud": config.get("scale", {}).get("baud", DEFAULT_BAUD_RATE),
    }


def get_or_create_pin() -> str:
    """Return the current PIN, generating (and attempting to persist) if needed."""
    config = load_config()
    existing_pin = config.get("miniweb", {}).get("pin")
    if existing_pin and isinstance(existing_pin, str) and existing_pin.isdigit() and len(existing_pin) == 4:
        logger.info("🔐 Mini-Web PIN (persisted): %s", existing_pin)
        return existing_pin

    pin = "".join(random.choices(string.digits, k=4))
    logger.info("🔐 Mini-Web PIN (generated): %s", pin)

    config.setdefault("miniweb", {})["pin"] = pin
    save_config(config)
    return pin


CURRENT_PIN = get_or_create_pin()

# ---------------------------------------------------------------------------
# Scale helpers
# ---------------------------------------------------------------------------
async def init_scale() -> None:
    """Initialize serial connection to ESP32 scale."""
    global scale_serial
    try:
        serial_config = get_serial_config()
        scale_serial = serial.Serial(
            port=serial_config["port"],
            baudrate=serial_config["baud"],
            timeout=1,
        )
        logger.info("✅ Scale connected on %s @ %s", serial_config["port"], serial_config["baud"])
    except Exception as exc:
        logger.warning("⚠️ Scale not connected: %s", exc)
        scale_serial = None


async def close_scale() -> None:
    """Close serial connection."""
    global scale_serial
    if scale_serial and scale_serial.is_open:
        scale_serial.close()
        logger.info("Scale connection closed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    await init_scale()
    try:
        yield
    finally:
        await close_scale()


app = FastAPI(lifespan=lifespan)

# CORS for local access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# SPA static files
# ---------------------------------------------------------------------------
if ASSETS_DIR.exists():
    app.mount("/assets", StaticFiles(directory=ASSETS_DIR, check_dir=False), name="assets")
else:  # pragma: no cover - informational log
    logger.warning("Assets directory not found at %s", ASSETS_DIR)


def spa_index_response() -> FileResponse:
    """Return the SPA entry point with cache disabled."""
    if not INDEX_FILE.exists():
        logger.error("index.html not found at %s", INDEX_FILE)
        raise HTTPException(status_code=404, detail="SPA build not found")
    return FileResponse(INDEX_FILE, media_type="text/html", headers={"Cache-Control": "no-store"})


def dist_file_response(filename: str, *, media_type: Optional[str] = None, headers: Optional[dict[str, str]] = None) -> FileResponse:
    """Serve a file from the dist directory."""
    file_path = DIST_DIR / filename
    if not file_path.exists():
        logger.error("Requested asset %s not found in %s", filename, DIST_DIR)
        raise HTTPException(status_code=404, detail=f"{filename} not found")
    return FileResponse(file_path, media_type=media_type, headers=headers)


@app.get("/", include_in_schema=False)
async def serve_root() -> FileResponse:
    return spa_index_response()


@app.get("/config", include_in_schema=False)
async def serve_config() -> FileResponse:
    return spa_index_response()


@app.get("/manifest.json", include_in_schema=False)
async def serve_manifest() -> FileResponse:
    return dist_file_response("manifest.json", media_type="application/manifest+json")


@app.get("/service-worker.js", include_in_schema=False)
async def serve_service_worker() -> FileResponse:
    return dist_file_response("service-worker.js", media_type="application/javascript", headers={"Cache-Control": "no-cache"})


@app.get("/favicon.ico", include_in_schema=False)
async def serve_favicon() -> FileResponse:
    return dist_file_response("favicon.ico")


@app.get("/icon-192.png", include_in_schema=False)
async def serve_icon_192() -> FileResponse:
    return dist_file_response("icon-192.png")


@app.get("/icon-512.png", include_in_schema=False)
async def serve_icon_512() -> FileResponse:
    return dist_file_response("icon-512.png")


@app.get("/robots.txt", include_in_schema=False)
async def serve_robots() -> FileResponse:
    return dist_file_response("robots.txt", media_type="text/plain")


@app.get("/{full_path:path}", include_in_schema=False)
async def spa_catch_all(full_path: str) -> FileResponse:
    if full_path.startswith("api/") or full_path.startswith("assets/"):
        raise HTTPException(status_code=404, detail="Not Found")
    return spa_index_response()


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class PinVerification(BaseModel):
    pin: str


class WifiCredentials(BaseModel):
    ssid: str
    password: Optional[str] = None


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------
async def run_command(command: List[str], *, timeout: int = 15, check: bool = True) -> subprocess.CompletedProcess:
    """Run a subprocess command in a thread to avoid blocking the event loop."""
    logger.debug("Executing command: %s", " ".join(command))

    def _run() -> subprocess.CompletedProcess:
        return subprocess.run(command, capture_output=True, text=True, timeout=timeout)

    try:
        result = await asyncio.to_thread(_run)
    except FileNotFoundError:
        raise
    except subprocess.TimeoutExpired as exc:
        logger.error("Command timed out: %s", " ".join(command))
        raise

    if check and result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or f"Command {' '.join(command)} failed"
        raise RuntimeError(message)
    return result


async def call_nmcli(args: List[str], *, timeout: int = 15, check: bool = True) -> subprocess.CompletedProcess:
    """Helper to execute nmcli with the provided arguments."""
    return await run_command(["nmcli", *args], timeout=timeout, check=check)


async def get_connection_mode(connection_name: str) -> Optional[str]:
    try:
        result = await call_nmcli([
            "-t",
            "-f",
            "802-11-wireless.mode",
            "connection",
            "show",
            connection_name,
        ], check=False)
    except FileNotFoundError:
        return None

    if result.returncode != 0:
        return None

    line = result.stdout.strip().splitlines()
    return line[0] if line else None


async def is_wifi_connected() -> bool:
    try:
        result = await call_nmcli([
            "-t",
            "-f",
            "DEVICE,STATE",
            "device",
            "status",
        ], check=False)
    except FileNotFoundError:
        return False

    for line in result.stdout.strip().splitlines():
        parts = line.split(":", 2)
        if len(parts) < 2:
            continue
        device, state = parts[0], parts[1]
        if device == WLAN_INTERFACE and state == "connected":
            return True
    return False


async def is_ap_active() -> bool:
    try:
        result = await call_nmcli([
            "-t",
            "-f",
            "NAME,TYPE,DEVICE",
            "connection",
            "show",
            "--active",
        ], check=False)
    except FileNotFoundError:
        return False

    if result.returncode != 0:
        return False

    for line in result.stdout.strip().splitlines():
        parts = line.split(":", 2)
        if len(parts) < 3:
            continue
        name, conn_type, device = parts[0], parts[1], parts[2]
        if device != WLAN_INTERFACE or conn_type != "802-11-wireless":
            continue
        if name == AP_CONNECTION_NAME:
            return True
        mode = await get_connection_mode(name)
        if mode == "ap":
            return True
    return False


async def ap_down(reason: Optional[str] = None) -> None:
    message_suffix = f" ({reason})" if reason else ""
    async with ap_state_lock:
        logger.info("📡 Disabling AP connection '%s'%s", AP_CONNECTION_NAME, message_suffix)
        try:
            result = await call_nmcli(["connection", "down", AP_CONNECTION_NAME], timeout=20, check=False)
        except FileNotFoundError:
            raise

        if result.returncode == 0:
            return

        stderr = (result.stderr or result.stdout or "").strip().lower()
        if "not active" in stderr:
            return

        fallback = await call_nmcli(["dev", "disconnect", WLAN_INTERFACE], timeout=20, check=False)
        if fallback.returncode != 0:
            fallback_error = fallback.stderr.strip() or fallback.stdout.strip()
            message = fallback_error or stderr or "Unable to disable AP"
            raise RuntimeError(message)


async def ap_up() -> None:
    async with ap_state_lock:
        logger.info("📡 Enabling AP connection '%s'", AP_CONNECTION_NAME)
        try:
            result = await call_nmcli(["connection", "up", AP_CONNECTION_NAME], timeout=20, check=False)
        except FileNotFoundError:
            raise

        if result.returncode != 0:
            error_message = result.stderr.strip() or result.stdout.strip() or "Unable to enable AP"
            raise RuntimeError(error_message)


async def cancel_ap_restore() -> None:
    global ap_restore_task
    if ap_restore_task and not ap_restore_task.done():
        ap_restore_task.cancel()
        with suppress(asyncio.CancelledError):
            await ap_restore_task
    ap_restore_task = None


async def schedule_ap_restore(delay_seconds: int) -> None:
    global ap_restore_task
    await cancel_ap_restore()

    if delay_seconds <= 0:
        return

    async def _restore_ap() -> None:
        try:
            await asyncio.sleep(delay_seconds)
            if await is_wifi_connected():
                logger.info("Skipping AP restore because %s is connected to Wi-Fi", WLAN_INTERFACE)
                return
            await ap_up()
            logger.info("AP connection '%s' restored after timeout", AP_CONNECTION_NAME)
        except asyncio.CancelledError:  # pragma: no cover - cancellation path
            logger.debug("AP restore task cancelled")
            raise
        except FileNotFoundError:
            logger.error("nmcli is not available; cannot restore AP")
        except Exception as exc:  # pragma: no cover - best effort logging
            logger.error("Failed to restore AP: %s", exc)

    ap_restore_task = asyncio.create_task(_restore_ap())


async def ensure_ap_disabled_for_scan() -> bool:
    if not await is_ap_active():
        return False
    await ap_down("wifi scan")
    await schedule_ap_restore(AP_RESTORE_DELAY_SECONDS)
    return True


async def wifi_scan() -> list[dict]:
    try:
        await call_nmcli(["dev", "wifi", "rescan"], timeout=20, check=False)
    except FileNotFoundError:
        raise
    except subprocess.TimeoutExpired:
        raise

    result = await call_nmcli([
        "-t",
        "-f",
        "SSID,SIGNAL,SECURITY",
        "dev",
        "wifi",
        "list",
    ], timeout=20, check=False)

    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or "Failed to list Wi-Fi networks"
        raise RuntimeError(message)

    networks = []
    seen = set()
    for line in result.stdout.strip().splitlines():
        if not line:
            continue
        ssid, signal, security = (line.split(":", 2) + ["", "", ""])[:3]
        ssid = ssid.strip()
        if not ssid:
            continue
        key = (ssid, signal, security)
        if key in seen:
            continue
        seen.add(key)
        try:
            signal_value = int(signal)
        except (TypeError, ValueError):
            signal_value = 0
        security_value = (security or "").strip()
        secured = security_value not in {"", "--"}
        networks.append({
            "ssid": ssid,
            "signal": signal_value,
            "secured": secured,
        })

    networks.sort(key=lambda item: item["signal"], reverse=True)
    return networks


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------
@app.post("/api/miniweb/verify-pin")
async def verify_pin(data: PinVerification):
    """Verify access PIN."""
    if data.pin == CURRENT_PIN:
        return {"success": True}
    raise HTTPException(status_code=403, detail="Invalid PIN")


@app.get("/api/miniweb/scan-networks")
async def scan_networks():
    """Scan available WiFi networks, temporarily disabling the AP if needed."""
    try:
        ap_temporarily_disabled = await ensure_ap_disabled_for_scan()
        if ap_temporarily_disabled:
            logger.info(
                "AP disabled for scan; it will be restored in approximately %s seconds",
                AP_RESTORE_DELAY_SECONDS,
            )
            await asyncio.sleep(SCAN_DELAY_AFTER_AP_DOWN)

        networks = await wifi_scan()
        return {"networks": networks}
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="nmcli is not available on this system")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Timed out while scanning for Wi-Fi networks")
    except RuntimeError as exc:
        logger.error("Wi-Fi scan failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/miniweb/connect-wifi")
async def connect_wifi(credentials: WifiCredentials):
    """Connect to WiFi network."""
    restore_on_failure = ap_restore_task is not None or await is_ap_active()

    try:
        await cancel_ap_restore()

        # Remove previous connection configuration if present
        await call_nmcli(["connection", "delete", credentials.ssid], timeout=10, check=False)

        command = ["dev", "wifi", "connect", credentials.ssid, "ifname", WLAN_INTERFACE]
        if credentials.password:
            command.extend(["password", credentials.password])

        result = await call_nmcli(command, timeout=30, check=False)

        if result.returncode != 0:
            error_message = result.stderr.strip() or result.stdout.strip() or "Unable to connect to Wi-Fi"
            logger.error("Failed to connect to Wi-Fi '%s': %s", credentials.ssid, error_message)
            raise HTTPException(status_code=400, detail=error_message)

        logger.info("✅ Connected to Wi-Fi SSID '%s'", credentials.ssid)

        # Ensure AP stays disabled after a successful connection
        await cancel_ap_restore()
        if await is_ap_active():
            await ap_down("wifi connected")

        with suppress(Exception):  # pragma: no cover - best effort
            subprocess.Popen(["sudo", "shutdown", "-r", "+1"])

        return {"success": True, "message": "Conectado exitosamente"}
    except FileNotFoundError:
        if restore_on_failure:
            await schedule_ap_restore(AP_RESTORE_DELAY_SECONDS)
        raise HTTPException(status_code=500, detail="nmcli is not available on this system")
    except subprocess.TimeoutExpired:
        if restore_on_failure:
            await schedule_ap_restore(AP_RESTORE_DELAY_SECONDS)
        raise HTTPException(status_code=408, detail="Connection timeout")
    except HTTPException as exc:
        if restore_on_failure:
            await schedule_ap_restore(AP_RESTORE_DELAY_SECONDS)
        raise exc
    except RuntimeError as exc:
        if restore_on_failure:
            await schedule_ap_restore(AP_RESTORE_DELAY_SECONDS)
        raise HTTPException(status_code=500, detail=str(exc))
    except Exception as exc:  # pragma: no cover - unexpected errors
        logger.error("Unexpected error while connecting to Wi-Fi: %s", exc)
        if restore_on_failure:
            await schedule_ap_restore(AP_RESTORE_DELAY_SECONDS)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/network/status")
async def network_status():
    """Get current network status."""
    try:
        result = await call_nmcli([
            "-t",
            "-f",
            "DEVICE,STATE,CONNECTION",
            "device",
            "status",
        ], check=False)
    except FileNotFoundError:
        return {"connected": False, "ssid": None, "ip": None, "mode": "managed", "error": "nmcli is not installed"}

    connected = False
    ssid: Optional[str] = None

    if result.returncode == 0:
        for line in result.stdout.strip().splitlines():
            parts = line.split(":", 2)
            if len(parts) < 3:
                continue
            device, state, connection_name = parts[0], parts[1], parts[2]
            if device == WLAN_INTERFACE and state == "connected":
                connected = True
                ssid = connection_name or None
                break

    ip_address = None
    if connected:
        try:
            ip_result = await run_command(["hostname", "-I"], timeout=5, check=False)
            if ip_result.stdout:
                ip_address = ip_result.stdout.strip().split()[0]
        except Exception as exc:  # pragma: no cover - best effort logging
            logger.warning("Unable to read IP address: %s", exc)

    mode = "ap" if await is_ap_active() else "managed"

    response = {
        "connected": connected,
        "ssid": ssid,
        "ip": ip_address,
        "mode": mode,
    }

    if result.returncode != 0:
        response["error"] = result.stderr.strip() or "Unable to determine device status"

    return response


@app.post("/api/network/enable-ap")
async def enable_ap_mode():
    """Enable Access Point mode via NetworkManager."""
    try:
        await cancel_ap_restore()
        await ap_up()
        return {"success": True}
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="nmcli is not available on this system")
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/network/disable-ap")
async def disable_ap_mode():
    """Disable Access Point mode via NetworkManager."""
    try:
        await cancel_ap_restore()
        await ap_down()
        return {"success": True}
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="nmcli is not available on this system")
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Scale endpoints
# ---------------------------------------------------------------------------
@app.websocket("/ws/scale")
async def websocket_scale(websocket: WebSocket):
    """WebSocket endpoint for real-time weight data."""
    await websocket.accept()
    active_connections.append(websocket)

    try:
        while True:
            if scale_serial and scale_serial.is_open:
                try:
                    if scale_serial.in_waiting > 0:
                        line = scale_serial.readline().decode("utf-8").strip()

                        try:
                            data = json.loads(line)
                            await websocket.send_json(data)
                        except json.JSONDecodeError:
                            try:
                                weight = float(line)
                                await websocket.send_json({
                                    "weight": weight,
                                    "stable": True,
                                    "unit": "g",
                                })
                            except ValueError:
                                pass
                except Exception as exc:
                    logger.error("Error reading from scale: %s", exc)

            await asyncio.sleep(0.1)

    except WebSocketDisconnect:
        active_connections.remove(websocket)
    except Exception as exc:  # pragma: no cover - best effort logging
        logger.error("WebSocket error: %s", exc)
        if websocket in active_connections:
            active_connections.remove(websocket)


@app.post("/api/scale/tare")
async def scale_tare():
    """Send tare command to scale."""
    if scale_serial and scale_serial.is_open:
        try:
            scale_serial.write(b"TARE\n")
            return {"success": True, "message": "Tare command sent"}
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))
    raise HTTPException(status_code=503, detail="Scale not connected")


@app.post("/api/scale/zero")
async def scale_zero():
    """Send zero/calibrate command to scale."""
    if scale_serial and scale_serial.is_open:
        try:
            scale_serial.write(b"ZERO\n")
            return {"success": True, "message": "Zero command sent"}
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))
    raise HTTPException(status_code=503, detail="Scale not connected")


@app.get("/api/scale/status")
async def scale_status():
    """Get scale connection status."""
    connected = scale_serial is not None and scale_serial.is_open
    serial_config = get_serial_config()

    return {
        "connected": connected,
        "port": serial_config["port"],
        "baud": serial_config["baud"],
    }


if __name__ == "__main__":
    import uvicorn

    logger.info("=" * 60)
    logger.info("🌐 Mini-Web Configuration Server + Scale Backend")
    logger.info("=" * 60)
    logger.info("📍 Access URL: http://192.168.4.1:8080")
    logger.info("🔐 PIN: %s", CURRENT_PIN)
    logger.info("=" * 60)

    uvicorn.run(app, host="0.0.0.0", port=8080)
