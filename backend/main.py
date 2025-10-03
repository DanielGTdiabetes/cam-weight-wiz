"""
Bascula Backend - Complete FastAPI Server
Includes: Scale, Camera, OCR, Timer, Nightscout, TTS, Recipes, Settings, OTA
"""

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, File, Form
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from contextlib import asynccontextmanager
from copy import deepcopy
from typing import Optional, Dict, Any, List
import asyncio
import serial
import json
import os
import subprocess
import time
import tarfile
import tempfile
import shutil
from io import BytesIO
from pathlib import Path
import math
from uuid import uuid4
from datetime import datetime
import httpx
import re

# Configuration
CONFIG_PATH = os.path.expanduser("~/.bascula/config.json")
DEFAULT_SERIAL_PORT = "/dev/serial0"
DEFAULT_BAUD_RATE = 115200

# Global state
scale_serial: Optional[serial.Serial] = None
active_websockets: list[WebSocket] = []
timer_task: Optional[asyncio.Task] = None
timer_state = {"running": False, "remaining": 0, "total": 0}

# Recipe knowledge base for deterministic guidance
RECIPE_DATABASE: List[Dict[str, Any]] = [
    {
        "id": "pasta_tomate",
        "title": "Pasta con salsa de tomate",
        "keywords": ["pasta", "espagueti", "tomate", "spaghetti", "macarrón"],
        "default_servings": 2,
        "ingredients": [
            {"name": "Pasta seca", "quantity": 200, "unit": "g", "needs_scale": True},
            {"name": "Tomate triturado", "quantity": 300, "unit": "g", "needs_scale": False},
            {"name": "Aceite de oliva", "quantity": 15, "unit": "ml", "needs_scale": False},
            {"name": "Albahaca fresca", "quantity": 10, "unit": "g", "needs_scale": False},
        ],
        "steps": [
            {
                "instruction": "Llena una olla grande con 2 litros de agua, añade una cucharada de sal y ponla a hervir.",
                "tip": "Si pones la tapa, el agua hervirá más rápido.",
            },
            {
                "instruction": "Pesa 100 g de pasta por ración en la báscula y agrégala al agua hirviendo.",
                "needs_scale": True,
                "expected_weight": 100,
                "tip": "Remueve al principio para que no se pegue.",
            },
            {
                "instruction": "Cocina la pasta siguiendo el tiempo del paquete (normalmente 8-10 minutos).", 
                "timer": 600,
                "tip": "Prueba la pasta un minuto antes para lograr el punto al dente.",
            },
            {
                "instruction": "Calienta el tomate triturado con una pizca de sal, pimienta y un chorrito de aceite.",
                "tip": "Añade hojas de albahaca al final para mantener su aroma.",
            },
            {
                "instruction": "Escurre la pasta, mezcla con la salsa y sirve inmediatamente.",
            },
        ],
    },
    {
        "id": "ensalada_quinoa",
        "title": "Ensalada templada de quinoa",
        "keywords": ["quinoa", "ensalada", "vegetariana"],
        "default_servings": 2,
        "ingredients": [
            {"name": "Quinoa", "quantity": 160, "unit": "g", "needs_scale": True},
            {"name": "Caldo de verduras", "quantity": 320, "unit": "ml", "needs_scale": False},
            {"name": "Garbanzos cocidos", "quantity": 200, "unit": "g", "needs_scale": True},
            {"name": "Pimiento rojo", "quantity": 80, "unit": "g", "needs_scale": True},
            {"name": "Pepino", "quantity": 80, "unit": "g", "needs_scale": True},
        ],
        "steps": [
            {
                "instruction": "Enjuaga la quinoa bajo el grifo hasta que el agua salga limpia.",
            },
            {
                "instruction": "Pesa 80 g de quinoa por ración y cuécela en el caldo durante 12 minutos.",
                "needs_scale": True,
                "expected_weight": 80,
                "tip": "La quinoa está lista cuando los granos se ven translúcidos.",
                "timer": 720,
            },
            {
                "instruction": "Corta el pimiento y el pepino en dados pequeños (aprox. 1 cm).",
            },
            {
                "instruction": "Mezcla la quinoa con los garbanzos, el pimiento, el pepino y aliña al gusto.",
            },
        ],
    },
    {
        "id": "pollo_asado",
        "title": "Pechuga de pollo marinada al horno",
        "keywords": ["pollo", "horno", "pechuga"],
        "default_servings": 2,
        "ingredients": [
            {"name": "Pechuga de pollo", "quantity": 300, "unit": "g", "needs_scale": True},
            {"name": "Zumo de limón", "quantity": 30, "unit": "ml", "needs_scale": False},
            {"name": "Aceite de oliva", "quantity": 15, "unit": "ml", "needs_scale": False},
            {"name": "Ajo picado", "quantity": 5, "unit": "g", "needs_scale": False},
        ],
        "steps": [
            {
                "instruction": "Precalienta el horno a 200 °C calor arriba y abajo.",
                "timer": 600,
            },
            {
                "instruction": "Pesa 150 g de pechuga por ración y marínala con aceite, limón, ajo, sal y pimienta.",
                "needs_scale": True,
                "expected_weight": 150,
                "tip": "Deja reposar la marinada al menos 15 minutos.",
                "timer": 900,
            },
            {
                "instruction": "Coloca el pollo en una bandeja y hornea durante 18-20 minutos.",
                "timer": 1200,
                "tip": "El jugo debe salir transparente cuando pinches el pollo.",
            },
            {
                "instruction": "Deja reposar el pollo 5 minutos antes de cortarlo.",
                "timer": 300,
            },
        ],
    },
]

active_recipes: Dict[str, Dict[str, Any]] = {}


GITHUB_REPO = "DanielGTdiabetes/bascula-ui"
RELEASES_DIR = Path(os.getenv("BASCULA_RELEASES_DIR", Path.home() / ".bascula" / "releases"))
DOWNLOADS_DIR = Path(os.getenv("BASCULA_DOWNLOADS_DIR", Path.home() / ".bascula" / "downloads"))
CURRENT_SYMLINK = RELEASES_DIR / "current"
VERSION_FILE = Path(os.getenv("BASCULA_VERSION_FILE", Path.home() / ".bascula" / "VERSION"))


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
    servings: Optional[int] = None


class RecipeNext(BaseModel):
    recipeId: str
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
            scale_serial.write(b"TARE
")
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
            scale_serial.write(b"ZERO
")
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
    """Analyze food from camera image using a lightweight color heuristic"""
    if weight <= 0:
        raise HTTPException(status_code=400, detail="El peso debe ser mayor que cero")

    raw_bytes = await image.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="No se recibió imagen para analizar")

    try:
        from PIL import Image  # type: ignore
    except ImportError as exc:
        raise HTTPException(
            status_code=500,
            detail="Pillow no está instalado en el backend. Instala 'pillow' para habilitar el análisis de imágenes."
        ) from exc

    try:
        img = Image.open(BytesIO(raw_bytes)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Imagen inválida: {exc}") from exc

    pixels = list(img.getdata())
    if not pixels:
        raise HTTPException(status_code=400, detail="No se pudieron leer los píxeles de la imagen")

    max_samples = 50000
    step = max(len(pixels) // max_samples, 1)
    sampled = pixels[::step] or pixels

    avg_r = sum(p[0] for p in sampled) / len(sampled)
    avg_g = sum(p[1] for p in sampled) / len(sampled)
    avg_b = sum(p[2] for p in sampled) / len(sampled)

    food_profiles = [
        {
            "name": "Manzana Roja",
            "rgb": (180, 45, 40),
            "glycemic_index": 40,
            "macros_per_100": {"carbs": 14.0, "proteins": 0.3, "fats": 0.2},
        },
        {
            "name": "Banana",
            "rgb": (225, 205, 80),
            "glycemic_index": 51,
            "macros_per_100": {"carbs": 23.0, "proteins": 1.3, "fats": 0.3},
        },
        {
            "name": "Tomate",
            "rgb": (185, 60, 55),
            "glycemic_index": 38,
            "macros_per_100": {"carbs": 3.9, "proteins": 0.9, "fats": 0.2},
        },
        {
            "name": "Brócoli",
            "rgb": (95, 135, 75),
            "glycemic_index": 15,
            "macros_per_100": {"carbs": 7.0, "proteins": 2.8, "fats": 0.4},
        },
        {
            "name": "Pollo Cocido",
            "rgb": (200, 180, 150),
            "glycemic_index": 0,
            "macros_per_100": {"carbs": 0.0, "proteins": 31.0, "fats": 3.6},
        },
        {
            "name": "Arroz Blanco",
            "rgb": (220, 220, 200),
            "glycemic_index": 73,
            "macros_per_100": {"carbs": 28.0, "proteins": 2.7, "fats": 0.3},
        },
    ]

    def color_distance(profile_rgb: tuple[int, int, int]) -> float:
        pr, pg, pb = profile_rgb
        return math.sqrt((pr - avg_r) ** 2 + (pg - avg_g) ** 2 + (pb - avg_b) ** 2)

    ranked = sorted(food_profiles, key=lambda profile: color_distance(profile["rgb"]))
    best_match = ranked[0]
    max_distance = math.sqrt(3 * (255 ** 2))
    distance = color_distance(best_match["rgb"])
    confidence = max(0.1, 1 - (distance / max_distance))

    macros = {
        key: round(weight * value / 100, 2)
        for key, value in best_match["macros_per_100"].items()
    }

    return {
        "name": best_match["name"],
        "confidence": round(confidence, 2),
        "avg_color": {
            "r": round(avg_r, 2),
            "g": round(avg_g, 2),
            "b": round(avg_b, 2),
        },
        "nutrition": {
            "carbs": macros["carbs"],
            "proteins": macros["proteins"],
            "fats": macros["fats"],
            "glycemic_index": best_match["glycemic_index"],
        },
    }

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
    """Generate a deterministic recipe based on preset knowledge."""
    prompt = data.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Debes indicar qué receta deseas preparar")

    servings = data.servings or 2
    prompt_lower = prompt.lower()

    def pick_recipe() -> Dict[str, Any]:
        for recipe in RECIPE_DATABASE:
            if any(keyword in prompt_lower for keyword in recipe["keywords"]):
                return deepcopy(recipe)
        fallback = deepcopy(RECIPE_DATABASE[0])
        fallback["title"] = f"Receta básica para {prompt}" if prompt else fallback["title"]
        return fallback

    recipe = pick_recipe()
    recipe_id = str(uuid4())

    default_servings = recipe.get("default_servings") or 2
    scale_factor = servings / default_servings if default_servings else 1

    scaled_ingredients = []
    for ingredient in recipe.get("ingredients", []):
        quantity = ingredient.get("quantity")
        scaled_quantity = round(quantity * scale_factor, 2) if quantity is not None else None
        scaled_ingredients.append({
            **ingredient,
            "quantity": scaled_quantity,
        })

    normalized_steps = []
    total_timer = 0
    for idx, raw_step in enumerate(recipe.get("steps", []), start=1):
        expected_weight = raw_step.get("expected_weight")
        scaled_weight = round(expected_weight * scale_factor, 2) if expected_weight else None
        step_timer = raw_step.get("timer", 0)
        total_timer += step_timer or 0

        normalized_steps.append({
            "index": idx,
            "instruction": raw_step["instruction"],
            "needsScale": raw_step.get("needs_scale", False),
            "expectedWeight": scaled_weight,
            "tip": raw_step.get("tip"),
            "timer": step_timer,
        })

    active_recipes[recipe_id] = {
        "id": recipe_id,
        "title": recipe.get("title", "Receta"),
        "servings": servings,
        "steps": normalized_steps,
        "raw_steps": recipe.get("steps", []),
    }

    return {
        "id": recipe_id,
        "title": recipe.get("title", "Receta"),
        "servings": servings,
        "ingredients": scaled_ingredients,
        "steps": normalized_steps,
        "estimatedTime": math.ceil(total_timer / 60) if total_timer else None,
    }


def _extract_weight(response: str | None) -> float | None:
    if not response:
        return None
    match = re.search(r"(\d+[\.,]?\d*)", response)
    if not match:
        return None
    value = match.group(1).replace(',', '.')
    try:
        return float(value)
    except ValueError:
        return None


@app.post("/api/recipes/next")
async def next_recipe_step(data: RecipeNext):
    """Return guidance for the next recipe step and evaluate user response."""
    recipe = active_recipes.get(data.recipeId)
    if not recipe:
        raise HTTPException(status_code=404, detail="Receta no encontrada o finalizada")

    steps = recipe["steps"]
    if data.currentStep >= len(steps):
        active_recipes.pop(data.recipeId, None)
        return {
            "isLast": True,
            "assistantMessage": "Receta finalizada. ¡Buen provecho!",
        }

    step = steps[data.currentStep]
    expected_weight = step.get("expectedWeight")
    measured_weight = _extract_weight(data.userResponse)

    assistant_message = step.get("tip")
    if step.get("needsScale") and expected_weight:
        if measured_weight is None:
            assistant_message = assistant_message or "Recuerda confirmar el peso en gramos para ajustar la receta."
        else:
            diff = abs(measured_weight - expected_weight)
            tolerance = max(5, expected_weight * 0.1)
            if diff <= tolerance:
                assistant_message = "Peso correcto, podemos continuar con la receta."
            elif measured_weight < expected_weight:
                assistant_message = (
                    f"Solo registraste {measured_weight:.0f} g. Añade {expected_weight - measured_weight:.0f} g para llegar a la cantidad recomendada."
                )
            else:
                assistant_message = (
                    f"Has sobrepasado el peso objetivo en {measured_weight - expected_weight:.0f} g. Ajusta o tenlo en cuenta para el resto de ingredientes."
                )
    elif data.userResponse and not assistant_message:
        assistant_message = f"Anotado: {data.userResponse.strip()}"

    is_last = data.currentStep == len(steps) - 1
    if is_last:
        active_recipes.pop(data.recipeId, None)

    return {
        "step": step,
        "isLast": is_last,
        "assistantMessage": assistant_message,
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
        
        lines = result.stdout.strip().splitlines()
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
                    for ip_line in ip_result.stdout.splitlines():
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
        current_version = "desconocido"
        if VERSION_FILE.exists():
            try:
                current_version = VERSION_FILE.read_text(encoding="utf-8").strip() or "desconocido"
            except Exception:
                current_version = "desconocido"

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
    """Download and unpack the latest release from GitHub"""
    try:
        DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
        RELEASES_DIR.mkdir(parents=True, exist_ok=True)

        async with httpx.AsyncClient(timeout=30) as client:
            release_resp = await client.get(f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest")
            release_resp.raise_for_status()
            release = release_resp.json()

        tag = release.get("tag_name")
        tarball_url = release.get("tarball_url")
        if not tag or not tarball_url:
            raise HTTPException(status_code=404, detail="No se encontró una release válida")

        download_path = DOWNLOADS_DIR / f"{tag}.tar.gz"
        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream("GET", tarball_url) as download:
                download.raise_for_status()
                with open(download_path, "wb") as file_stream:
                    async for chunk in download.aiter_bytes():
                        file_stream.write(chunk)

        with tempfile.TemporaryDirectory() as temp_dir:
            with tarfile.open(download_path, "r:gz") as archive:
                archive.extractall(temp_dir)

            temp_path = Path(temp_dir)
            extracted_dirs = [item for item in temp_path.iterdir() if item.is_dir()]
            if not extracted_dirs:
                raise HTTPException(status_code=500, detail="El paquete descargado está vacío")
            extracted_root = extracted_dirs[0]

            target_dir = RELEASES_DIR / tag
            if target_dir.exists():
                shutil.rmtree(target_dir)
            shutil.copytree(extracted_root, target_dir)

        try:
            VERSION_FILE.parent.mkdir(parents=True, exist_ok=True)
            VERSION_FILE.write_text(tag, encoding="utf-8")
        except Exception as exc:
            print(f"No se pudo actualizar VERSION local: {exc}")

        try:
            if CURRENT_SYMLINK.is_symlink() or CURRENT_SYMLINK.exists():
                CURRENT_SYMLINK.unlink()
            CURRENT_SYMLINK.symlink_to(target_dir, target_is_directory=True)
            symlink_message = "symlink actualizado"
        except (OSError, NotImplementedError) as exc:
            symlink_message = f"no se pudo crear symlink: {exc}"
            pointer_file = RELEASES_DIR / "current_path.txt"
            pointer_file.write_text(str(target_dir), encoding="utf-8")

        return {
            "success": True,
            "version": tag,
            "release_dir": str(target_dir),
            "message": symlink_message,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Instalación falló: {exc}")

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
