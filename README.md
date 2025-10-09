# Báscula Digital Pro (bascula-cam)

## Visión general

Este repositorio contiene la base de software para la báscula digital basada en Raspberry Pi.
Incluye:

- Backend FastAPI/uvicorn que expone la mini-web de configuración y los servicios de la báscula en `http://localhost:8080`.
- UI web (React/Chromium en modo kiosk) pensada para una pantalla táctil.
- Scripts de instalación reproducibles y servicios systemd listos para producción en Raspberry Pi OS Bookworm.
- Automatización del modo AP de NetworkManager para casos sin conectividad Wi-Fi ni Ethernet.

## Instalación limpia en Raspberry Pi

> Se asume Raspberry Pi OS Bookworm (64 bits) con el usuario `pi` habilitado y `NetworkManager` instalado.

1. Clona o sincroniza el proyecto en el directorio deseado (por ejemplo `/opt/bascula/current`).
2. Ejecuta el script principal como root:

   ```bash
   cd /opt/bascula/current
   sudo ./scripts/install-all.sh
   ```

   El script (`scripts/install-all.sh`) realiza las siguientes tareas principales:

   - Instala dependencias del sistema, Python, Node.js y Chromium kiosk. 【F:scripts/install-all.sh†L1-L210】
   - Configura reglas de PolicyKit que permiten al usuario `pi` administrar redes Wi-Fi (escaneo, conexión, y modo compartido). 【F:scripts/install-all.sh†L320-L352】【F:packaging/polkit/49-nmcli.rules†L1-L13】
   - Despliega el backend mini-web (`bascula-miniweb.service`) escuchando en `:8080`. 【F:packaging/systemd/bascula-miniweb.service†L1-L16】
   - Configura el servicio kiosk de Chromium apuntando a `http://localhost:8080`. 【F:scripts/install-all.sh†L772-L834】
   - Despliega el servicio `bascula-ap-ensure.service`, que crea y activa el AP `BasculaAP` (wlan0, `192.168.4.1/24`) sólo cuando no hay conectividad previa. 【F:scripts/install-all.sh†L1090-L1185】【F:scripts/bascula-ap-ensure.sh†L1-L150】
  - El servicio espera hasta 25 segundos a que NetworkManager intente las redes guardadas antes de encender el AP (`nm-online`) y, si NetworkManager sigue en estado `connecting`, prolonga la espera hasta 45 segundos adicionales antes de activar el modo AP. 【F:systemd/bascula-ap-ensure.service†L1-L13】【F:scripts/bascula-ap-ensure.sh†L24-L120】

3. Reinicia el dispositivo al finalizar la instalación para cargar todos los servicios y reglas (`sudo reboot`).

Tras el reinicio:

- `bascula-miniweb.service` sirve la mini-web y la API en `http://localhost:8080`.
- `bascula-ui.service` lanza Chromium en modo kiosk apuntando a `http://localhost:8080` y gestiona el flujo de inicio tolerante a reinicios.
- El PIN de acceso se muestra en la pantalla principal y puede consultarse desde `/api/miniweb/pin` cuando se accede localmente.
- Si no hay Wi-Fi ni Ethernet, `bascula-ap-ensure.service` levanta `Bascula-AP` (`192.168.4.1`) con clave `Bascula1234` para exponer la miniweb en `http://192.168.4.1:8080`. 【F:scripts/bascula-ap-ensure.sh†L18-L115】

### Configuración de audio (HifiBerry + micro USB)

El instalador crea un `/etc/asound.conf` con aliases listos para compartir el micrófono USB (dsnoop a 48 kHz → plug `bascula_mix_in`) y mezclar la salida HifiBerry mediante `dmix` (`bascula_out`). 【F:scripts/install-all.sh†L212-L314】

Antes de ejecutar la instalación, verifica los índices reales de las tarjetas con:

```bash
arecord -l
aplay -l
```

En nuestros presets habituales: micrófono USB = `card 0, device 0`; HiFiBerry DAC = `card 1, device 0`. Si difiere, edita `/etc/asound.conf` y ajusta las secciones `pcm.raw_mic`/`pcm.raw_dac`. 【F:scripts/install-all.sh†L212-L314】

El backend consume estas variables publicadas por el servicio `bascula-miniweb`:

```
BASCULA_MIC_DEVICE=bascula_mix_in
BASCULA_SAMPLE_RATE=16000
BASCULA_AUDIO_DEVICE=bascula_out
```

El listener de wake-word opera siempre a 16 kHz mediante el alias `bascula_mix_in`, por lo que conviene mantener los aliases de ALSA generados por el instalador. Si el preflight del micrófono falla, el backend intentará usar el primer dispositivo USB disponible (`hw:<card>,0` detectado con `arecord -l`).

Tras `install-all.sh`, el script ejecuta pruebas rápidas: graba con `arecord` sobre `bascula_mix_in`, reinicia la miniweb para aplicar los overrides y reproduce audio por `bascula_out` (usando `aplay` o `speaker-test`). 【F:scripts/install-all.sh†L316-L392】

Para comprobaciones manuales adicionales:

```bash
arecord -D bascula_mix_in -f S16_LE -r 16000 -c 1 -d 2 /tmp/test.wav
aplay -D bascula_out /usr/share/sounds/alsa/Front_Center.wav
speaker-test -D bascula_out -t sine -f 440 -l 1
```

### Dependencias Python críticas

El backend y la miniweb requieren una serie de librerías que ahora se instalan desde `requirements.txt`. 【F:requirements.txt†L1-L20】
Entre las más relevantes se encuentran `fastapi`, `uvicorn[standard]`, `pydantic`, `rapidfuzz` (>=3,<4), `vosk`, `picamera2` y `piper-tts`, necesarias para la API, reconocimiento de voz y cámara. 【F:requirements.txt†L2-L20】
El instalador crea la `venv` con el usuario objetivo, instala esas dependencias y valida el entorno importando `fastapi`, `uvicorn` y `rapidfuzz` antes de habilitar los servicios, evitando fallos por módulos faltantes. 【F:scripts/install-all.sh†L1202-L1254】

Adicionalmente, asegúrate de tener disponibles los paquetes del sistema `python3-picamera2`, `rpicam-apps` y `python3-pil` (Pillow) para que la cámara IMX708 funcione con Picamera2 y el guardado de JPEG.

### Cámara (Picamera2 + miniweb)

La miniweb en `:8080` expone tres endpoints REST para consultar el estado de la cámara y realizar capturas puntuales:

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/camera/info` | Devuelve propiedades del sensor detectado (modelo, rotación y resolución nativa). |
| POST | `/api/camera/capture` | Captura un frame JPEG en memoria y lo devuelve como `image/jpeg`. |
| POST | `/api/camera/capture-to-file` | Captura un JPEG one-shot (`RGB888`) y lo guarda en `/tmp/camera-capture.jpg`, devolviendo `{ ok, path, full, size }`. |

Cada petición reutiliza la misma sesión de Picamera2, aplica la rotación correcta para el módulo IMX708 y guarda el archivo en RGB puro para evitar errores `cannot write mode RGBA as JPEG`.

La UI táctil se sirve desde `http://localhost` mediante Nginx. El bloque `location /api/` de `nginx/bascula.conf` actúa como proxy inverso hacia `http://127.0.0.1:8080/`, de modo que todas las llamadas `fetch('/api/...')` usan el mismo origen y no disparan CORS en Chromium kiosk. 【F:nginx/bascula.conf†L23-L44】

Para validar el proxy y la captura desde el propio dispositivo:

```bash
curl -s -X POST http://localhost/api/camera/capture-to-file | jq .
journalctl -u bascula-miniweb -n 50 --no-pager | grep 'POST /api/camera/capture-to-file' | tail -n 1
```

En la mini-web, el botón “Activar cámara” realiza el `POST` anterior y muestra `/tmp/camera-capture.jpg?ts=<epoch_ms>` para forzar un cache-buster en cada intento. Así se pueden repetir capturas sucesivas sin que el navegador reutilice la imagen previa.

## API de configuración de red

La mini-web expone endpoints REST pensados para el flujo de provisión sin `sudo` ni edición manual de perfiles de NetworkManager:

| Método | Endpoint                    | Descripción                                                                           |
|--------|-----------------------------|---------------------------------------------------------------------------------------|
| GET    | `/api/miniweb/scan-networks`| Escanea redes visibles y devuelve `{ssid, signal, sec, in_use, secured}` por entrada. 【F:backend/miniweb.py†L134-L183】|
| POST   | `/api/miniweb/connect`      | Recrea el perfil Wi-Fi con el SSID indicado, fija `autoconnect` (prioridad 120), baja `BasculaAP` y activa la nueva red. 【F:backend/miniweb.py†L1446-L1573】|
| GET    | `/api/miniweb/status`       | Devuelve el estado actual (`connected`, `internet`, `ssid`, `ip`, `ethernet_connected`, `ap_active`, `should_activate_ap`). 【F:backend/miniweb.py†L1707-L1808】|

> El endpoint legado `/api/miniweb/connect-wifi` permanece disponible como alias para compatibilidad.

## Mini-web de ajustes y API de settings

La mini-web completa está disponible en `http://<IP>:8080/config` durante el modo AP y también desde la red local habitual en
`http://<IP>/config`. Desde cualquier navegador conectado podrás introducir el PIN mostrado en la báscula y gestionar tanto la
conexión Wi-Fi como las integraciones (OpenAI, Nightscout, modo offline, etc.).

El backend expone una API específica para estos ajustes:

| Método  | Endpoint                 | Descripción |
|---------|--------------------------|-------------|
| GET     | `/api/settings`          | Devuelve la configuración actual normalizada, incluyendo `network.status`, `ui.offline_mode` y los indicadores de credenciales almacenadas. |
| POST    | `/api/settings`          | Persiste cambios de configuración. **Debe usarse `POST`** (no `PUT`), enviando JSON con los campos deseados. Cuando accedes desde otro dispositivo añade `Authorization: BasculaPin <PIN>` en la cabecera para autorizar la operación. |
| OPTIONS | `/api/settings`          | Expone `Allow: GET, POST, OPTIONS` para clientes y diagnósticos. |
| GET     | `/api/settings/health`   | Comprueba lectura/escritura del archivo de settings y responde `{ ok, can_write, message, version, updated_at }`. |

Los scripts, la UI táctil y la mini-web utilizan esta misma API. Tras ejecutar `scripts/install-all.sh` puedes validar el
comportamiento con:

```bash
curl -s http://localhost:8080/api/settings/health | jq .
curl -s http://localhost:8080/api/settings | jq .
curl -s -X POST http://localhost:8080/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"ui": {"offline_mode": false}}'
```

### Reglas de PolicyKit

Las reglas instaladas permiten al usuario `pi` (o miembros de `netdev`) ejecutar `nmcli` para escanear, crear conexiones Wi-Fi y gestionar modo compartido sin `sudo`. 【F:packaging/polkit/49-nmcli.rules†L1-L13】

### Modo AP de rescate

El modo AP está gestionado íntegramente por NetworkManager:

- **SSID**: `Bascula-AP`
- **Contraseña WPA2**: `Bascula1234` (puedes personalizarla exportando `AP_PASS="<tu_clave>"` antes de ejecutar el instalador o con
  `nmcli con modify BasculaAP wifi-sec.psk <nueva_clave>` tras la instalación).
- **IP de la báscula**: `192.168.4.1/24`
- **Miniweb**: `http://192.168.4.1:8080`

> Cambia esta contraseña en cuanto sea posible desde la miniweb para tu despliegue final.

Flujo esperado:

1. Sin credenciales conocidas → `bascula-ap-ensure.sh` crea/activa la red compartida en `wlan0` con DHCP interno de NetworkManager.
2. El usuario accede a `http://192.168.4.1:8080`, introduce el PIN y guarda una Wi-Fi doméstica.
3. Al enviar SSID y clave desde la miniweb, la Pi recrea el perfil Wi-Fi, lo exporta a `/etc/NetworkManager/system-connections/<SSID>.nmconnection` (permisos `600`, `autoconnect=yes`, prioridad `120`), desconecta `BasculaAP`, activa la red doméstica y reinicia el kiosk. Si más tarde se pierde la conectividad, el AP reaparece.

Verificación rápida (no bloqueante):

```bash
nmcli con show --active
nmcli dev status
nmcli -g connection.interface-name,802-11-wireless.mode,ipv4.method,ipv4.addresses,ipv4.gateway con show BasculaAP
journalctl -u bascula-ap-ensure -b | tail -n 20
ss -lntu | grep ':53' || true   # No debe aparecer dnsmasq.service
```

Todos estos pasos quedan automatizados por `scripts/bascula-ap-ensure.sh`, ejecutado como servicio `oneshot` con reintentos. 【F:scripts/bascula-ap-ensure.sh†L1-L150】【F:systemd/bascula-ap-ensure.service†L1-L16】

Checklist posterior a la instalación:

1. Tras ejecutar el instalador, confirma que `BasculaAP` no tiene autoconexión: `nmcli con show | grep BasculaAP` debe mostrar `autoconnect=no`.
2. Arranca sin cable Ethernet ni Wi-Fi guardada y verifica que el ensure levanta `BasculaAP` (SSID `Bascula-AP`).
3. Usa la miniweb para guardar una Wi-Fi válida; la AP debe bajar y la interfaz cambiar al modo normal tras obtener IP del router.
4. En un arranque posterior con esa Wi-Fi guardada, NetworkManager debe conectar al perfil cliente (prioridad 120) sin levantar la AP; si por cualquier motivo `BasculaAP` aparece activa, el ensure la apagará automáticamente al detectar conectividad.

## Validación recomendada

1. Tras una instalación limpia y reinicio, abre `http://localhost:8080` desde el propio dispositivo y confirma que se muestra el PIN de acceso.
2. Desde la mini-web (`/config`) o un navegador en la misma LAN:
   - Ejecuta un escaneo de redes y verifica que se listan SSID, nivel de señal, seguridad y la red actualmente en uso. 【F:src/pages/MiniWebConfig.tsx†L1-L210】
   - Conecta a una red protegida y comprueba que el endpoint responde con éxito y programa el reinicio.
3. Con Ethernet conectada, revisa que `bascula-ap-ensure` no active el AP (`nmcli -t -f NAME con show --active` no debe listar `BasculaAP`).
4. Tras desconectar Ethernet y eliminar cualquier Wi-Fi válida, `BasculaAP` debe aparecer con IP `192.168.4.1`. Verifica con los comandos de la sección anterior y consulta los logs con `journalctl -u bascula-ap-ensure -b`.

Con este flujo, una Raspberry Pi recién provisionada queda lista para funcionar sin intervenciones manuales en NetworkManager y con la UI limpia de branding antiguo.
