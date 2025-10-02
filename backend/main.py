"""
Bascula Backend - Complete FastAPI Server
Includes: Scale, Camera, OCR, Timer, Nightscout, TTS, Recipes, Settings, OTA
"""

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, File, Form
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from contextlib import asynccontextmanager
from typing import Optional
import asyncio
import serial
import json
import os
import subprocess
import time
from datetime import datetime
import httpx

# Configuration
CONFIG_PATH = os.path.expanduser("~/.bascula/config.json")
DEFAULT_SERIAL_PORT = "/dev/serial0"
DEFAULT_BAUD_RATE = 115200

# Global state
scale_serial: Optional[serial.Serial] = None
active_websockets: list[WebSocket] = []
timer_task: Optional[asyncio.Task] = None
timer_state = {"running": False, "remaining": 0, "total": 0}

# ============= MODELS =============

class TareCommand(BaseModel):
    pass

class ZeroCommand(BaseModel):
    pass

class CalibrationData(BaseModel):
    factor: float

class TimerStart(BaseModel):
    seconds: int

class BolusData(BaseModel):
    carbs: float
    insulin: float
    timestamp: str

class SpeakRequest(BaseModel):
    text: str
    voice: Optional[str] = "es_ES-mls_10246-medium"

class RecipeRequest(BaseModel):
    prompt: str

class RecipeNext(BaseModel):
    currentStep: int
    userResponse: Optional[str] = None

# ============= CONFIG HELPERS =============

def load_config():
    """Load configuration from JSON file"""
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r') as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading config: {e}")
    return {
        "general": {"sound_enabled": True, "volume": 70, "tts_enabled": True},
        "scale": {"port": DEFAULT_SERIAL_PORT, "baud": DEFAULT_BAUD_RATE, "calib_factor": 1.0, "unit": "g"},
        "network": {"miniweb_enabled": True, "miniweb_port": 8080},
        "diabetes": {"diabetes_enabled": False, "ns_url": "", "ns_token": ""},
    }

def save_config(config: dict):
    """Save configuration to JSON file"""
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, 'w') as f:
        json.dump(config, f, indent=2)

# ============= SERIAL/SCALE =============

async def init_scale():
    """Initialize serial connection to ESP32 scale"""
    global scale_serial
    try:
        config = load_config()
        port = config.get("scale", {}).get("port", DEFAULT_SERIAL_PORT)
        baud = config.get("scale", {}).get("baud", DEFAULT_BAUD_RATE)
        
        scale_serial = serial.Serial(port=port, baudrate=baud, timeout=1)
        print(f"✅ Scale connected on {port} @ {baud}")
    except Exception as e:
        print(f"⚠️  Scale not connected: {e}")
        scale_serial = None

async def close_scale():
    """Close serial connection"""
    global scale_serial
    if scale_serial and scale_serial.is_open:
        scale_serial.close()
        print("Scale connection closed")

# ============= APP LIFECYCLE =============

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events"""
    await init_scale()
    yield
    await close_scale()

app = FastAPI(title="Bascula Backend API", version="1.0", lifespan=lifespan)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============= SCALE ENDPOINTS =============

@app.websocket("/ws/scale")
async def websocket_scale(websocket: WebSocket):
    """WebSocket endpoint for real-time weight data"""
    await websocket.accept()
    active_websockets.append(websocket)
    
    try:
        while True:
            if scale_serial and scale_serial.is_open:
                try:
                    if scale_serial.in_waiting > 0:
                        line = scale_serial.readline().decode('utf-8').strip()
                        
                        try:
                            data = json.loads(line)
                            await websocket.send_json(data)
                        except json.JSONDecodeError:
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
            
            await asyncio.sleep(0.1)
            
    except WebSocketDisconnect:
        active_websockets.remove(websocket)
    except Exception as e:
        print(f"WebSocket error: {e}")
        if websocket in active_websockets:
            active_websockets.remove(websocket)

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

@app.post("/api/scale/calibrate")
async def set_calibration(data: CalibrationData):
    """Update calibration factor"""
    config = load_config()
    config["scale"]["calib_factor"] = data.factor
    save_config(config)
    return {"success": True, "factor": data.factor}

@app.get("/api/scale/status")
async def scale_status():
    """Get scale connection status"""
    connected = scale_serial is not None and scale_serial.is_open
    config = load_config()
    
    return {
        "connected": connected,
        "port": config.get("scale", {}).get("port", DEFAULT_SERIAL_PORT),
        "baud": config.get("scale", {}).get("baud", DEFAULT_BAUD_RATE)
    }

# ============= FOOD SCANNER =============

@app.post("/api/scanner/analyze")
async def analyze_food(image: UploadFile = File(...), weight: float = Form(...)):
    """Analyze food from camera image using AI/OCR"""
    try:
        # TODO: Implement real AI analysis with TFLite or external API
        # For now, return mock data
        
        # Save image temporarily
        img_path = f"/tmp/food_{int(time.time())}.jpg"
        with open(img_path, "wb") as f:
            f.write(await image.read())
        
        # Simulate AI processing
        await asyncio.sleep(1)
        
        # Mock response
        return {
            "name": "Alimento detectado",
            "confidence": 0.85,
            "nutrition": {
                "carbs": round(weight * 0.15),
                "proteins": round(weight * 0.03),
                "fats": round(weight * 0.01),
                "glycemic_index": 55
            }
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(img_path):
            os.remove(img_path)

@app.get("/api/scanner/barcode/{barcode}")
async def scan_barcode(barcode: str):
    """Get food info from barcode using OpenFoodFacts API"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"https://world.openfoodfacts.org/api/v0/product/{barcode}.json")
            data = response.json()
            
            if data.get("status") == 1:
                product = data["product"]
                nutriments = product.get("nutriments", {})
                
                return {
                    "name": product.get("product_name", "Producto desconocido"),
                    "confidence": 1.0,
                    "nutrition": {
                        "carbs": nutriments.get("carbohydrates_100g", 0),
                        "proteins": nutriments.get("proteins_100g", 0),
                        "fats": nutriments.get("fat_100g", 0),
                        "glycemic_index": 50  # Default
                    }
                }
            else:
                raise HTTPException(status_code=404, detail="Product not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ============= TIMER =============

async def timer_countdown(seconds: int):
    """Background task for countdown"""
    global timer_state
    timer_state["running"] = True
    timer_state["total"] = seconds
    timer_state["remaining"] = seconds
    
    while timer_state["remaining"] > 0 and timer_state["running"]:
        await asyncio.sleep(1)
        timer_state["remaining"] -= 1
    
    if timer_state["running"]:
        # Timer finished, play sound
        try:
            subprocess.run(["aplay", "/usr/share/sounds/alsa/Front_Center.wav"], check=False)
        except:
            pass
    
    timer_state["running"] = False
    timer_state["remaining"] = 0

@app.post("/api/timer/start")
async def start_timer(data: TimerStart):
    """Start countdown timer"""
    global timer_task
    
    if timer_task and not timer_task.done():
        timer_task.cancel()
    
    timer_task = asyncio.create_task(timer_countdown(data.seconds))
    return {"success": True, "seconds": data.seconds}

@app.post("/api/timer/stop")
async def stop_timer():
    """Stop running timer"""
    global timer_state, timer_task
    
    timer_state["running"] = False
    if timer_task and not timer_task.done():
        timer_task.cancel()
    
    return {"success": True}

@app.get("/api/timer/status")
async def get_timer_status():
    """Get current timer status"""
    return {
        "running": timer_state["running"],
        "remaining": timer_state["remaining"]
    }

# ============= NIGHTSCOUT =============

@app.get("/api/nightscout/glucose")
async def get_glucose():
    """Get current glucose from Nightscout"""
    config = load_config()
    ns_url = config.get("diabetes", {}).get("ns_url", "")
    ns_token = config.get("diabetes", {}).get("ns_token", "")
    
    if not ns_url:
        raise HTTPException(status_code=400, detail="Nightscout not configured")
    
    try:
        async with httpx.AsyncClient() as client:
            headers = {"API-SECRET": ns_token} if ns_token else {}
            response = await client.get(f"{ns_url}/api/v1/entries/current.json", headers=headers, timeout=5)
            data = response.json()
            
            if data and len(data) > 0:
                entry = data[0]
                return {
                    "glucose": entry.get("sgv", 0),
                    "trend": entry.get("direction", "Flat").lower(),
                    "timestamp": entry.get("dateString", "")
                }
            else:
                raise HTTPException(status_code=404, detail="No glucose data")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Nightscout error: {str(e)}")

@app.post("/api/nightscout/bolus")
async def export_bolus(data: BolusData):
    """Export bolus to Nightscout"""
    config = load_config()
    ns_url = config.get("diabetes", {}).get("ns_url", "")
    ns_token = config.get("diabetes", {}).get("ns_token", "")
    
    if not ns_url:
        raise HTTPException(status_code=400, detail="Nightscout not configured")
    
    try:
        treatment = {
            "eventType": "Meal Bolus",
            "carbs": data.carbs,
            "insulin": data.insulin,
            "created_at": data.timestamp,
            "enteredBy": "Bascula Digital"
        }
        
        async with httpx.AsyncClient() as client:
            headers = {"API-SECRET": ns_token, "Content-Type": "application/json"} if ns_token else {}
            response = await client.post(f"{ns_url}/api/v1/treatments", json=treatment, headers=headers)
            
            if response.status_code in [200, 201]:
                return {"success": True}
            else:
                raise HTTPException(status_code=500, detail="Failed to export")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ============= VOICE/TTS =============

@app.post("/api/voice/speak")
async def speak_text(data: SpeakRequest):
    """Convert text to speech using Piper TTS"""
    try:
        # Sanitize text to prevent command injection
        safe_text = data.text.replace('"', '\\"').replace('$', '\\$').replace('`', '\\`')
        
        # Use Piper TTS if installed
        if os.path.exists("/usr/local/bin/piper"):
            voice_model = f"/opt/piper/models/{data.voice}.onnx"
            if os.path.exists(voice_model):
                # Generate speech using piped commands safely
                echo_proc = subprocess.Popen(
                    ["echo", data.text],
                    stdout=subprocess.PIPE
                )
                piper_proc = subprocess.Popen(
                    ["piper", "--model", voice_model, "--output-raw"],
                    stdin=echo_proc.stdout,
                    stdout=subprocess.PIPE
                )
                subprocess.Popen(
                    ["aplay", "-r", "22050", "-f", "S16_LE"],
                    stdin=piper_proc.stdout
                )
                echo_proc.stdout.close()
                piper_proc.stdout.close()
                return {"success": True}
        
        # Fallback to espeak (already safe with list)
        subprocess.Popen(["espeak", "-v", "es", data.text])
        return {"success": True, "fallback": "espeak"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ============= RECIPES (AI) =============

@app.post("/api/recipes/generate")
async def generate_recipe(data: RecipeRequest):
    """Generate recipe using ChatGPT API"""
    config = load_config()
    # TODO: Implement ChatGPT integration
    # For now, return mock steps
    
    return {
        "steps": [
            f"Paso 1: Preparar los ingredientes para {data.prompt}",
            "Paso 2: Precalentar el horno a 180°C",
            "Paso 3: Mezclar ingredientes secos",
            "Paso 4: Añadir ingredientes húmedos",
            "Paso 5: Hornear durante 30 minutos"
        ]
    }

@app.post("/api/recipes/next")
async def next_recipe_step(data: RecipeNext):
    """Get next recipe step"""
    # TODO: Implement conversational AI
    return {
        "step": f"Paso {data.currentStep + 1}: Continúa con el siguiente paso",
        "needsScale": data.currentStep == 2  # Example
    }

# ============= SETTINGS =============

@app.get("/api/settings")
async def get_settings():
    """Get current settings"""
    return load_config()

@app.put("/api/settings")
async def update_settings(settings: dict):
    """Update settings"""
    try:
        save_config(settings)
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ============= NETWORK MANAGEMENT =============

@app.get("/api/network/status")
async def network_status():
    """Get current network status"""
    try:
        # Check if connected to WiFi
        result = subprocess.run(
            ["nmcli", "-t", "-f", "DEVICE,STATE,CONNECTION", "dev", "status"],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        lines = result.stdout.strip().split('\n')
        connected = False
        ssid = None
        ip = None
        
        for line in lines:
            parts = line.split(':')
            if len(parts) >= 3 and parts[1] == 'connected':
                connected = True
                ssid = parts[2] if parts[2] else None
                
                # Get IP address
                try:
                    ip_result = subprocess.run(
                        ["ip", "-4", "addr", "show", parts[0]],
                        capture_output=True,
                        text=True,
                        timeout=3
                    )
                    for ip_line in ip_result.stdout.split('\n'):
                        if 'inet ' in ip_line:
                            ip = ip_line.strip().split()[1].split('/')[0]
                            break
                except:
                    pass
                break
        
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
        raise HTTPException(status_code=500, detail=str(e))

# ============= OTA UPDATES =============

@app.get("/api/updates/check")
async def check_updates():
    """Check for available updates from GitHub"""
    try:
        # Get current version
        current_version = "v1"  # TODO: Read from version file
        
        # Check GitHub for latest release
        async with httpx.AsyncClient() as client:
            response = await client.get("https://api.github.com/repos/DanielGTdiabetes/bascula-ui/releases/latest")
            if response.status_code == 200:
                latest = response.json()
                latest_version = latest.get("tag_name", "")
                
                return {
                    "available": latest_version != current_version,
                    "version": latest_version
                }
        
        return {"available": False}
    except Exception as e:
        return {"available": False, "error": str(e)}

@app.post("/api/updates/install")
async def install_update():
    """Install available update"""
    try:
        # TODO: Implement OTA update logic
        # 1. Download new release
        # 2. Extract to /opt/bascula/releases/vX
        # 3. Update symlink
        # 4. Restart services
        
        return {"success": True, "message": "Update scheduled"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ============= HEALTH CHECK =============

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "ok",
        "scale_connected": scale_serial is not None and scale_serial.is_open,
        "timestamp": datetime.now().isoformat()
    }

@app.get("/")
async def root():
    """Root endpoint"""
    return {"message": "Bascula Backend API", "version": "1.0"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
