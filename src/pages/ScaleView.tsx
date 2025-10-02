import { useState, useEffect } from "react";
import { Scale, Zap, Droplets, History, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useScaleWebSocket } from "@/hooks/useScaleWebSocket";
import { useWeightHistory } from "@/hooks/useWeightHistory";
import { api } from "@/services/api";
import { useToast } from "@/hooks/use-toast";
import { WeightHistoryDialog } from "@/components/WeightHistoryDialog";

interface ScaleViewProps {
  onNavigate: (view: string) => void;
}

export const ScaleView = ({ onNavigate }: ScaleViewProps) => {
  const { weight, isStable, unit, isConnected, error, reconnectAttempts } = useScaleWebSocket();
  const { addRecord } = useWeightHistory();
  const [displayUnit, setDisplayUnit] = useState<"g" | "ml">("g");
  const [showHistory, setShowHistory] = useState(false);
  const { toast } = useToast();

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
      toast({ title: "Tara realizada" });
    } catch (err) {
      toast({
        title: "Error",
        description: "No se pudo realizar la tara",
        variant: "destructive",
      });
    }
  };

  const handleZero = async () => {
    try {
      await api.scaleZero();
      toast({ title: "Zero realizado" });
    } catch (err) {
      toast({
        title: "Error",
        description: "No se pudo realizar el zero",
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

  const handleSaveWeight = () => {
    if (weight > 0) {
      addRecord(displayWeight, displayUnit, isStable);
      toast({ 
        title: "Guardado", 
        description: `Peso: ${displayWeight.toFixed(1)} ${displayUnit}` 
      });
      // Haptic feedback
      if (navigator.vibrate) {
        navigator.vibrate([30, 50, 30]);
      }
    }
  };

  // Display weight in selected unit
  const displayWeight = displayUnit === "ml" && unit === "g" 
    ? weight // Simple 1:1 conversion for water, can be improved
    : weight;

  return (
    <div className="flex h-full flex-col bg-background p-4">
      {/* Connection Status */}
      {!isConnected && (
        <div className="mb-4 rounded-lg border-warning/50 bg-warning/10 p-3 text-center animate-fade-in">
          <p className="text-sm font-medium text-warning">
            {reconnectAttempts > 0 
              ? `Reconectando... Intento ${reconnectAttempts}/10`
              : 'Conectando con la báscula...'
            }
          </p>
        </div>
      )}

      {/* Weight Display - Pantalla grande y clara */}
      <Card className={cn(
        "relative mb-6 flex-1 overflow-hidden transition-smooth",
        isStable ? "border-success/50 glow-green" : "border-primary/30"
      )}>
        <div className="gradient-holographic absolute inset-0 opacity-30" />
        <div className="relative flex h-full flex-col items-center justify-center">
          <div className={cn(
            "mb-4 rounded-full p-6 transition-smooth",
            isStable ? "bg-success/20" : "bg-primary/20"
          )}>
            <Scale className={cn(
              "h-16 w-16 transition-smooth",
              isStable ? "text-success" : "text-primary animate-pulse"
            )} />
          </div>
          
          <div className={cn(
            "mb-4 text-9xl font-bold tracking-tight transition-smooth",
            isStable ? "text-success text-glow-green" : "text-primary text-glow-cyan"
          )}>
            {displayWeight.toFixed(1)}
          </div>
          
          <Button
            onClick={toggleUnit}
            variant="ghost"
            size="xl"
            className="text-3xl"
          >
            {displayUnit}
          </Button>
          
          <div className={cn(
            "mt-4 inline-flex items-center gap-3 rounded-full px-6 py-3 text-xl font-medium transition-smooth",
            isStable ? "bg-success/20 text-success" : "bg-primary/20 text-primary"
          )}>
            <span className={cn(
              "h-3 w-3 rounded-full",
              isStable ? "bg-success animate-pulse" : "bg-primary animate-pulse"
            )} />
            {isStable ? "Peso Estable" : "Estabilizando..."}
          </div>
        </div>
      </Card>

      {/* Control Buttons - Botones grandes para táctil */}
      <div className="grid grid-cols-2 gap-5 mb-5">
        <Button
          onClick={handleTare}
          size="xxl"
          variant="outline"
          disabled={!isConnected}
        >
          <Zap className="mr-3" />
          TARA
        </Button>
        
        <Button
          onClick={handleZero}
          size="xxl"
          variant="outline"
          disabled={!isConnected}
        >
          <Scale className="mr-3" />
          ZERO
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-5">
        <Button
          onClick={toggleUnit}
          size="xxl"
          variant="secondary"
        >
          <Droplets className="mr-3" />
          g ↔ ml
        </Button>

        <Button
          onClick={handleSaveWeight}
          size="xxl"
          variant="success"
          disabled={weight === 0}
        >
          <Save className="mr-3" />
          Guardar
        </Button>

        <Button
          onClick={() => setShowHistory(true)}
          size="xxl"
          variant="outline"
        >
          <History className="mr-3" />
          Historial
        </Button>
      </div>

      <WeightHistoryDialog 
        open={showHistory}
        onClose={() => setShowHistory(false)}
      />
    </div>
  );
};
