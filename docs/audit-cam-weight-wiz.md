# Auditoría técnica – cam-weight-wiz (Raspberry Pi kiosk)

## Resumen ejecutivo (Top 5 riesgos)
1. **Edición remota bloqueada:** El backend solo expone `POST /api/settings` y exige el PIN en el cuerpo, mientras que la miniweb consume `PUT /api/settings` con cabecera `Authorization: BasculaPin …`, por lo que cualquier guardado desde la LAN falla con 403 o 405. 【F:backend/miniweb.py†L3663-L3683】【F:src/services/api.ts†L349-L365】【F:src/pages/MiniWebConfig.tsx†L744-L787】
2. **Errores 500 al guardar ajustes:** La rutina `update_settings` usa la variable local `changed` sin inicializar; en la mayoría de rutas (OpenAI/Nightscout/UI) nunca se asigna y se lanza `UnboundLocalError`, por lo que los cambios no se persisten. 【F:backend/miniweb.py†L3788-L3893】
3. **OpenAI API key no se guarda:** El backend ignora `payload.network.openai_api_key`, pero la UI solo envía ese formato moderno, así que la clave queda siempre vacía incluso si el bug anterior se corrige. 【F:backend/miniweb.py†L3701-L3720】【F:src/pages/MiniWebConfig.tsx†L752-L780】
4. **Sin health-check de configuración:** La miniweb invoca `GET /api/settings/health` para validar permisos y mostrar feedback, pero el servicio FastAPI no implementa ese endpoint, produciendo errores persistentes en la interfaz. 【F:src/pages/MiniWebConfig.tsx†L349-L371】
5. **Sin versionado/permiso seguro del archivo:** El backend guarda `~/.bascula/config.json` con `_save_json`, que no aplica `chmod 600`, `chown pi:pi` ni incrementa `meta.version`; en consecuencia el websocket siempre emite versión `0` y se rompe la sincronización fina y los requisitos de seguridad. 【F:backend/miniweb.py†L231-L240】【F:backend/miniweb.py†L3896-L3911】【F:backend/app/services/settings_service.py†L118-L145】

> **Actualización (2024):** La API publica ahora `Allow: GET, POST, OPTIONS` para `/api/settings` y únicamente acepta `POST` para persistir cambios; la miniweb y el SDK cliente ya emiten `POST` con la cabecera `BasculaPin` cuando corresponda. 【F:backend/main.py†L1706-L1721】【F:src/services/api.ts†L355-L370】【F:src/pages/MiniWebConfig.tsx†L818-L835】

## Matriz de riesgos y acciones propuestas
| Prioridad | Hallazgo | Acción recomendada |
| --- | --- | --- |
| P0 | API de settings incompatible con la miniweb y uso incorrecto del PIN | Migrar todos los clientes a `POST /api/settings`, anunciar `Allow: GET, POST, OPTIONS` y validar siempre la cabecera `Authorization: BasculaPin …` en peticiones remotas. |
| P0 | Variable `changed` sin inicializar provoca 500 | Inicializar `changed = False` al inicio y marcarla en cada sección que modifica config antes de evaluar `if changed`. |
| P0 | Ignora `network.openai_api_key` (nuevo esquema) | Normalizar payloads heredados y modernos: mapear `payload.network.openai_api_key` hacia la estructura `settings.network.openai_api_key` antes de guardar. |
| P1 | Falta health-check real / pruebas de escritura | Implementar `GET /api/settings/health` reutilizando `SettingsService` para comprobar lectura, escritura (tmp + fsync + rename) y permisos correctos. |
| P1 | Sin versionado/diff en WebSocket y sin permisos 600/700 | Reutilizar `SettingsService.save()` en miniweb para asegurar metadata (`meta.version`, `updated_at`), permisos y propietario. Emitir en el WS `{version, diff}` calculado respecto al payload previo. |
| P1 | Tests OpenAI/Nightscout sin rate limit ni cabecera PIN | Leer el PIN de la cabecera si está presente, aplicar rate limit por IP y reducir timeout de OpenAI a ≤5 s. |
| P2 | Logs de eventos incluyen `nightscout_url` en metadata | Redactar o truncar URL sensibles antes de registrar/broadcast para evitar exponer datos personales. |
| P2 | CORS `*` sin CSRF adicional | Restringir orígenes a la miniweb local o exigir siempre el header `Authorization` + token anti-CSRF. |

## Hallazgos detallados

### A. Backend (FastAPI)
1. **Método HTTP incorrecto y PIN solo en el cuerpo (P0).** El backend declara `@app.post("/api/settings")` y llama a `_ensure_pin_valid_for_request` con `payload.pin`, ignorando la cabecera `Authorization`. 【F:backend/miniweb.py†L3669-L3680】 La miniweb utiliza `PUT /api/settings` y únicamente la cabecera `BasculaPin`. 【F:src/services/api.ts†L349-L365】【F:src/pages/MiniWebConfig.tsx†L744-L787】 Resultado: las peticiones devuelven 403/405. **Fix:** consolidar en `POST /api/settings`, rechazar `PUT` con 405 y validar siempre la cabecera `BasculaPin` para peticiones remotas, reutilizando `SettingsService.save()`.

2. **Variable `changed` sin inicializar (P0).** Tras procesar las secciones, la función evalúa `if changed:` pero nunca definió `changed = False`. 【F:backend/miniweb.py†L3788-L3893】 Python lanza `UnboundLocalError`, por lo que ningún cambio llega a disco. **Fix:** inicializar `changed = False` antes de las ramas y marcarla en todas las secciones (`openai`, `nightscout`, `ui`, etc.) cuando haya modificaciones.

3. **Compatibilidad incompleta con el nuevo esquema (P0).** La UI envía `payload.network.openai_api_key`, pero el backend solo lee `payload.openai.apiKey`; la clave jamás se actualiza y la IA queda inutilizada. 【F:backend/miniweb.py†L3701-L3712】【F:src/pages/MiniWebConfig.tsx†L752-L780】 **Fix:** mapear `payload.network.openai_api_key` y `payload.diabetes.{nightscout_url,nightscout_token}` hacia la estructura canónica antes de guardar, y tratar `__stored__` como placeholder para conservar secretos existentes.

4. **Sin endpoint `GET /api/settings/health` (P1).** La miniweb llama a ese recurso para mostrar estado y permisos. 【F:src/pages/MiniWebConfig.tsx†L349-L371】 Al no existir, siempre muestra error (“No se pudo contactar…”). **Fix:** implementar `SettingsService.health()` que compruebe lectura, escriba un temporal con `fsync` + `os.replace`, verifique permisos `700/600` y devolver flags `can_read/can_write` reales.

5. **Guardado inseguro fuera del servicio (P1).** `_save_json` crea la carpeta con permisos por defecto y no aplica `chmod 600` ni `chown pi:pi`. 【F:backend/miniweb.py†L193-L200】【F:backend/miniweb.py†L231-L240】 Además no incrementa `meta.version` como sí hace `SettingsService._save_atomic`. 【F:backend/app/services/settings_service.py†L118-L145】 **Fix:** reemplazar `_save_json` por `SettingsService.save()` o replicar el flujo completo (permisos, fsync, metadata) para evitar condiciones de carrera y asegurar el versionado.

6. **WebSocket sin `diff` ni versión válida (P1).** El mensaje `settings.changed` sólo contiene `fields` y `metadata`, la versión queda fija en `0` porque el archivo carece de `meta.version`. 【F:backend/miniweb.py†L3896-L3911】 **Fix:** generar un diff real (por ejemplo con `dictdiffer`) y enviar `{version, diff}` tras salvar usando `SettingsService` para que la segunda pantalla aplique cambios en caliente.

7. **Test OpenAI con timeout excesivo (P1).** La llamada usa `httpx.AsyncClient(timeout=10.0)`, excediendo los 5 s requeridos. 【F:backend/miniweb.py†L3968-L3976】 **Fix:** bajar a 5 s y añadir `asyncio.wait_for` o `timeout=5.0`.

### B. Seguridad
1. **PIN vulnerable a CSRF y no reusable (P0).** Con CORS `*` y sin exigencia de cabecera, un sitio externo podría enviar `POST /api/settings` con el PIN en el cuerpo si el usuario lo introduce en la interfaz. Además, el flujo actual ignora la cabecera que la UI sí envía. 【F:backend/miniweb.py†L3613-L3624】【F:src/pages/MiniWebConfig.tsx†L764-L770】 **Fix:** obligar a `Authorization: BasculaPin …` para toda petición no loopback, validar formato y añadir comprobación doble (PIN + token antifalsificación) o restringir orígenes a `http(s)://<host>:8080`.

2. **Permisos de `~/.bascula` laxos (P1).** `CFG_DIR.mkdir` no especifica modo `0o700`, dejando la carpeta legible para otros usuarios. 【F:backend/miniweb.py†L193-L200】 **Fix:** usar `mode=0o700` y `os.chmod` tras crearla, alineado con `SettingsService._ensure_dir`.

3. **Metadata sensible en logs/WS (P2).** Se emite `nightscout_url` en `change_metadata`, lo que llega a los clientes vía WebSocket. 【F:backend/miniweb.py†L3751-L3910】 **Fix:** redactar o remover el valor, manteniendo sólo flags booleanos (`has_url`).

### C. Sincronización en tiempo real
1. **Sin versión ni diff (P1).** Ver hallazgo A6: el WS no cumple el contrato `{version, diff}` y siempre envía versión 0. 【F:backend/miniweb.py†L3896-L3911】
2. **Sin normalización tras reconexión (P1).** Al no incrementar `meta.version`, los clientes no pueden detectar race conditions. **Fix:** persistir `meta.version` y enviar `settings.initial` + `settings.changed` consistentes reutilizando `SettingsService`.

### D. UI/UX
1. **Flujo de guardado y pruebas siempre fallido (P0).** La UI queda bloqueada esperando el health-check y recibe errores 403/405 al guardar o probar integraciones, frustrando al usuario. 【F:src/pages/MiniWebConfig.tsx†L349-L409】【F:src/pages/MiniWebConfig.tsx†L744-L816】 **Fix:** tras corregir la API, añadir manejo de placeholders (`__stored__`) y feedback específico cuando falte el endpoint.
2. **Sin feedback consistente en PIN remoto (P1).** Debido a errores previos, el banner de PIN queda permanentemente en estado de fallo. Resolver los P0 resuelve esta UX.

### E. Rendimiento y robustez
1. **Timeout de OpenAI largo (P1).** Ya cubierto en A7.
2. **Sin reintento controlado en fetch `/api/settings` tras WS**: la función `useSettingsSync` reintenta inmediatamente, pero esto es aceptable; sin hallazgos críticos adicionales.

### F. systemd / despliegue
*No se detectaron regresiones en los unit files: `ExecStart` único y `Restart=always` están bien configurados.*

### G. OTA y segunda pantalla
1. **Versionado estático rompe sincronización (P1).** Al no aumentar `meta.version`, la segunda pantalla no puede discernir si sus datos están obsoletos tras un OTA. 【F:backend/miniweb.py†L3896-L3911】 **Fix:** usar `SettingsService.save()` para garantizar `meta.version` y emitir diffs; validar en pruebas OTA que la miniweb recibe `settings.changed` con `version > anterior`.

## Propuestas de corrección y pruebas de aceptación

Para cada hallazgo P0/P1:
1. **Endpoint PUT + PIN en cabecera**
   - *Fix:* Añadir ruta `@app.put("/api/settings")` que invoca la misma función, extraer PIN desde `Authorization` cuando exista y soportar payloads legado/modernos.
   - *Pruebas:* Ejecutar los pasos 1–5 de la guía (curl) usando loopback y una IP LAN, verificando códigos 200 y placeholders `"__stored__"`.

2. **Inicializar `changed` y normalizar payloads**
   - *Fix:* `changed = False` al inicio; marcar `changed = True` cuando se toquen `openai`, `nightscout`, `ui`, etc.; si el valor recibido es `__stored__`, conservar el existente.
   - *Pruebas:* Guardar con los comandos 3 y 4 de la guía, luego comprobar `~/.bascula/config.json` (paso 6) y que el WS emite `settings.changed` con versión incrementada.

3. **Health-check real**
   - *Fix:* Crear `GET /api/settings/health` que usa `SettingsService` para leer/escribir, devolviendo `{ok, can_read, can_write, message}`.
   - *Pruebas:* Paso 1 de la guía debe devolver `"ok": true` y `"can_write": true`.

4. **WebSocket con versión/diff**
   - *Fix:* Tras `SettingsService.save()`, calcular diff (`jsonpatch`/`deepdiff`) y emitir `{"version": <meta.version>, "diff": {...}}`.
   - *Pruebas:* Paso 7 de la guía: modificar un flag desde un navegador y confirmar que el kiosko actualiza sin recargar, inspeccionando el mensaje WS en DevTools.

5. **Seguridad y permisos**
   - *Fix:* Ajustar `CFG_DIR.mkdir(mode=0o700)` y usar `os.chmod`/`os.chown` tras guardar; exigir cabecera PIN en tests e introducir rate limit (por IP) con ventana ≥5 s.
   - *Pruebas:* Paso 6 (`ls -l ~/.bascula`) debe mostrar `drwx------` y `-rw-------`; repetir POST `/api/settings/test/openai` más de dos veces en 5 s debe devolver 429.

## Guía de pruebas rápida (después de aplicar fixes)
1. `curl -s http://localhost:8080/api/settings/health | jq .`
2. `curl -s http://localhost:8080/api/settings | jq .`
3. `curl -s -X POST http://localhost:8080/api/settings \
   -H 'Content-Type: application/json' \
   -d '{"ui":{"sound_enabled":true},"network":{"openai_api_key":"sk-TEST"},"diabetes":{"nightscout_url":"https://ns.example","nightscout_token":"NS-TEST"}}' | jq .`
4. `curl -s -X POST http://<IP>:8080/api/settings \
   -H 'Content-Type: application/json' \
   -H 'Authorization: BasculaPin <PIN>' \
   -d '{"ui":{"sound_enabled":false}}' | jq .`
5. `curl -s -X POST http://<IP>:8080/api/settings/test/openai -H 'Authorization: BasculaPin <PIN>' | jq .`
6. `curl -s -X POST http://<IP>:8080/api/settings/test/nightscout -H 'Authorization: BasculaPin <PIN>' | jq .`
7. `cat ~/.bascula/config.json | jq .` y `ls -l ~/.bascula ~/.bascula/config.json`
8. Probar sincronización en dos navegadores observando mensajes WS `settings.changed` con `version` creciente y `diff` coherente.

---
**Conclusión:** Corregir los P0 (método HTTP, manejo de PIN, inicialización de `changed` y compatibilidad de payloads) es imprescindible antes del siguiente despliegue. Sin estos arreglos, la interfaz remota queda inutilizable y las integraciones (OpenAI/Nightscout) permanecen inoperantes.
