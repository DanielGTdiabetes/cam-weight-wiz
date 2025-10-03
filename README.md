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
   - Instala y habilita el temporizador de fallback (`bascula-net-fallback`) que activa el AP sólo cuando no hay Wi-Fi ni Ethernet disponibles. 【F:scripts/net-fallback.sh†L1-L152】

3. Reinicia el dispositivo al finalizar la instalación para cargar todos los servicios y reglas (`sudo reboot`).

Tras el reinicio:

- `bascula-miniweb.service` sirve la mini-web y la API en `http://localhost:8080`.
- `bascula-app.service` lanza Chromium en modo kiosk apuntando a `http://localhost:8080`.
- El PIN de acceso se muestra en la pantalla principal y puede consultarse desde `/api/miniweb/pin` cuando se accede localmente.

## API de configuración de red

La mini-web expone endpoints REST pensados para el flujo de provisión sin `sudo` ni edición manual de perfiles de NetworkManager:

| Método | Endpoint                    | Descripción                                                                           |
|--------|-----------------------------|---------------------------------------------------------------------------------------|
| GET    | `/api/miniweb/scan-networks`| Escanea redes visibles y devuelve `{ssid, signal, sec, in_use, secured}` por entrada. 【F:backend/miniweb.py†L134-L183】|
| POST   | `/api/miniweb/connect`      | Crea/actualiza el perfil `BasculaHome` y conecta a la red indicada; programa un reinicio automático. 【F:backend/miniweb.py†L694-L745】|
| GET    | `/api/miniweb/status`       | Devuelve el estado actual (`connected`, `ssid`, `ip`, `ethernet_connected`, `ap_active`, `should_activate_ap`). 【F:backend/miniweb.py†L531-L575】|

> El endpoint legado `/api/miniweb/connect-wifi` permanece disponible como alias para compatibilidad.

### Reglas de PolicyKit

Las reglas instaladas permiten al usuario `pi` (o miembros de `netdev`) ejecutar `nmcli` para escanear, crear conexiones Wi-Fi y gestionar modo compartido sin `sudo`. 【F:packaging/polkit/49-nmcli.rules†L1-L13】

### Modo AP de rescate

`scripts/net-fallback.sh` se ejecuta periódicamente y sólo levanta el AP `BasculaAP` (`192.168.4.1`) cuando:

- No hay conexión Ethernet activa.
- No se detecta conectividad a Internet mediante Wi-Fi.

Si se detecta Ethernet, el AP se desactiva automáticamente para priorizar la red cableada. 【F:scripts/net-fallback.sh†L30-L134】

## Validación recomendada

1. Tras una instalación limpia y reinicio, abre `http://localhost:8080` desde el propio dispositivo y confirma que se muestra el PIN de acceso.
2. Desde la mini-web (`/config`) o un navegador en la misma LAN:
   - Ejecuta un escaneo de redes y verifica que se listan SSID, nivel de señal, seguridad y la red actualmente en uso. 【F:src/pages/MiniWebConfig.tsx†L1-L210】
   - Conecta a una red protegida y comprueba que el endpoint responde con éxito y programa el reinicio.
3. Con Ethernet conectada, asegúrate de que el AP `BasculaAP` no se levanta (el timer lo desactivará si estuviera activo). 【F:scripts/net-fallback.sh†L105-L134】
4. Si desconectas Ethernet y no hay Wi-Fi válida, el AP `BasculaAP` debe activarse automáticamente para permitir la configuración.

Con este flujo, una Raspberry Pi recién provisionada queda lista para funcionar sin intervenciones manuales en NetworkManager y con la UI limpia de branding antiguo.
