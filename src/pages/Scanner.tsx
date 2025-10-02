import { useState } from "react";
import { Camera, X, Scan, CheckCircle2 } from "lucide-react";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export const Scanner = () => {
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<any>(null);

  const handleScan = () => {
    setIsScanning(true);
    // Simulate scanning
    setTimeout(() => {
      setScanResult({
        name: "Manzana Roja",
        calories: 52,
        carbs: 14,
        protein: 0.3,
        fat: 0.2,
        confidence: 95,
      });
      setIsScanning(false);
    }, 2000);
  };

  const handleReset = () => {
    setScanResult(null);
    setIsScanning(false);
  };

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header 
        title="Escáner de Alimentos" 
        subtitle="Identifica alimentos con la cámara"
      />
      
      <main className="mx-auto max-w-screen-xl space-y-6 p-4">
        {/* Camera View */}
        <Card className="relative aspect-video overflow-hidden bg-muted">
          <div className="flex h-full items-center justify-center">
            {isScanning ? (
              <div className="text-center">
                <Scan className="mx-auto mb-4 h-12 w-12 animate-pulse text-primary" />
                <p className="text-lg font-medium">Analizando...</p>
              </div>
            ) : scanResult ? (
              <div className="text-center">
                <CheckCircle2 className="mx-auto mb-4 h-12 w-12 text-success glow-green" />
                <p className="text-lg font-medium text-success">¡Alimento Identificado!</p>
              </div>
            ) : (
              <div className="text-center text-muted-foreground">
                <Camera className="mx-auto mb-4 h-12 w-12" />
                <p>Posiciona el alimento frente a la cámara</p>
              </div>
            )}
          </div>
          
          {/* Scan overlay */}
          {isScanning && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="h-48 w-48 animate-pulse rounded-lg border-4 border-primary glow-cyan" />
            </div>
          )}
        </Card>

        {/* Scan Controls */}
        <div className="flex gap-4">
          {scanResult ? (
            <Button 
              onClick={handleReset} 
              variant="outline" 
              className="flex-1"
            >
              <X className="mr-2 h-4 w-4" />
              Nueva Escaneo
            </Button>
          ) : (
            <Button 
              onClick={handleScan} 
              disabled={isScanning}
              variant="glow"
              size="xl"
              className="flex-1"
            >
              <Scan className="mr-2 h-5 w-5" />
              {isScanning ? "Escaneando..." : "Escanear"}
            </Button>
          )}
        </div>

        {/* Results */}
        {scanResult && (
          <Card className="border-success/30 glow-green">
            <div className="p-6">
              <div className="mb-6 text-center">
                <h2 className="mb-2 text-2xl font-bold text-primary">
                  {scanResult.name}
                </h2>
                <p className="text-sm text-muted-foreground">
                  Confianza: {scanResult.confidence}%
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-lg bg-muted/30 p-4 text-center">
                  <p className="mb-1 text-sm text-muted-foreground">Calorías</p>
                  <p className="text-2xl font-bold text-warning">{scanResult.calories}</p>
                  <p className="text-xs text-muted-foreground">kcal/100g</p>
                </div>
                
                <div className="rounded-lg bg-muted/30 p-4 text-center">
                  <p className="mb-1 text-sm text-muted-foreground">Carbohidratos</p>
                  <p className="text-2xl font-bold text-primary">{scanResult.carbs}g</p>
                  <p className="text-xs text-muted-foreground">por 100g</p>
                </div>
                
                <div className="rounded-lg bg-muted/30 p-4 text-center">
                  <p className="mb-1 text-sm text-muted-foreground">Proteína</p>
                  <p className="text-2xl font-bold text-secondary">{scanResult.protein}g</p>
                  <p className="text-xs text-muted-foreground">por 100g</p>
                </div>
                
                <div className="rounded-lg bg-muted/30 p-4 text-center">
                  <p className="mb-1 text-sm text-muted-foreground">Grasa</p>
                  <p className="text-2xl font-bold text-success">{scanResult.fat}g</p>
                  <p className="text-xs text-muted-foreground">por 100g</p>
                </div>
              </div>

              <Button className="mt-6 w-full" variant="success">
                Guardar en Historial
              </Button>
            </div>
          </Card>
        )}
      </main>
    </div>
  );
};
