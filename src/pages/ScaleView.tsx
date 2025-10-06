import { useState, useEffect } from "react";
import { Scale, Droplets } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useScaleWebSocket } from "@/hooks/useScaleWebSocket";
import { api } from "@/services/api";
import { useToast } from "@/hooks/use-toast";
import { storage } from "@/services/storage";
import { isLocalClient } from "@/lib/network";
import { formatWeight } from "@/lib/format";
import { useScaleDecimals } from "@/hooks/useScaleDecimals";

interface ScaleViewProps {
  onNavigate: (view: string) => void;
}

export const ScaleView = ({ onNavigate }: ScaleViewProps) => {
  const { weight, isStable, unit, isConnected, error, reconnectAttempts, connectionState } = useScaleWebSocket();
  const [displayUnit, setDisplayUnit] = useState<"g" | "ml">("g");
  const decimals = useScaleDecimals();
  const [calibrationV2Enabled, setCalibrationV2Enabled] = useState(() => {
    try {
      return storage.getSettings().ui.flags.calibrationV2;
    } catch {
      return false;
    }
  });
  const { toast } = useToast();
  const localClient = isLocalClient();

  const statusLabelMap = {
    connected: "Conectado",
    reconnecting: "Reconectando",
    "no-data": "Sin datos",
  } as const;
  const statusColorMap = {
    connected: "bg-success",
    reconnecting: "bg-amber-500",
    "no-data": "bg-destructive",
  } as const;

  const statusLabel = statusLabelMap[connectionState];
  const statusDotClass = statusColorMap[connectionState];

  useEffect(() => {
    const handleStorageChange = () => {
      try {
        setCalibrationV2Enabled(storage.getSettings().ui.flags.calibrationV2);
      } catch {
        setCalibrationV2Enabled(false);
      }
    };

    if (typeof window === "undefined") {
      return;
    }

    window.addEventListener("storage", handleStorageChange);
    return () => {
      window.removeEventListener("storage", handleStorageChange);
    };
  }, []);

  useEffect(() => {
    if (error) {
      toast({
        title: "Error de conexión",
        description: error,
        variant: "destructive",
      });
    }
  }, [error, toast]);

  const handleTare = async () => {
    try {
      await api.scaleTare();
      toast({ title: calibrationV2Enabled ? "Tara aplicada" : "Tara realizada" });
    } catch (err) {
      toast({
        title: "Error",
        description: calibrationV2Enabled ? "No se pudo aplicar la tara" : "No se pudo realizar la tara",
        variant: "destructive",
      });
    }
  };

  const toggleUnit = () => {
    setDisplayUnit(prev => prev === "g" ? "ml" : "g");
    // Haptic feedback
    if (navigator.vibrate) {
      navigator.vibrate(30);
    }
  };

  // Display weight in selected unit
  const displayWeight = displayUnit === "ml" && unit === "g" 
    ? weight // Simple 1:1 conversion for water, can be improved
    : weight;

  return (
    <div className="flex h-full flex-col bg-background p-4">
      {/* Connection Status */}
      {connectionState !== "connected" && (
        <div className="mb-4 rounded-lg border-warning/50 bg-warning/10 p-3 text-center animate-fade-in">
          <p className="text-sm font-medium text-warning">
            {connectionState === "reconnecting"
              ? localClient && reconnectAttempts > 0
                ? `Reconectando... Intento ${reconnectAttempts}/10`
                : "Reconectando con la báscula..."
              : "Sin datos de la báscula"}
          </p>
        </div>
      )}

      {/* Weight Display - Pantalla grande y clara */}
      <Card className={cn(
        "relative mb-4 flex-1 overflow-hidden transition-smooth",
        isStable ? "border-success/50 glow-green" : "border-primary/30"
      )}>
        <div className="gradient-holographic absolute inset-0 opacity-30" />
        <div className="absolute right-4 top-4 flex items-center gap-2 rounded-full border border-border bg-background/80 px-3 py-1 text-sm font-medium shadow-sm backdrop-blur">
          <span className={cn("h-2.5 w-2.5 rounded-full", statusDotClass)} />
          <span>{statusLabel}</span>
        </div>
        <div className="relative flex h-full flex-col items-center justify-center">
          <div className={cn(
            "mb-3 rounded-full p-4 transition-smooth",
            isStable ? "bg-success/20" : "bg-primary/20"
          )}>
            <Scale className={cn(
              "h-12 w-12 transition-smooth",
              isStable ? "text-success" : "text-primary animate-pulse"
            )} />
          </div>
          
          <div
            className={cn(
              "mb-3 min-h-[140px] flex items-center text-8xl font-bold tracking-tight transition-smooth",
              isStable ? "text-success text-glow-green" : "text-primary text-glow-cyan"
            )}
            style={{ fontFeatureSettings: '"tnum"' }}
          >
            {formatWeight(displayWeight, decimals)}
          </div>
          
          <Button
            onClick={toggleUnit}
            variant="ghost"
            size="lg"
            className="text-2xl mb-2"
          >
            {displayUnit}
          </Button>
          
          <div className={cn(
            "inline-flex items-center gap-2 rounded-full px-4 py-2 text-base font-medium transition-smooth",
            isStable ? "bg-success/20 text-success" : "bg-primary/20 text-primary"
          )}>
            <span className={cn(
              "h-2 w-2 rounded-full",
              isStable ? "bg-success animate-pulse" : "bg-primary animate-pulse"
            )} />
            {isStable ? "Peso Estable" : "Estabilizando..."}
          </div>
        </div>
      </Card>

      {/* Control Buttons - Botones grandes para táctil */}
      <div className="grid grid-cols-2 gap-4">
        <Button
          onClick={handleTare}
          size="lg"
          variant="outline"
          disabled={!isConnected}
          className="h-16 text-xl"
        >
          {calibrationV2Enabled ? "Cero" : "TARA"}
        </Button>
        
        <Button
          onClick={toggleUnit}
          size="lg"
          variant="secondary"
          className="h-16 text-xl"
        >
          <Droplets className="mr-2 h-6 w-6" />
          g ↔ ml
        </Button>
      </div>
    </div>
  );
};
