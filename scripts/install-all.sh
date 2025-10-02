#!/bin/bash
#
# Script de instalación completa para Báscula Inteligente
# Instala el sistema completo en Raspberry Pi 5 con OS Lite
#

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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
echo -e "${YELLOW}[1/12] Verificando conexión a Internet...${NC}"
if ! ping -c 1 google.com &> /dev/null; then
    echo -e "${RED}Error: No hay conexión a Internet${NC}"
    echo "Por favor verifica tu conexión WiFi e intenta nuevamente"
    exit 1
fi
echo -e "${GREEN}✓ Conexión verificada${NC}"

# Update system
echo -e "${YELLOW}[2/12] Actualizando el sistema...${NC}"
sudo apt update
sudo apt upgrade -y
echo -e "${GREEN}✓ Sistema actualizado${NC}"

# Install Node.js and npm
echo -e "${YELLOW}[3/12] Instalando Node.js...${NC}"
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
fi
echo -e "${GREEN}✓ Node.js $(node --version) instalado${NC}"

# Install system dependencies
echo -e "${YELLOW}[4/12] Instalando dependencias del sistema...${NC}"
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
    openbox
echo -e "${GREEN}✓ Dependencias instaladas${NC}"

# Install Python dependencies
echo -e "${YELLOW}[5/12] Configurando entorno Python...${NC}"
sudo apt install -y \
    python3-picamera2 \
    python3-serial \
    python3-opencv
echo -e "${GREEN}✓ Python configurado${NC}"

# Clone/setup project
echo -e "${YELLOW}[6/12] Configurando proyecto...${NC}"
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
echo -e "${YELLOW}[7/12] Instalando dependencias de Node.js...${NC}"
npm install
echo -e "${GREEN}✓ Dependencias instaladas${NC}"

echo -e "${YELLOW}[8/12] Compilando aplicación web...${NC}"
npm run build
echo -e "${GREEN}✓ Aplicación compilada${NC}"

# Configure Nginx
echo -e "${YELLOW}[9/12] Configurando Nginx...${NC}"
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
echo -e "${YELLOW}[10/12] Configurando modo kiosk...${NC}"
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
echo -e "${YELLOW}[11/12] Configurando arranque automático...${NC}"
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

# Create environment file template
echo -e "${YELLOW}[12/12] Creando archivo de configuración...${NC}"
cat > "$PROJECT_DIR/.env" <<'ENVEOF'
# Backend API Configuration
VITE_API_URL=http://localhost:8080
VITE_WS_URL=ws://localhost:8080

# Optional: Override for specific IP
# VITE_API_URL=http://192.168.1.100:8080
# VITE_WS_URL=ws://192.168.1.100:8080
ENVEOF

echo -e "${GREEN}✓ Configuración creada${NC}"

# Final instructions
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  ¡Instalación Completada!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "${YELLOW}Próximos pasos:${NC}"
echo ""
echo "1. Edita la configuración del backend:"
echo "   nano $PROJECT_DIR/.env"
echo ""
echo "2. Tu backend Python debe exponer los endpoints en:"
echo "   - http://localhost:8080/api/*"
echo "   - ws://localhost:8080/ws/*"
echo ""
echo "3. La aplicación web está en:"
echo "   http://localhost (o la IP de tu Raspberry Pi)"
echo ""
echo "4. Para reiniciar el sistema:"
echo "   sudo reboot"
echo ""
echo "5. Para ver logs del kiosk:"
echo "   journalctl -u bascula-ui.service -f"
echo ""
echo -e "${YELLOW}Documentación completa:${NC}"
echo "   - Ver $PROJECT_DIR/INTEGRATION.md"
echo "   - Ver $PROJECT_DIR/TODO.md"
echo ""
echo -e "${GREEN}¡Disfruta de tu báscula inteligente!${NC}"
