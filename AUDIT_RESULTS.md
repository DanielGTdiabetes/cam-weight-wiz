# 🔍 Auditoría técnica - Bascula UI

**Fecha:** 2025-02-14  
**Auditor:** gpt-5-codex

---

## 1. Resumen ejecutivo
- ❌ La suite de pruebas unitarias (`vitest`) falla actualmente (3 pruebas rojas), destacando un problema funcional en el flujo de fallback por voz del escáner y validaciones inconsistentes de formularios. 【06e5f4†L1-L33】
- ❌ El linting (`eslint`) reporta 57 incidencias (47 errores, 10 advertencias), incluyendo dependencias incorrectas de hooks y uso extendido de `any`. 【b459bd†L1-L74】
- ⚠️ Se detectaron riesgos de seguridad en el instalador OTA (extracción de tar sin saneado) y en la escritura del perfil Wi-Fi (inyección de SSID/PSK sin escape), además de la imposibilidad de conectar a redes abiertas en el mini-portal.

---

## 2. Resultados de pruebas automatizadas
| Comando | Estado | Evidencia |
| --- | --- | --- |
| `npx vitest run` | ❌ Falla | 3 pruebas rojas (validaciones y fallback por voz). 【06e5f4†L1-L33】 |
| `npm run lint` | ❌ Falla | 47 errores + 10 advertencias; incluye `no-explicit-any` y dependencias de hooks. 【b459bd†L1-L74】 |

> **Nota:** `npm test` sin argumentos queda en modo watch; usar `npx vitest run` para CI.

---

## 3. Hallazgos críticos

### 3.1 Validaciones permiten valores vacíos
- `validateUrl` y `validateApiKey` devuelven *válido* cuando la cadena está vacía, lo que contradice las expectativas de los tests y permite guardar URLs/API keys en blanco desde el teclado en pantalla. 【F:src/lib/validation.ts†L11-L28】【F:src/lib/validation.ts†L79-L100】
- Impacto: ajustes como Nightscout o endpoints remotos pueden persistir en blanco sin alertar al usuario.
- Recomendación: marcar vacío como inválido y, si es opcional, parametrizar desde el diálogo (`KeyboardDialog`) para no romper casos legítimos.

### 3.2 Flujo de fallback por voz no se activa
- La prueba `muestra la entrada por voz cuando expira el temporizador de la IA` expira por timeout; el temporizador de 10s no está forzando el cambio de fase a `fallback`. 【06e5f4†L1-L18】【F:src/components/BarcodeScannerModal.tsx†L928-L998】
- Impacto: ante una IA bloqueada la UI no ofrece la captura por voz/manual automáticamente, dejando al usuario sin salida.
- Recomendación: revisar `setInterval`/`setTimeout` en `startAIScanning`, asegurando limpieza al hacer `cleanup()` y avanzando a `fallback` incluso con promesas pendientes.

### 3.3 Riesgo de path traversal en OTA
- `install_update` usa `tarfile.extractall` directamente sobre artefactos descargados de GitHub sin validar rutas de salida. 【F:backend/main.py†L1181-L1194】
- Impacto: un tar malicioso podría sobrescribir archivos arbitrarios (si el repositorio remoto es comprometido o la URL se altera).
- Recomendación: aplicar extracción segura (filtrado de rutas, `tarfile.TarInfo`) o usar librerías que validen paths antes de escribir.

### 3.4 Escritura insegura de perfiles Wi-Fi
- `_write_nm_profile` inserta SSID y contraseña sin escape en el `.nmconnection`. Caracteres como saltos de línea o `"` rompen el archivo y pueden permitir inyección de claves. 【F:backend/miniweb.py†L241-L268】
- Además `_connect_wifi` rechaza contraseñas vacías, bloqueando redes abiertas (sin seguridad) que `nmcli` sí admite. 【F:backend/miniweb.py†L326-L339】
- Recomendación: sanitizar/entrecomillar los valores al escribir el perfil y permitir redes abiertas mediante detección de `secured` en la UI o parámetro explícito.

---

## 4. Observaciones adicionales
- Varias advertencias de React hooks (`react-hooks/exhaustive-deps`) en componentes clave pueden causar estados inconsistentes a futuro. 【b459bd†L1-L18】
- El repositorio contiene numerosas definiciones `any` en servicios (`api.ts`, `apiWrapper.ts`, `storage.ts`, tests) que reducen la cobertura de TypeScript y complican la detección temprana de errores. 【b459bd†L18-L66】
- El mini-portal (`MiniWebConfig.tsx`) usa `fetch` directo sin manejar timeouts ni cancelación; evaluar integración con `apiWrapper` para reutilizar manejo de errores.

---

## 5. Próximos pasos sugeridos
1. Corregir funciones de validación y actualizar las pruebas afectadas.
2. Depurar el flujo de `startAIScanning` para garantizar el fallback automático y añadir cobertura adicional.
3. Endurecer el instalador OTA (validaciones de tar, verificación de firmas) antes de usarlo en producción.
4. Ajustar la generación de perfiles Wi-Fi para soportar SSID/PSK arbitrarios y redes abiertas.
5. Planificar una campaña para eliminar `any` y satisfacer las reglas de `eslint`, evitando regresiones.

---

**Conclusión:** El proyecto tiene una base funcional amplia, pero los fallos actuales en pruebas/lint y los riesgos de seguridad detectados impiden considerarlo listo para producción hasta que se apliquen las correcciones indicadas.
