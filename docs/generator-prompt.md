# Prompt actualizado para generador de código

Quiero que actualices la vista de la báscula para que utilice el hook de WebSocket ya existente.

## Instrucciones clave para el generador

1. Importa el hook `useScaleWebSocket` desde `@/hooks/useScaleWebSocket`.
2. Extrae el peso actual con `const { weight } = useScaleWebSocket()`.
   - Si necesitas usar un nombre diferente en el componente, indica claramente cómo se transforma (`const pesoActual = weight;`).
3. El estado de la báscula debe describirse usando `pesoActual` calculado a partir del hook anterior. Si se requieren deltas o variaciones, especifícalas como derivados de `weight` (por ejemplo, `delta = pesoActual - pesoPrevio`).
4. Elimina o ignora cualquier referencia previa a `useWeight` y reemplázala por el uso descrito del hook `useScaleWebSocket`.

## Contexto adicional

- Mantén la integración existente con historial y toasts.
- Respeta el estilo visual actual (clases Tailwind y componentes shadcn).
- No modifiques la lógica del backend.

Utiliza estas pautas para guiar cualquier cambio solicitado al generador.
