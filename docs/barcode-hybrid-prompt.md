# Prompt híbrido del escáner (barcode + IA)

Usa este prompt cuando necesites generar cambios para el nuevo flujo híbrido del escáner de alimentos con código de barras y reconocimiento por foto IA. Asegúrate de que el contrato de datos se mantenga alineado con `FoodScannerView`.

## Prompt sugerido

```
You are an expert React + TypeScript developer working on the cam-weight-wiz kiosk app. Build a production-ready `BarcodeScannerModal` component that plugs into the existing food scanner workflow and matches the app’s architecture.

Context & existing code:

- `FoodScannerView` (`src/pages/FoodScannerView.tsx`) keeps the scanned food list in local component state (`foods`) and helper methods like `appendFood`, `handleAnalyze`, `handleScanBarcode`, and `handleDelete`. It already relies on `useScaleWebSocket`, `storage`, `api.scanBarcode`, the global `useToast` hook, and `logger` for feedback and persistence.
- Persistence is handled with the `storage` service (`src/services/storage.ts`). Extend it with utilities such as `getScannerHistory`, `saveScannerHistory`, and `enqueueScannerAction` using the key `scanner_history`, following the same pattern as the weight history helpers.
- Back-end integration for barcodes and Nightscout lives in `src/services/api.ts` (use `api.scanBarcode` and `api.exportBolus`; extend with a new `api.analyzeFoodPhoto(imageBase64: string)` that returns estimated `{ name: string; carbsPer100g: number; proteinsPer100g?: number; fatsPer100g?: number; glycemicIndex?: number; kcalPer100g?: number; confidence: number }` or `null` on low confidence, using a lightweight ML model like TensorFlow.js if feasible on client-side, or backend proxy to Picamera2 integration).
- UI stack: Vite, React 18, shadcn-ui (`Dialog`, `Tabs`, `Card`, `Button`, `ButtonGroup`, `Input`, `Slider`, `Progress`, `Toast`), Tailwind classes, `lucide-react` icons.
- Weight hook: import `{ useScaleWebSocket }` from `@/hooks/useScaleWebSocket` and derive `const { weight } = useScaleWebSocket();` (alias to `pesoActual` if needed). Do NOT reference `useWeight` anywhere.
- Shared types live in `@/features/food-scanner/foodItem`. Use `FoodScannerConfirmedPayload` and helpers like `createScannerSnapshot`, `scaleNutritionByFactor`, and `roundMacro` to normalise macros before invoking callbacks.

Implementation requirements:

1. Component signature:

   ```ts
   import type { FoodScannerConfirmedPayload } from "@/features/food-scanner/foodItem";

   interface BarcodeScannerModalProps {
     open: boolean;
     onClose: () => void;
     prefilledBarcode?: string;
     onFoodConfirmed: (item: FoodScannerConfirmedPayload) => void;
   }
   ```

   Always provide the full `FoodScannerConfirmedPayload` (name, weight, carbs, proteins, fats, glycemicIndex, optional `kcal`, `confidence`, `avgColor`). If any source lacks proteins/fats/glycemic index, derive sensible defaults or reuse the last known manual entry before calling `onFoodConfirmed` so `FoodScannerView` can keep using `toFoodItem` without extra adapters.

2. Modal behavior (shadcn `Dialog`):
   - When opened, immediately show a hybrid mode selector: a shadcn `ButtonGroup` or `ToggleGroup` with two options – "Código de Barras" (default, primary button) and "Foto IA" (secondary, for fresh/complex foods like fruits or home-cooked). Use icons (e.g., `Barcode` for barcode, `Camera` for IA). On selection, proceed to the chosen phase; if "Foto IA" fails (e.g., >3 attempts or confidence <0.7), auto-fallback to barcode scan or voice tab with a toast "Detección IA incierta, probando barcode".
   - For "Código de Barras" mode: start a 10s scan phase using `Html5QrcodeScanner` (install via `npm install html5-qrcode`). Target `{ video: { facingMode: 'environment' } }`, fallback to user camera if needed. Clean up on close/unmount.
   - For "Foto IA" mode: activate camera for photo snap (via `getUserMedia` + canvas capture on button press or auto after 5s preview), send base64 to `api.analyzeFoodPhoto`. Show overlay instructions "Apunta al alimento y confirma" with progress bar. Limit to 3 attempts before fallback. When receiving estimates per 100 g, convert them to `FoodScannerConfirmedPayload` fields using the expected portion weight (default 100 g) before continuing.
   - Shared overlay for both modes: semi-transparent div with Tailwind (`bg-black/50`) showing centered text instructions + progress bar counting down from 100% over 10s; cancel to fallback when timeout or three consecutive failures. Rate limit to 3 scans/minute (disable buttons, show tooltip).
   - On successful barcode scan: show loading state, call `api.scanBarcode(barcode)`, normalise macros with the helpers above so the resulting `FoodScannerConfirmedPayload` includes carbs, proteins, fats and glycemic index. If the API fails or returns incomplete data, look for a manual match in `storage.getScannerHistory()` using the barcode before switching to fallback.
   - On successful IA photo: if confidence >= 0.7, proceed to preview with "Estimado por IA" label; else, fallback.

3. Preview phase:
   - Show product details in a shadcn `Card`, with a badge/label indicating source ("De Barcode" or "Estimado por IA"). Allow editing of name, macros (per 100 g or total) and optional total weight with controlled `Input`s validated via `zod` + `react-hook-form`. For IA estimates, add a confidence indicator (progress bar or icon). Ensure edits continue to output a valid `FoodScannerConfirmedPayload` by recomputing macros and `kcal` via `roundMacro`.
   - Provide actions “Confirmar y pesar” (advances to weighing, with optional "Confirma carbs estimados" checkbox for IA mode) and “Reescáner” (restarts the selected mode and timer, preserving choice).

4. Weighing phase:
   - Split layout: left card shows live weight (`pesoActual`) and delta versus the last stable value, color-coded. Announce updates via `aria-live="polite"`.
   - Right card displays carbs/kcal calculated with `useMemo`, updating on weight or slider changes. Use `scaleNutritionByFactor` to keep macros consistent.
   - Include a `Slider` labeled “Ajustar porción esperada” (1g–1000g). Calculations must avoid NaN (default 0, clamp to sensible ranges).
   - “Aceptar” button captures an optional photo via `getUserMedia` + canvas snapshot, creates the payload (full `FoodScannerConfirmedPayload` plus photo metadata if desired), invokes `onFoodConfirmed`, persists manual data if barcode missing, enqueues offline action when `!navigator.onLine`, shows toast feedback, optionally calls `api.exportBolus` when Nightscout URL/token exist (reuse settings from `storage`), and closes/reset modal.

5. Fallback tabs:
   - Tab 1 “Entrada por Voz”: use `SpeechRecognition` (`window.SpeechRecognition || window.webkitSpeechRecognition`) with Spanish locale, limited to 3 failed attempts, parse patterns like “manzana 14 carbs por 100g” or “total 320 gramos”. Populate the manual form automatically when parsing succeeds; otherwise guide the user.
   - Tab 2 “Entrada Manual”: form with sub-tabs for “Por 100g” vs “Por Total”. Numeric inputs should open a custom on-screen keypad dialog (shadcn `Dialog`) to improve kiosk usability. Optionally attempt OCR with Tesseract.js only if it is already installed; otherwise skip gracefully.
   - Both tabs share validation (non-empty name, positive numbers) and persist entries through the new storage helpers. Ensure conversions end up in a valid `FoodScannerConfirmedPayload`.

6. Offline support: queue pending API calls to `scanner_history_queue` (same file) and flush them when the app regains connectivity.

7. Accessibility: focus trap the modal, add `aria-label` on the scanner region and toggle group, announce weight updates via `aria-live="polite"`, ensure keyboard navigation for keypad buttons and mode toggles, and support dark mode styling consistent with existing screens.

8. Performance & cleanup: stop camera/recognition when closing, memoize expensive computations, use `useCallback` for handlers, and throttle WebSocket updates if needed.

9. Logging & feedback: use `logger` for significant events (scan success/failure, offline queue, IA confidence). Use `useToast` for user notifications.

Integration tasks:

- Install missing deps: `npm install html5-qrcode @tensorflow/tfjs` and dev tools `npm install -D vitest @testing-library/react @testing-library/user-event @testing-library/jest-dom`. Add `"test": "vitest"` to `package.json`.
- Update `FoodScannerView` to replace the current `window.prompt` barcode flow with the new modal: add state to control the dialog, pass `appendFood` to `onFoodConfirmed`, and hydrate initial manual history from storage.
- Extend `storage` with the new helpers (scanner history + queue) and expose them through the singleton export.
- Export any shared types if necessary so both the view and modal agree on the food payload shape.

Testing (Vitest + React Testing Library):

- Create `tests/BarcodeScannerModal.test.tsx` covering: renders & opens with hybrid toggle, transitions through barcode/IA modes (success/fail/fallback), preview with source labels and confidence, weighing calculations for per-100g and total weight, fallback tabs (voice + manual) including validation, offline queueing, and ensuring `onFoodConfirmed` is called with the expected `FoodScannerConfirmedPayload`.
- Mock Web APIs (`Html5QrcodeScanner`, `SpeechRecognition`, media devices, canvas, `api.analyzeFoodPhoto` returning `{ name: 'Manzana', carbsPer100g: 14, proteinsPer100g: 0.3, fatsPer100g: 0.2, confidence: 0.8 }` or low-confidence `null`) and `useScaleWebSocket` to provide deterministic weight values.
- Include a reusable `tests/setup.ts` that configures `vi.mock`, `@testing-library/jest-dom`, and provides mocks for `logger`/`api`.

Deliverables:

1. `src/components/BarcodeScannerModal.tsx`
2. Updates to `src/services/storage.ts` (new helpers)
3. Updates to `src/pages/FoodScannerView.tsx` integrating the modal
4. Any supporting hooks/utilities created for keypad/offline queue
5. `tests/BarcodeScannerModal.test.tsx` + optional `tests/setup.ts`
6. `package.json` / lockfile updates for new dependencies
7. Brief changelog: “Implemented hybrid barcode/IA scanner modal with weighing, fallbacks, persistence, and tests.”
```

## Notas
- Esta versión del prompt deja claro que el callback del modal usa `FoodScannerConfirmedPayload`, evitando el problema detectado en iteraciones previas.
- Si la IA sólo aporta carbohidratos, indica explícitamente cómo completar proteínas, grasas y `glycemicIndex` (por ejemplo, reutilizando el último valor manual o solicitando confirmación del usuario) antes de invocar `onFoodConfirmed`.
