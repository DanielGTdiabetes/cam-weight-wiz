# Guía de instalación

Esta guía describe cómo desplegar Báscula Digital Pro en una Raspberry Pi 5 con Raspberry Pi OS Bookworm Lite (64‑bit) usando el instalador automatizado y detalla las opciones más habituales para personalizarlo.

## 1. Requisitos previos
- **Hardware:** Raspberry Pi 5, cámara (IMX708 u otra soportada por libcamera), báscula HX711 o serie y audio (DAC/altavoz + micrófono USB/I2S).【F:scripts/install-all.sh†L1-L108】【F:scripts/install-all.sh†L1600-L1726】
- **Sistema operativo:** Raspberry Pi OS Bookworm Lite de 64 bits recién instalado y actualizado.
- **Acceso a Internet:** necesario para resolver paquetes APT (libcamera, Chromium, nginx, ALSA, etc.) y descargar dependencias Python/voz.【F:scripts/install-all.sh†L1180-L1193】【F:scripts/install-all.sh†L1719-L1734】
- **Usuario:** se asume el usuario por defecto `pi` con el repositorio clonado en `/home/pi/cam-weight-wiz`.

## 2. Preparar el repositorio
1. Conectar por SSH o consola a la Raspberry Pi.
2. Copiar el repositorio al directorio deseado (ejemplo: `/home/pi/cam-weight-wiz`).
3. (Opcional) Actualizar la Pi antes del despliegue:
   ```bash
   sudo apt update && sudo apt full-upgrade -y
   sudo reboot
   ```

## 3. Instalación automatizada
Ejecuta el instalador con privilegios de `root`:

```bash
cd /home/pi/cam-weight-wiz
sudo ./scripts/install-all.sh
```

El script es idempotente y puede relanzarse para aplicar actualizaciones. Gestiona el dominio Wi‑Fi, sincroniza el release activo (`/opt/bascula/current`) y deja preparados los servicios y dependencias necesarios.【F:scripts/install-all.sh†L20-L55】【F:scripts/install-all.sh†L1656-L1674】【F:scripts/install-all.sh†L1180-L1193】

### Reinicio requerido
Si el instalador modifica overlays en `/boot/firmware/config.txt` o detecta cambios en UART/cámara, marcará que es necesario reiniciar la Raspberry Pi antes de ejecutar las pruebas de audio.【F:scripts/install-all.sh†L1195-L1237】【F:scripts/install-all.sh†L265-L272】

## 4. Variables y banderas útiles
Puedes ajustar el comportamiento del instalador exportando variables antes de lanzarlo:

| Variable | Descripción |
| --- | --- |
| `WIFI_COUNTRY=XX` | Define el país Wi‑Fi antes de escribir `wpa_supplicant.conf` y aplicar `iw reg set`. Útil en instalaciones headless.【F:scripts/install-all.sh†L20-L48】 |
| `BASCULA_TRACE=1` | Activa trazas detalladas (`set -x`) en el log de instalación.【F:scripts/install-all.sh†L71-L83】 |
| `BASCULA_LOG_DIR=/ruta` / `BASCULA_LOG_FILE=/ruta/log.log` | Cambia la carpeta o fichero de log generado automáticamente.【F:scripts/install-all.sh†L60-L70】 |
| `BASCULA_RELEASE_ID=20250101-0000` | Fuerza el identificador de release en `/opt/bascula/releases/<id>`; por defecto se usa un timestamp.【F:scripts/install-all.sh†L1656-L1662】 |
| `SKIP_UI_BUILD=1` | Evita recompilar el frontend si ya entregaste los estáticos en `dist/` (útil para pruebas rápidas).【F:scripts/install-all.sh†L330-L335】 |

## 5. Qué configura `install-all.sh`
El instalador resume múltiples tareas para dejar la Pi lista para producción:

1. **Estructura OTA:** crea `/opt/bascula/releases/<timestamp>` con una copia del repositorio, escribe `.release-commit` y actualiza el enlace `/opt/bascula/current` con permisos `pi:pi`.【F:scripts/install-all.sh†L1642-L1691】
2. **Dependencias del sistema:** instala paquetes esenciales (`python3-*`, libcamera, Chromium, nginx, ALSA, herramientas de kiosk, etc.) y gestiona alternativas según disponibilidad del mirror.【F:scripts/install-all.sh†L1180-L1193】
3. **Virtualenv compartida:** genera `.venv` en el release activo reutilizando paquetes de sistema, instala FastAPI, RapidOCR, dependencias de voz y valida que módulos críticos provengan de APT.【F:scripts/install-all.sh†L1694-L1756】
4. **Modelos de voz y OCR:** prepara `/opt/rapidocr/models` con instrucciones, descarga el modelo wake-word de Vosk y las voces Piper si no existen.【F:scripts/install-all.sh†L1759-L1775】【F:scripts/install-all.sh†L300-L311】
5. **Audio ALSA:** despliega `/etc/asound.conf` con `bascula_out` (dmix a 48 kHz) y `bascula_mix_in` (dsnoop) asegurando permisos adecuados.【F:scripts/install-all.sh†L2179-L2257】
6. **Directorios y tmpfiles:** garantiza `/run/bascula/captures` con modo `02770`, crea el archivo `tmpfiles.d` correspondiente y configura `/var/log/bascula`.【F:scripts/install-all.sh†L2260-L2264】【F:scripts/install-all.sh†L280-L335】
7. **Wi‑Fi y red:** aplica el país Wi‑Fi si falta, prepara NetworkManager/hostapd para modo AP y ajusta overlays necesarios para cámara/audio.【F:scripts/install-all.sh†L20-L55】【F:scripts/install-all.sh†L1188-L1193】【F:scripts/install-all.sh†L1195-L1237】
8. **Servicios systemd y nginx:** instala unidades (`bascula-miniweb`, `bascula-backend`, `bascula-health-wait`, `bascula-ui`), despliega la configuración de nginx y reinicia servicios tras validar `nginx -t`.【F:scripts/install-all.sh†L280-L335】【F:scripts/install-all.sh†L336-L367】【F:systemd/bascula-miniweb.service†L1-L27】【F:systemd/bascula-backend.service†L1-L21】【F:systemd/bascula-ui.service†L1-L33】
9. **Resúmenes y logs:** al finalizar muestra el estado de cámara, báscula y audio, indicando la ruta del log completo (`/var/log/bascula/install-*.log`).【F:scripts/install-all.sh†L240-L282】【F:scripts/install-all.sh†L265-L272】

## 6. Comprobaciones posteriores
Tras un reinicio (si el instalador lo solicitó) ejecuta:

```bash
sudo ./scripts/post-install-checks.sh
```

El script valida systemd, nginx, mini‑web, cámara y audio. Usa `SKIP_AUDIO=1` para omitir pruebas acústicas cuando aún no hay hardware conectado.【F:scripts/post-install-checks.sh†L1-L48】

## 7. Reinstalaciones y actualizaciones
- **Actualizar código:** `git pull` en `/home/pi/cam-weight-wiz` y relanza `sudo ./scripts/install-all.sh`. El instalador reutiliza la release actual si el commit coincide o genera una nueva carpeta con timestamp.【F:scripts/install-all.sh†L1642-L1669】
- **Ver logs anteriores:** los ficheros `install-*.log` se guardan en `/var/log/bascula`. Usa `sudo tail -n 200 /var/log/bascula/install-YYYYMMDD-HHMMSS.log` para diagnosticar.【F:scripts/install-all.sh†L60-L70】【F:scripts/install-all.sh†L265-L282】

## 8. Configuración del país Wi‑Fi
El instalador ya fuerza un país si no existe, pero puedes definirlo manualmente de antemano:

### 8.1. Definirlo en la ejecución (recomendado)
```bash
sudo WIFI_COUNTRY=MX ./scripts/install-all.sh
```

### 8.2. Configurarlo antes del primer arranque (headless)
1. Monta la partición `boot` de la imagen de Raspberry Pi OS en tu ordenador.
2. Crea `wpa_supplicant.conf` con:
   ```conf
   country=MX
   update_config=1
   ctrl_interface=/var/run/wpa_supplicant
   ```
3. (Opcional) Añade un archivo vacío `ssh` para habilitar el acceso remoto.
4. Inserta la tarjeta en la Pi y arranca; el instalador respetará la configuración existente.【F:scripts/install-all.sh†L20-L55】

### 8.3. Ajustarlo manualmente tras la instalación
```bash
sudo raspi-config nonint do_wifi_country MX
sudo sed -i '1{/^country=/d;}; 1i country=MX' /etc/wpa_supplicant/wpa_supplicant.conf
sudo rfkill unblock wifi || true
sudo iw reg set MX || true
```

Comprueba el estado con:
```bash
grep -E '^country=' /etc/wpa_supplicant/wpa_supplicant.conf || echo "Sin country"
iw reg get | head -n 5
```

Si el Wi‑Fi no conecta tras el cambio, reinicia y revisa los logs de `wpa_supplicant` (`journalctl -u wpa_supplicant --no-pager -b`).

## 9. Scripts útiles
- `scripts/post-install-checks.sh`: validación rápida tras el despliegue.【F:scripts/post-install-checks.sh†L1-L48】
- `scripts/smoke-miniweb.sh`: smoke test de endpoints HTTP/WS de la mini‑web.
- `scripts/fetch-piper-voices.sh`: descarga manual de voces Piper si necesitas cambiarlas o reinstalarlas.【F:scripts/install-all.sh†L300-L311】

Con esto la Raspberry Pi queda lista para ejecutar Báscula Digital Pro con arranque automático de mini‑web, backend y UI kiosk.

