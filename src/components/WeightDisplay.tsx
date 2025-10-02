import { Scale } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface WeightDisplayProps {
  weight: number;
  isStable: boolean;
  unit?: string;
}

export const WeightDisplay = ({ weight, isStable, unit = "g" }: WeightDisplayProps) => {
  return (
    <Card className={cn(
      "relative overflow-hidden transition-smooth",
      isStable ? "glow-green border-success/30" : "border-primary/20"
    )}>
      <div className="gradient-holographic absolute inset-0 opacity-50" />
      <div className="relative p-8 text-center">
        <div className="mb-4 flex justify-center">
          <div className={cn(
            "rounded-full p-4 transition-smooth",
            isStable ? "bg-success/20" : "bg-primary/20"
          )}>
            <Scale className={cn(
              "h-8 w-8 transition-smooth",
              isStable ? "text-success" : "text-primary animate-pulse"
            )} />
          </div>
        </div>
        
        <div className="space-y-2">
          <div className={cn(
            "text-6xl font-bold tracking-tight transition-smooth",
            isStable ? "text-success text-glow-cyan" : "text-primary text-glow-cyan"
          )}>
            {weight.toFixed(1)}
            <span className="ml-2 text-3xl font-normal text-muted-foreground">{unit}</span>
          </div>
          
          <div className={cn(
            "inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition-smooth",
            isStable 
              ? "bg-success/20 text-success" 
              : "bg-primary/20 text-primary"
          )}>
            <span className={cn(
              "h-2 w-2 rounded-full transition-smooth",
              isStable ? "bg-success animate-pulse" : "bg-primary animate-pulse"
            )} />
            {isStable ? "Peso Estable" : "Estabilizando..."}
          </div>
        </div>
      </div>
    </Card>
  );
};
