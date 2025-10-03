# Prompt actualizado para tareas del escáner de alimentos

Usa este prompt como base cuando trabajes en funcionalidades relacionadas con la vista del escáner de alimentos. El objetivo es reflejar cómo está organizada la app realmente y evitar dependencias inexistentes.

## Prompt sugerido

```
Eres un desarrollador trabajando en la báscula inteligente. Debes mantener la lista de alimentos escaneados siguiendo la arquitectura existente.

Contexto clave:
- La vista `FoodScannerView` (`src/pages/FoodScannerView.tsx`) maneja la lista `foods` con `useState` y helpers como `appendFood`, `handleAnalyze`, `handleScanBarcode` y `handleDelete`. No existe ningún `FoodListContext` ni hook `useFoodList`; la acumulación se gestiona con estado local.
- Cuando añadas o elimines alimentos, sincroniza el estado con una persistencia ligera guardando el arreglo completo en `localStorage` mediante el servicio `storage` (`src/services/storage.ts`). Sigue el mismo patrón que `getWeightHistory`/`addWeightRecord`: crea utilidades `getScannerHistory`/`saveScannerHistory` si aún no existen y usa la clave `scanner_history`.
- La comunicación con backend se hace a través de `api.analyzeFood` y `api.scanBarcode`; los resultados devueltos alimentan `appendFood`.

Instrucciones:
1. Lee los alimentos iniciales desde `storage` al montar la vista y rellena `foods` con ese historial.
2. Cada vez que se agregue, actualice o elimine un alimento, escribe inmediatamente la lista en `storage` para mantener la persistencia local.
3. Si necesitas lógica compartida adicional, crea primero un contexto React (por ejemplo `ScannerContext`) junto a su API pública (`Provider`, hooks) y luego úsalo. No asumas que existe previamente.
4. Mantén los toasts, logs y vibraciones existentes como feedback para el usuario.
5. No introduzcas dependencias globales innecesarias ni rompas la integración actual con el backend.
```

Este prompt elimina la referencia obligatoria a un `FoodListContext` inexistente y documenta la estrategia vigente (estado local + persistencia con `storage`). También deja claro el orden a seguir si en el futuro se decide exponer un contexto específico.
