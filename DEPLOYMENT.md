# Guía de Despliegue - Báscula Inteligente

## Instalación Automática

### Método 1: Instalación Completa (Recomendado)

```bash
# Clonar o copiar el proyecto a la Raspberry Pi
cd /home/pi
git clone <tu-repositorio> bascula-ui
cd bascula-ui

# Ejecutar instalación completa
bash scripts/install-all.sh
```

El script instalará:
- ✅ Node.js y dependencias
- ✅ Nginx como servidor web
- ✅ Configuración de modo kiosk
- ✅ Arranque automático
- ✅ Optimizaciones para pantalla 7"

### Método 2: Instalación Manual

Si prefieres control total del proceso:

#### 1. Sistema Base
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nodejs npm nginx chromium-browser unclutter
```

#### 2. Compilar Aplicación
```bash
cd /home/pi/bascula-ui
npm install
npm run build
```

#### 3. Configurar Nginx
```bash
sudo cp nginx/bascula.conf /etc/nginx/sites-available/bascula
sudo ln -s /etc/nginx/sites-available/bascula /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

#### 4. Modo Kiosk
```bash
cp systemd/bascula-ui.service /etc/systemd/system/
sudo systemctl enable bascula-ui.service
sudo systemctl start bascula-ui.service
```

## Configuración Post-Instalación

### 1. Variables de Entorno

Edita `/home/pi/bascula-ui/.env`:

```bash
# IP de tu Raspberry Pi
VITE_API_URL=http://192.168.1.100:8080
VITE_WS_URL=ws://192.168.1.100:8080
```

### 2. Backend Python

Tu backend debe exponer estos endpoints:

**WebSocket (tiempo real):**
- `ws://localhost:8080/ws/scale` - Peso en tiempo real

**REST API:**
- `POST /api/scale/tare` - Tara
- `POST /api/scale/zero` - Zero
- `POST /api/scanner/analyze` - Analizar alimento
- `GET /api/nightscout/glucose` - Glucosa
- `POST /api/timer/start` - Temporizador
- Ver `INTEGRATION.md` para lista completa

### 3. Verificar Instalación

```bash
# Ver logs del servicio
journalctl -u bascula-ui.service -f

# Ver logs de Nginx
sudo tail -f /var/log/nginx/error.log

# Verificar puertos
ss -tulpn | grep -E ':(80|8080)'
```

## Optimizaciones para Pantalla 7"

La aplicación está optimizada para 1024x600px:
- Botones grandes (mínimo 48x48px)
- Textos legibles (mínimo 16px)
- Espaciado generoso para táctil
- Sin elementos pequeños

### Forzar Resolución (Opcional)

En `/boot/config.txt`:
```
hdmi_force_hotplug=1
hdmi_group=2
hdmi_mode=87
hdmi_cvt=1024 600 60 6 0 0 0
```

## Modo AP WiFi Fallback

Si no hay red WiFi al arrancar, el sistema activa automáticamente:

**SSID:** `Bascula-AP`  
**Password:** `bascula2025`  
**URL:** `http://192.168.4.1:8080`

Configura desde la mini-web y reinicia.

## Actualizaciones OTA

### Desde la Aplicación
1. Ve a **Ajustes → OTA**
2. Click en **Buscar Actualizaciones**
3. Si hay actualización, click **Instalar**
4. El sistema se reiniciará automáticamente

### Manual
```bash
cd /home/pi/bascula-ui
git pull
npm run build
sudo systemctl restart nginx
```

## Recovery Mode

Si el sistema no arranca correctamente:

1. Presiona **Ctrl+Alt+F2** para TTY
2. Login como `pi`
3. Ejecuta:
```bash
cd /home/pi/bascula-ui
git checkout main
npm run build
sudo systemctl restart bascula-ui.service
```

O activa recovery desde localStorage:
```bash
# En una consola del navegador
localStorage.setItem('recovery_mode', 'true');
location.reload();
```

## Troubleshooting

### La pantalla no arranca
```bash
# Verificar X server
ps aux | grep X
startx
```

### No hay peso en la báscula
```bash
# Verificar WebSocket
wscat -c ws://localhost:8080/ws/scale

# Verificar puerto serie ESP32
ls -la /dev/ttyUSB* /dev/ttyACM*
```

### No funciona la cámara
```bash
# Verificar Picamera2
libcamera-hello

# Permisos
sudo usermod -aG video pi
```

### Nginx no sirve la aplicación
```bash
# Verificar configuración
sudo nginx -t

# Reiniciar
sudo systemctl restart nginx

# Verificar que el build existe
ls -la /home/pi/bascula-ui/dist/
```

### Backend no responde
```bash
# Verificar que FastAPI está corriendo
ps aux | grep python

# Verificar logs
journalctl -u bascula-backend.service -f
```

## Performance

### Optimizaciones Aplicadas
- ✅ Gzip compression
- ✅ Cache de assets estáticos
- ✅ Service Worker para offline
- ✅ Lazy loading de componentes
- ✅ Bundle optimization

### Métricas Esperadas
- First Contentful Paint: < 1s
- Time to Interactive: < 2s
- Lighthouse Score: > 90

## Seguridad

### Firewall (Opcional)
```bash
sudo apt install ufw
sudo ufw allow 80/tcp
sudo ufw allow 8080/tcp
sudo ufw allow ssh
sudo ufw enable
```

### HTTPS (Opcional)
Para producción con acceso externo:
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d tudominio.com
```

## Backup

### Backup Manual
```bash
# Backup completo
sudo tar -czf bascula-backup-$(date +%Y%m%d).tar.gz \
  /home/pi/bascula-ui \
  /etc/nginx/sites-available/bascula \
  /etc/systemd/system/bascula-ui.service
```

### Restaurar
```bash
tar -xzf bascula-backup-YYYYMMDD.tar.gz -C /
sudo systemctl daemon-reload
sudo systemctl restart nginx bascula-ui.service
```

## Soporte

- **Documentación:** Ver `INTEGRATION.md` y `TODO.md`
- **Logs:** `journalctl -u bascula-ui.service -f`
- **Issues:** Reportar en el repositorio del proyecto

## Próximos Pasos

1. ✅ Sistema instalado
2. ⏳ Configurar backend Python
3. ⏳ Probar conexión WebSocket
4. ⏳ Calibrar báscula
5. ⏳ Configurar Nightscout
6. ⏳ Entrenar IA local (opcional)
7. ⏳ Configurar API Keys (ChatGPT)

¡Tu báscula inteligente está lista para usar!
