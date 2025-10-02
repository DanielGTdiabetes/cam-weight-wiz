import { useState, useEffect } from "react";
import { Scale, Zap, Droplets } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface ScaleViewProps {
  onNavigate: (view: string) => void;
}

export const ScaleView = ({ onNavigate }: ScaleViewProps) => {
  const [weight, setWeight] = useState(0);
  const [isStable, setIsStable] = useState(false);
  const [unit, setUnit] = useState<"g" | "ml">("g");

  // Simulate weight from ESP32
  useEffect(() => {
    // TODO: Connect to WebSocket or API from Python backend
    const interval = setInterval(() => {
      const random = Math.random();
      setWeight(120 + (random * 10) - 5);
      setIsStable(random > 0.5);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleTare = () => {
    // TODO: Send tare command to backend
    console.log("Tara");
  };

  const handleZero = () => {
    // TODO: Send zero command to backend
    console.log("Zero");
  };

  const toggleUnit = () => {
    setUnit(prev => prev === "g" ? "ml" : "g");
  };

  return (
    <div className="flex h-screen flex-col bg-background p-4">
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
            {weight.toFixed(1)}
          </div>
          
          <Button
            onClick={toggleUnit}
            variant="ghost"
            size="xl"
            className="text-3xl"
          >
            {unit}
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
      <div className="grid grid-cols-3 gap-4">
        <Button
          onClick={handleTare}
          size="xl"
          variant="outline"
          className="h-24 text-2xl"
        >
          <Zap className="mr-2 h-8 w-8" />
          TARA
        </Button>
        
        <Button
          onClick={handleZero}
          size="xl"
          variant="outline"
          className="h-24 text-2xl"
        >
          <Scale className="mr-2 h-8 w-8" />
          ZERO
        </Button>
        
        <Button
          onClick={toggleUnit}
          size="xl"
          variant="secondary"
          className="h-24 text-2xl"
        >
          <Droplets className="mr-2 h-8 w-8" />
          g ↔ ml
        </Button>
      </div>
    </div>
  );
};
