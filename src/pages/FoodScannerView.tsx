import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Trash2, Check, X, Barcode, Syringe, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { BolusCalculator } from "@/components/BolusCalculator";
import { BarcodeScannerModal } from "@/components/BarcodeScannerModal";
import { useScaleWebSocket } from "@/hooks/useScaleWebSocket";
import { storage, type ScannerHistoryEntry, type ScannerSource } from "@/services/storage";
import { logger } from "@/services/logger";
import { api } from "@/services/api";
import { ApiError } from "@/services/apiWrapper";
import { buildFoodItem, toFoodItem, type FoodScannerConfirmedPayload, type FoodItem } from "@/features/food-scanner/foodItem";
import { formatWeight } from "@/lib/format";
import { useScaleDecimals } from "@/hooks/useScaleDecimals";
import { useCameraPreview } from "@/hooks/useCameraPreview";

type CaptureMode = "backend" | "browser";

interface CaptureResponse {
  ok?: boolean;
  path?: string | null;
  url?: string | null;
  detail?: string | null;
  message?: string | null;
  error?: string | null;
}

interface RemoteCaptureOutcome {
  result: { blob: Blob; previewUrl: string } | null;
  errorMessage: string | null;
}

const kioskUserAgentPattern = /(bascula|raspberry|aarch64)/i;

const isLikelyLocalDevice = (): boolean => {
  if (typeof window === "undefined") {
    return true;
  }

  try {
    const hostname = window.location?.hostname ?? "";
    const userAgent = window.navigator?.userAgent ?? "";
    if (!hostname) {
      return kioskUserAgentPattern.test(userAgent);
    }

    const normalizedHost = hostname.trim().toLowerCase();
    if (
      normalizedHost === "localhost" ||
      normalizedHost === "127.0.0.1" ||
      normalizedHost === "::1" ||
      normalizedHost.endsWith(".local")
    ) {
      return true;
    }

    return kioskUserAgentPattern.test(userAgent);
  } catch {
    return true;
  }
};

export const FoodScannerView = () => {
  const { weight: scaleWeight } = useScaleWebSocket();
  const [isScanning, setIsScanning] = useState(false);
  const [foods, setFoods] = useState<FoodItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showBolusCalculator, setShowBolusCalculator] = useState(false);
  const [currentGlucose, setCurrentGlucose] = useState<number | undefined>();
  const [lastCaptureUrl, setLastCaptureUrl] = useState<string | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isCameraStarting, setIsCameraStarting] = useState(false);
  const [isBackendPreviewing, setIsBackendPreviewing] = useState(false);
  const [isBarcodeModalOpen, setIsBarcodeModalOpen] = useState(false);
  const [prefilledBarcode, setPrefilledBarcode] = useState<string | undefined>(undefined);
  const [isRemoteCapturing, setIsRemoteCapturing] = useState(false);
  const [captureMode, setCaptureMode] = useState<CaptureMode>("backend");

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasHydratedHistoryRef = useRef(false);
  const preservedScannerEntriesRef = useRef<ScannerHistoryEntry[]>([]);
  const captureCacheRef = useRef<{ blob: Blob; previewUrl: string } | null>(null);

  const { toast } = useToast();
  const decimals = useScaleDecimals();
  const allowBrowserCapture = useMemo(() => !isLikelyLocalDevice(), []);
  const renderWeight = (value: number | null | undefined) => {
    const formatted = formatWeight(value, decimals);
    return formatted === '–' ? formatted : `${formatted} g`;
  };

  const settings = storage.getSettings();
  const isDiabetesMode = settings.diabetesMode;

  const backendOrigin = useMemo(() => {
    try {
      const apiUrl = typeof settings?.apiUrl === "string" ? settings.apiUrl.trim() : "";
      if (apiUrl) {
        return apiUrl;
      }
    } catch (error) {
      logger.debug("[scanner] Failed to read settings apiUrl", { error });
    }

    if (typeof window === "undefined") {
      return "http://127.0.0.1:8081";
    }

    try {
      const current = new URL(window.location.href);
      const port = current.port;

      if (port === "8080") {
        current.port = "8081";
        return current.origin;
      }

      if (port === "" || port === "80" || port === "443") {
        current.port = "8081";
        return current.origin;
      }

      return current.origin;
    } catch (error) {
      logger.debug("[scanner] Unable to derive backend origin", { error });
      return "http://127.0.0.1:8081";
    }
  }, [settings?.apiUrl]);

  const buildBackendUrl = useCallback(
    (path: string) => {
      if (!path) {
        return backendOrigin;
      }

      if (/^https?:\/\//i.test(path)) {
        return path;
      }

      try {
        return new URL(path, backendOrigin).toString();
      } catch (error) {
        logger.debug("[scanner] Failed to compose backend URL", { path, error });
        return path;
      }
    },
    [backendOrigin],
  );

  const totals = useMemo(
    () =>
      foods.reduce(
        (acc, food) => ({
          weight: acc.weight + food.weight,
          carbs: acc.carbs + food.carbs,
          proteins: acc.proteins + food.proteins,
          fats: acc.fats + food.fats,
        }),
        { weight: 0, carbs: 0, proteins: 0, fats: 0 }
      ),
    [foods]
  );

  const hydrateScannerHistory = useCallback(() => {
    const history = storage.getScannerHistory();
    preservedScannerEntriesRef.current = [];
    if (!Array.isArray(history)) {
      hasHydratedHistoryRef.current = true;
      return;
    }

    const normalised = history
      .map((entry): FoodItem | null => {
        if (!entry || typeof entry !== "object") {
          return null;
        }

        // Check if it has all required fields for FoodItem
        const hasRequiredNumbers =
          typeof entry.weight === "number" &&
          typeof entry.carbs === "number" &&
          typeof entry.proteins === "number" &&
          typeof entry.fats === "number" &&
          typeof entry.glycemicIndex === "number";

        if (!hasRequiredNumbers || typeof entry.name !== "string") {
          // Keep original entry if it looks valid
          if (entry.name && entry.weight && typeof entry.timestamp === 'string') {
            preservedScannerEntriesRef.current.push(entry);
          }
          return null;
        }

        const source: FoodItem["source"] = entry.source === "ai" ? "camera" : "barcode";

        // Parse timestamp from ScannerHistoryEntry to capturedAt for FoodItem
        const capturedAt = (() => {
          if (typeof entry.capturedAt === "string") {
            return Date.parse(entry.capturedAt) || Date.now();
          }
          if (typeof entry.timestamp === "string") {
            return Date.parse(entry.timestamp) || Date.now();
          }
          return Date.now();
        })();

        const baseId = entry.id ?? `${capturedAt}-${entry.name.toLowerCase().replace(/\s+/g, "-")}`;

        return {
          id: baseId,
          name: entry.name,
          weight: entry.weight,
          carbs: entry.carbs,
          proteins: entry.proteins,
          fats: entry.fats,
          glycemicIndex: entry.glycemicIndex,
          kcal: entry.kcal,
          confidence: entry.confidence,
          source,
          capturedAt,
          photo: entry.photo,
        } as FoodItem;
      })
      .filter((item): item is FoodItem => Boolean(item?.name && item?.weight));

    if (normalised.length > 0) {
      setFoods(normalised);
      setSelectedId(normalised[normalised.length - 1]?.id ?? null);
    }

    hasHydratedHistoryRef.current = true;
  }, []);

  useEffect(() => {    
    hydrateScannerHistory();
  }, [hydrateScannerHistory]);

  useEffect(() => {
    if (!hasHydratedHistoryRef.current) {
      return;
    }
    try {
      // Convert FoodItem to ScannerHistoryEntry format
      const scannerEntries = foods.map((item): ScannerHistoryEntry => ({
        id: item.id,
        name: item.name,
        weight: item.weight,
        carbs: item.carbs,
        proteins: item.proteins,
        fats: item.fats,
        glycemicIndex: item.glycemicIndex,
        kcal: item.kcal,
        confidence: item.confidence,
        source: item.source as ScannerSource,
        timestamp: new Date(item.capturedAt).toISOString(),
        capturedAt: new Date(item.capturedAt).toISOString(),
        photo: item.photo,
        carbsPer100g: item.weight > 0 ? (item.carbs / item.weight) * 100 : 0,
        proteinsPer100g: item.weight > 0 ? (item.proteins / item.weight) * 100 : 0,
        fatsPer100g: item.weight > 0 ? (item.fats / item.weight) * 100 : 0,
        kcalPer100g: item.kcal && item.weight > 0 ? (item.kcal / item.weight) * 100 : 0,
        portionWeight: item.weight,
      }));
      
      const payload: ScannerHistoryEntry[] = [
        ...preservedScannerEntriesRef.current,
        ...scannerEntries,
      ];
      storage.saveScannerHistory(payload);
    } catch (error) {
      logger.error("Failed to persist scanner history", { error });
    }
  }, [foods]);

  const stopCamera = useCallback((options?: { preserveCapture?: boolean }) => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      const video = videoRef.current;
      video.pause();
      video.srcObject = null;
    }
    setIsCameraActive(false);
    if (!options?.preserveCapture) {
      captureCacheRef.current = null;
    }
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  useEffect(() => {
    if (captureMode === "backend") {
      stopCamera({ preserveCapture: true });
      setCameraError(null);
    }
    setIsBackendPreviewing(false);
  }, [captureMode, stopCamera]);

  useEffect(() => {
    console.info("[scanner] capture mode:", captureMode);
  }, [captureMode]);

  const captureRemotePhoto = useCallback(
    async (options?: { silent?: boolean; timeoutMs?: number }): Promise<RemoteCaptureOutcome> => {
      const silent = options?.silent ?? false;
      const timeoutMs = options?.timeoutMs ?? 8000;

      if (!silent) {
        setIsRemoteCapturing(true);
      }

      const runWithTimeout = async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), timeoutMs);
        try {
          return await fetch(input, { ...init, signal: controller.signal });
        } finally {
          window.clearTimeout(timer);
        }
      };

      const fail = (message: string): RemoteCaptureOutcome => {
        if (!silent) {
          setCameraError(message);
          toast({
            title: "Captura fallida",
            description: message,
            variant: "destructive",
          });
        }
        return { result: null, errorMessage: message };
      };

      try {
        const endpoint = buildBackendUrl("/api/camera/capture-to-file");
        const response = await runWithTimeout(endpoint, { method: "POST" });
        let payload: CaptureResponse | null = null;

        try {
          payload = (await response.json()) as CaptureResponse;
        } catch (parseError) {
          if (!response.ok) {
            console.error("[scanner] backend capture failed:", response.status, null);
            logger.error("Remote capture JSON parse failed", { parseError });
            return fail(`HTTP ${response.status}`);
          }
        }

        if (!response.ok) {
          const message =
            payload?.detail || payload?.message || payload?.error || `HTTP ${response.status}`;
          console.error("[scanner] backend capture failed:", response.status, payload);
          logger.error("Remote capture request failed", { status: response.status, payload });
          return fail(message);
        }

        const captureOk = payload?.ok ?? true;
        if (!captureOk) {
          const message =
            payload?.detail || payload?.message || payload?.error || "La captura remota no se completó.";
          console.error("[scanner] backend capture failed:", response.status, payload);
          logger.error("Remote capture reported failure", { payload });
          return fail(message);
        }

        const pathValue = payload?.url ?? payload?.path;
        if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
          logger.error("Remote capture missing path", { payload });
          return fail("La captura remota no devolvió una ruta válida.");
        }

        const normalizedPath = pathValue.trim();
        const absoluteUrl = buildBackendUrl(normalizedPath);
        const bustUrl = `${absoluteUrl}${absoluteUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
        console.info("[scanner] capture via backend:", bustUrl);

        const imageResponse = await runWithTimeout(bustUrl, { cache: "no-store" });
        if (!imageResponse.ok) {
          console.error("[scanner] backend capture failed:", imageResponse.status, null);
          logger.error("Remote capture image fetch failed", { status: imageResponse.status });
          return fail(`No se pudo descargar la imagen (HTTP ${imageResponse.status}).`);
        }

        const blob = await imageResponse.blob();
        const capturePayload = { blob, previewUrl: bustUrl };
        captureCacheRef.current = capturePayload;
        setLastCaptureUrl(bustUrl);
        if (!silent) {
          setCameraError(null);
        }

        return { result: capturePayload, errorMessage: null };
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "No se pudo capturar la imagen desde la báscula.";
        console.error("[scanner] backend capture failed:", message, error);
        logger.error("Remote capture threw exception", { error });
        return fail(message);
      } finally {
        if (!silent) {
          setIsRemoteCapturing(false);
        }
      }
    },
    [buildBackendUrl, toast],
  );

  const backendPreviewEndpoint = useMemo(
    () => buildBackendUrl("/api/camera/capture"),
    [buildBackendUrl],
  );

  const handleBackendPreviewError = useCallback(
    (error: Error) => {
      logger.error("Remote preview failed", { error });
      setIsBackendPreviewing(false);
      setCameraError("No se pudo iniciar la cámara de la báscula.");
      toast({
        title: "Cámara no disponible",
        description: "No se pudo iniciar la cámara de la báscula.",
        variant: "destructive",
      });
    },
    [toast],
  );

  const livePreviewSrc = useCameraPreview(
    backendPreviewEndpoint,
    captureMode === "backend" && isBackendPreviewing && !lastCaptureUrl,
    { intervalMs: 800, onError: handleBackendPreviewError },
  );

  const startBrowserCamera = useCallback(async () => {
    setCameraError(null);
    setIsCameraStarting(true);

    let localStreamStarted = false;
    let localErrorMessage: string | null = null;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      localErrorMessage =
        "Este dispositivo no permite acceso directo a la cámara. Se utilizará la cámara integrada al analizar.";
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          const video = videoRef.current;
          video.srcObject = stream;
          video.muted = true;
          video.setAttribute("muted", "true");
          try {
            await video.play();
          } catch (playError) {
            logger.error("Failed to play camera stream", { error: playError });
            stream.getTracks().forEach((track) => track.stop());
            if (streamRef.current === stream) {
              streamRef.current = null;
            }
            video.srcObject = null;
            throw playError;
          }
        }
        setIsCameraActive(true);
        captureCacheRef.current = null;
        setLastCaptureUrl(null);
        localStreamStarted = true;
      } catch (error) {
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = null;
        }
        setIsCameraActive(false);
        logger.error("Failed to start camera", { error });
        localErrorMessage =
          "No se pudo iniciar la cámara del navegador. Revisa permisos o continúa usando la cámara integrada al analizar.";
      }
    }

    setIsCameraStarting(false);

    if (localStreamStarted) {
      return;
    }

    if (localErrorMessage) {
      setCameraError(localErrorMessage);
    }

    toast({
      title: "Usando la cámara de la báscula",
      description: "No pudimos acceder a la cámara del navegador, intentando captura remota…",
    });

    const { result: remoteCapture, errorMessage } = await captureRemotePhoto({ silent: true, timeoutMs: 7000 });
    if (remoteCapture) {
      captureCacheRef.current = remoteCapture;
      setLastCaptureUrl(remoteCapture.previewUrl);
      setCameraError(null);
      toast({
        title: "Captura remota lista",
        description: "La imagen se obtuvo desde la cámara de la báscula.",
      });
    } else {
      const description =
        errorMessage ||
        (localErrorMessage
          ? "No se pudo acceder a la cámara del navegador ni obtener una captura desde la báscula."
          : "No se pudo obtener una captura desde la cámara integrada de la báscula.");
      setCameraError(description);
      toast({
        title: "Sin cámara disponible",
        description: description ||
          "No se pudo obtener una captura desde la cámara integrada de la báscula.",
        variant: "destructive",
      });
    }
  }, [captureRemotePhoto, toast]);

  const handleCaptureModeToggle = useCallback(
    (checked: boolean) => {
      if (!allowBrowserCapture) {
        return;
      }
      setCaptureMode(checked ? "browser" : "backend");
    },
    [allowBrowserCapture],
  );

  const startBackendPreview = useCallback(() => {
    captureCacheRef.current = null;
    setLastCaptureUrl(null);
    setCameraError(null);
    setIsBackendPreviewing(true);
  }, []);

  const handleCaptureClick = useCallback(async () => {
    if (captureMode === "backend") {
      if (!isBackendPreviewing && !lastCaptureUrl) {
        startBackendPreview();
        return;
      }

      if (isBackendPreviewing) {
        const { result: remoteCapture } = await captureRemotePhoto({ silent: false, timeoutMs: 7000 });
        if (remoteCapture) {
          setIsBackendPreviewing(false);
        }
        return;
      }

      return;
    }

    if (!isCameraActive) {
      await startBrowserCamera();
      return;
    }

    const blob = await capturePhoto();
    if (blob) {
      stopCamera({ preserveCapture: true });
    }
  }, [
    captureMode,
    capturePhoto,
    captureRemotePhoto,
    isBackendPreviewing,
    isCameraActive,
    lastCaptureUrl,
    startBackendPreview,
    startBrowserCamera,
    stopCamera,
  ]);

  const capturePhoto = useCallback(async (): Promise<Blob | null> => {
    if (!videoRef.current) {
      return null;
    }
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      return null;
    }

    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.drawImage(video, 0, 0, width, height);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    setLastCaptureUrl(dataUrl);

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => {
        if (blob) {
          captureCacheRef.current = { blob, previewUrl: dataUrl };
        }
        resolve(blob);
      }, "image/jpeg", 0.92);
    });
  }, []);

  const handleRetake = useCallback(async () => {
    setUploadedFile(null);
    if (captureMode === "backend") {
      startBackendPreview();
      return;
    }

    setLastCaptureUrl(null);
    captureCacheRef.current = null;
    stopCamera();
    await startBrowserCamera();
  }, [captureMode, startBackendPreview, startBrowserCamera, stopCamera]);

  useEffect(() => {
    if (!uploadedFile) {
      return;
    }
    const url = URL.createObjectURL(uploadedFile);
    setLastCaptureUrl(url);
    captureCacheRef.current = { blob: uploadedFile, previewUrl: url };
    return () => {
      URL.revokeObjectURL(url);
      if (captureCacheRef.current?.previewUrl === url) {
        captureCacheRef.current = null;
      }
    };
  }, [uploadedFile]);

  useEffect(() => {
    if (captureMode !== "browser") {
      return;
    }

    const video = videoRef.current;
    const stream = streamRef.current;
    if (!isCameraActive || !video || !stream) {
      return;
    }

    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    video.muted = true;
    video.setAttribute("muted", "true");
    video
      .play()
      .catch((error) => logger.error("Failed to play camera stream", { error }));
  }, [captureMode, isCameraActive]);

  const ensureWeight = async (): Promise<number | null> => {
    if (scaleWeight > 0) {
      return scaleWeight;
    }
    const manual = window.prompt(
      "Introduce el peso en gramos. Si tienes la báscula conectada, actívala antes de continuar."
    );
    if (!manual) {
      return null;
    }
    const parsed = Number(manual.replace(",", "."));
    if (Number.isNaN(parsed) || parsed <= 0) {
      toast({
        title: "Peso inválido",
        description: "Introduce un valor numérico mayor que cero",
        variant: "destructive",
      });
      return null;
    }
    return parsed;
  };

  const appendFood = (item: FoodItem) => {
    setFoods((prev) => [...prev, item]);
    setSelectedId(item.id);
    logger.info("Food registered", { name: item.name, weight: item.weight, source: item.source });
    toast({ title: "Alimento añadido", description: `${item.name} - ${renderWeight(item.weight)}` });
    if (navigator.vibrate) {
      navigator.vibrate(25);
    }
  };

  const handleBarcodeModalClose = useCallback(() => {
    setIsBarcodeModalOpen(false);
    setPrefilledBarcode(undefined);
  }, []);

  const handleBarcodeModalOpen = useCallback((barcode?: string) => {
    setPrefilledBarcode(barcode?.trim() || undefined);
    setIsBarcodeModalOpen(true);
  }, []);

  const handleFoodConfirmed = (payload: FoodScannerConfirmedPayload) => {
    const item = toFoodItem(payload, "barcode");
    appendFood(item);
  };

  const handleAnalyze = async () => {
    if (!captureCacheRef.current) {
      toast({
        title: "Sin captura",
        description: "Captura una imagen antes de analizar.",
        variant: "destructive",
      });
      return;
    }

    const validWeight = await ensureWeight();
    if (!validWeight) {
      return;
    }

    const blob = captureCacheRef.current.blob;

    setIsScanning(true);
    try {
      const analysis = await api.analyzeFood(blob, validWeight);
      const item = buildFoodItem(analysis, validWeight, "camera");
      appendFood(item);
      if (uploadedFile) {
        setUploadedFile(null);
      }
    } catch (error) {
      logger.error("Food analysis failed", { error });
      if (error instanceof ApiError) {
        toast({ title: "Error", description: error.message, variant: "destructive" });
      } else {
        toast({ title: "Error inesperado", description: "No se pudo analizar la imagen" });
      }
    } finally {
      setIsScanning(false);
    }
  };

  const handleScanBarcode = useCallback(() => {
    handleBarcodeModalOpen();
  }, [handleBarcodeModalOpen]);

  const handleDelete = (id: string) => {
    setFoods((prev) => prev.filter((food) => food.id !== id));
    if (selectedId === id) {
      setSelectedId(null);
    }
    toast({ title: "Alimento eliminado" });
  };

  const handleFinish = async () => {
    logger.info("Food analysis completed", {
      totalWeight: totals.weight,
      totalCarbs: totals.carbs,
      totalProteins: totals.proteins,
      totalFats: totals.fats,
    });
    toast({
      title: "Resumen guardado",
      description: `Peso total: ${renderWeight(totals.weight)}`
    });
  };

  const flushScannerQueue = useCallback(async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      return;
    }

    while (true) {
      const action = storage.dequeueScannerAction();
      if (!action) {
        break;
      }

      try {
        if (action.type === "exportBolus") {
          const timestamp = typeof action.timestamp === 'string' ? action.timestamp : action.timestamp.toISOString();
          await api.exportBolus(action.carbs, action.insulin ?? 0, timestamp);
        }
        logger.info("Scanner queue action processed", { action });
      } catch (error) {
        logger.error("Failed to process scanner queue action", { action, error });
        storage.enqueueScannerAction(action);
        break;
      }
    }
  }, []);

  useEffect(() => {
    flushScannerQueue();

    const handleOnline = () => {
      toast({ title: "Conexión restaurada", description: "Procesando acciones pendientes" });
      flushScannerQueue();
    };

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [flushScannerQueue, toast]);

  const hasCapture = Boolean(lastCaptureUrl);
  const isBrowserPreviewing = captureMode === "browser" && (isCameraActive || isCameraStarting);
  const isBackendPreviewingActive = captureMode === "backend" && isBackendPreviewing;
  const scannerMode: "idle" | "previewing" | "captured" = hasCapture
    ? "captured"
    : isBrowserPreviewing || isBackendPreviewingActive
      ? "previewing"
      : "idle";
  const canAnalyze = Boolean(captureCacheRef.current);

  return (
    <div className="flex h-full flex-col gap-6 bg-background p-4">
      <div className="grid gap-6 md:grid-cols-[1.4fr_1fr]">
        <Card className="relative overflow-hidden border-primary/30">
          <div className="p-6">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-2xl font-bold">Captura con cámara</h2>
                <p className="text-sm text-muted-foreground" style={{ fontFeatureSettings: '"tnum"' }}>
                  Peso detectado: {renderWeight(scaleWeight)}
                </p>
              </div>
              <div className="flex flex-col items-end gap-3">
                {allowBrowserCapture ? (
                  <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
                    <Switch
                      id="capture-mode-toggle"
                      checked={captureMode === "browser"}
                      onCheckedChange={handleCaptureModeToggle}
                    />
                    <div className="flex flex-col">
                      <Label
                        htmlFor="capture-mode-toggle"
                        className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                      >
                        Modo de captura
                      </Label>
                      <span className="text-sm font-semibold">
                        {captureMode === "backend" ? "Cámara de la báscula" : "Cámara del navegador"}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-primary">
                    Modo: Cámara de la báscula
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    onClick={handleCaptureClick}
                    variant="secondary"
                    size="sm"
                    disabled={
                      captureMode === "backend"
                        ? isRemoteCapturing || scannerMode === "captured"
                        : isCameraStarting || scannerMode === "captured"
                    }
                  >
                    {captureMode === "backend" ? (
                      isRemoteCapturing ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Capturando…
                        </>
                      ) : scannerMode === "captured" ? (
                        <>
                          <Camera className="mr-2 h-4 w-4" /> Captura lista
                        </>
                      ) : (
                        <>
                          <Camera className="mr-2 h-4 w-4" /> Capturar imagen
                        </>
                      )
                    ) : isCameraStarting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Activando…
                      </>
                    ) : scannerMode === "previewing" ? (
                      <>
                        <Camera className="mr-2 h-4 w-4" /> Capturar imagen
                      </>
                    ) : scannerMode === "captured" ? (
                      <>
                        <Camera className="mr-2 h-4 w-4" /> Captura lista
                      </>
                    ) : (
                      <>
                        <Camera className="mr-2 h-4 w-4" /> Activar cámara
                      </>
                    )}
                  </Button>
                  {scannerMode === "captured" && (
                    <Button onClick={handleRetake} variant="outline" size="sm">
                      Capturar de nuevo
                    </Button>
                  )}
                  {captureMode === "browser" && isCameraActive && (
                    <Button
                      onClick={() => stopCamera({ preserveCapture: true })}
                      variant="ghost"
                      size="sm"
                    >
                      Detener
                    </Button>
                  )}
                </div>
              </div>
            </div>

            <div className="mb-4">
              {scannerMode === "idle" && (
                <div className="grid aspect-video w-full place-items-center rounded-2xl border border-dashed border-primary/30 bg-muted/30 p-8 text-center text-muted-foreground">
                  <Camera className="mb-3 h-10 w-10 opacity-60" />
                  <p className="text-sm font-medium">La captura se realizará desde la cámara de la báscula.</p>
                  <p className="text-xs text-muted-foreground/80">Pulsa «Capturar imagen» para iniciar la vista previa.</p>
                  {cameraError && (
                    <span className="mt-3 text-xs font-semibold text-destructive">{cameraError}</span>
                  )}
                </div>
              )}

              {scannerMode === "previewing" && (
                captureMode === "backend" ? (
                  <figure className="relative aspect-video w-full overflow-hidden rounded-2xl border border-primary/40 bg-black/70">
                    {livePreviewSrc ? (
                      <img
                        src={livePreviewSrc}
                        alt="Vista previa en vivo"
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                        <Loader2 className="h-6 w-6 animate-spin" />
                        <span className="text-sm font-medium">Iniciando cámara…</span>
                      </div>
                    )}
                  </figure>
                ) : (
                  <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-primary/40 bg-black/70">
                    <video ref={videoRef} autoPlay playsInline className="h-full w-full object-cover" />
                    {isCameraStarting && (
                      <div className="absolute inset-0 grid place-items-center bg-black/60 text-sm text-muted-foreground">
                        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Activando cámara…
                      </div>
                    )}
                  </div>
                )
              )}

              {scannerMode === "captured" && lastCaptureUrl && (
                <figure className="aspect-video w-full overflow-hidden rounded-2xl border border-primary/40 bg-black/70">
                  <img src={lastCaptureUrl} alt="Última captura" className="h-full w-full object-contain" />
                </figure>
              )}

              {cameraError && scannerMode !== "idle" && (
                <p className="mt-3 text-sm text-destructive">{cameraError}</p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={handleAnalyze}
                disabled={!canAnalyze || isScanning || isRemoteCapturing}
                className="min-w-[180px]"
              >
                {isScanning ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Analizando…
                  </>
                ) : isRemoteCapturing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Esperando captura…
                  </>
                ) : (
                  <>
                    <Camera className="mr-2 h-4 w-4" /> Analizar alimento
                  </>
                )}
              </Button>
              <Button
                onClick={handleScanBarcode}
                variant="secondary"
                disabled={isScanning}
              >
                <Barcode className="mr-2 h-4 w-4" /> Código de barras
              </Button>
            </div>
            <canvas ref={canvasRef} className="hidden" />
          </div>
        </Card>

        <Card className="border-primary/30">
          <div className="p-6">
            <h2 className="text-2xl font-bold">Historial del escáner</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              Selecciona un alimento para ver opciones adicionales.
            </p>

            <div className="space-y-3">
              {foods.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Aún no has añadido alimentos. Captura una imagen o usa el lector de códigos de barras.
                </p>
              )}

              {foods.map((food) => (
                <button
                  key={food.id}
                  className={cn(
                    "w-full rounded-lg border p-4 text-left transition",
                    selectedId === food.id ? "border-primary bg-primary/10" : "border-border hover:border-primary/60"
                  )}
                  onClick={() => setSelectedId(food.id)}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <div>
                      <p className="text-lg font-semibold">{food.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {food.source === "camera" ? "Imagen" : "Código de barras"}
                        {typeof food.confidence === "number" && (
                          <>
                            {" "}· Confianza {(food.confidence * 100).toFixed(0)}%
                          </>
                        )}
                      </p>
                    </div>
                    <span className="text-xl font-bold text-primary" style={{ fontFeatureSettings: '"tnum"' }}>
                      {renderWeight(food.weight)}
                    </span>
                  </div>

                  <div className="grid grid-cols-5 gap-2 text-sm">
                    <div>
                      <p className="text-muted-foreground">HC</p>
                      <p className="font-semibold">{food.carbs.toFixed(2)} g</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Proteínas</p>
                      <p className="font-semibold">{food.proteins.toFixed(2)} g</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Grasas</p>
                      <p className="font-semibold">{food.fats.toFixed(2)} g</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">IG</p>
                      <p className="font-semibold">{food.glycemicIndex}</p>
                    </div>
                    {food.avgColor && (
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">Color</span>
                        <span
                          className="h-4 w-4 rounded-full border"
                          style={{ backgroundColor: `rgb(${food.avgColor.r}, ${food.avgColor.g}, ${food.avgColor.b})` }}
                        />
                      </div>
                    )}
                  </div>

                  {selectedId === food.id && (
                    <Button
                      onClick={(event) => {
                        event.stopPropagation();
                        handleDelete(food.id);
                      }}
                      variant="destructive"
                      size="sm"
                      className="mt-3 w-full"
                    >
                      <Trash2 className="mr-2 h-4 w-4" /> Eliminar
                    </Button>
                  )}
                </button>
              ))}
            </div>
          </div>
        </Card>
      </div>

      {foods.length > 0 && (
        <Card className="border-primary/50 bg-primary/5">
          <div className="p-4">
            <h3 className="mb-3 text-xl font-bold">Totales</h3>
            <div className="mb-4 grid grid-cols-4 gap-4 text-center">
              <div>
                <p className="text-sm text-muted-foreground">Peso</p>
                <p className="text-2xl font-bold text-primary" style={{ fontFeatureSettings: '"tnum"' }}>
                  {renderWeight(totals.weight)}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">HC</p>
                <p className="text-2xl font-bold text-warning">{totals.carbs.toFixed(1)} g</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Proteínas</p>
                <p className="text-2xl font-bold text-secondary">{totals.proteins.toFixed(1)} g</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Grasas</p>
                <p className="text-2xl font-bold text-success">{totals.fats.toFixed(1)} g</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Button
                onClick={() => {
                  setFoods([]);
                  setSelectedId(null);
                  toast({ title: "Lista limpiada" });
                }}
                variant="outline"
                size="xl"
                className="text-xl"
              >
                <X className="mr-2 h-6 w-6" /> Limpiar
              </Button>
              <Button
                onClick={handleFinish}
                variant="success"
                size="xl"
                className="text-xl"
              >
                <Check className="mr-2 h-6 w-6" /> Finalizar
              </Button>
            </div>
            {isDiabetesMode && totals.carbs > 0 && (
              <Button
                onClick={async () => {
                  try {
                    const glucoseData = await api.getGlucose();
                    setCurrentGlucose(glucoseData.glucose);
                  } catch (error) {
                    logger.warn("Could not fetch glucose", { error });
                  }
                  setShowBolusCalculator(true);
                }}
                variant="glow"
                size="xl"
                className="mt-3 w-full text-xl"
              >
                <Syringe className="mr-2 h-6 w-6" /> Calcular bolo de insulina
              </Button>
            )}
          </div>
        </Card>
      )}

      {showBolusCalculator && (
        <BolusCalculator
          totalCarbs={totals.carbs}
          currentGlucose={currentGlucose}
          onClose={() => {
            setShowBolusCalculator(false);
            setFoods([]);
          }}
        />
      )}

      <BarcodeScannerModal
        open={isBarcodeModalOpen}
        onClose={handleBarcodeModalClose}
        prefilledBarcode={prefilledBarcode}
        onFoodConfirmed={handleFoodConfirmed}
      />
    </div>
  );
};
