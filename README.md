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
   - Despliega el servicio `bascula-ap-ensure.service`, que recrea el perfil `BasculaAP` en `wlan0` (`192.168.4.1/24`, WPA2-PSK) y sólo levanta la AP cuando no existe conectividad real (ping + DNS o `nmcli g connectivity`). 【F:scripts/install-all.sh†L703-L812】【F:scripts/bascula-ap-ensure.sh†L1-L210】
  - El servicio activa la radio Wi-Fi con dominio regulatorio `ES`, respeta el flag `/run/bascula/force_ap` para tareas de mantenimiento y reinicia la miniweb tras subir la AP para asegurar el portal de configuración. 【F:systemd/bascula-ap-ensure.service†L1-L13】【F:scripts/bascula-ap-ensure.sh†L40-L205】

3. Reinicia el dispositivo al finalizar la instalación para cargar todos los servicios y reglas (`sudo reboot`).

Tras el reinicio:

- `bascula-miniweb.service` sirve la mini-web y la API en `http://localhost:8080`.
- `bascula-app.service` lanza Chromium en modo kiosk apuntando a `http://localhost:8080`.
- El PIN de acceso se muestra en la pantalla principal y puede consultarse desde `/api/miniweb/pin` cuando se accede localmente.
- Si no hay Wi-Fi ni Ethernet, `bascula-ap-ensure.service` levanta `Bascula-AP` (`192.168.4.1`) con clave `Bascula1234` para exponer la miniweb en `http://192.168.4.1:8080`. 【F:scripts/bascula-ap-ensure.sh†L18-L115】

## API de configuración de red

La mini-web expone endpoints REST pensados para el flujo de provisión sin `sudo` ni edición manual de perfiles de NetworkManager:

| Método | Endpoint                    | Descripción                                                                           |
|--------|-----------------------------|---------------------------------------------------------------------------------------|
| GET    | `/api/miniweb/scan-networks`| Escanea redes visibles y devuelve `{ssid, signal, sec, in_use, secured}` por entrada. 【F:backend/miniweb.py†L134-L183】|
| POST   | `/api/miniweb/connect`      | Crea un perfil Wi-Fi persistente en `/etc/NetworkManager/system-connections/` (autoconnect=YES, prioridad 200), elimina el flag de AP forzado, baja `BasculaAP` y activa la nueva red. 【F:backend/miniweb.py†L1806-L2112】|
| GET    | `/api/miniweb/status`       | Devuelve el estado actual (`connected`, `ssid`, `ip`, `ethernet_connected`, `ap_active`, `should_activate_ap`). 【F:backend/miniweb.py†L531-L575】|

> El endpoint legado `/api/miniweb/connect-wifi` permanece disponible como alias para compatibilidad.

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
3. Al enviar SSID y clave desde la miniweb, la Pi recrea el perfil Wi-Fi, lo exporta a `/etc/NetworkManager/system-connections/<SSID>.nmconnection` (permisos `600`, `autoconnect=yes`, prioridad `200`), elimina el flag `/run/bascula/force_ap`, desconecta `BasculaAP`, activa la red doméstica y reinicia el kiosk. Si más tarde se pierde la conectividad, el AP reaparece.

Verificación rápida (no bloqueante):

```bash
nmcli con show --active
nmcli dev status
nmcli -g connection.interface-name,802-11-wireless.mode,ipv4.method,ipv4.addresses,ipv4.gateway con show BasculaAP
journalctl -u bascula-ap-ensure -b | tail -n 20
ss -lntu | grep ':53' || true   # No debe aparecer dnsmasq.service
```

Todos estos pasos quedan automatizados por `scripts/bascula-ap-ensure.sh`, ejecutado como servicio `oneshot` con reintentos. 【F:scripts/bascula-ap-ensure.sh†L1-L210】【F:systemd/bascula-ap-ensure.service†L1-L16】

Checklist posterior a la instalación:

1. Tras ejecutar el instalador, confirma que `BasculaAP` no tiene autoconexión: `nmcli con show | grep BasculaAP` debe mostrar `autoconnect=no`.
2. Arranca sin cable Ethernet ni Wi-Fi guardada y verifica que el ensure levanta `BasculaAP` (SSID `Bascula-AP`).
3. Usa la miniweb para guardar una Wi-Fi válida; la AP debe bajar y la interfaz cambiar al modo normal tras obtener IP del router.
4. En un arranque posterior con esa Wi-Fi guardada, NetworkManager debe conectar al perfil cliente (prioridad 200) sin levantar la AP; si por cualquier motivo `BasculaAP` aparece activa, el ensure la mantendrá solo si el flag de mantenimiento existe y, en caso contrario, la apagará automáticamente al detectar conectividad real.

Cuando el usuario habilita el AP manualmente desde la miniweb se crea el flag `/run/bascula/force_ap`, evitando que el ensure lo tumbe aunque exista cable Ethernet o una Wi-Fi operativa. Al conectar a una Wi-Fi doméstica desde la miniweb, ese flag se elimina, se baja `BasculaAP` y el perfil persistente se activa inmediatamente. 【F:backend/miniweb.py†L2038-L2137】【F:scripts/bascula-ap-ensure.sh†L91-L165】

## Validación recomendada

1. Tras una instalación limpia y reinicio, abre `http://localhost:8080` desde el propio dispositivo y confirma que se muestra el PIN de acceso.
2. Desde la mini-web (`/config`) o un navegador en la misma LAN:
   - Ejecuta un escaneo de redes y verifica que se listan SSID, nivel de señal, seguridad y la red actualmente en uso. 【F:src/pages/MiniWebConfig.tsx†L1-L210】
   - Conecta a una red protegida y comprueba que el endpoint responde con éxito y programa el reinicio.
3. Con Ethernet conectada, revisa que `bascula-ap-ensure` no active el AP (`nmcli -t -f NAME con show --active` no debe listar `BasculaAP`).
4. Tras desconectar Ethernet y eliminar cualquier Wi-Fi válida, `BasculaAP` debe aparecer con IP `192.168.4.1`. Verifica con los comandos de la sección anterior y consulta los logs con `journalctl -u bascula-ap-ensure -b`.

Con este flujo, una Raspberry Pi recién provisionada queda lista para funcionar sin intervenciones manuales en NetworkManager y con la UI limpia de branding antiguo.
