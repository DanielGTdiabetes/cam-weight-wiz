import { useState } from "react";
import { Syringe, Clock, AlertCircle, Send } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { storage } from "@/services/storage";
import { api } from "@/services/api";
import { useToast } from "@/hooks/use-toast";
import { logger } from "@/services/logger";

interface BolusCalculatorProps {
  totalCarbs: number;
  currentGlucose?: number;
  onClose: () => void;
}

export const BolusCalculator = ({ totalCarbs, currentGlucose, onClose }: BolusCalculatorProps) => {
  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);
  
  // Get user settings from storage
  const settings = storage.getSettings();
  const carbRatio = settings.carbRatio || 10;
  const correctionFactor = settings.correctionFactor || 30;
  const targetGlucose = settings.targetGlucose || 100;

  const carbsInsulin = totalCarbs / carbRatio;
  const correctionInsulin =
    typeof currentGlucose === "number"
      ? Math.max(0, (currentGlucose - targetGlucose) / correctionFactor)
      : 0;
  const totalInsulin = carbsInsulin + correctionInsulin;

  const getTimingRecommendation = () => {
    const highGI = totalCarbs > 50;
    if (highGI) {
      return "Inyectar 15 minutos ANTES de comer";
    }
    return "Inyectar JUSTO ANTES de comer";
  };

  const handleExportToNightscout = async () => {
    // Check if Nightscout is configured
    if (!settings.nightscoutUrl) {
      toast({
        title: "Nightscout no configurado",
        description: "Configura Nightscout en Ajustes → Diabetes",
        variant: "destructive",
      });
      return;
    }

    setIsExporting(true);
    try {
      const timestamp = new Date().toISOString();
      
      await api.exportBolus(
        totalCarbs,
        totalInsulin,
        timestamp
      );

      logger.info("Bolus exported to Nightscout", {
        carbs: totalCarbs,
        insulin: totalInsulin,
        glucose: currentGlucose,
      });

      toast({
        title: "¡Exportado a Nightscout!",
        description: `${totalCarbs}g HC → ${totalInsulin.toFixed(1)}U insulina`,
      });

      // Haptic feedback
      if (navigator.vibrate) {
        navigator.vibrate([50, 100, 50]);
      }

      onClose();
    } catch (error) {
      logger.error("Failed to export to Nightscout", { error });
      toast({
        title: "Error al exportar",
        description: "Verifica la configuración de Nightscout",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm">
      <Card className="w-full max-w-2xl border-primary/50 p-8 glow-cyan">
        <div className="mb-6 text-center">
          <div className="mb-4 flex justify-center">
            <div className="rounded-full bg-primary/20 p-4">
              <Syringe className="h-12 w-12 text-primary" />
            </div>
          </div>
          <h2 className="text-3xl font-bold">Recomendación de Bolo</h2>
        </div>

        {/* Warning */}
        <div className="mb-6 rounded-lg border-warning/50 bg-warning/5 p-4">
          <div className="flex gap-3">
            <AlertCircle className="h-6 w-6 flex-shrink-0 text-warning" />
            <p className="text-sm">
              <strong>AVISO:</strong> Esta es una estimación automatizada y NO debe tomarse como consejo médico. 
              Consulta siempre con tu endocrinólogo.
            </p>
          </div>
        </div>

        {/* Calculation Details */}
        <div className="mb-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-lg bg-muted/30 p-4">
              <p className="mb-1 text-sm text-muted-foreground">Total Carbohidratos</p>
              <p className="text-3xl font-bold text-warning">{totalCarbs.toFixed(1)}g</p>
            </div>
            
            {currentGlucose !== undefined && (
              <div className="rounded-lg bg-muted/30 p-4">
                <p className="mb-1 text-sm text-muted-foreground">Glucosa Actual</p>
                <p className="text-3xl font-bold text-primary">{currentGlucose} mg/dl</p>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Insulina por HC:</span>
              <span className="font-medium">{carbsInsulin.toFixed(1)}U</span>
            </div>
            {correctionInsulin > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Corrección:</span>
                <span className="font-medium">+{correctionInsulin.toFixed(1)}U</span>
              </div>
            )}
            <div className="border-t border-border pt-2 flex justify-between">
              <span className="font-bold">Total:</span>
              <span className="text-3xl font-bold text-primary">{totalInsulin.toFixed(1)}U</span>
            </div>
          </div>
        </div>

        {/* Timing Recommendation */}
        <div className="mb-6 rounded-lg bg-primary/10 p-6">
          <div className="flex items-center gap-3 mb-2">
            <Clock className="h-6 w-6 text-primary" />
            <h3 className="text-xl font-bold">Momento Recomendado</h3>
          </div>
          <p className="text-2xl font-semibold text-primary">
            {getTimingRecommendation()}
          </p>
        </div>

        {/* Actions */}
        <div className="grid grid-cols-2 gap-4">
          <Button
            onClick={onClose}
            variant="outline"
            size="xl"
            className="text-xl"
          >
            Cerrar
          </Button>
          <Button
            onClick={handleExportToNightscout}
            variant="success"
            size="xl"
            className="text-xl"
            disabled={isExporting}
          >
            {isExporting ? (
              "Exportando..."
            ) : (
              <>
                <Send className="mr-2 h-6 w-6" />
                Exportar a Nightscout
              </>
            )}
          </Button>
        </div>
      </Card>
    </div>
  );
};
