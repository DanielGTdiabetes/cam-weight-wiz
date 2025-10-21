# Báscula Digital Pro (cam-weight-wiz)

## Visión general
Báscula Digital Pro reúne en un único proyecto el backend FastAPI que orquesta el hardware de la báscula, la mini‑web de configuración y la interfaz kiosk desplegada en Raspberry Pi 5.【F:backend/main.py†L1346-L1352】【F:systemd/bascula-ui.service†L1-L33】 El frontal está construido con React + Vite y se entrega como una PWA lista para modo kiosk y recuperación automática.【F:package.json†L1-L13】【F:src/main.tsx†L1-L62】

## Componentes principales
- **Mini‑web (puerto 8080):** expone FastAPI `backend.miniweb` con APIs de cámara, báscula, voz contextual y administración, y sirve la UI para tareas de configuración.【F:backend/miniweb.py†L1-L104】【F:systemd/bascula-miniweb.service†L1-L27】  
- **Backend principal (puerto 8081):** concentra lógica de negocio, OCR, Nightscout, agregados de estado y cola de eventos que alimenta la interfaz principal.【F:backend/main.py†L3120-L3218】【F:systemd/bascula-backend.service†L1-L21】  
- **UI kiosk:** servicio `bascula-ui.service` que arranca Chromium en pantalla completa tras validar que mini‑web y backend están sanos.【F:systemd/bascula-ui.service†L1-L33】  
- **Servicios de voz:** `VoiceService` gestiona push‑to‑talk, sincroniza el micro y expone transcripciones para el asistente de recetas.【F:backend/services/voice_service.py†L1-L124】  
- **Automatización de despliegue:** `scripts/install-all.sh` instala dependencias del sistema, crea releases OTA en `/opt/bascula`, configura audio/nginx/systemd y guarda logs idempotentes.【F:scripts/install-all.sh†L1-L115】【F:scripts/install-all.sh†L280-L335】【F:scripts/install-all.sh†L1656-L1760】

## Características destacadas
- **Estado agregado sin fallos duros:** `GET /api/state` resume versión, modo de app, servicios críticos, conectividad y flags de diabetes sin propagar excepciones cuando algún subsistema no responde.【F:backend/main.py†L3120-L3218】
- **Recuperación automática en la UI:** la lógica de `useServiciosState` activa `recovery_mode` tras tres fallos consecutivos en los endpoints críticos y limpia la bandera cuando se estabilizan.【F:src/hooks/servicios/useServiciosState.ts†L24-L207】
- **Push‑to‑talk bajo demanda:** el backend abre el micro sólo cuando el modo recetas está activo, libera el recurso al finalizar y devuelve la transcripción para la UI.【F:backend/services/voice_service.py†L35-L144】
- **Verificaciones post‑instalación reproducibles:** `scripts/post-install-checks.sh` ejecuta pruebas de systemd, nginx, mini‑web, cámara y audio, y permite omitir audio con `SKIP_AUDIO=1`.【F:scripts/post-install-checks.sh†L1-L48】

## Servicios, puertos y rutas relevantes
| Servicio | Puerto | Descripción |
| --- | --- | --- |
| `bascula-miniweb.service` | 8080 | FastAPI de configuración/diagnóstico y API pública de la báscula.【F:systemd/bascula-miniweb.service†L1-L27】 |
| `bascula-backend.service` | 8081 | Backend principal (`python -m backend.main`) con OCR, Nightscout y agregados de estado.【F:systemd/bascula-backend.service†L1-L21】【F:backend/main.py†L3246-L3268】 |
| `bascula-ui.service` | kiosk | Chromium en pantalla completa; espera a que mini‑web responda antes de lanzar la sesión gráfica.【F:systemd/bascula-ui.service†L1-L33】 |
| Capturas HTTP | 80 | Nginx sirve `/captures/` y los estáticos compilados desde `/opt/bascula/current/dist`.【F:scripts/install-all.sh†L336-L367】【F:scripts/install-all.sh†L280-L335】 |

## Requisitos
- **Hardware:** Raspberry Pi 5 con Bookworm Lite de 64 bits, cámara (IMX708 o USB), DAC/altavoz y báscula HX711 o serie.【F:scripts/install-all.sh†L1-L108】【F:scripts/install-all.sh†L1600-L1726】
- **Sistema base:** ejecutar el instalador como `root` en la Pi con acceso a Internet para resolver dependencias APT (libcamera, Chromium, nginx, ALSA, etc.).【F:scripts/install-all.sh†L1-L108】【F:scripts/install-all.sh†L1180-L1190】

## Instalación rápida en Raspberry Pi OS (Bookworm Lite)
1. **Copiar el repositorio** a la Pi (por ejemplo `/home/pi/cam-weight-wiz`).
2. **Ejecutar el instalador idempotente:**
   ```bash
   cd /home/pi/cam-weight-wiz
   sudo ./scripts/install-all.sh
   ```
   El script gestiona el país Wi‑Fi, sincroniza una nueva release en `/opt/bascula/releases/<timestamp>` y enlaza `/opt/bascula/current`. También crea la virtualenv compartida, instala dependencias Python y despliega servicios systemd/nginx.【F:scripts/install-all.sh†L20-L55】【F:scripts/install-all.sh†L1656-L1760】【F:scripts/install-all.sh†L280-L335】
3. **Personalizar variables opcionales:**
   - `WIFI_COUNTRY=MX` para fijar el dominio regulatorio antes de instalar.【F:scripts/install-all.sh†L20-L55】
   - `BASCULA_TRACE=1` para obtener trazas detalladas en el log.【F:scripts/install-all.sh†L71-L83】
   - `BASCULA_LOG_DIR=/ruta` o `BASCULA_LOG_FILE=/ruta/log.log` para redirigir la salida.【F:scripts/install-all.sh†L60-L70】
4. **Verificar tras el reboot (si el instalador lo solicita):**
   ```bash
   sudo ./scripts/post-install-checks.sh
   ```
   Usa `SKIP_AUDIO=1` si aún no tienes DAC/mic conectados.【F:scripts/post-install-checks.sh†L1-L48】

## Desarrollo local
- **Frontend:** `npm install` y `npm run dev` lanzan la app React en modo desarrollo con Vite y Tailwind; `npm run build` genera el paquete que servirá la mini‑web.【F:package.json†L6-L13】
- **Backend:** `python -m backend.main --host 0.0.0.0 --port 8081` arranca la API de FastAPI; se puede usar uvicorn directamente si se desea recarga en desarrollo.【F:backend/main.py†L3246-L3268】
- **Mini‑web en local:** `uvicorn backend.miniweb:app --reload --port 8080` permite probar la interfaz de configuración sin hardware, con modo demo configurable mediante variables (`BASCULA_MINIWEB_SCALE_MODE`, `BASCULA_SCALE_DEMO`, etc.).【F:backend/miniweb.py†L1-L104】【F:systemd/bascula-miniweb.service†L15-L22】

## Documentación adicional
- [docs/INSTALL.md](docs/INSTALL.md): guía completa de instalación y post‑instalación.
- [INTEGRATION.md](INTEGRATION.md): resumen de endpoints para integrar hardware externo.
- [DEPLOYMENT.md](DEPLOYMENT.md): checklist de despliegue y validación manual.

