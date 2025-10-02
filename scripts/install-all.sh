#!/bin/bash
#
# Script de instalación completa para Báscula Inteligente
# Instala el sistema completo en Raspberry Pi 5 con OS Lite
# Optimizado para pantalla táctil 7" (1024x600)
#

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Instalación Completa - Báscula Inteligente${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
   echo -e "${RED}No ejecutes este script como root${NC}"
   echo "Por favor ejecuta: bash install-all.sh"
   exit 1
fi

# Detect architecture
ARCH=$(uname -m)
if [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "armv7l" ]; then
    echo -e "${YELLOW}Advertencia: No se detectó arquitectura ARM. Este script está diseñado para Raspberry Pi.${NC}"
    read -p "¿Continuar de todos modos? (s/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Ss]$ ]]; then
        exit 1
    fi
fi

# Check internet connection
echo -e "${YELLOW}[1/15] Verificando conexión a Internet...${NC}"
if ! ping -c 1 google.com &> /dev/null; then
    echo -e "${RED}Error: No hay conexión a Internet${NC}"
    echo "Por favor verifica tu conexión WiFi e intenta nuevamente"
    exit 1
fi
echo -e "${GREEN}✓ Conexión verificada${NC}"

# Update system
echo -e "${YELLOW}[2/15] Actualizando el sistema...${NC}"
sudo apt update
sudo apt upgrade -y
echo -e "${GREEN}✓ Sistema actualizado${NC}"

# Install Node.js and npm
echo -e "${YELLOW}[3/15] Instalando Node.js...${NC}"
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
fi
echo -e "${GREEN}✓ Node.js $(node --version) instalado${NC}"

# Install system dependencies
echo -e "${YELLOW}[4/15] Instalando dependencias del sistema...${NC}"
sudo apt install -y \
    nginx \
    python3 \
    python3-pip \
    python3-venv \
    git \
    unclutter \
    chromium-browser \
    xserver-xorg \
    x11-xserver-utils \
    xinit \
    openbox \
    alsa-utils \
    pulseaudio \
    i2c-tools \
    python3-smbus
echo -e "${GREEN}✓ Dependencias instaladas${NC}"

# Install Python dependencies
echo -e "${YELLOW}[5/15] Instalando dependencias Python del sistema...${NC}"
sudo apt install -y \
    python3-picamera2 \
    python3-serial \
    python3-opencv \
    libatlas-base-dev
echo -e "${GREEN}✓ Dependencias Python del sistema instaladas${NC}"

# Setup Python virtual environment for backend
echo -e "${YELLOW}[6/15] Configurando entorno Python para backend...${NC}"
BACKEND_DIR="/home/pi/bascula-backend"
mkdir -p "$BACKEND_DIR"
python3 -m venv "$BACKEND_DIR/venv"
source "$BACKEND_DIR/venv/bin/activate"

# Install Python packages for backend
pip install --upgrade pip
pip install \
    fastapi \
    uvicorn[standard] \
    websockets \
    python-multipart \
    pyserial \
    opencv-python \
    numpy \
    pillow \
    aiofiles \
    httpx

deactivate
echo -e "${GREEN}✓ Entorno Python backend configurado${NC}"

# Configure hardware permissions
echo -e "${YELLOW}[7/15] Configurando permisos de hardware...${NC}"
# Add user to required groups
sudo usermod -aG video pi
sudo usermod -aG dialout pi
sudo usermod -aG i2c pi
sudo usermod -aG gpio pi
sudo usermod -aG audio pi

# Enable I2C for audio (MAX98357A)
if ! grep -q "^dtparam=i2c_arm=on" /boot/config.txt; then
    echo "dtparam=i2c_arm=on" | sudo tee -a /boot/config.txt
fi

# Enable serial for ESP32
if ! grep -q "^enable_uart=1" /boot/config.txt; then
    echo "enable_uart=1" | sudo tee -a /boot/config.txt
fi

# Configure screen resolution for 7" display (1024x600)
if ! grep -q "^hdmi_force_hotplug=1" /boot/config.txt; then
    sudo tee -a /boot/config.txt > /dev/null <<SCREENEOF

# 7" Display Configuration
hdmi_force_hotplug=1
hdmi_group=2
hdmi_mode=87
hdmi_cvt=1024 600 60 6 0 0 0
disable_overscan=1
SCREENEOF
fi

echo -e "${GREEN}✓ Permisos configurados${NC}"

# Clone/setup frontend project
echo -e "${YELLOW}[8/15] Configurando proyecto frontend...${NC}"
PROJECT_DIR="/home/pi/bascula-ui"
if [ -d "$PROJECT_DIR" ]; then
    echo "El directorio del proyecto ya existe"
    read -p "¿Sobrescribir? (s/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Ss]$ ]]; then
        rm -rf "$PROJECT_DIR"
    else
        echo "Usando proyecto existente"
    fi
fi

if [ ! -d "$PROJECT_DIR" ]; then
    mkdir -p "$PROJECT_DIR"
    # Copy project files here
    echo "Copiando archivos del proyecto..."
fi

cd "$PROJECT_DIR"

# Install npm dependencies and build
echo -e "${YELLOW}[9/15] Instalando dependencias de Node.js...${NC}"
npm install
echo -e "${GREEN}✓ Dependencias instaladas${NC}"

echo -e "${YELLOW}[10/15] Compilando aplicación web...${NC}"
npm run build
echo -e "${GREEN}✓ Aplicación compilada${NC}"

# Configure Nginx
echo -e "${YELLOW}[11/15] Configurando Nginx...${NC}"
sudo tee /etc/nginx/sites-available/bascula > /dev/null <<EOF
server {
    listen 80 default_server;
    server_name _;
    root $PROJECT_DIR/dist;
    index index.html;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    # SPA routing
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Proxy for backend API
    location /api {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }

    # WebSocket
    location /ws {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/bascula /etc/nginx/sites-enabled/bascula
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx
echo -e "${GREEN}✓ Nginx configurado${NC}"

# Setup Chromium kiosk mode
echo -e "${YELLOW}[12/15] Configurando modo kiosk...${NC}"
cat > /home/pi/start-bascula.sh <<'KIOSKEOF'
#!/bin/bash
# Wait for X server
sleep 5

# Hide cursor
unclutter -idle 0 &

# Start Chromium in kiosk mode
chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI \
  --check-for-update-interval=31536000 \
  --start-fullscreen \
  http://localhost
KIOSKEOF

chmod +x /home/pi/start-bascula.sh

# Create systemd service
sudo tee /etc/systemd/system/bascula-ui.service > /dev/null <<EOF
[Unit]
Description=Bascula UI Kiosk
After=network.target nginx.service

[Service]
Type=simple
User=pi
Environment=DISPLAY=:0
ExecStart=/home/pi/start-bascula.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable bascula-ui.service
echo -e "${GREEN}✓ Modo kiosk configurado${NC}"

# Setup X server auto-start
echo -e "${YELLOW}[13/15] Configurando arranque automático...${NC}"
if ! grep -q "startx" /home/pi/.bash_profile; then
    echo '[[ -z $DISPLAY && $XDG_VTNR -eq 1 ]] && startx' >> /home/pi/.bash_profile
fi

# Create minimal openbox config
mkdir -p /home/pi/.config/openbox
cat > /home/pi/.config/openbox/autostart <<'OPENBOXEOF'
# Disable screen blanking
xset s off
xset -dpms
xset s noblank

# Start bascula UI
/home/pi/start-bascula.sh &
OPENBOXEOF

echo -e "${GREEN}✓ Arranque automático configurado${NC}"

# Create backend service template
echo -e "${YELLOW}[14/15] Configurando servicio backend...${NC}"
cat > "$BACKEND_DIR/main.py" <<'BACKENDEOF'
"""
Báscula Inteligente - Backend FastAPI
Este es un template. Implementa tus servicios aquí.
"""
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
import asyncio

app = FastAPI(title="Bascula Backend")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    return {"status": "ok", "message": "Bascula Backend Running"}

@app.websocket("/ws/scale")
async def websocket_scale(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            # TODO: Implementar lectura del ESP32 + HX711
            weight_data = {
                "weight": 0.0,
                "stable": True,
                "unit": "g"
            }
            await websocket.send_json(weight_data)
            await asyncio.sleep(0.1)
    except Exception as e:
        print(f"WebSocket error: {e}")
    finally:
        await websocket.close()

@app.post("/api/scale/tare")
async def tare_scale():
    # TODO: Implementar tara
    return {"status": "ok"}

@app.post("/api/scale/zero")
async def zero_scale():
    # TODO: Implementar zero
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
BACKENDEOF

# Create backend systemd service
sudo tee /etc/systemd/system/bascula-backend.service > /dev/null <<EOF
[Unit]
Description=Bascula Backend FastAPI
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=$BACKEND_DIR
Environment="PATH=$BACKEND_DIR/venv/bin"
ExecStart=$BACKEND_DIR/venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8080
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable bascula-backend.service
echo -e "${GREEN}✓ Servicio backend configurado${NC}"

# Create environment file template
echo -e "${YELLOW}[15/15] Creando archivos de configuración...${NC}"
cat > "$PROJECT_DIR/.env" <<'ENVEOF'
# Backend API Configuration
VITE_API_URL=http://localhost:8080
VITE_WS_URL=ws://localhost:8080

# Optional: Override for specific IP
# VITE_API_URL=http://192.168.1.100:8080
# VITE_WS_URL=ws://192.168.1.100:8080
ENVEOF

# Create backend config file
cat > "$BACKEND_DIR/.env" <<'BACKENDENVEOF'
# Backend Configuration
API_PORT=8080
SERIAL_PORT=/dev/ttyUSB0
BAUD_RATE=115200

# ChatGPT API (opcional)
# OPENAI_API_KEY=your_key_here

# Nightscout (opcional)
# NIGHTSCOUT_URL=https://your-nightscout.herokuapp.com
# NIGHTSCOUT_TOKEN=your_token_here
BACKENDENVEOF

echo -e "${GREEN}✓ Configuración creada${NC}"

# Install debugging tools
echo -e "${YELLOW}Instalando herramientas de debugging...${NC}"
sudo npm install -g wscat 2>/dev/null || true

# Final instructions
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  ¡Instalación Completada!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "${BLUE}Sistema instalado con éxito:${NC}"
echo "  ✅ Frontend React en: $PROJECT_DIR"
echo "  ✅ Backend FastAPI en: $BACKEND_DIR"
echo "  ✅ Nginx configurado"
echo "  ✅ Servicios systemd creados"
echo "  ✅ Pantalla 7\" táctil optimizada"
echo ""
echo -e "${YELLOW}═══════════════════════════════════════════${NC}"
echo -e "${YELLOW}  CONFIGURACIÓN REQUERIDA${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════${NC}"
echo ""
echo -e "${RED}⚠ IMPORTANTE: Se requiere REINICIO${NC}"
echo "   Los cambios de hardware necesitan reinicio del sistema"
echo ""
echo "1️⃣  Edita configuración frontend:"
echo "   nano $PROJECT_DIR/.env"
echo ""
echo "2️⃣  Edita configuración backend:"
echo "   nano $BACKEND_DIR/.env"
echo ""
echo "3️⃣  Implementa tu código backend:"
echo "   nano $BACKEND_DIR/main.py"
echo "   (Conectar ESP32, cámara, Nightscout, etc.)"
echo ""
echo "4️⃣  REINICIA el sistema:"
echo "   ${RED}sudo reboot${NC}"
echo ""
echo -e "${YELLOW}═══════════════════════════════════════════${NC}"
echo -e "${YELLOW}  COMANDOS ÚTILES${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════${NC}"
echo ""
echo "📊 Ver logs del frontend:"
echo "   journalctl -u bascula-ui.service -f"
echo ""
echo "📊 Ver logs del backend:"
echo "   journalctl -u bascula-backend.service -f"
echo ""
echo "🔧 Reiniciar servicios:"
echo "   sudo systemctl restart bascula-backend.service"
echo "   sudo systemctl restart bascula-ui.service"
echo ""
echo "🧪 Probar WebSocket (después de reiniciar):"
echo "   wscat -c ws://localhost:8080/ws/scale"
echo ""
echo "🔍 Verificar hardware:"
echo "   ls -la /dev/ttyUSB* /dev/ttyACM*  # ESP32 serial"
echo "   libcamera-hello                   # Cámara"
echo "   i2cdetect -y 1                    # I2C audio"
echo ""
echo "🌐 Acceder a la aplicación:"
echo "   http://localhost (en la Raspberry Pi)"
echo "   http://$(hostname -I | awk '{print $1}') (desde otro dispositivo)"
echo ""
echo -e "${YELLOW}═══════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}📚 Documentación:${NC}"
echo "   $PROJECT_DIR/INTEGRATION.md  - Integración backend"
echo "   $PROJECT_DIR/DEPLOYMENT.md   - Guía despliegue"
echo "   $PROJECT_DIR/TODO.md         - Tareas pendientes"
echo ""
echo -e "${GREEN}¡Disfruta de tu báscula inteligente!${NC}"
