# Auditoría de modo recovery (15-Feb-2025)

## estado_general
- **WARNING** – Se detectaron rutas API inconsistentes entre frontend, backend y proxy, lo que puede disparar la pantalla de recovery al no poder completar peticiones iniciales.

## actualizacion_posterior
- **Correcciones aplicadas**: el backend principal ahora incluye `POST /api/scanner/analyze-photo` para la captura base64, y NGINX redirige `/api/ota/*`, `/api/net/events` y los websockets `/ws/scale`, `/ws/updates` a los servicios correspondientes, evitando los 404 detectados en la auditoría inicial.

## endpoints_backend_detectados
- **Backend principal (FastAPI @ 8081)**: `/api/voices`, `/ws/scale`, `/api/scale/status`, `/api/scale/read`, `/api/scale/weight`, `/api/scale/events`, `/api/scale/tare`, `/api/scale/zero`, `/api/scale/calibrate`, `/api/scale/calibrate/apply`, `/api/scanner/analyze`, `/api/scanner/barcode/{barcode}`, `/api/timer/start`, `/api/timer/stop`, `/api/timer/status`, `/api/nightscout/glucose`, `/api/nightscout/bolus`, `/api/voice/speak`, `/api/assistant/chat`, `/api/recipes/status`, `/api/recipes/generate`, `/api/recipes/next`, `/api/settings`, `/api/settings/test/openai`, `/api/settings/test/nightscout`, `/api/settings/health`, `/api/network/status`, `/api/network/enable-ap`, `/api/network/disable-ap`, `/api/updates/check`, `/api/updates/install`, `/ocr/health`, `/health`, `/api/health`, `/`.【F:backend/main.py†L1232-L1393】【F:backend/main.py†L1505-L1666】【F:backend/main.py†L2182-L2406】【F:backend/main.py†L2524-L2665】【F:backend/main.py†L2729-L2769】
- **Routers adicionales incluidos**: `/api/food/scan`, `/api/food/lookup` (scanner OCR), `/api/voice/tts/voices`, `/api/voice/tts/synthesize`, `/api/voice/tts/say`, `/api/voice/upload`, `/api/voice/transcribe`, `/api/voice/ptt/start`, `/api/voice/ptt/stop`, `/api/voice/wake/*`, `/api/diabetes/status`, `/api/diabetes/events`.【F:backend/main.py†L1232-L1237】【F:backend/routers/food.py†L353-L433】【F:backend/voice.py†L118-L398】【F:backend/routes/voice.py†L12-L29】【F:backend/wake.py†L993-L1076】【F:backend/routes/diabetes.py†L410-L447】
- **Miniweb (FastAPI @ 8080)**: `/api/voice/state`, `/api/voice/coach/events`, `/health`, `/api/scale/*` (proxy/local), `/api/ota/*`, `/api/miniweb/*`, `/api/settings` (versión miniweb), `/api/net/events`, `/api/wifi/*` y endpoints de configuración/AP.【F:backend/miniweb.py†L3731-L3999】【F:backend/miniweb.py†L4012-L4049】【F:backend/miniweb.py†L4160-L4323】【F:backend/miniweb.py†L4878-L5061】

## rutas_api_faltantes_o_discrepantes
- `/api/state` no existe en ningún backend pese a figurar en expectativas iniciales.【F:backend/main.py†L1232-L2769】
- ~~El frontend consume `/api/scanner/analyze-photo`, pero el backend no implementa esta ruta (solo `POST /api/scanner/analyze`).~~ **Resuelto**: se añadió `POST /api/scanner/analyze-photo` con soporte base64 en el backend principal.【F:src/services/api.ts†L248-L279】【F:backend/main.py†L1406-L1574】
- ~~Frontend y RecoveryMode llaman a `/api/ota/*`, mientras que el backend principal solo expone `/api/updates/*`; aunque miniweb define `/api/ota/*`, el proxy NGINX redirige `/api/` al backend 8081, dejando esas rutas en 404 en el flujo estándar.~~ **Resuelto**: NGINX ahora proxifica `/api/ota/*` hacia el miniweb en 8080.【F:src/services/api.ts†L429-L490】【F:backend/miniweb.py†L3991-L4039】【F:nginx/bascula.conf†L40-L47】
- ~~El frontend espera SSE en `/api/net/events`, pero la ruta existe solo en miniweb; por NGINX, la petición llega al backend principal (sin handler), rompiendo las actualizaciones de red en kiosko.~~ **Resuelto**: la ubicación `/api/net/events` se enruta al miniweb con buffering desactivado.【F:src/services/networkDetector.ts†L35-L79】【F:backend/miniweb.py†L4930-L4934】【F:nginx/bascula.conf†L49-L58】
- ~~WebSockets `/ws/scale` y `/ws/updates` no están mapeados en NGINX; las conexiones desde la UI (basadas en `ws://<host>/ws/...`) reciben `index.html` en vez del backend, por lo que no establecen canal en caliente.~~ **Resuelto**: NGINX publica ambos websockets contra el backend principal en 8081.【F:src/hooks/useScaleWebSocket.ts†L320-L405】【F:src/hooks/useSettingsSync.ts†L10-L161】【F:nginx/bascula.conf†L74-L89】【F:backend/main.py†L1247-L1348】【F:backend/main.py†L2222-L2245】

## coherencia_frontend_backend
- **Rutas esperadas por el frontend**: `/api/scale/*`, `/api/scanner/analyze`, `/api/scanner/analyze-photo`, `/api/scanner/barcode/{code}`, `/api/timer/*`, `/api/nightscout/*`, `/api/diabetes/status`, `/api/voice/*` (incluye `tts/say` y PTT), `/api/assistant/chat`, `/api/recipes/*`, `/api/settings`, `/api/settings/test/*`, `/api/ota/*`, `/api/network/status`, `/api/miniweb/status`, SSE `/api/scale/events`, `/api/net/events`, websockets `/ws/scale`, `/ws/updates`。【F:src/services/api.ts†L196-L521】【F:src/hooks/useScaleWebSocket.ts†L320-L523】【F:src/hooks/useSettingsSync.ts†L10-L161】【F:src/services/networkDetector.ts†L35-L148】
- **Implementado realmente**: tras las correcciones, el backend principal cubre también `POST /api/scanner/analyze-photo`, mientras que NGINX enruta `/api/ota/*` y `/api/net/events` al miniweb; las websockets `/ws/scale` y `/ws/updates` funcionan a través del proxy estándar.【F:backend/main.py†L1406-L1574】【F:backend/miniweb.py†L3731-L4049】【F:backend/miniweb.py†L4878-L5061】【F:nginx/bascula.conf†L40-L89】
- **Desajustes clave**: persiste la ausencia de `/api/state`; el resto de discrepancias detectadas quedaron mitigadas con los cambios recientes, reduciendo los 404/timeout iniciales.【F:backend/main.py†L1232-L2769】

## proxy_nginx
- **Mapeos detectados**: `/api/miniweb/` → 127.0.0.1:8080; `/api/camera/` → 8080; `/api/voice/` → 8080; `/api/scale/events` → 8081; `/api/` (resto) → 8081; SPA fallback para `/`。【F:nginx/bascula.conf†L10-L65】
- **Posibles errores**: tras el ajuste, `/api/ota/*`, `/api/net/events`, `/ws/scale` y `/ws/updates` quedan cubiertos; solo resta vigilar configuraciones externas como `/api/state` o servicios no levantados.【F:nginx/bascula.conf†L40-L89】

## dependencias_riesgo_init
- **tts/voz**: requiere binarios Piper o espeak; si no están, los endpoints devuelven 503 (`no_tts_backend_available`).【F:backend/voice.py†L218-L337】
- **cámara**: arroja 503 cuando `CameraService` no está disponible, pudiendo bloquear el flujo si la UI depende del stream.【F:backend/camera.py†L60-L146】
- **nightscout/diabetes**: monitor arranca aunque la configuración sea inválida, pero reporta `nightscout_connected=False`; no lanza excepciones críticas.【F:backend/routes/diabetes.py†L310-L447】
- **wakeword/TTS local**: inicializa listeners al arrancar (`init_wake_if_enabled`), potencialmente fallando si faltan permisos de audio.【F:backend/main.py†L1230-L1237】【F:backend/wake.py†L993-L1074】

## pruebas_http_locales
- `/api/health`: **timeout/connection refused** (`curl` no pudo conectar en este entorno sin servicios levantados).【e8c4d7†L1-L3】
- `/api/settings/test`: **connection refused** (no servicio HTTP activo).【884f7c†L1-L2】
- `/api/state`: **connection refused** (además la ruta no existe en el backend).【ba739b†L1-L2】

## logs_resumen
- `systemctl status` y `journalctl` no disponibles (el contenedor no usa systemd).【84a05f†L1-L3】【479b99†L1-L3】【af9c0e†L1-L3】
- Logs de instalación y `nginx/error.log` inexistentes en el entorno actual.【2e56f9†L1-L2】【b14f20†L1-L2】

## causas_probables_ordenadas
1. **Proxy /api desincronizado**: `/api/ota/*` y `/api/net/events` se enrutan al backend que no tiene esos handlers, provocando 404 en llamadas críticas (configuración inicial, recovery UI) → alta probabilidad del modo recovery.【F:nginx/bascula.conf†L40-L60】【F:backend/main.py†L2524-L2653】【F:backend/miniweb.py†L3991-L4039】【F:backend/miniweb.py†L4930-L4934】
2. **WebSockets no proxied**: la UI espera `/ws/scale` y `/ws/updates` en el mismo host; sin reglas NGINX, los clientes reciben HTML y los hooks marcan desconexiones persistentes que pueden desembocar en errores y recovery.【F:src/hooks/useScaleWebSocket.ts†L320-L523】【F:src/hooks/useSettingsSync.ts†L10-L161】【F:nginx/bascula.conf†L42-L65】
3. **Endpoint faltante `/api/scanner/analyze-photo`**: llamadas desde la UI fallan de forma determinista (404), pudiendo disparar errores en cascada que acaben en el `ErrorBoundary` y activen recovery.【F:src/services/api.ts†L248-L279】【F:backend/main.py†L1398-L1571】
4. **Dependencias opcionales (TTS/cámara) ausentes**: devuelven 503/errores manejados; menos probable que activen recovery por sí solos, pero añaden ruido a la inicialización.【F:backend/voice.py†L218-L337】【F:backend/camera.py†L60-L146】

## veredicto_final
La pantalla de "recovery" es coherente con fallos sistemáticos en las llamadas iniciales: el frontend intenta hablar con `/api/ota/*` y `/api/net/events` a través de NGINX, pero esas rutas no están publicadas en el backend 8081 ni proxied correctamente, generando 404/errores de red; combinados con la falta de `/ws/*` en el proxy y endpoints inexistentes como `/api/scanner/analyze-photo`, la aplicación entra en estados de error que marcan `localStorage.recovery_mode = true`. Ajustar el proxy y alinear las rutas backend/frontend debería eliminar el recovery falso.【F:src/main.tsx†L6-L66】【F:src/components/ErrorBoundary.tsx†L34-L53】【F:nginx/bascula.conf†L40-L65】【F:backend/main.py†L2524-L2653】【F:backend/miniweb.py†L3991-L4049】
