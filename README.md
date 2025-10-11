# Báscula Digital Pro (cam-weight-wiz)

Software para la báscula digital basada en Raspberry Pi 5. Incluye:

- API/mini-web de configuración FastAPI (puerto 8080) desplegada mediante `uvicorn`.
- Backend principal en el puerto 8081 para lógica de la báscula.
- UI kiosk en Chromium que se muestra al arrancar (`bascula-ui.service`).
- Scripts de instalación idempotentes y unidades systemd listos para Raspberry Pi OS Bookworm Lite (64-bit).

## Puertos y variables de entorno por defecto

- **Miniweb**: expone la API local en `http://127.0.0.1:8080`.
- **Backend principal**: escucha en `http://127.0.0.1:8081`.
- **Variables relevantes**:
  - `BACKEND_BASE_URL` para forzar la URL completa usada por componentes clientes.
  - `BASCULA_BACKEND_HOST` y `BASCULA_BACKEND_PORT` (por defecto `127.0.0.1` y `8081`) para componer la URL cuando no se fija la anterior.
  - `MINIWEB_BASE_URL` para fijar explícitamente la URL base del miniweb.
  - `BASCULA_MINIWEB_HOST` y `BASCULA_MINIWEB_PORT` (por defecto `127.0.0.1` y `8080`) como fallback cuando no se define `MINIWEB_BASE_URL`.

## Instalación limpia en Raspberry Pi OS Bookworm Lite (Pi 5)

1. Copia el repositorio a la Raspberry Pi (por ejemplo en `/home/pi/cam-weight-wiz`).
2. Ejecuta el instalador como `root`:

   ```bash
   cd /home/pi/cam-weight-wiz
   sudo ./scripts/install-all.sh
   ```

   El script es idempotente: se puede volver a ejecutar sin romper instalaciones previas.

### Logging del instalador

- `scripts/install-all.sh` vuelca siempre el log a consola y a un fichero en `BASCULA_LOG_DIR` (por defecto `/var/log/bascula`).
- Personaliza la ruta exportando `BASCULA_LOG_DIR=/ruta` o `BASCULA_LOG_FILE=/ruta/fichero.log` antes de ejecutarlo.
- Activa el trazado detallado con `BASCULA_TRACE=1`; el `PS4` enriquecido añade timestamps, PID, archivo, línea y función a cada comando.
- Al finalizar (incluso si falla) muestra la ruta exacta del log generado.

### Qué hace `scripts/install-all.sh`

El instalador crea una estructura tipo OTA y deja los servicios listos para producción:

- Provisiona `/opt/bascula/releases/<timestamp>` con el contenido del repositorio y apunta `/opt/bascula/current` al release activo. 【F:scripts/install-all.sh†L57-L130】
- Instala dependencias del sistema (libcamera/picamera2, Chromium kiosk, nginx, ALSA, libzbar0, herramientas básicas) sólo si faltan. 【F:scripts/install-all.sh†L75-L103】【F:scripts/install-all.sh†L397-L406】
- Fuerza los overlays requeridos en `/boot/firmware/config.txt` (`vc4-kms-v3d-pi5`, `disable-bt`, `hifiberry-dac`, `enable_uart=1`). Si alguno se añade, marca que es necesario reiniciar. 【F:scripts/install-all.sh†L120-L148】
- Crea la virtualenv en `/opt/bascula/current/.venv` compartiendo los paquetes del sistema y sólo instala nuestras dependencias vía pip (sin resolver dependencias). 【F:scripts/install-all.sh†L150-L205】
- Genera `/etc/asound.conf` con alias robustos (`bascula_out` → HiFiBerry si está disponible, fallback a HDMI; `bascula_mix_in` con `dsnoop` para el micro USB). 【F:scripts/install-all.sh†L192-L244】
- Asegura `/run/bascula/captures` con permisos `drwxrws---`, crea `/var/log/bascula` y despliega el archivo tmpfiles correspondiente (`/run/bascula` con `0775`). 【F:scripts/install-all.sh†L246-L272】【F:systemd/tmpfiles.d/bascula.conf†L1-L2】
- Configura nginx para servir `/captures/` únicamente en loopback y reinicia el servicio tras validar `nginx -t`. 【F:scripts/install-all.sh†L336-L367】
- Instala y habilita `bascula-miniweb.service`, `bascula-backend.service`, `bascula-health-wait.service` y `bascula-ui.service`. 【F:scripts/install-all.sh†L318-L334】【F:systemd/bascula-miniweb.service†L1-L21】【F:systemd/bascula-backend.service†L1-L18】【F:systemd/bascula-health-wait.service†L1-L13】【F:systemd/bascula-ui.service†L1-L27】
- Ejecuta verificaciones de salud (`systemd-analyze verify`, `curl 127.0.0.1:8080`, `python -c 'import picamera2'`, `arecord`, `speaker-test`). Si el script detecta que hay que reiniciar por cambios en `config.txt`, pospone las pruebas de audio y finaliza exitosamente recordando que falta el reboot. 【F:scripts/install-all.sh†L369-L381】【F:scripts/install-all.sh†L425-L437】

### Primer arranque en Bookworm

Los overlays `vc4-kms-v3d-pi5`, `disable-bt`, `hifiberry-dac` y `enable_uart=1` requieren reinicio. La primera vez que se ejecuta el instalador:

1. Detectará los overlays ausentes, los añadirá a `/boot/firmware/config.txt` y dejará registro en `/var/lib/bascula/reboot-reasons.txt`.
2. El script terminará con un aviso: reinicia manualmente (`sudo reboot`) antes de ejecutar `arecord`/`speaker-test`.
3. Después del reboot, vuelve a lanzar `./scripts/install-all.sh` (no recrea el release) o ejecuta `./scripts/post-install-checks.sh` para validar audio y miniweb. 【F:scripts/install-all.sh†L333-L364】【F:scripts/post-install-checks.sh†L1-L39】

### Comprobaciones rápidas

Tras el reboot (o después del instalador si no hubo overlays nuevos), verifica el estado con:

```bash
sudo ./scripts/post-install-checks.sh
```

El script comprueba `shellcheck`, `systemd-analyze verify`, `nginx -t`, `curl 127.0.0.1:8080`, `picamera2`, `arecord` y `speaker-test`. Usa `SKIP_AUDIO=1` si aún no tienes conectado el DAC o el micrófono. 【F:scripts/post-install-checks.sh†L1-L39】

### Servicios desplegados

- **bascula-miniweb.service** – mini web/API FastAPI en `:8080`, ejecutada bajo `uvicorn` con usuario `pi` y grupo `www-data`. La configuración de audio se inyecta mediante `/etc/default/bascula-audio`. 【F:systemd/bascula-miniweb.service†L1-L21】
- **bascula-backend.service** – backend principal (puerto 8081) ejecutando `python -m backend.main`. 【F:systemd/bascula-backend.service†L1-L18】
- **bascula-health-wait.service** – espera a que `/api/miniweb/status` devuelva `"ok": true` antes de dejar continuar al kiosk. 【F:systemd/bascula-health-wait.service†L1-L13】
- **bascula-ui.service** – arranca `startx` + Chromium kiosk sólo cuando `bascula-health-wait.service` completó correctamente. Prepara `/run/user/1000` y los logs antes de lanzar la sesión gráfica. 【F:systemd/bascula-ui.service†L1-L27】

### Troubleshooting rápido

- **Miniweb no responde**: revisa `journalctl -u bascula-miniweb -n 50` y vuelve a lanzar `sudo systemctl restart bascula-miniweb`. Asegúrate de que la virtualenv exista en `/opt/bascula/current/.venv`.
- **Chromium no arranca**: comprueba que `bascula-health-wait.service` haya terminado (`systemctl status bascula-health-wait`). Si el miniweb no devuelve `ok=true`, la UI queda bloqueada por diseño.
- **Audio**: `arecord -D bascula_mix_in -f S16_LE -r 16000 -d 2 /tmp/test.wav` y `speaker-test -D bascula_out -t sine -f 440 -l 1`. Si fallan tras el reboot inicial, revisa `/etc/asound.conf` y que ALSA detecte el DAC (`aplay -L`).
- **Capturas**: los archivos se escriben en `/run/bascula/captures` con permisos `02770` y bit `g+s`. Nginx los expone en `http://127.0.0.1/captures/`. 【F:scripts/install-all.sh†L246-L267】【F:scripts/install-all.sh†L336-L367】

Para más diagnósticos, consulta los journals de cada servicio (`journalctl -u bascula-*.service`).

### Paquetes Python desde APT en Raspberry Pi 5

En Raspberry Pi OS Bookworm usamos los binarios oficiales de `picamera2`, `numpy` y `simplejpeg` que vienen empaquetados en APT (`python3-picamera2`, `python3-numpy`, `python3-simplejpeg`). Esto evita tener que compilar `python-prctl` y otros bindings en la Pi, y garantiza que los módulos críticos de cámara se construyan contra el ABI correcto de libcamera/mesa. 【F:scripts/install-all.sh†L150-L205】【F:requirements.txt†L1-L19】

El instalador verifica explícitamente que estas librerías se carguen desde `/usr/lib/python3/dist-packages/`; si detecta que se resolvieron desde `pip`, aborta para prevenir instalaciones inconsistentes. 【F:scripts/install-all.sh†L150-L205】

### OCR RapidOCR en Raspberry Pi 5

- El backend activa RapidOCR por defecto (`BASCULA_OCR_ENABLED=true`) y busca los modelos en `/opt/rapidocr/models` (configurable con `BASCULA_OCR_MODELS_DIR`). 【F:systemd/bascula-backend.service†L11-L14】【F:backend/ocr_models.py†L1-L12】
- `scripts/install-all.sh` instala las dependencias de sistema necesarias (`libgomp1`, `libzbar0`), fija las wheels ARM64 de `rapidocr-onnxruntime`, `onnxruntime`, `pyclipper` y `shapely`, y valida los imports tras crear la virtualenv. 【F:scripts/install-all.sh†L82-L103】【F:scripts/install-all.sh†L165-L206】
- El instalador deja preparada la carpeta `/opt/rapidocr/models` con un README recordando dónde colocar los `.onnx` de detección y reconocimiento. 【F:scripts/install-all.sh†L207-L216】
- El endpoint `GET /ocr/health` indica si RapidOCR está listo (`{"ocr": "ready"}`) o si faltan modelos (`503` con `{"ocr": "missing_models"}`), evitando que el backend caiga cuando todavía no se han copiado los `.onnx`. 【F:backend/main.py†L2489-L2498】

Coloca los modelos oficiales de RapidOCR (por ejemplo `det.onnx`, `rec.onnx` y opcionalmente `cls.onnx`) en `/opt/rapidocr/models`; el servicio se cargará automáticamente la primera vez que se utilice OCR.

### Voces Piper

- Las voces se descargan desde GitHub Releases del repositorio `DanielGTdiabetes/bascula-cam` (configurable con `BASCULA_VOICES_TAG`). `scripts/install-all.sh` invoca `scripts/fetch-piper-voices.sh`, que es idempotente y puede relanzarse manualmente sin eliminar archivos existentes. 【F:scripts/fetch-piper-voices.sh†L1-L154】【F:scripts/install-all.sh†L708-L723】
- Los modelos se instalan en `/opt/bascula/voices/piper`. Para cambiar la voz por defecto basta con actualizar el enlace: `sudo ln -sfn /opt/bascula/voices/piper/es_ES-xxx.onnx /opt/bascula/voices/piper/default.onnx`. 【F:scripts/fetch-piper-voices.sh†L105-L145】
- Cada descarga valida el `sha256` indicado en el `.onnx.json` cuando está disponible; si falta, se muestra un aviso pero no se aborta. 【F:scripts/fetch-piper-voices.sh†L69-L97】
