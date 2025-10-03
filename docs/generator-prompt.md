# Prompt actualizado para generador de código

Quiero que actualices la vista de la báscula para que utilice el hook de WebSocket ya existente. Además, cualquier flujo relacionado con el escáner de códigos de barras debe apoyarse en las utilidades reales del repositorio en lugar de llamadas ficticias.

## Instrucciones clave para el generador

### Báscula con WebSocket

1. Importa el hook `useScaleWebSocket` desde `@/hooks/useScaleWebSocket`.
2. Extrae el peso actual con `const { weight } = useScaleWebSocket()`.
   - Si necesitas usar un nombre diferente en el componente, indica claramente cómo se transforma (`const pesoActual = weight;`).
3. El estado de la báscula debe describirse usando `pesoActual` calculado a partir del hook anterior. Si se requieren deltas o variaciones, especifícalas como derivados de `weight` (por ejemplo, `delta = pesoActual - pesoPrevio`).
4. Elimina o ignora cualquier referencia previa a `useWeight` y reemplázala por el uso descrito del hook `useScaleWebSocket`.

### Escáner de códigos de barras

1. Importa el cliente existente con `import { api } from '@/services/api';`.
2. Llama al servicio disponible mediante `await api.scanBarcode(codigoBarras);` en lugar de funciones inexistentes como `fetchFatSecret`.
3. El servicio devuelve un objeto `FoodAnalysis` real del repositorio con la siguiente forma y tipos:
   - `name`: nombre del producto detectado.
   - `confidence`: confianza opcional del reconocimiento.
   - `nutrition`: objeto con `carbs`, `proteins`, `fats` e `glycemic_index`.
4. Asegúrate de que el flujo describa cómo presentar estos datos en la UI (por ejemplo, rellenar la tarjeta del alimento, actualizar totales, recalcular macros agregados y mostrar la confianza si está disponible).
5. Gestiona errores y estados de carga usando los mecanismos existentes (spinners, toasts o mensajes) explicando claramente cómo se conectan al llamado de `api.scanBarcode`.

#### Flujo recomendado para `api.scanBarcode`

1. Validar o solicitar el código de barras.
2. Mostrar un indicador de carga y deshabilitar acciones repetidas mientras se espera la respuesta.
3. Ejecutar `const analysis = await api.scanBarcode(code);` y envolver la llamada en `try/catch` para capturar errores del servicio.
4. Con la respuesta del backend, detalla explícitamente cómo mapear cada campo real:
   - Desestructura `name`, `confidence` y `nutrition` (`carbs`, `proteins`, `fats`, `glycemic_index`).
   - Actualiza la lista de alimentos o el estado correspondiente con un nuevo objeto que combine estos datos con metainformación local (por ejemplo, peso escaneado o timestamp).
   - Usa los valores de `nutrition` para recalcular totales, porcentajes o indicadores de la UI; documenta cómo se guardan en estado y cómo se muestran.
   - Si `confidence` existe, muéstrala en la UI (badge, texto secundario) e indica qué formato utilizar (por ejemplo, porcentaje redondeado).
   - Guarda la respuesta en `localStorage` si el flujo requiere persistencia (utilizando las utilidades existentes en `storage`).
5. Si la petición falla, captura el error y muestra un mensaje adecuado (toast o alerta) indicando que no se pudo obtener la información del código, además de restablecer cualquier estado temporal (spinners, botones deshabilitados).
6. Restablece el estado de carga independientemente del resultado.

##### Contrato del modal de códigos de barras

El modal que encapsule la lectura de códigos (`BarcodeScannerModal`) debe aceptar un callback `appendFood` que reciba todos los macronutrientes necesarios para poblar la vista sin cálculos adicionales. El contrato compartido está disponible en `@/features/food-scanner/foodItem`:

```ts
export interface BarcodeScannerSnapshot {
  name: string;
  weight: number;
  carbs: number;
  proteins: number;
  fats: number;
  glycemicIndex: number;
  confidence?: number;
  avgColor?: { r: number; g: number; b: number };
}

export interface BarcodeScannerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appendFood: (food: BarcodeScannerSnapshot) => void;
}
```

Si el backend entrega los macronutrientes normalizados a 100 g, crea primero un `BarcodeScannerSnapshot` ajustando `proteins`, `fats` y `glycemicIndex` antes de invocar `appendFood`. Puedes utilizar los helpers `scaleNutritionByFactor`, `createScannerSnapshot` y `toFoodItem` para mantener el contrato sincronizado con la vista.

### Notas sobre FatSecret

- Solo utiliza FatSecret si el requisito lo especifica. En ese caso, indica explícitamente en el prompt cómo crear y configurar el cliente antes de usarlo (por ejemplo, instanciando un `FatSecretClient` con claves y tokens válidos o creando un helper `createFatSecretClient` que gestione la autenticación) **antes** de realizar cualquier llamada.
- Deja claro que cualquier uso posterior del cliente debe partir de esa instancia configurada; no invoques funciones como `fetchFatSecret` sin haber creado previamente dicho cliente y sin pasar la configuración necesaria.

## Contexto adicional

- Mantén la integración existente con historial y toasts.
- Respeta el estilo visual actual (clases Tailwind y componentes shadcn).
- No modifiques la lógica del backend.

Utiliza estas pautas para guiar cualquier cambio solicitado al generador.
