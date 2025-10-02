"""
Mini-Web Configuration Server
Runs on AP mode for WiFi configuration
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import subprocess
import os
import random
import string

app = FastAPI()

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

if __name__ == "__main__":
    import uvicorn
    
    print("=" * 60)
    print("🌐 Mini-Web Configuration Server")
    print("=" * 60)
    print(f"📍 Access URL: http://192.168.4.1:8080")
    print(f"🔐 PIN: {CURRENT_PIN}")
    print("=" * 60)
    
    uvicorn.run(app, host="0.0.0.0", port=8080)
