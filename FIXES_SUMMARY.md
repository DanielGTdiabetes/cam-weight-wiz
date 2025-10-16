# Fixes Summary - Configuración sin PIN y nueva UI de /config

## 2025-XX-XX

### Cambios clave
- **Nueva interfaz React/Vite (`src/pages/MiniWebConfig.tsx`)**: vista única para estado del dispositivo, Wi-Fi, OpenAI y Nightscout. Maneja `__stored__`, no limpia inputs tras guardar y permite seleccionar redes con un clic.
- **Estado compartido con Zustand (`src/stores/configStore.ts`)**: centraliza `settings`, `networkStatus`, estados ocupados y la cola de toasts para sincronizar la UI con el backend.
- **Toasts consistentes (`src/components/config/ConfigToastManager.tsx`)**: puente entre el store y el sistema de notificaciones existente para mostrar mensajes estándar (éxito, advertencia, error, info).
- **Backend sin PIN (`backend/miniweb.py`)**: eliminada la validación de PIN en `/api/settings`, `/api/wifi/*`, `/api/settings/test/*` y pruebas Nightscout/OpenAI; el endpoint de PIN ahora devuelve `enabled: false`.
- **Actualización de service worker**: el script `scripts/generate-service-worker.mjs` genera versiones `cwz-<semver>-<sha>` para forzar la recarga del frontend y se añade el botón "Recargar UI".

### Notas de migración
1. Ejecuta `npm run build` (o el `install-all.sh` existente) para regenerar `backend/dist/` tras cualquier cambio en `frontend/`.
2. Las peticiones desde clientes antiguos pueden seguir enviando el campo `pin`, pero es ignorado. No es necesario actualizar claves ni tokens existentes; si están almacenados se muestran como `__stored__`.
3. El botón de teclado en pantalla sólo funciona en la báscula (determinada por `hostname`/`userAgent`). Verifica que `matchbox-keyboard` esté instalado en la imagen de la Pi.
4. El botón "Recargar UI" limpia Cache Storage y pide a los service workers descargar la última versión; puede ser útil tras despliegues OTA.

### Pruebas manuales sugeridas
- Abrir `http://<ip>:8080/config` desde la LAN y comprobar que no se solicita PIN.
- Guardar una clave de OpenAI y un token/URL de Nightscout; recargar la página para comprobar el badge "Guardado" y que los inputs permanecen editables.
- Escanear redes Wi-Fi, seleccionar una red con un clic, introducir contraseña y conectar. Verificar mensajes "Conectando…" → "Conectado".
- Alternar "Modo offline" y confirmar que el estado se refleja en el panel de "Estado rápido".
- Usar "Probar" en OpenAI/Nightscout para ver toasts de éxito o error según respuesta del backend.
- Desde la báscula, abrir el teclado en pantalla y usar "Recargar UI" para validar la limpieza de caché.

### Pruebas automáticas recomendadas
- `pytest` (si hay suites configuradas) para validar `/api/settings` y `/api/wifi/*`.
- `npm run build` para asegurar que la UI compila y genera `backend/dist/`.

