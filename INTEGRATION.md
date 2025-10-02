# Guía de Integración - Báscula Inteligente

## Arquitectura de la Aplicación

Esta aplicación web React se comunica con tu backend Python/FastAPI existente que ya gestiona:
- ESP32 + HX711 (báscula)
- Cámara Module 3
- Audio (MAX98357A)
- Mini-web (FastAPI)
- Servicios de Nightscout

## Configuración del Backend

### 1. Habilitar CORS en tu Mini-web FastAPI

En tu archivo principal de FastAPI (probablemente `bascula/miniweb/app.py` o similar):

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

# Configurar CORS para permitir la conexión desde la UI web
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # En producción, especifica la URL de tu app
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

### 2. Endpoints Necesarios

Necesitarás exponer estos endpoints en tu FastAPI:

#### Báscula (WebSocket recomendado para tiempo real)

```python
from fastapi import WebSocket

@app.websocket("/ws/scale")
async def websocket_scale(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            # Enviar datos de peso desde ESP32
            weight_data = {
                "weight": get_current_weight(),  # Tu función existente
                "stable": is_weight_stable(),     # Tu función existente
                "unit": "g"
            }
            await websocket.send_json(weight_data)
            await asyncio.sleep(0.1)  # Actualizar cada 100ms
    except Exception as e:
        print(f"WebSocket error: {e}")
    finally:
        await websocket.close()

@app.post("/api/scale/tare")
async def tare_scale():
    # Tu código existente de tara
    serial_scale.tare()
    return {"status": "ok"}

@app.post("/api/scale/zero")
async def zero_scale():
    # Tu código existente de zero
    serial_scale.zero()
    return {"status": "ok"}
```

#### Escáner de Alimentos

```python
@app.post("/api/scanner/analyze")
async def analyze_food(image: UploadFile):
    # Tu código existente con ChatGPT o IA local
    result = await food_recognizer.analyze(image)
    return {
        "name": result.name,
        "nutrition": {
            "carbs": result.carbs,
            "proteins": result.proteins,
            "fats": result.fats,
            "glycemic_index": result.gi
        },
        "confidence": result.confidence
    }
```

#### Temporizador

```python
@app.post("/api/timer/start")
async def start_timer(seconds: int):
    # Tu código existente de temporizador
    timer_service.start(seconds)
    return {"status": "started", "seconds": seconds}

@app.get("/api/timer/status")
async def timer_status():
    return {
        "running": timer_service.is_running(),
        "remaining": timer_service.get_remaining()
    }
```

#### Nightscout

```python
@app.get("/api/nightscout/glucose")
async def get_glucose():
    # Tu código existente de Nightscout
    data = nightscout_service.get_latest()
    return {
        "glucose": data.glucose,
        "trend": data.trend  # "up", "down", "stable"
    }
```

## Configuración del Frontend React

### 1. Variables de Entorno

Crea un archivo `.env` en la raíz del proyecto React:

```bash
VITE_API_URL=http://localhost:8080
VITE_WS_URL=ws://localhost:8080
```

### 2. Integrar WebSocket para la Báscula

Actualiza `src/pages/ScaleView.tsx`:

```typescript
useEffect(() => {
  const ws = new WebSocket(`${import.meta.env.VITE_WS_URL}/ws/scale`);
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    setWeight(data.weight);
    setIsStable(data.stable);
    setUnit(data.unit);
  };

  ws.onerror = (error) => {
    console.error("WebSocket error:", error);
  };

  return () => {
    ws.close();
  };
}, []);
```

### 3. Conectar Botones de Control

```typescript
const handleTare = async () => {
  try {
    await fetch(`${import.meta.env.VITE_API_URL}/api/scale/tare`, {
      method: 'POST',
    });
  } catch (error) {
    console.error("Error en tara:", error);
  }
};

const handleZero = async () => {
  try {
    await fetch(`${import.meta.env.VITE_API_URL}/api/scale/zero`, {
      method: 'POST',
    });
  } catch (error) {
    console.error("Error en zero:", error);
  }
};
```

## Despliegue en Raspberry Pi

### Opción 1: Nginx + Build Estático (Recomendado)

1. **Build de la aplicación:**
```bash
npm run build
```

2. **Instalar Nginx:**
```bash
sudo apt install nginx
```

3. **Configurar Nginx** (`/etc/nginx/sites-available/bascula`):
```nginx
server {
    listen 80;
    server_name localhost;
    root /home/pi/bascula-ui/dist;
    index index.html;

    # SPA routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy para el backend FastAPI
    location /api {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # WebSocket
    location /ws {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
    }
}
```

4. **Activar configuración:**
```bash
sudo ln -s /etc/nginx/sites-available/bascula /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### Opción 2: Chromium en Modo Kiosk

Para ejecutar la app en pantalla completa sin barra de navegación:

1. **Script de inicio** (`/home/pi/start-bascula.sh`):
```bash
#!/bin/bash
# Esperar a que X esté listo
sleep 5

# Ocultar cursor
unclutter -idle 0 &

# Lanzar Chromium en modo kiosk
chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI \
  --check-for-update-interval=31536000 \
  http://localhost
```

2. **Hacer ejecutable:**
```bash
chmod +x /home/pi/start-bascula.sh
```

3. **Auto-inicio con systemd** (`/etc/systemd/system/bascula-ui.service`):
```ini
[Unit]
Description=Bascula UI Kiosk
After=network.target

[Service]
Type=simple
User=pi
Environment=DISPLAY=:0
ExecStart=/home/pi/start-bascula.sh
Restart=always

[Install]
WantedBy=multi-user.target
```

4. **Habilitar servicio:**
```bash
sudo systemctl enable bascula-ui.service
sudo systemctl start bascula-ui.service
```

## Próximos Pasos

1. ✅ Báscula con peso en tiempo real
2. ⏱️ Temporizador funcional
3. 📷 Escáner de alimentos con ChatGPT/IA
4. 🍽️ Modo recetas interactivo
5. 💉 Calculadora de bolos de insulina
6. 📊 Integración completa Nightscout
7. ⚙️ Panel de configuración
8. 🔄 Sistema OTA updates

## Notas Técnicas

- **WebSocket vs Polling**: Para la báscula, WebSocket es preferible por su baja latencia
- **Optimización**: Considera usar Service Workers para cache y funcionamiento offline
- **Seguridad**: En producción, configura HTTPS y autenticación adecuada
- **Performance**: La app está optimizada para 1024x600px, ajusta si tu pantalla difiere

## Contacto y Soporte

Para dudas sobre la integración, revisa tu código existente en:
- `bascula/services/scale.py` - Servicio de báscula
- `bascula/ui/app.py` - UI actual en Tkinter
- `bascula/miniweb/` - Mini-web FastAPI
