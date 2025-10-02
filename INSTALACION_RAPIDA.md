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
- ✅ Backend FastAPI (mini-web + OCR service)
- ✅ Servicios systemd (auto-start)
- ✅ Modo kiosk (Chromium fullscreen)
- ✅ Configuración de pantalla táctil 7"
- ✅ Librerías de cámara (libcamera, picamera2)
- ✅ Dependencias para procesamiento de imagen (OpenCV, PIL)
- ✅ Piper TTS (síntesis de voz en español)
- ✅ Tesseract OCR + RapidOCR
- ✅ Audio I2S (HifiBerry DAC / MAX98357A)
- ✅ NetworkManager AP fallback automático
- ✅ Estructura OTA con versionado
- ✅ Polkit rules (permisos NetworkManager sin sudo)

### 3. Configuración Post-Instalación

La configuración principal está en `~/.bascula/config.json`:

```bash
# Editar configuración
nano ~/.bascula/config.json
```

**Ejemplo `config.json`:**
```json
{
  "general": {
    "sound_enabled": true,
    "volume": 70,
    "tts_enabled": true
  },
  "scale": {
    "port": "/dev/serial0",
    "baud": 115200,
    "hx711_dt": 5,
    "hx711_sck": 6,
    "calib_factor": 1.0,
    "smoothing": 5,
    "decimals": 0,
    "unit": "g",
    "ml_factor": 1.0
  },
  "network": {
    "miniweb_enabled": true,
    "miniweb_port": 8080,
    "miniweb_pin": ""
  },
  "diabetes": {
    "diabetes_enabled": false,
    "ns_url": "",
    "ns_token": "",
    "hypo_alarm": 70,
    "hyper_alarm": 180,
    "mode_15_15": false,
    "insulin_ratio": 12.0,
    "insulin_sensitivity": 50.0,
    "target_glucose": 110
  },
  "audio": {
    "audio_device": "default"
  }
}
```

### 4. Estructura Instalada

El sistema queda instalado con estructura OTA:

```
/opt/bascula/
├── current -> releases/v1/  # Enlace simbólico a versión activa
└── releases/
    └── v1/                  # Release actual
        ├── backend/         # Backend FastAPI (miniweb)
        ├── src/             # Frontend React
        ├── dist/            # Build producción (servido por Nginx)
        └── .venv/           # Virtual environment Python

~/.bascula/
└── config.json              # Configuración principal

/var/log/bascula/            # Logs del sistema

Servicios systemd:
- bascula-miniweb.service    # Backend mini-web (puerto 8080)
- bascula-app.service        # UI kiosk (Chromium fullscreen)
- ocr-service.service        # OCR API (puerto 8078)
- bascula-net-fallback.timer # AP fallback automático
```

### 5. Reiniciar Sistema

**⚠️ REINICIO OBLIGATORIO** para aplicar configuración de hardware:

```bash
sudo reboot
```

Después del reinicio, todos los servicios arrancarán automáticamente.

## 🔍 Verificación de Instalación

### Comprobar Servicios

```bash
# Mini-web backend
sudo systemctl status bascula-miniweb

# UI kiosk
sudo systemctl status bascula-app

# OCR service
sudo systemctl status ocr-service

# Nginx
sudo systemctl status nginx

# Ver logs en tiempo real
sudo journalctl -u bascula-miniweb -f
sudo journalctl -u bascula-app -f
sudo journalctl -u ocr-service -f
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

## 🔧 Verificación de Hardware

### Audio I2S (HifiBerry DAC / MAX98357A)

```bash
# Ver tarjetas de audio detectadas
aplay -l

# Probar audio
speaker-test -c2 -twav -l1

# Probar síntesis de voz (Piper TTS)
say.sh "Hola, sistema funcionando correctamente"
```

### Báscula UART (ESP32 + HX711)

```bash
# Verificar puerto serial
ls -l /dev/serial0 /dev/ttyAMA0

# Probar comunicación (ajustar baud según ESP32)
minicom -D /dev/serial0 -b 115200
```

### Configurar Camera Module 3 (CSI)

```bash
# Instalar libcamera y picamera2
sudo apt update
sudo apt install -y python3-picamera2 python3-libcamera libcamera-apps

# Instalar dependencias de imagen para Python
sudo apt install -y python3-opencv python3-pil python3-numpy

# Habilitar cámara en raspi-config
sudo raspi-config
# Ir a: Interface Options > Camera > Enable

# Configurar en boot/config.txt
sudo nano /boot/firmware/config.txt

# Asegurarse de tener estas líneas:
camera_auto_detect=1
dtoverlay=imx708  # Para Camera Module 3

# Guardar y reiniciar
sudo reboot
```

**Verificar Camera Module 3:**

```bash
# Listar cámaras detectadas
libcamera-hello --list-cameras

# Debería mostrar algo como:
# Available cameras
# -----------------
# 0 : imx708 [4608x2592] (/base/axi/pcie@120000/rp1/i2c@80000/imx708@1a)

# Capturar foto de prueba (5 segundos preview)
libcamera-still -o test.jpg -t 5000

# Probar con Python
python3 << EOF
from picamera2 import Picamera2
import time

picam2 = Picamera2()
config = picam2.create_still_configuration()
picam2.configure(config)
picam2.start()
time.sleep(2)
picam2.capture_file("test_python.jpg")
picam2.stop()
print("✅ Foto capturada: test_python.jpg")
EOF
```

**Para cámara USB (alternativa):**

```bash
# Verificar dispositivos de video
ls -l /dev/video*

# Instalar v4l-utils
sudo apt install -y v4l-utils

# Ver información de la cámara
v4l2-ctl --list-devices

# Probar captura
fswebcam -r 1920x1080 --no-banner test_usb.jpg
```

### Habilitar I2C (opcional, sensores)

```bash
sudo raspi-config
# Ir a: Interface Options > I2C > Enable
```

### Configurar UART para ESP32 (Báscula)

```bash
# Habilitar UART y deshabilitar console serial
sudo raspi-config
# Ir a: Interface Options > Serial Port
# "Would you like a login shell accessible over serial?" -> NO
# "Would you like the serial port hardware to be enabled?" -> YES

# O editar directamente config.txt
sudo nano /boot/firmware/config.txt

# Agregar al final:
enable_uart=1
dtoverlay=disable-bt

# Guardar y salir

# Liberar UART de Bluetooth (opcional, mejora estabilidad)
sudo systemctl disable hciuart

# Agregar usuario a grupo dialout (permisos serial)
sudo usermod -a -G dialout pi

# Reiniciar
sudo reboot
```

**Verificar comunicación con ESP32:**

```bash
# Listar puertos seriales disponibles
ls -l /dev/serial*
ls -l /dev/ttyAMA* /dev/ttyS*

# Probar comunicación (con minicom o screen)
sudo apt install -y minicom
minicom -b 115200 -o -D /dev/serial0

# O con Python
python3 << EOF
import serial
ser = serial.Serial('/dev/serial0', 115200, timeout=1)
print(f"Puerto abierto: {ser.is_open}")
ser.close()
EOF
```

**Pines UART en Raspberry Pi 5:**
- **GPIO 14 (Pin 8)** - TX (transmit) → conectar a RX del ESP32
- **GPIO 15 (Pin 10)** - RX (receive) → conectar a TX del ESP32
- **GND** - Conectar a GND del ESP32
- **3.3V o 5V** - Alimentación del ESP32 (según modelo)

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
# Verificar que la cámara está conectada correctamente
libcamera-hello --list-cameras

# Para Camera Module 3 CSI
libcamera-still -o test.jpg

# Verificar configuración en boot
grep -E "camera|imx708" /boot/firmware/config.txt

# Debe mostrar:
# camera_auto_detect=1
# dtoverlay=imx708

# Para cámara USB
v4l2-ctl --list-devices
fswebcam test.jpg

# Verificar permisos
groups pi  # Debe incluir "video"
sudo usermod -a -G video pi

# Ver logs del kernel sobre la cámara
dmesg | grep -i camera
dmesg | grep -i imx708

# Reiniciar si hiciste cambios
sudo reboot
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
