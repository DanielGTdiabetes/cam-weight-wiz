# 🚀 Instalación Rápida - Raspberry Pi 5

## 📋 Requisitos Previos

- **Raspberry Pi 5** (4GB RAM mínimo recomendado)
- **MicroSD** de 32GB o más con Raspberry Pi OS (64-bit, Bookworm)
- **Pantalla táctil** de 7" oficial de Raspberry Pi
- **Conexión a Internet** (WiFi o Ethernet)
- **Báscula USB** conectada
- **Cámara** (CSI o USB)
- **Teclado y mouse** para configuración inicial

## ⚡ Instalación Automática (Recomendada)

### 1. Preparar Raspberry Pi

```bash
# Actualizar sistema
sudo apt update && sudo apt upgrade -y

# Instalar git
sudo apt install -y git

# Clonar repositorio
cd ~
git clone <URL_DE_TU_REPO> bascula-ui
cd bascula-ui
```

### 2. Ejecutar Script de Instalación

```bash
# Dar permisos de ejecución
chmod +x scripts/install-all.sh

# Ejecutar instalación (requiere sudo)
sudo ./scripts/install-all.sh
```

**⏱️ Tiempo estimado:** 15-20 minutos

El script instalará automáticamente:
- ✅ Node.js 20.x LTS
- ✅ Python 3.11+ con virtualenv
- ✅ Nginx como servidor web
- ✅ Frontend (React + Vite build)
- ✅ Backend (FastAPI)
- ✅ Servicios systemd (auto-start)
- ✅ Modo kiosk (Chromium fullscreen)
- ✅ Configuración de pantalla táctil 7"

### 3. Configuración Post-Instalación

Edita los archivos de configuración:

```bash
# Frontend - URLs del backend
nano ~/bascula-ui/.env

# Backend - Configuración de hardware y APIs
nano ~/bascula-backend/.env
```

**Ejemplo `.env` frontend:**
```env
VITE_API_URL=http://localhost:8080
VITE_WS_URL=ws://localhost:8080
```

**Ejemplo `.env` backend:**
```env
# Hardware
SCALE_DEVICE=/dev/ttyUSB0
CAMERA_INDEX=0

# Nightscout (opcional)
NIGHTSCOUT_URL=https://tu-sitio.herokuapp.com
NIGHTSCOUT_API_SECRET=tu_api_secret

# WiFi AP Mode
AP_SSID=Bascula-Config
AP_PASSWORD=bascula2024
```

### 4. Implementar Backend

El script crea un template en `~/bascula-backend/main.py`. Necesitas implementar:

```python
# ~/bascula-backend/main.py
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
import asyncio

app = FastAPI()

# ... keep existing code (CORS setup)

# Implementar endpoints según backend/miniweb.py y src/services/api.ts
@app.get("/api/weight")
async def get_weight():
    # Leer báscula USB
    weight = read_scale()  # Implementar
    return {"weight": weight, "unit": "g", "stable": True}

@app.websocket("/ws/scale")
async def websocket_scale(websocket: WebSocket):
    await websocket.accept()
    while True:
        weight = read_scale()
        await websocket.send_json({"weight": weight})
        await asyncio.sleep(0.5)

# ... más endpoints según api.ts
```

### 5. Reiniciar Sistema

```bash
# Reiniciar servicios
sudo systemctl restart bascula-backend
sudo systemctl restart bascula-ui
sudo systemctl restart nginx

# O reiniciar Raspberry Pi
sudo reboot
```

## 🔍 Verificación de Instalación

### Comprobar Servicios

```bash
# Backend activo
sudo systemctl status bascula-backend

# UI kiosk activo
sudo systemctl status bascula-ui

# Nginx activo
sudo systemctl status nginx

# Ver logs en tiempo real
sudo journalctl -u bascula-backend -f
sudo journalctl -u bascula-ui -f
```

### Probar en Navegador

```bash
# Desde la misma Raspberry Pi
http://localhost

# Desde otro dispositivo en la red
http://<IP_RASPBERRY_PI>
```

Obtener IP:
```bash
hostname -I
```

## 🛠️ Instalación Manual (Avanzada)

Si prefieres control total, sigue estos pasos:

### 1. Instalar Dependencias

```bash
# Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Python y pip
sudo apt install -y python3-pip python3-venv

# Nginx
sudo apt install -y nginx

# Chromium para kiosk
sudo apt install -y chromium-browser unclutter

# Herramientas de desarrollo
sudo apt install -y git build-essential
```

### 2. Construir Frontend

```bash
cd ~/bascula-ui

# Instalar dependencias
npm install

# Build de producción
npm run build

# Los archivos compilados estarán en dist/
```

### 3. Configurar Nginx

```bash
# Copiar configuración
sudo cp nginx/bascula.conf /etc/nginx/sites-available/bascula
sudo ln -s /etc/nginx/sites-available/bascula /etc/nginx/sites-enabled/

# Eliminar default
sudo rm /etc/nginx/sites-enabled/default

# Verificar configuración
sudo nginx -t

# Reiniciar
sudo systemctl restart nginx
```

### 4. Setup Backend

```bash
# Crear directorio
mkdir -p ~/bascula-backend
cd ~/bascula-backend

# Crear virtualenv
python3 -m venv venv
source venv/bin/activate

# Instalar dependencias
pip install fastapi uvicorn websockets python-multipart pyserial picamera2

# Copiar template
cp ~/bascula-ui/backend/miniweb.py main.py

# Crear .env con configuración
```

### 5. Crear Servicios Systemd

```bash
# Backend
sudo cp ~/bascula-ui/systemd/bascula-backend.service /etc/systemd/system/
sudo systemctl enable bascula-backend
sudo systemctl start bascula-backend

# UI Kiosk
sudo cp ~/bascula-ui/systemd/bascula-ui.service /etc/systemd/system/
sudo systemctl enable bascula-ui
sudo systemctl start bascula-ui
```

## 📱 Configuración de Pantalla Táctil 7"

Si usas la pantalla oficial de 7":

```bash
# Editar configuración de boot
sudo nano /boot/firmware/config.txt

# Agregar al final:
dtoverlay=vc4-kms-v3d
hdmi_group=2
hdmi_mode=87
hdmi_cvt=1024 600 60 6 0 0 0
hdmi_drive=2

# Guardar y reiniciar
sudo reboot
```

## 🔧 Configuración de Hardware

### Permisos para Báscula USB

```bash
# Agregar usuario al grupo dialout
sudo usermod -a -G dialout pi

# Reiniciar para aplicar cambios
sudo reboot
```

### Habilitar Cámara

```bash
# Para cámara CSI (ribbon cable)
sudo raspi-config
# Ir a: Interface Options > Camera > Enable

# Para cámara USB, verificar:
ls /dev/video*
```

### Habilitar I2C (opcional, sensores)

```bash
sudo raspi-config
# Ir a: Interface Options > I2C > Enable
```

## 🌐 Configuración de Red

### WiFi Estático (Opcional)

```bash
sudo nano /etc/dhcpcd.conf

# Agregar:
interface wlan0
static ip_address=192.168.1.100/24
static routers=192.168.1.1
static domain_name_servers=8.8.8.8
```

### Modo AP WiFi (Fallback Automático)

```bash
# Dar permisos al script
chmod +x ~/bascula-ui/scripts/setup-ap-mode.sh

# Ejecutar setup
sudo ~/bascula-ui/scripts/setup-ap-mode.sh

# El AP se activará automáticamente cuando no haya WiFi
```

## 🔐 Seguridad (Producción)

### Cambiar Contraseñas

```bash
# Usuario pi
passwd

# PIN de mini-web (en backend .env)
ADMIN_PIN=<tu_nuevo_pin>
```

### Firewall (Opcional)

```bash
sudo apt install -y ufw

# Permitir solo HTTP y SSH
sudo ufw allow 80/tcp
sudo ufw allow 22/tcp

# Activar
sudo ufw enable
```

### HTTPS con Let's Encrypt (Opcional)

```bash
sudo apt install -y certbot python3-certbot-nginx

# Obtener certificado
sudo certbot --nginx -d tudominio.com

# Renovación automática ya está configurada
```

## 🐛 Solución de Problemas

### La Pantalla no Inicia

```bash
# Verificar servicio UI
sudo systemctl status bascula-ui

# Ver logs
sudo journalctl -u bascula-ui -n 50

# Reiniciar manualmente
DISPLAY=:0 chromium-browser --kiosk http://localhost
```

### Backend no Responde

```bash
# Verificar que está corriendo
sudo systemctl status bascula-backend

# Ver logs
sudo journalctl -u bascula-backend -n 50

# Probar manualmente
curl http://localhost:8080/api/health
```

### Báscula no Detectada

```bash
# Listar dispositivos USB
lsusb

# Ver dispositivos seriales
ls -l /dev/ttyUSB*

# Verificar permisos
groups pi  # Debe incluir "dialout"
```

### Cámara no Funciona

```bash
# Para cámara CSI
libcamera-hello

# Para cámara USB
fswebcam test.jpg

# Verificar permisos
groups pi  # Debe incluir "video"
```

### WiFi AP no se Activa

```bash
# Verificar hostapd
sudo systemctl status hostapd

# Ver configuración
cat /etc/hostapd/hostapd.conf

# Logs de activación
sudo journalctl -u hostapd -n 50
```

## 📊 Monitoreo del Sistema

### Ver Rendimiento

```bash
# Temperatura CPU
vcgencmd measure_temp

# Memoria
free -h

# Uso de CPU
htop

# Espacio en disco
df -h
```

### Logs Importantes

```bash
# Backend
sudo journalctl -u bascula-backend -f

# UI Kiosk
sudo journalctl -u bascula-ui -f

# Nginx
sudo tail -f /var/log/nginx/bascula-error.log

# Sistema
sudo dmesg -w
```

## 🔄 Actualizaciones OTA

Una vez configurado, puedes actualizar desde la app:

1. Ir a **Configuración** > **Sistema**
2. Click en **Buscar Actualizaciones**
3. Si hay actualización disponible, click **Instalar**
4. El sistema se reiniciará automáticamente

O manualmente:

```bash
cd ~/bascula-ui
git pull
npm install
npm run build
sudo systemctl restart bascula-backend bascula-ui nginx
```

## 🎯 Checklist Final

- [ ] Servicios activos (backend, ui, nginx)
- [ ] Pantalla muestra interfaz en fullscreen
- [ ] Báscula responde y muestra peso
- [ ] Cámara captura imágenes
- [ ] WiFi conectado o AP activo
- [ ] Mini-web accesible desde otro dispositivo
- [ ] Nightscout conectado (si aplica)
- [ ] Modo 15/15 funciona (si diabetes activo)
- [ ] Recovery mode probado
- [ ] Datos persisten después de reinicio

## 📚 Documentación Adicional

- [DEPLOYMENT.md](./DEPLOYMENT.md) - Guía completa de deployment
- [MINI_WEB_AND_AP.md](./MINI_WEB_AND_AP.md) - Sistema de mini-web y WiFi AP
- [RECOVERY_MODE.md](./RECOVERY_MODE.md) - Modo de recuperación
- [FEATURES_STATUS.md](./FEATURES_STATUS.md) - Estado de features
- [INTEGRATION.md](./INTEGRATION.md) - Guía de integración

## 🆘 Soporte

Si encuentras problemas:

1. Revisa los logs con `journalctl`
2. Verifica que todos los servicios están activos
3. Prueba acceder a http://localhost desde la Pi
4. Verifica conexiones de hardware (USB, cámara)
5. Prueba el modo Recovery (`localStorage.setItem("recovery_mode", "true")`)

---

**¡Sistema listo para producción! 🎉**

Una vez completada la instalación, tendrás:
- ✅ Interfaz táctil funcionando en fullscreen
- ✅ Báscula con medición en tiempo real
- ✅ Escáner de alimentos con cámara
- ✅ Calculadora de bolos
- ✅ Integración con Nightscout
- ✅ Modo 15/15 para hipoglucemia
- ✅ Sistema de recetas
- ✅ Temporizador de cocina
- ✅ Configuración vía mini-web
- ✅ WiFi AP automático
- ✅ Modo Recovery
- ✅ Actualizaciones OTA
