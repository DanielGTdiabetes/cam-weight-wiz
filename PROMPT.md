# Prompt actualizado para tareas del escáner de alimentos

Usa este prompt como base cuando trabajes en funcionalidades relacionadas con la vista del escáner de alimentos. El objetivo es reflejar cómo está organizada la app realmente y evitar dependencias inexistentes.

## Prompt sugerido

```
Eres un desarrollador trabajando en la báscula inteligente. Debes mantener la lista de alimentos escaneados siguiendo la arquitectura existente.

Contexto clave:
- La vista `FoodScannerView` (`src/pages/FoodScannerView.tsx`) maneja la lista `foods` con `useState` y helpers como `appendFood`, `handleAnalyze`, `handleScanBarcode` y `handleDelete`. No existe ningún `FoodListContext` ni hook `useFoodList`; la acumulación se gestiona con estado local.
- Cuando añadas o elimines alimentos, sincroniza el estado con una persistencia ligera guardando el arreglo completo en `localStorage` mediante el servicio `storage` (`src/services/storage.ts`). Sigue el mismo patrón que `getWeightHistory`/`addWeightRecord`: crea utilidades `getScannerHistory`/`saveScannerHistory` si aún no existen y usa la clave `scanner_history`.
- La comunicación con backend se hace a través de `api.analyzeFood` y `api.scanBarcode`; los resultados devueltos alimentan `appendFood` tras mapearse con los helpers de `@/features/food-scanner/foodItem`.
- El modal `BarcodeScannerModal` expone un callback `onFoodConfirmed` que recibe un `FoodScannerConfirmedPayload` con los mismos campos que usa la vista (nombre, peso, macros, índice glucémico, color promedio y opcionalmente `kcal`). Si alguna fuente entrega datos parciales, completa el payload antes de invocar el callback para mantener sincronizados el modal y la vista.
- Para exportar bolos a Nightscout, llama al método real `api.exportBolus(carbs, insulin, timestamp)`. El timestamp debe ser una cadena ISO generada con `new Date().toISOString()` y el payload enviado al backend debe incluir `{ carbs, insulin, timestamp }`.
- Antes de invocar la exportación, lee la configuración mediante `storage.getSettings()` y cancela la operación con un toast de error si `nightscoutUrl` no está configurado; respeta los toasts, logs (`logger`) y vibración (`navigator.vibrate`) existentes tras una exportación exitosa o fallida.
- Dependencias externas: instala siempre `html5-qrcode`, `localforage` y `tesseract.js` con `npm install html5-qrcode localforage tesseract.js` cuando implementes características que dependan de escaneo de códigos, persistencia offline o reconocimiento óptico. Si alguna de estas librerías no es necesaria para la funcionalidad concreta, elimina su uso del diseño en lugar de dejar referencias huérfanas.
- Integración en Vite:
  - Importa los módulos directamente en archivos cliente usando ESM (`import { Html5QrcodeScanner } from "html5-qrcode";`, `import localforage from "localforage";`, `import { createWorker } from "tesseract.js";`). Evita `require` o accesos al objeto global.
  - Debido a que `html5-qrcode` y `tesseract.js` dependen de APIs del navegador, protégelos detrás de comprobaciones `if (typeof window !== "undefined")` o carga diferida (`await import("html5-qrcode")`) cuando renderices en contextos que puedan ejecutarse en SSR o pruebas.
  - Configura `localforage` en el arranque (por ejemplo en `src/services/storage.ts`) con `localforage.config({ name: "cam-weight-wiz", storeName: "scanner" });` antes de usarlo como backend de almacenamiento.
- Adaptaciones adicionales:
  - Declara tipos auxiliares en `src/types` si las definiciones de las librerías no cubren tus casos (por ejemplo ampliar `Html5QrcodeScannerConfig`). Evita valores `any` innecesarios.
  - Para pruebas, proporciona mocks ligeros en `tests/__mocks__` que simulen los métodos mínimos (`Html5QrcodeScanner.render`, `localforage.getItem`/`setItem`, `createWorker`) para evitar dependencias de hardware o workers reales.
  - Si necesitas workers de `tesseract.js`, define rutas usando las opciones `workerPath`, `langPath` y `corePath` apuntando a assets servidos por Vite (colócalos en `public/` si es necesario).

Instrucciones:
1. Lee los alimentos iniciales desde `storage` al montar la vista y rellena `foods` con ese historial.
2. Cada vez que se agregue, actualice o elimine un alimento, escribe inmediatamente la lista en `storage` para mantener la persistencia local.
3. Si necesitas lógica compartida adicional, crea primero un contexto React (por ejemplo `ScannerContext`) junto a su API pública (`Provider`, hooks) y luego úsalo. No asumas que existe previamente.
4. Mantén los toasts, logs y vibraciones existentes como feedback para el usuario.
5. No introduzcas dependencias globales innecesarias ni rompas la integración actual con el backend.
```

Este prompt elimina la referencia obligatoria a un `FoodListContext` inexistente y documenta la estrategia vigente (estado local + persistencia con `storage`). También deja claro el orden a seguir si en el futuro se decide exponer un contexto específico.

> 💡 **Flujo híbrido barcode + IA**: si necesitas un prompt más avanzado que combine escaneo por código y estimaciones por foto, revisa `docs/barcode-hybrid-prompt.md`. Ese documento mantiene el mismo contrato `FoodScannerConfirmedPayload` y amplía los requisitos con la modalidad de IA.
