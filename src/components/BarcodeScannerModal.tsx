import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Barcode, Camera, X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
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

interface BarcodeScannerModalProps {
  open: boolean;
  onClose: () => void;
  prefilledBarcode?: string;
  onFoodConfirmed: (item: {
    name: string;
    weight: number;
    carbs: number;
    kcal: number;
    photo?: string;
    timestamp: Date;
  }) => void;
}

type ScanMode = 'barcode' | 'ai';
type Phase = 'mode-select' | 'scanning' | 'preview' | 'weighing' | 'fallback';

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
  
  // Product data
  const [productName, setProductName] = useState('');
  const [carbsPer100g, setCarbsPer100g] = useState(0);
  const [proteinsPer100g, setProteinsPer100g] = useState(0);
  const [fatsPer100g, setFatsPer100g] = useState(0);
  const [kcalPer100g, setKcalPer100g] = useState(0);
  const [confidence, setConfidence] = useState(0);
  const [source, setSource] = useState<'barcode' | 'ai' | 'manual'>('barcode');
  const [lastStableWeight, setLastStableWeight] = useState(0);
  const [expectedPortion, setExpectedPortion] = useState(100);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scannerRef = useRef<any>(null);
  const recognitionRef = useRef<any>(null);

  // Reset on open/close
  useEffect(() => {
    if (open) {
      setPhase('mode-select');
      setAttemptCount(0);
      setScanProgress(100);
      setLastStableWeight(0);
      
      if (prefilledBarcode) {
        handleBarcodeScanned(prefilledBarcode);
      }
    } else {
      cleanup();
    }
  }, [open, prefilledBarcode]);

  const cleanup = useCallback(() => {
    if (scannerRef.current) {
      try {
        scannerRef.current.clear();
      } catch (e) {
        // Ignore cleanup errors
      }
      scannerRef.current = null;
    }
    
    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
    
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {
        // Ignore
      }
      recognitionRef.current = null;
    }
  }, []);

  const startBarcodeScanning = useCallback(async () => {
    if (attemptCount >= 3) {
      toast({
        title: 'Límite de intentos',
        description: 'Usa entrada manual o por voz',
        variant: 'destructive',
      });
      setPhase('fallback');
      return;
    }

    setPhase('scanning');
    setLoading(true);
    setScanProgress(100);

    try {
      // Dynamically import html5-qrcode
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
        (decodedText) => {
          handleBarcodeScanned(decodedText);
          scanner.clear();
        },
        (error) => {
          // Ignore scanning errors, they're frequent
        }
      );

      scannerRef.current = scanner;

      // 10s timeout
      const interval = setInterval(() => {
        setScanProgress(prev => {
          if (prev <= 0) {
            clearInterval(interval);
            setAttemptCount(c => c + 1);
            toast({
              title: 'Tiempo agotado',
              description: 'Intenta de nuevo o usa entrada manual',
            });
            setPhase('fallback');
            return 0;
          }
          return prev - 10;
        });
      }, 1000);

    } catch (error) {
      logger.error('Barcode scanner error:', error);
      toast({
        title: 'Error al iniciar escáner',
        description: 'Usa entrada manual',
        variant: 'destructive',
      });
      setPhase('fallback');
    } finally {
      setLoading(false);
    }
  }, [attemptCount, toast]);

  const startAIScanning = useCallback(async () => {
    if (attemptCount >= 3) {
      toast({
        title: 'Límite de intentos',
        description: 'Probando escaneo de código de barras',
      });
      setScanMode('barcode');
      startBarcodeScanning();
      return;
    }

    setPhase('scanning');
    setLoading(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      // Auto-capture after 5s
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
      startBarcodeScanning();
    } finally {
      setLoading(false);
    }
  }, [attemptCount, toast]);

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

    setLoading(true);

    try {
      const result = await api.analyzeFoodPhoto(imageBase64);
      
      if (!result) {
        setAttemptCount(c => c + 1);
        toast({
          title: 'Detección IA incierta',
          description: 'Probando código de barras',
        });
        cleanup();
        setScanMode('barcode');
        startBarcodeScanning();
        return;
      }

      setProductName(result.name);
      setCarbsPer100g(result.carbsPer100g);
      setProteinsPer100g(result.proteinsPer100g || 0);
      setFatsPer100g(result.fatsPer100g || 0);
      setKcalPer100g(result.kcalPer100g || Math.round(result.carbsPer100g * 4));
      setConfidence(result.confidence);
      setSource('ai');
      setPhase('preview');
      
      cleanup();
      
      logger.info('AI analysis successful', { name: result.name, confidence: result.confidence });

    } catch (error) {
      logger.error('AI analysis failed:', error);
      setAttemptCount(c => c + 1);
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
  }, [toast, cleanup]);

  const handleBarcodeScanned = useCallback(async (barcode: string) => {
    setLoading(true);
    cleanup();

    try {
      const result = await api.scanBarcode(barcode);
      
      setProductName(result.name);
      setCarbsPer100g(result.nutrition.carbs);
      setProteinsPer100g(result.nutrition.proteins);
      setFatsPer100g(result.nutrition.fats);
      setKcalPer100g(Math.round(
        result.nutrition.carbs * 4 + 
        result.nutrition.proteins * 4 + 
        result.nutrition.fats * 9
      ));
      setConfidence(result.confidence || 1);
      setSource('barcode');
      setPhase('preview');
      
      logger.info('Barcode scanned successfully', { barcode, name: result.name });

    } catch (error) {
      logger.error('Barcode lookup failed:', error);
      
      // Try to find in history
      const history = storage.getScannerHistory();
      const match = history.find((item: any) => item.barcode === barcode);
      
      if (match) {
        setProductName(match.name);
        setCarbsPer100g(match.carbsPer100g);
        setProteinsPer100g(match.proteinsPer100g || 0);
        setFatsPer100g(match.fatsPer100g || 0);
        setKcalPer100g(match.kcalPer100g || 0);
        setSource('manual');
        setPhase('preview');
        
        toast({
          title: 'Encontrado en historial',
          description: 'Verifica los datos antes de confirmar',
        });
      } else {
        toast({
          title: 'Producto no encontrado',
          description: 'Usa entrada manual para agregar los datos',
        });
        setPhase('fallback');
      }
    } finally {
      setLoading(false);
    }
  }, [cleanup, toast]);

  const handleStartWeighing = useCallback(() => {
    if (!productName || carbsPer100g <= 0) {
      toast({
        title: 'Datos incompletos',
        description: 'Completa nombre y carbohidratos',
        variant: 'destructive',
      });
      return;
    }
    
    setPhase('weighing');
    setLastStableWeight(pesoActual);
  }, [productName, carbsPer100g, pesoActual, toast]);

  const calculatedCarbs = useMemo(() => {
    return Math.round((carbsPer100g * pesoActual) / 100);
  }, [carbsPer100g, pesoActual]);

  const calculatedKcal = useMemo(() => {
    return Math.round((kcalPer100g * pesoActual) / 100);
  }, [kcalPer100g, pesoActual]);

  const handleConfirm = useCallback(async () => {
    if (pesoActual <= 0) {
      toast({
        title: 'Peso inválido',
        description: 'Coloca el alimento en la báscula',
        variant: 'destructive',
      });
      return;
    }

    const payload = {
      name: productName,
      weight: pesoActual,
      carbs: calculatedCarbs,
      kcal: calculatedKcal,
      timestamp: new Date(),
    };

    // Save to history
    storage.addScannerRecord({
      ...payload,
      carbsPer100g,
      proteinsPer100g,
      fatsPer100g,
      kcalPer100g,
      source,
      confidence,
    });

    // Export to Nightscout if configured
    const settings = storage.getSettings();
    if (settings.nightscoutUrl && settings.nightscoutToken) {
      try {
        if (navigator.onLine) {
          await api.exportBolus(calculatedCarbs, 0, new Date().toISOString());
          toast({
            title: '✓ Exportado a Nightscout',
          });
        } else {
          storage.enqueueScannerAction({
            type: 'exportBolus',
            carbs: calculatedCarbs,
            timestamp: new Date().toISOString(),
          });
          toast({
            title: 'Sin conexión',
            description: 'Se exportará cuando haya internet',
          });
        }
      } catch (error) {
        logger.error('Nightscout export failed:', error);
      }
    }

    onFoodConfirmed(payload);
    onClose();

    toast({
      title: 'Alimento registrado',
      description: `${productName}: ${calculatedCarbs}g carbos`,
    });

    if (navigator.vibrate) {
      navigator.vibrate(200);
    }
  }, [
    pesoActual,
    productName,
    calculatedCarbs,
    calculatedKcal,
    carbsPer100g,
    proteinsPer100g,
    fatsPer100g,
    kcalPer100g,
    source,
    confidence,
    onFoodConfirmed,
    onClose,
    toast,
  ]);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Escanear Alimento</DialogTitle>
        </DialogHeader>

        {phase === 'mode-select' && (
          <div className="space-y-4">
            <p className="text-muted-foreground">Elige cómo escanear el alimento:</p>
            <div className="grid grid-cols-2 gap-4">
              <Button
                size="lg"
                variant="default"
                className="h-32 flex-col gap-2"
                onClick={() => {
                  setScanMode('barcode');
                  startBarcodeScanning();
                }}
              >
                <Barcode className="h-12 w-12" />
                <span>Código de Barras</span>
              </Button>
              <Button
                size="lg"
                variant="secondary"
                className="h-32 flex-col gap-2"
                onClick={() => {
                  setScanMode('ai');
                  startAIScanning();
                }}
              >
                <Camera className="h-12 w-12" />
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
                  <Progress value={scanProgress} className="h-2" />
                </div>
                <div id="barcode-reader" className="w-full" />
              </>
            ) : (
              <>
                <div className="bg-black/50 rounded-lg p-4 text-center text-white">
                  <p className="mb-2">Apunta al alimento y espera</p>
                  {loading && <Loader2 className="h-6 w-6 animate-spin mx-auto mt-2" />}
                </div>
                <video
                  ref={videoRef}
                  className="w-full rounded-lg"
                  autoPlay
                  playsInline
                  muted
                />
                <canvas ref={canvasRef} className="hidden" />
                <Button
                  onClick={captureAndAnalyze}
                  disabled={loading}
                  className="w-full"
                >
                  {loading ? 'Analizando...' : 'Capturar Ahora'}
                </Button>
              </>
            )}
            <Button variant="outline" onClick={() => setPhase('fallback')} className="w-full">
              Cancelar / Entrada Manual
            </Button>
          </div>
        )}

        {phase === 'preview' && (
          <div className="space-y-4">
            <Card className="p-4">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-semibold text-lg">{productName}</h3>
                  <Badge variant={source === 'ai' ? 'secondary' : 'default'}>
                    {source === 'barcode' ? 'De Barcode' : 'Estimado por IA'}
                  </Badge>
                </div>
                {source === 'ai' && (
                  <div className="text-right">
                    <p className="text-sm text-muted-foreground">Confianza</p>
                    <Progress value={confidence * 100} className="w-20 h-2" />
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Nombre</Label>
                  <Input
                    value={productName}
                    onChange={(e) => setProductName(e.target.value)}
                  />
                </div>
                <div>
                  <Label>Carbos / 100g</Label>
                  <Input
                    type="number"
                    value={carbsPer100g}
                    onChange={(e) => setCarbsPer100g(Number(e.target.value))}
                  />
                </div>
                <div>
                  <Label>Proteínas / 100g</Label>
                  <Input
                    type="number"
                    value={proteinsPer100g}
                    onChange={(e) => setProteinsPer100g(Number(e.target.value))}
                  />
                </div>
                <div>
                  <Label>Grasas / 100g</Label>
                  <Input
                    type="number"
                    value={fatsPer100g}
                    onChange={(e) => setFatsPer100g(Number(e.target.value))}
                  />
                </div>
              </div>
            </Card>

            <div className="flex gap-2">
              <Button onClick={handleStartWeighing} className="flex-1">
                Confirmar y Pesar
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setAttemptCount(0);
                  setPhase('mode-select');
                }}
              >
                Reescáner
              </Button>
            </div>
          </div>
        )}

        {phase === 'weighing' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Card className="p-4">
                <h3 className="font-semibold mb-2">Peso Actual</h3>
                <div className="text-3xl font-bold">{pesoActual}g</div>
                <p className="text-sm text-muted-foreground">
                  Δ {pesoActual - lastStableWeight > 0 ? '+' : ''}
                  {pesoActual - lastStableWeight}g
                </p>
              </Card>

              <Card className="p-4" aria-live="polite">
                <h3 className="font-semibold mb-2">Nutrición</h3>
                <div className="space-y-1">
                  <p className="text-lg">
                    <span className="font-bold">{calculatedCarbs}g</span> carbos
                  </p>
                  <p className="text-lg">
                    <span className="font-bold">{calculatedKcal}</span> kcal
                  </p>
                </div>
              </Card>
            </div>

            <div>
              <Label>Ajustar porción esperada (g)</Label>
              <Slider
                value={[expectedPortion]}
                onValueChange={([val]) => setExpectedPortion(val)}
                min={1}
                max={1000}
                step={1}
                className="mt-2"
              />
              <p className="text-sm text-muted-foreground mt-1">
                {expectedPortion}g
              </p>
            </div>

            <div className="flex gap-2">
              <Button onClick={handleConfirm} className="flex-1" disabled={pesoActual <= 0}>
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Aceptar
              </Button>
              <Button variant="outline" onClick={() => setPhase('preview')}>
                Volver
              </Button>
            </div>
          </div>
        )}

        {phase === 'fallback' && (
          <Tabs defaultValue="voice" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="voice">Voz</TabsTrigger>
              <TabsTrigger value="manual">Manual</TabsTrigger>
            </TabsList>

            <TabsContent value="voice" className="space-y-4">
              <div className="text-center p-8 border-2 border-dashed rounded-lg">
                <AlertCircle className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-muted-foreground">
                  Entrada por voz disponible próximamente
                </p>
                <p className="text-sm text-muted-foreground mt-2">
                  Usa la pestaña Manual para continuar
                </p>
              </div>
            </TabsContent>

            <TabsContent value="manual" className="space-y-4">
              <div className="space-y-4">
                <div>
                  <Label>Nombre del alimento</Label>
                  <Input
                    value={productName}
                    onChange={(e) => setProductName(e.target.value)}
                    placeholder="Ej: Manzana"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Carbos / 100g</Label>
                    <Input
                      type="number"
                      value={carbsPer100g || ''}
                      onChange={(e) => setCarbsPer100g(Number(e.target.value) || 0)}
                    />
                  </div>
                  <div>
                    <Label>Kcal / 100g</Label>
                    <Input
                      type="number"
                      value={kcalPer100g || ''}
                      onChange={(e) => setKcalPer100g(Number(e.target.value) || 0)}
                    />
                  </div>
                </div>

                <Button
                  onClick={() => {
                    setSource('manual');
                    handleStartWeighing();
                  }}
                  className="w-full"
                  disabled={!productName || carbsPer100g <= 0}
                >
                  Continuar a Pesar
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
