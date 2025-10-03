import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Barcode,
  Camera,
  Loader2,
  CheckCircle2,
  Mic,
  MicOff,
  Keyboard,
  Delete,
  RefreshCw,
  ImagePlus,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { useScaleWebSocket } from '@/hooks/useScaleWebSocket';
import { storage } from '@/services/storage';
import { api } from '@/services/api';
import { logger } from '@/services/logger';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { roundMacro, type FoodScannerConfirmedPayload } from '@/features/food-scanner/foodItem';

interface BarcodeScannerModalProps {
  open: boolean;
  onClose: () => void;
  prefilledBarcode?: string;
  onFoodConfirmed: (item: FoodScannerConfirmedPayload) => void;
}

type ScanMode = 'barcode' | 'ai';
type Phase = 'mode-select' | 'scanning' | 'preview' | 'weighing' | 'fallback';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike extends ArrayLike<SpeechRecognitionAlternativeLike> {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface BrowserSpeechRecognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

const manualSchema = z.object({
  name: z.string().min(2, 'Ingresa al menos 2 caracteres'),
  carbsPer100g: z.number({ invalid_type_error: 'Requerido' }).positive('Debe ser mayor a 0'),
  proteinsPer100g: z.number({ invalid_type_error: 'Ingresa un número' }).min(0, 'Debe ser >= 0'),
  fatsPer100g: z.number({ invalid_type_error: 'Ingresa un número' }).min(0, 'Debe ser >= 0'),
  kcalPer100g: z.number({ invalid_type_error: 'Ingresa un número' }).min(0, 'Debe ser >= 0'),
  glycemicIndex: z
    .number({ invalid_type_error: 'Ingresa un número' })
    .min(0, 'Debe ser >= 0')
    .max(150, 'Valor fuera de rango'),
});

const MAX_ATTEMPTS = 3;
const BARCODE_TIMEOUT_SECONDS = 10;
const SCAN_COOLDOWN_MS = 15_000;

type ManualFormValues = z.infer<typeof manualSchema>;

interface ProductData extends ManualFormValues {
  confidence: number;
  source: 'barcode' | 'ai' | 'manual';
  photo?: string;
}

interface ScannerHistoryItem {
  barcode?: string;
  name: string;
  carbsPer100g: number;
  proteinsPer100g?: number;
  fatsPer100g?: number;
  kcalPer100g?: number;
  confidence?: number;
  photo?: string;
  glycemicIndex?: number;
}

interface Html5QrcodeScannerLike {
  render(onSuccess: (decodedText: string) => void, onError: (error: unknown) => void): void;
  clear(): Promise<void>;
}

type TimerRef = ReturnType<typeof setInterval>;

interface ScannerQueueAction {
  type: 'exportBolus';
  carbs: number;
  insulin?: number;
  timestamp: string;
}

function NumericKeyboard({
  onKey,
  onDelete,
  onClear,
}: {
  onKey: (value: string) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '.', '00'];

  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="Teclado numérico">
      {keys.map((key) => (
        <Button key={key} variant="secondary" onClick={() => onKey(key)}>
          {key}
        </Button>
      ))}
      <Button variant="outline" onClick={onDelete}>
        <Delete className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">Borrar dígito</span>
      </Button>
      <Button variant="outline" onClick={onClear}>
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">Limpiar</span>
      </Button>
    </div>
  );
}

export function BarcodeScannerModal({
  open,
  onClose,
  prefilledBarcode,
  onFoodConfirmed,
}: BarcodeScannerModalProps) {
  const { toast } = useToast();
  const { weight: pesoActual } = useScaleWebSocket();

  const [phase, setPhase] = useState<Phase>('mode-select');
  const [scanMode, setScanMode] = useState<ScanMode>('barcode');
  const [loading, setLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState(100);
  const [attemptCount, setAttemptCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState('Selecciona un modo de escaneo para comenzar');
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const cooldownUntilRef = useRef<number | null>(null);
  const [expectedPortion, setExpectedPortion] = useState(100);
  const [lastStableWeight, setLastStableWeight] = useState(0);
  const [capturedPhoto, setCapturedPhoto] = useState<string | undefined>(undefined);
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'listening' | 'processing' | 'error'>('idle');
  const [activeNumericField, setActiveNumericField] = useState<keyof ManualFormValues | null>(null);

  const [productData, setProductData] = useState<ProductData>({
    name: '',
    carbsPer100g: 0,
    proteinsPer100g: 0,
    fatsPer100g: 0,
    kcalPer100g: 0,
    glycemicIndex: 50,
    confidence: 0,
    source: 'barcode',
  });

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scannerRef = useRef<Html5QrcodeScannerLike | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const countdownRef = useRef<TimerRef | null>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);

  const isClient = typeof window !== 'undefined';
  const speechRecognitionClass: SpeechRecognitionConstructor | null = isClient
    ? ((window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor; })
        .SpeechRecognition ||
      (window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor; })
        .webkitSpeechRecognition ||
      null)
    : null;
  const speechSupported = Boolean(speechRecognitionClass);

  const manualForm = useForm<ManualFormValues>({
    resolver: zodResolver(manualSchema),
    defaultValues: {
      name: '',
      carbsPer100g: 0,
      proteinsPer100g: 0,
      fatsPer100g: 0,
      kcalPer100g: 0,
      glycemicIndex: 50,
    },
    mode: 'onChange',
  });

  useEffect(() => {
    manualForm.reset({
      name: productData.name,
      carbsPer100g: productData.carbsPer100g,
      proteinsPer100g: productData.proteinsPer100g,
      fatsPer100g: productData.fatsPer100g,
      kcalPer100g: productData.kcalPer100g,
      glycemicIndex: productData.glycemicIndex,
    });
  }, [productData, manualForm]);

  const cleanup = useCallback(() => {
    if (scannerRef.current) {
      try {
        scannerRef.current.clear();
      } catch (e) {
        // ignore cleanup errors
      }
      scannerRef.current = null;
    }

    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }

    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {
        // ignore
      }
      recognitionRef.current = null;
    }
  }, []);

  const handleBarcodeScanned = useCallback(
    async (barcode: string) => {
      setLoading(true);
      cleanup();
      setStatusMessage('Buscando información nutricional');

      try {
        const result = await api.scanBarcode(barcode);

        const kcal = Math.round(
          result.nutrition.carbs * 4 + result.nutrition.proteins * 4 + result.nutrition.fats * 9
        );

        const product: ProductData = {
          name: result.name,
          carbsPer100g: result.nutrition.carbs,
          proteinsPer100g: result.nutrition.proteins,
          fatsPer100g: result.nutrition.fats,
          kcalPer100g: kcal,
          glycemicIndex: Math.round(result.nutrition.glycemic_index ?? 0),
          confidence: result.confidence ?? 1,
          source: 'barcode',
          photo: capturedPhoto,
        };

        setProductData(product);
        setPhase('preview');
        setStatusMessage(`Producto encontrado: ${result.name}`);

        logger.info('Barcode scanned successfully', { barcode, name: result.name });
      } catch (error) {
        logger.error('Barcode lookup failed:', error);

        const history = storage.getScannerHistory() as ScannerHistoryItem[];
        const match = history.find((item) => item.barcode === barcode);

        if (match) {
          setProductData({
            name: match.name,
            carbsPer100g: match.carbsPer100g,
            proteinsPer100g: match.proteinsPer100g || 0,
            fatsPer100g: match.fatsPer100g || 0,
            kcalPer100g: match.kcalPer100g || 0,
            glycemicIndex: match.glycemicIndex ?? 50,
            confidence: match.confidence || 0,
            source: 'manual',
            photo: match.photo,
          });
          setPhase('preview');
          toast({
            title: 'Encontrado en historial',
            description: 'Verifica los datos antes de confirmar',
          });
        } else {
          toast({
            title: 'Producto no encontrado',
            description: 'Usa la entrada manual o por voz para continuar',
          });
          setPhase('fallback');
        }
      } finally {
        setLoading(false);
      }
    },
    [capturedPhoto, cleanup, toast]
  );

  const flushOfflineQueue = useCallback(async () => {
    if (!navigator.onLine) return;

    while (true) {
      const action = storage.dequeueScannerAction() as ScannerQueueAction | null;
      if (!action) break;

      try {
        if (action.type === 'exportBolus') {
          await api.exportBolus(action.carbs, action.insulin ?? 0, action.timestamp);
        }
      } catch (error) {
        logger.error('Failed to flush offline queue', error);
        storage.enqueueScannerAction(action);
        break;
      }
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    const handleOnline = () => {
      toast({ title: 'Conexión restaurada', description: 'Reintentando exportaciones pendientes' });
      flushOfflineQueue();
    };

    window.addEventListener('online', handleOnline);
    flushOfflineQueue();

    return () => {
      window.removeEventListener('online', handleOnline);
    };
  }, [open, flushOfflineQueue, toast]);

  useEffect(() => {
    if (open) {
      setPhase('mode-select');
      setAttemptCount(0);
      setScanProgress(100);
      setLastStableWeight(0);
      setExpectedPortion(100);
      setStatusMessage('Selecciona un modo de escaneo para comenzar');
      setProductData({
        name: '',
        carbsPer100g: 0,
        proteinsPer100g: 0,
        fatsPer100g: 0,
        kcalPer100g: 0,
        glycemicIndex: 50,
        confidence: 0,
        source: 'barcode',
      });
      setCapturedPhoto(undefined);
      setVoiceTranscript('');
      setVoiceStatus('idle');

      if (prefilledBarcode) {
        handleBarcodeScanned(prefilledBarcode);
      }
    } else {
      cleanup();
    }
  }, [open, prefilledBarcode, cleanup, handleBarcodeScanned]);

  useEffect(() => cleanup, [cleanup]);

  const resetCooldown = useCallback(() => {
    cooldownUntilRef.current = null;
    setCooldownUntil(null);
  }, []);

  const ensureCooldown = useCallback(() => {
    const now = Date.now();
    const currentCooldown = cooldownUntilRef.current;
    if (currentCooldown && now < currentCooldown) {
      const remaining = Math.ceil((currentCooldown - now) / 1000);
      toast({
        title: 'Espera un momento',
        description: `Puedes volver a intentar en ${remaining}s`,
        variant: 'destructive',
      });
      return false;
    }
    const nextCooldown = now + SCAN_COOLDOWN_MS;
    cooldownUntilRef.current = nextCooldown;
    setCooldownUntil(nextCooldown);
    return true;
  }, [toast]);

  const startBarcodeScanning = useCallback(async () => {
    if (attemptCount >= MAX_ATTEMPTS) {
      toast({
        title: 'Límite de intentos',
        description: 'Pasa a la entrada manual o por voz',
        variant: 'destructive',
      });
      setPhase('fallback');
      return;
    }

    if (!ensureCooldown()) {
      return;
    }

    setScanMode('barcode');
    setPhase('scanning');
    setLoading(true);
    setScanProgress(100);
    setStatusMessage('Iniciando escáner de código de barras');

    try {
      const { Html5QrcodeScanner } = await import('html5-qrcode');

      const scanner = new Html5QrcodeScanner(
        'barcode-reader',
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
          aspectRatio: 1.0,
        },
        false
      );

      scanner.render(
        (decodedText: string) => {
          setStatusMessage(`Código detectado: ${decodedText}`);
          handleBarcodeScanned(decodedText);
          scanner.clear();
          scannerRef.current = null;
        },
        () => {
          // ignore per-frame errors
        }
      );

      scannerRef.current = scanner;

      if (countdownRef.current) {
        clearInterval(countdownRef.current);
      }

      countdownRef.current = setInterval(() => {
        setScanProgress((prev) => {
          if (prev <= 0) {
            if (countdownRef.current) {
              clearInterval(countdownRef.current);
              countdownRef.current = null;
            }
            setAttemptCount((c) => c + 1);
            setStatusMessage('Tiempo agotado, cambiando a alternativas');
            toast({
              title: 'Tiempo agotado',
              description: 'Intenta de nuevo o usa entrada manual/voz',
            });
            setPhase('fallback');
            cleanup();
            return 0;
          }
          return prev - 100 / BARCODE_TIMEOUT_SECONDS;
        });
      }, 1000);
    } catch (error) {
      logger.error('Barcode scanner error:', error);
      toast({
        title: 'Error al iniciar escáner',
        description: 'Usa la entrada manual o IA como respaldo',
        variant: 'destructive',
      });
      setPhase('fallback');
    } finally {
      setLoading(false);
    }
  }, [attemptCount, ensureCooldown, toast, cleanup, handleBarcodeScanned]);

  const captureAndAnalyze = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const video = videoRef.current;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0);
    const imageBase64 = canvas.toDataURL('image/jpeg', 0.8);
    setCapturedPhoto(imageBase64);

    setLoading(true);
    setStatusMessage('Analizando imagen con IA');

    try {
      const result = await api.analyzeFoodPhoto(imageBase64);

      if (!result) {
        setAttemptCount((c) => c + 1);
        toast({
          title: 'Detección incierta',
          description: 'Probando código de barras',
        });
        cleanup();
        setScanMode('barcode');
        resetCooldown();
        startBarcodeScanning();
        return;
      }

      const inferredKcal =
        result.kcalPer100g ?? Math.round(result.carbsPer100g * 4 + (result.fatsPer100g || 0) * 9);

      const aiRawGlycemicIndex =
        'glycemicIndex' in result && typeof (result as { glycemicIndex?: number }).glycemicIndex === 'number'
          ? (result as { glycemicIndex?: number }).glycemicIndex
          : undefined;

      const aiProduct: ProductData = {
        name: result.name,
        carbsPer100g: result.carbsPer100g,
        proteinsPer100g: result.proteinsPer100g || 0,
        fatsPer100g: result.fatsPer100g || 0,
        kcalPer100g: inferredKcal,
        glycemicIndex: Math.round(aiRawGlycemicIndex ?? 50),
        confidence: result.confidence,
        source: 'ai',
        photo: imageBase64,
      };

      setProductData(aiProduct);
      setStatusMessage(`Reconocido: ${result.name} (confianza ${(result.confidence * 100).toFixed(0)}%)`);
      setPhase('preview');

      cleanup();

      logger.info('AI analysis successful', { name: result.name, confidence: result.confidence });
    } catch (error) {
      logger.error('AI analysis failed:', error);
      setAttemptCount((c) => c + 1);
      toast({
        title: 'Error en análisis IA',
        description: 'Intenta de nuevo o usa código de barras',
        variant: 'destructive',
      });
      cleanup();
      setPhase('fallback');
    } finally {
      setLoading(false);
    }
  }, [toast, cleanup, startBarcodeScanning, resetCooldown]);

  const startAIScanning = useCallback(async () => {
    if (attemptCount >= MAX_ATTEMPTS) {
      toast({
        title: 'Límite de intentos alcanzado',
        description: 'Probando escaneo de código de barras',
      });
      setScanMode('barcode');
      resetCooldown();
      startBarcodeScanning();
      return;
    }

    if (!ensureCooldown()) {
      return;
    }

    setScanMode('ai');
    setPhase('scanning');
    setLoading(true);
    setStatusMessage('Activando cámara para analizar el alimento');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setTimeout(() => {
        captureAndAnalyze();
      }, 5000);
    } catch (error) {
      logger.error('Camera access error:', error);
      toast({
        title: 'Error al acceder a la cámara',
        description: 'Probando escaneo de código de barras',
      });
      setScanMode('barcode');
      resetCooldown();
      startBarcodeScanning();
    } finally {
      setLoading(false);
    }
  }, [
    attemptCount,
    ensureCooldown,
    toast,
    startBarcodeScanning,
    captureAndAnalyze,
    resetCooldown,
  ]);

  const handleStartWeighing = useCallback(() => {
    if (!productData.name || productData.carbsPer100g <= 0) {
      toast({
        title: 'Datos incompletos',
        description: 'Completa nombre y carbohidratos',
        variant: 'destructive',
      });
      return;
    }

    setPhase('weighing');
    setLastStableWeight(pesoActual);
    setStatusMessage('Coloca el alimento sobre la báscula y espera estabilización');
  }, [productData, pesoActual, toast]);

  const calculatedCarbs = useMemo(
    () => roundMacro((productData.carbsPer100g * pesoActual) / 100),
    [productData.carbsPer100g, pesoActual]
  );

  const calculatedProteins = useMemo(
    () => roundMacro((productData.proteinsPer100g * pesoActual) / 100),
    [productData.proteinsPer100g, pesoActual]
  );

  const calculatedFats = useMemo(
    () => roundMacro((productData.fatsPer100g * pesoActual) / 100),
    [productData.fatsPer100g, pesoActual]
  );

  const calculatedKcal = useMemo(
    () => Math.round((productData.kcalPer100g * pesoActual) / 100),
    [productData.kcalPer100g, pesoActual]
  );

  const handleConfirm = useCallback(async () => {
    if (pesoActual <= 0) {
      toast({
        title: 'Peso inválido',
        description: 'Coloca el alimento en la báscula',
        variant: 'destructive',
      });
      return;
    }

    const confirmedAt = new Date();
    const photo = productData.photo ?? capturedPhoto;
    const payload: FoodScannerConfirmedPayload = {
      name: productData.name,
      weight: pesoActual,
      carbs: calculatedCarbs,
      proteins: calculatedProteins,
      fats: calculatedFats,
      glycemicIndex: productData.glycemicIndex,
      kcal: calculatedKcal > 0 ? calculatedKcal : undefined,
      confidence: productData.confidence || undefined,
      timestamp: confirmedAt,
      photo,
    };

    storage.addScannerRecord({
      ...payload,
      timestamp: confirmedAt.toISOString(),
      carbsPer100g: productData.carbsPer100g,
      proteinsPer100g: productData.proteinsPer100g,
      fatsPer100g: productData.fatsPer100g,
      kcalPer100g: productData.kcalPer100g,
      glycemicIndex: productData.glycemicIndex,
      source: productData.source,
      confidence: productData.confidence,
    });

    const settings = storage.getSettings();
    if (settings.nightscoutUrl && settings.nightscoutToken) {
      try {
        if (navigator.onLine) {
          await api.exportBolus(calculatedCarbs, 0, confirmedAt.toISOString());
          toast({
            title: 'Exportado a Nightscout',
            description: 'Revisa tu registro en Nightscout',
          });
        } else {
          storage.enqueueScannerAction({
            type: 'exportBolus',
            carbs: calculatedCarbs,
            insulin: 0,
            timestamp: confirmedAt.toISOString(),
          });
          toast({
            title: 'Sin conexión',
            description: 'Se exportará automáticamente al volver la conexión',
          });
        }
      } catch (error) {
        logger.error('Nightscout export failed:', error);
        toast({
          title: 'Error al exportar',
          description: 'Se reintentará más tarde',
          variant: 'destructive',
        });
        storage.enqueueScannerAction({
          type: 'exportBolus',
          carbs: calculatedCarbs,
          insulin: 0,
          timestamp: confirmedAt.toISOString(),
        });
      }
    }

    onFoodConfirmed(payload);
    onClose();

    toast({
      title: 'Alimento registrado',
      description: `${productData.name}: ${calculatedCarbs}g carbos`,
    });

    if (navigator.vibrate) {
      navigator.vibrate(200);
    }
  }, [
    pesoActual,
    productData,
    calculatedCarbs,
    calculatedProteins,
    calculatedFats,
    calculatedKcal,
    onFoodConfirmed,
    onClose,
    toast,
    capturedPhoto,
  ]);

  const parseVoiceTranscript = useCallback((transcript: string): Partial<ManualFormValues> => {
    const normalized = transcript.toLowerCase();
    const numberMatches = Array.from(
      normalized.matchAll(/(\d+[.,]?\d*)\s*(carbohidratos|carbos|calor[ií]as|kcal)?/g)
    );

    let carbs: number | undefined;
    let kcal: number | undefined;
    numberMatches.forEach((match) => {
      const value = Number(match[1].replace(',', '.'));
      const hint = match[2];
      if (!hint) {
        if (carbs === undefined) {
          carbs = value;
        } else if (kcal === undefined) {
          kcal = value;
        }
        return;
      }
      if (hint.includes('carb')) {
        carbs = value;
      }
      if (hint.includes('cal')) {
        kcal = value;
      }
    });

    const firstNumber = numberMatches[0]?.[0];
    const namePart = firstNumber
      ? normalized.split(firstNumber)[0]
      : normalized;

    const cleanedName = namePart.replace(/^(registrar|agregar|añadir)/, '').trim();

    return {
      name: cleanedName ? cleanedName.replace(/(^|\s)\w/g, (c) => c.toUpperCase()) : undefined,
      carbsPer100g: carbs,
      kcalPer100g: kcal,
    } as Partial<ManualFormValues>;
  }, []);

  const startVoiceRecognition = useCallback(() => {
    if (!speechSupported || !speechRecognitionClass) {
      setVoiceStatus('error');
      toast({
        title: 'Reconocimiento de voz no disponible',
        description: 'Verifica permisos o usa entrada manual',
        variant: 'destructive',
      });
      return;
    }

    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }

    const recognition = new speechRecognitionClass();
    recognition.lang = 'es-ES';
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      const results = Array.from(event.results) as SpeechRecognitionResultLike[];
      let transcript = '';
      for (let i = event.resultIndex; i < results.length; i++) {
        const result = results[i];
        const alternative = result?.[0];
        if (alternative) {
          transcript += alternative.transcript;
        }
      }
      setVoiceTranscript(transcript);
      setStatusMessage(`Escuchando: ${transcript}`);

      const lastResult = results[results.length - 1];
      if (lastResult?.isFinal) {
        setVoiceStatus('processing');
        const parsed = parseVoiceTranscript(transcript);

        if (parsed.name) {
          manualForm.setValue('name', parsed.name, { shouldDirty: true, shouldTouch: true });
        }
        if (parsed.carbsPer100g !== undefined) {
          manualForm.setValue('carbsPer100g', parsed.carbsPer100g, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
        }
        if (parsed.kcalPer100g !== undefined) {
          manualForm.setValue('kcalPer100g', parsed.kcalPer100g, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
        }

        toast({
          title: 'Transcripción completada',
          description: 'Revisa y confirma los datos detectados',
        });
        setVoiceStatus('idle');
      }
    };

    recognition.onerror = (_event: SpeechRecognitionErrorEventLike) => {
      setVoiceStatus('error');
      toast({
        title: 'Error al reconocer voz',
        description: 'Intenta nuevamente o usa entrada manual',
        variant: 'destructive',
      });
    };

    recognition.onend = () => {
      setVoiceStatus('idle');
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    recognition.start();
    setVoiceStatus('listening');
    setStatusMessage('Escuchando instrucciones...');
  }, [manualForm, parseVoiceTranscript, speechRecognitionClass, speechSupported, toast]);

  const stopVoiceRecognition = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setVoiceStatus('idle');
    setStatusMessage('Reconocimiento de voz detenido');
  }, []);

  const handleManualSubmit = manualForm.handleSubmit((values) => {
    const updatedProduct: ProductData = {
      ...productData,
      name: values.name,
      carbsPer100g: values.carbsPer100g,
      proteinsPer100g: values.proteinsPer100g,
      fatsPer100g: values.fatsPer100g,
      kcalPer100g: values.kcalPer100g,
      glycemicIndex: values.glycemicIndex,
      source: 'manual',
      photo: capturedPhoto,
    };

    setProductData(updatedProduct);
    setPhase('weighing');
    setLastStableWeight(pesoActual);
    setStatusMessage('Datos guardados manualmente, procede a pesar');
  });

  const handleNumericKey = useCallback(
    (key: string) => {
      if (!activeNumericField) return;
      const currentRaw = manualForm.getValues(activeNumericField);
      const current = currentRaw ? String(currentRaw) : '';
      if (key === '.' && current.includes('.')) {
        return;
      }
      const base = current === '0' && key !== '.' ? '' : current;
      const combined = `${base}${key}`;
      const normalized = combined.replace(/^0+(?=\d)/, '').replace(',', '.');
      const parsed = Number(normalized || '0');
      manualForm.setValue(activeNumericField, isNaN(parsed) ? 0 : parsed, {
        shouldDirty: true,
        shouldValidate: true,
      });
    },
    [activeNumericField, manualForm]
  );

  const handleNumericDelete = useCallback(() => {
    if (!activeNumericField) return;
    const currentRaw = manualForm.getValues(activeNumericField);
    const current = currentRaw ? String(currentRaw) : '';
    const newValue = current.slice(0, -1);
    const parsed = Number(newValue || '0');
    manualForm.setValue(activeNumericField, parsed, {
      shouldDirty: true,
      shouldValidate: true,
    });
  }, [activeNumericField, manualForm]);

  const handleNumericClear = useCallback(() => {
    if (!activeNumericField) return;
    manualForm.setValue(activeNumericField, 0, {
      shouldDirty: true,
      shouldValidate: true,
    });
  }, [activeNumericField, manualForm]);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent
        className="max-w-2xl max-h-[90vh] overflow-y-auto"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          initialFocusRef.current?.focus();
        }}
        onPointerDownOutside={(event) => {
          if (phase === 'scanning') {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Escanear Alimento</DialogTitle>
        </DialogHeader>

        <p className="sr-only" aria-live="assertive">
          {statusMessage}
        </p>

        <div className="flex items-center justify-between gap-4 rounded-md border p-3" aria-live="polite">
          <div>
            <p className="text-sm font-medium">Estado</p>
            <p className="text-sm text-muted-foreground">{statusMessage}</p>
          </div>
          <Badge variant="outline">Intentos: {attemptCount}/{MAX_ATTEMPTS}</Badge>
        </div>

        {phase === 'mode-select' && (
          <div className="space-y-4">
            <p className="text-muted-foreground">Elige cómo escanear el alimento:</p>
            <div className="grid grid-cols-2 gap-4">
              <Button
                ref={initialFocusRef}
                size="lg"
                variant="default"
                className="h-32 flex-col gap-2"
                onClick={startBarcodeScanning}
              >
                <Barcode className="h-12 w-12" aria-hidden="true" />
                <span>Código de Barras</span>
              </Button>
              <Button
                size="lg"
                variant="secondary"
                className="h-32 flex-col gap-2"
                onClick={startAIScanning}
              >
                <Camera className="h-12 w-12" aria-hidden="true" />
                <span>Foto IA</span>
              </Button>
            </div>
          </div>
        )}

        {phase === 'scanning' && (
          <div className="space-y-4">
            {scanMode === 'barcode' ? (
              <>
                <div className="bg-black/50 rounded-lg p-4 text-center text-white">
                  <p className="mb-2">Apunta la cámara al código de barras</p>
                  <Progress value={scanProgress} className="h-2" aria-label="Progreso de escaneo" />
                </div>
                <div id="barcode-reader" className="w-full" aria-live="polite" />
              </>
            ) : (
              <>
                <div className="bg-black/50 rounded-lg p-4 text-center text-white">
                  <p className="mb-2">Apunta al alimento y espera</p>
                  {loading && <Loader2 className="h-6 w-6 animate-spin mx-auto mt-2" aria-hidden="true" />}
                </div>
                <video
                  ref={videoRef}
                  className="w-full rounded-lg"
                  autoPlay
                  playsInline
                  muted
                  aria-label="Vista previa de cámara"
                />
                <canvas ref={canvasRef} className="hidden" />
                <div className="flex gap-2">
                  <Button onClick={captureAndAnalyze} disabled={loading} className="flex-1">
                    <ImagePlus className="mr-2 h-4 w-4" aria-hidden="true" />
                    {loading ? 'Analizando...' : 'Capturar Ahora'}
                  </Button>
                  <Button variant="outline" onClick={() => setPhase('mode-select')}>
                    Cancelar
                  </Button>
                </div>
              </>
            )}
            <Button variant="outline" onClick={() => setPhase('fallback')} className="w-full">
              Entrada Manual / Voz
            </Button>
          </div>
        )}

        {phase === 'preview' && (
          <div className="space-y-4">
            <Card className="p-4 space-y-4" aria-live="polite">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="font-semibold text-lg">{productData.name}</h3>
                  <Badge variant={productData.source === 'ai' ? 'secondary' : 'default'}>
                    {productData.source === 'ai' ? 'IA' : productData.source === 'barcode' ? 'Código de barras' : 'Manual'}
                  </Badge>
                </div>
                {productData.confidence > 0 && (
                  <Badge variant="outline">Confianza {(productData.confidence * 100).toFixed(0)}%</Badge>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm sm:text-base">
                <div>
                  <p className="font-medium">Carbohidratos</p>
                  <p>{productData.carbsPer100g} g / 100 g</p>
                </div>
                <div>
                  <p className="font-medium">Proteínas</p>
                  <p>{productData.proteinsPer100g} g / 100 g</p>
                </div>
                <div>
                  <p className="font-medium">Grasas</p>
                  <p>{productData.fatsPer100g} g / 100 g</p>
                </div>
                <div>
                  <p className="font-medium">Calorías</p>
                  <p>{productData.kcalPer100g} kcal / 100 g</p>
                </div>
                <div>
                  <p className="font-medium">Índice glucémico</p>
                  <p>{productData.glycemicIndex}</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button onClick={handleStartWeighing} className="flex-1 min-w-[150px]">
                  Continuar a pesar
                </Button>
                <Button variant="outline" onClick={() => setPhase('mode-select')} className="min-w-[150px]">
                  Escanear de nuevo
                </Button>
                <Button variant="outline" onClick={() => setPhase('fallback')} className="min-w-[150px]">
                  Ajustar manualmente
                </Button>
              </div>
            </Card>
          </div>
        )}

        {phase === 'weighing' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card className="p-4" aria-live="polite">
                <h3 className="font-semibold mb-2">Peso actual</h3>
                <div className="text-3xl font-bold">{pesoActual} g</div>
                <p className="text-sm text-muted-foreground">
                  Δ {pesoActual - lastStableWeight > 0 ? '+' : ''}
                  {pesoActual - lastStableWeight} g
                </p>
              </Card>

              <Card className="p-4" aria-live="polite">
                <h3 className="font-semibold mb-2">Nutrición estimada</h3>
                <div className="space-y-1">
                  <p className="text-lg">
                    <span className="font-bold">{calculatedCarbs} g</span> carbohidratos
                  </p>
                  <p className="text-lg">
                    <span className="font-bold">{calculatedKcal}</span> kcal
                  </p>
                </div>
              </Card>
            </div>

            <div>
              <Label htmlFor="expected-portion">Ajustar porción esperada (g)</Label>
              <Slider
                id="expected-portion"
                value={[expectedPortion]}
                onValueChange={([val]) => setExpectedPortion(val)}
                min={1}
                max={1000}
                step={1}
                className="mt-2"
                aria-label="Porción esperada"
              />
              <p className="text-sm text-muted-foreground mt-1">{expectedPortion} g</p>
            </div>

            <div className="flex gap-2">
              <Button onClick={handleConfirm} className="flex-1" disabled={pesoActual <= 0}>
                <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden="true" />
                Confirmar
              </Button>
              <Button variant="outline" onClick={() => setPhase('preview')}>
                Volver
              </Button>
            </div>
          </div>
        )}

        {phase === 'fallback' && (
          <Tabs defaultValue={speechSupported ? 'voice' : 'manual'} className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="voice" disabled={!speechSupported}>
                Voz
              </TabsTrigger>
              <TabsTrigger value="manual">Manual</TabsTrigger>
            </TabsList>

            <TabsContent value="voice" className="space-y-4" forceMount>
              <div className="space-y-4">
                <div className="rounded-lg border p-4" aria-live="polite">
                  <p className="font-medium mb-2">Dicta el alimento y sus datos</p>
                  <p className="text-sm text-muted-foreground">
                    Ejemplo: “Manzana 12 carbohidratos 50 calorías”
                  </p>
                  <p className="mt-2 text-sm" aria-live="polite">
                    Transcripción: {voiceTranscript || 'Sin entrada todavía'}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    variant={voiceStatus === 'listening' ? 'destructive' : 'default'}
                    onClick={voiceStatus === 'listening' ? stopVoiceRecognition : startVoiceRecognition}
                  >
                    {voiceStatus === 'listening' ? (
                      <>
                        <MicOff className="mr-2 h-4 w-4" aria-hidden="true" />
                        Detener
                      </>
                    ) : (
                      <>
                        <Mic className="mr-2 h-4 w-4" aria-hidden="true" />
                        Escuchar
                      </>
                    )}
                  </Button>
                  <Button variant="outline" onClick={() => setVoiceTranscript('')}>
                    Limpiar
                  </Button>
                </div>
                <Button className="w-full" onClick={handleManualSubmit}>
                  Usar datos transcritos
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="manual" className="space-y-4" forceMount>
              <form onSubmit={handleManualSubmit} className="space-y-4" aria-label="Formulario manual">
                <div>
                  <Label htmlFor="manual-name">Nombre del alimento</Label>
                  <Input
                    id="manual-name"
                    placeholder="Ej: Manzana"
                    {...manualForm.register('name')}
                    aria-invalid={manualForm.formState.errors.name ? 'true' : 'false'}
                  />
                  {manualForm.formState.errors.name && (
                    <p className="text-sm text-red-600" role="alert">
                      {manualForm.formState.errors.name.message}
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="carbs">Carbos / 100g</Label>
                      <Button
                        type="button"
                        size="icon"
                        variant={activeNumericField === 'carbsPer100g' ? 'default' : 'ghost'}
                        onClick={() =>
                          setActiveNumericField((prev) => (prev === 'carbsPer100g' ? null : 'carbsPer100g'))
                        }
                        aria-pressed={activeNumericField === 'carbsPer100g'}
                      >
                        <Keyboard className="h-4 w-4" aria-hidden="true" />
                        <span className="sr-only">Mostrar teclado para carbohidratos</span>
                      </Button>
                    </div>
                    <Input
                      id="carbs"
                      type="number"
                      step="0.1"
                      {...manualForm.register('carbsPer100g', { valueAsNumber: true })}
                      aria-invalid={manualForm.formState.errors.carbsPer100g ? 'true' : 'false'}
                    />
                    {manualForm.formState.errors.carbsPer100g && (
                      <p className="text-sm text-red-600" role="alert">
                        {manualForm.formState.errors.carbsPer100g.message}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="kcal">Kcal / 100g</Label>
                      <Button
                        type="button"
                        size="icon"
                        variant={activeNumericField === 'kcalPer100g' ? 'default' : 'ghost'}
                        onClick={() =>
                          setActiveNumericField((prev) => (prev === 'kcalPer100g' ? null : 'kcalPer100g'))
                        }
                        aria-pressed={activeNumericField === 'kcalPer100g'}
                      >
                        <Keyboard className="h-4 w-4" aria-hidden="true" />
                        <span className="sr-only">Mostrar teclado para calorías</span>
                      </Button>
                    </div>
                    <Input
                      id="kcal"
                      type="number"
                      step="0.1"
                      {...manualForm.register('kcalPer100g', { valueAsNumber: true })}
                      aria-invalid={manualForm.formState.errors.kcalPer100g ? 'true' : 'false'}
                    />
                    {manualForm.formState.errors.kcalPer100g && (
                      <p className="text-sm text-red-600" role="alert">
                        {manualForm.formState.errors.kcalPer100g.message}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="proteins">Proteínas / 100g</Label>
                    <Input
                      id="proteins"
                      type="number"
                      step="0.1"
                      {...manualForm.register('proteinsPer100g', { valueAsNumber: true })}
                      aria-invalid={manualForm.formState.errors.proteinsPer100g ? 'true' : 'false'}
                    />
                    {manualForm.formState.errors.proteinsPer100g && (
                      <p className="text-sm text-red-600" role="alert">
                        {manualForm.formState.errors.proteinsPer100g.message}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="fats">Grasas / 100g</Label>
                    <Input
                      id="fats"
                      type="number"
                      step="0.1"
                      {...manualForm.register('fatsPer100g', { valueAsNumber: true })}
                      aria-invalid={manualForm.formState.errors.fatsPer100g ? 'true' : 'false'}
                    />
                    {manualForm.formState.errors.fatsPer100g && (
                      <p className="text-sm text-red-600" role="alert">
                        {manualForm.formState.errors.fatsPer100g.message}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="glycemic-index">Índice glucémico</Label>
                      <Button
                        type="button"
                        size="icon"
                        variant={activeNumericField === 'glycemicIndex' ? 'default' : 'ghost'}
                        onClick={() =>
                          setActiveNumericField((prev) => (prev === 'glycemicIndex' ? null : 'glycemicIndex'))
                        }
                        aria-pressed={activeNumericField === 'glycemicIndex'}
                      >
                        <Keyboard className="h-4 w-4" aria-hidden="true" />
                        <span className="sr-only">Mostrar teclado para índice glucémico</span>
                      </Button>
                    </div>
                    <Input
                      id="glycemic-index"
                      type="number"
                      step="1"
                      {...manualForm.register('glycemicIndex', { valueAsNumber: true })}
                      aria-invalid={manualForm.formState.errors.glycemicIndex ? 'true' : 'false'}
                    />
                    {manualForm.formState.errors.glycemicIndex && (
                      <p className="text-sm text-red-600" role="alert">
                        {manualForm.formState.errors.glycemicIndex.message}
                      </p>
                    )}
                  </div>
                </div>

                {activeNumericField && (
                  <NumericKeyboard
                    onKey={handleNumericKey}
                    onDelete={handleNumericDelete}
                    onClear={handleNumericClear}
                  />
                )}

                <Button type="submit" className="w-full" disabled={!manualForm.formState.isValid}>
                  Guardar y pesar
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        )}

        <div className="text-xs text-muted-foreground" role="note">
          El modo seleccionado se bloquea unos segundos tras cada intento para evitar lecturas repetidas.
        </div>
      </DialogContent>
    </Dialog>
  );
}
