import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Trash2, Check, X, Barcode, Syringe, Loader2, Image as ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { BolusCalculator } from "@/components/BolusCalculator";
import { useScaleWebSocket } from "@/hooks/useScaleWebSocket";
import { storage } from "@/services/storage";
import { logger } from "@/services/logger";
import { api, type FoodAnalysis } from "@/services/api";
import { ApiError } from "@/services/apiWrapper";

interface FoodItem {
  id: string;
  name: string;
  weight: number;
  carbs: number;
  proteins: number;
  fats: number;
  glycemicIndex: number;
  confidence?: number;
  source: "camera" | "barcode";
  capturedAt: number;
  avgColor?: { r: number; g: number; b: number };
}

const roundMacro = (value: number) => Number(value.toFixed(2));

const buildFoodItem = (
  analysis: FoodAnalysis,
  weight: number,
  source: FoodItem["source"]
): FoodItem => {
  const macros = analysis.nutrition ?? { carbs: 0, proteins: 0, fats: 0, glycemic_index: 0 };
  const color = analysis.avg_color
    ? {
        r: analysis.avg_color.r,
        g: analysis.avg_color.g,
        b: analysis.avg_color.b,
      }
    : undefined;

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: analysis.name || "Alimento sin nombre",
    weight,
    carbs: roundMacro(macros.carbs ?? 0),
    proteins: roundMacro(macros.proteins ?? 0),
    fats: roundMacro(macros.fats ?? 0),
    glycemicIndex: Math.round(macros.glycemic_index ?? 0),
    confidence: analysis.confidence,
    source,
    capturedAt: Date.now(),
    avgColor: color,
  };
};

export const FoodScannerView = () => {
  const { weight: scaleWeight } = useScaleWebSocket();
  const [isScanning, setIsScanning] = useState(false);
  const [foods, setFoods] = useState<FoodItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showBolusCalculator, setShowBolusCalculator] = useState(false);
  const [currentGlucose, setCurrentGlucose] = useState<number | undefined>();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { toast } = useToast();

  const settings = storage.getSettings();
  const isDiabetesMode = settings.diabetesMode;

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

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsCameraActive(false);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const startCamera = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setCameraError("Este dispositivo no permite acceso a la cámara desde el navegador");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      streamRef.current = stream;
      setCameraError(null);
      setIsCameraActive(true);
    } catch (error) {
      logger.error("Failed to start camera", { error });
      setCameraError("No se pudo iniciar la cámara. Revisa permisos o intenta con otro navegador.");
    }
  }, []);

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
    setPreviewUrl(dataUrl);

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.92);
    });
  }, []);

  useEffect(() => {
    if (!uploadedFile) {
      return;
    }
    const url = URL.createObjectURL(uploadedFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [uploadedFile]);

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
    logger.info("Food registered", item);
    toast({ title: "Alimento añadido", description: `${item.name} - ${item.weight.toFixed(1)} g` });
    if (navigator.vibrate) {
      navigator.vibrate(25);
    }
  };

  const handleAnalyze = async () => {
    const validWeight = await ensureWeight();
    if (!validWeight) {
      return;
    }

    let blob: Blob | null = null;

    if (isCameraActive) {
      blob = await capturePhoto();
    }

    if (!blob && uploadedFile) {
      blob = uploadedFile;
    }

    if (!blob) {
      toast({
        title: "Sin imagen",
        description: "Activa la cámara o sube una foto del alimento para analizarlo",
        variant: "destructive",
      });
      return;
    }

    setIsScanning(true);
    try {
      const analysis = await api.analyzeFood(blob, validWeight);
      const item = buildFoodItem(analysis, validWeight, "camera");
      appendFood(item);
      setUploadedFile(null);
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

  const handleScanBarcode = async () => {
    const code = window.prompt("Escanea o escribe el código de barras del producto");
    if (!code) {
      return;
    }

    const validWeight = await ensureWeight();
    if (!validWeight) {
      return;
    }

    setIsScanning(true);
    try {
      const analysis = await api.scanBarcode(code.trim());
      const macros = analysis.nutrition ?? { carbs: 0, proteins: 0, fats: 0, glycemic_index: 0 };
      const factor = validWeight / 100;
      const normalized: FoodAnalysis = {
        ...analysis,
        nutrition: {
          carbs: roundMacro((macros.carbs ?? 0) * factor),
          proteins: roundMacro((macros.proteins ?? 0) * factor),
          fats: roundMacro((macros.fats ?? 0) * factor),
          glycemic_index: macros.glycemic_index ?? 0,
        },
      };
      const item = buildFoodItem(normalized, validWeight, "barcode");
      appendFood(item);
    } catch (error) {
      logger.error("Barcode lookup failed", { error });
      if (error instanceof ApiError) {
        toast({ title: "No encontrado", description: error.message, variant: "destructive" });
      } else {
        toast({ title: "Error", description: "No se pudo consultar el código de barras", variant: "destructive" });
      }
    } finally {
      setIsScanning(false);
    }
  };

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
      description: `Peso total: ${totals.weight.toFixed(1)} g`
    });
  };

  return (
    <div className="flex h-full flex-col gap-6 bg-background p-4">
      <div className="grid gap-6 md:grid-cols-[1.4fr_1fr]">
        <Card className="relative overflow-hidden border-primary/30">
          <div className="p-6">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold">Captura con cámara</h2>
                <p className="text-sm text-muted-foreground">
                  Peso detectado: {scaleWeight.toFixed(1)} g
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={startCamera}
                  variant="secondary"
                  size="sm"
                  disabled={isCameraActive}
                >
                  <Camera className="mr-2 h-4 w-4" /> Activar cámara
                </Button>
                <Button
                  onClick={stopCamera}
                  variant="outline"
                  size="sm"
                  disabled={!isCameraActive}
                >
                  Detener
                </Button>
              </div>
            </div>

            <div className="relative mb-4 rounded-xl border border-dashed border-primary/30 bg-muted/30">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                className={cn(
                  "h-64 w-full rounded-xl object-cover",
                  !isCameraActive && "opacity-30"
                )}
              />
              {!isCameraActive && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
                  <Camera className="mb-2 h-8 w-8" />
                  <p>Activa la cámara o sube una imagen desde archivos.</p>
                </div>
              )}
            </div>

            {previewUrl && (
              <div className="mb-4 rounded-lg border border-primary/20 bg-primary/5 p-3">
                <p className="mb-2 text-sm font-medium text-primary">Última captura</p>
                <img src={previewUrl} alt="Vista previa" className="h-40 w-full rounded-md object-cover" />
              </div>
            )}

            {cameraError && (
              <p className="mb-4 text-sm text-destructive">{cameraError}</p>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    setUploadedFile(file);
                  }
                }}
              />
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
              >
                <ImageIcon className="mr-2 h-4 w-4" /> Subir foto
              </Button>
              <Button
                onClick={handleAnalyze}
                disabled={isScanning}
                className="min-w-[180px]"
              >
                {isScanning ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Analizando…
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
                    <span className="text-xl font-bold text-primary">{food.weight.toFixed(1)} g</span>
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
                <p className="text-2xl font-bold text-primary">{totals.weight.toFixed(1)} g</p>
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
    </div>
  );
};
