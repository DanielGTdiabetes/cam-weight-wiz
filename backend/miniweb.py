"""
Mini-Web Configuration Server + Scale Backend
- WiFi configuration in AP mode
- Serial communication with ESP32 scale
- WebSocket for real-time weight data
"""

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import subprocess
import os
import random
import string
import asyncio
import serial
import json
from typing import Optional
from contextlib import asynccontextmanager

# Global state for scale connection
scale_serial: Optional[serial.Serial] = None
active_connections: list[WebSocket] = []

# Configuration
CONFIG_PATH = os.path.expanduser("~/.bascula/config.json")
DEFAULT_SERIAL_PORT = "/dev/serial0"
DEFAULT_BAUD_RATE = 115200

def load_config():
    """Load configuration from JSON file"""
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r') as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading config: {e}")
    return {}

def get_serial_config():
    """Get serial port configuration"""
    config = load_config()
    return {
        "port": config.get("scale", {}).get("port", DEFAULT_SERIAL_PORT),
        "baud": config.get("scale", {}).get("baud", DEFAULT_BAUD_RATE),
    }

async def init_scale():
    """Initialize serial connection to ESP32 scale"""
    global scale_serial
    try:
        serial_config = get_serial_config()
        scale_serial = serial.Serial(
            port=serial_config["port"],
            baudrate=serial_config["baud"],
            timeout=1
        )
        print(f"✅ Scale connected on {serial_config['port']} @ {serial_config['baud']}")
    except Exception as e:
        print(f"⚠️ Scale not connected: {e}")
        scale_serial = None

async def close_scale():
    """Close serial connection"""
    global scale_serial
    if scale_serial and scale_serial.is_open:
        scale_serial.close()
        print("Scale connection closed")

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events"""
    # Startup
    await init_scale()
    yield
    # Shutdown
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

# Generate random PIN on startup
CURRENT_PIN = ''.join(random.choices(string.digits, k=4))
print(f"🔐 Mini-Web PIN: {CURRENT_PIN}")

class PinVerification(BaseModel):
    pin: str

class WifiCredentials(BaseModel):
    ssid: str
    password: str

@app.post("/api/miniweb/verify-pin")
async def verify_pin(data: PinVerification):
    """Verify access PIN"""
    if data.pin == CURRENT_PIN:
        return {"success": True}
    raise HTTPException(status_code=403, detail="Invalid PIN")

@app.get("/api/miniweb/scan-networks")
async def scan_networks():
    """Scan available WiFi networks"""
    try:
        # Use nmcli to scan networks
        result = subprocess.run(
            ["nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY", "dev", "wifi", "list"],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        networks = []
        for line in result.stdout.strip().split('\n'):
            if line:
                parts = line.split(':')
                if len(parts) >= 2:
                    ssid = parts[0]
                    signal = int(parts[1]) if parts[1].isdigit() else 0
                    secured = len(parts) > 2 and parts[2] != ""
                    
                    if ssid:  # Skip empty SSIDs
                        networks.append({
                            "ssid": ssid,
                            "signal": signal,
                            "secured": secured
                        })
        
        # Sort by signal strength
        networks.sort(key=lambda x: x['signal'], reverse=True)
        
        return {"networks": networks}
    except Exception as e:
        print(f"Error scanning networks: {e}")
        return {"networks": []}

@app.post("/api/miniweb/connect-wifi")
async def connect_wifi(credentials: WifiCredentials):
    """Connect to WiFi network"""
    try:
        # Delete existing connection if exists
        subprocess.run(
            ["nmcli", "connection", "delete", credentials.ssid],
            capture_output=True
        )
        
        # Create new connection
        result = subprocess.run(
            [
                "nmcli", "dev", "wifi", "connect",
                credentials.ssid,
                "password", credentials.password
            ],
            capture_output=True,
            text=True,
            timeout=30
        )
        
        if result.returncode == 0:
            # Connection successful
            print(f"✅ Connected to {credentials.ssid}")
            
            # Disable AP mode
            disable_ap_mode()
            
            # Schedule reboot in 5 seconds
            subprocess.Popen(["sudo", "shutdown", "-r", "+1"])
            
            return {"success": True, "message": "Conectado exitosamente"}
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Failed to connect: {result.stderr}"
            )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=408, detail="Connection timeout")
    except Exception as e:
        print(f"Error connecting to WiFi: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/network/status")
async def network_status():
    """Get current network status"""
    try:
        # Check if connected to WiFi
        result = subprocess.run(
            ["nmcli", "-t", "-f", "DEVICE,STATE,CONNECTION", "dev", "status"],
            capture_output=True,
            text=True
        )
        
        connected = False
        ssid = None
        
        for line in result.stdout.split('\n'):
            if 'wifi' in line and 'connected' in line:
                parts = line.split(':')
                if len(parts) >= 3:
                    connected = True
                    ssid = parts[2]
                    break
        
        # Get IP address
        ip = None
        if connected:
            ip_result = subprocess.run(
                ["hostname", "-I"],
                capture_output=True,
                text=True
            )
            ip = ip_result.stdout.strip().split()[0] if ip_result.stdout else None
        
        return {
            "connected": connected,
            "ssid": ssid,
            "ip": ip
        }
    except Exception as e:
        print(f"Error getting network status: {e}")
        return {"connected": False}

@app.post("/api/network/enable-ap")
async def enable_ap_mode():
    """Enable Access Point mode"""
    try:
        # Start hostapd and dnsmasq
        subprocess.run(["sudo", "systemctl", "start", "hostapd"], check=True)
        subprocess.run(["sudo", "systemctl", "start", "dnsmasq"], check=True)
        
        print("📡 AP mode enabled")
        return {"success": True}
    except Exception as e:
        print(f"Error enabling AP mode: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/network/disable-ap")
async def disable_ap_mode():
    """Disable Access Point mode"""
    try:
        # Stop hostapd and dnsmasq
        subprocess.run(["sudo", "systemctl", "stop", "hostapd"])
        subprocess.run(["sudo", "systemctl", "stop", "dnsmasq"])
        
        print("📡 AP mode disabled")
        return {"success": True}
    except Exception as e:
        print(f"Error disabling AP mode: {e}")
        return {"success": False}

def disable_ap_mode():
    """Internal function to disable AP"""
    try:
        subprocess.run(["sudo", "systemctl", "stop", "hostapd"])
        subprocess.run(["sudo", "systemctl", "stop", "dnsmasq"])
    except:
        pass

# ============= SCALE ENDPOINTS =============

@app.websocket("/ws/scale")
async def websocket_scale(websocket: WebSocket):
    """WebSocket endpoint for real-time weight data"""
    await websocket.accept()
    active_connections.append(websocket)
    
    try:
        while True:
            if scale_serial and scale_serial.is_open:
                try:
                    # Read line from ESP32
                    if scale_serial.in_waiting > 0:
                        line = scale_serial.readline().decode('utf-8').strip()
                        
                        # Expected format from ESP32: {"weight":123.45,"stable":true,"unit":"g"}
                        try:
                            data = json.loads(line)
                            await websocket.send_json(data)
                        except json.JSONDecodeError:
                            # If not JSON, try to parse as simple number
                            try:
                                weight = float(line)
                                await websocket.send_json({
                                    "weight": weight,
                                    "stable": True,
                                    "unit": "g"
                                })
                            except ValueError:
                                pass
                except Exception as e:
                    print(f"Error reading from scale: {e}")
            
            # Send heartbeat even if no data
            await asyncio.sleep(0.1)
            
    except WebSocketDisconnect:
        active_connections.remove(websocket)
    except Exception as e:
        print(f"WebSocket error: {e}")
        if websocket in active_connections:
            active_connections.remove(websocket)

@app.post("/api/scale/tare")
async def scale_tare():
    """Send tare command to scale"""
    if scale_serial and scale_serial.is_open:
        try:
            scale_serial.write(b"TARE\n")
            return {"success": True, "message": "Tare command sent"}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
    else:
        raise HTTPException(status_code=503, detail="Scale not connected")

@app.post("/api/scale/zero")
async def scale_zero():
    """Send zero/calibrate command to scale"""
    if scale_serial and scale_serial.is_open:
        try:
            scale_serial.write(b"ZERO\n")
            return {"success": True, "message": "Zero command sent"}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
    else:
        raise HTTPException(status_code=503, detail="Scale not connected")

@app.get("/api/scale/status")
async def scale_status():
    """Get scale connection status"""
    connected = scale_serial is not None and scale_serial.is_open
    serial_config = get_serial_config()
    
    return {
        "connected": connected,
        "port": serial_config["port"],
        "baud": serial_config["baud"]
    }

if __name__ == "__main__":
    import uvicorn
    
    print("=" * 60)
    print("🌐 Mini-Web Configuration Server + Scale Backend")
    print("=" * 60)
    print(f"📍 Access URL: http://192.168.4.1:8080")
    print(f"🔐 PIN: {CURRENT_PIN}")
    print("=" * 60)
    
    uvicorn.run(app, host="0.0.0.0", port=8080)
