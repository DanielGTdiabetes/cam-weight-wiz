import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Scale, Weight, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { storage } from "@/services/storage";
import { useToast } from "@/hooks/use-toast";

interface CalibrationWizardProps {
  open: boolean;
  onClose: () => void;
  currentWeight?: number;
}

export const CalibrationWizard = ({ open, onClose, currentWeight = 0 }: CalibrationWizardProps) => {
  const [step, setStep] = useState(1);
  const [knownWeight, setKnownWeight] = useState("100");
  const [rawValue, setRawValue] = useState(0);
  const [calibrationFactor, setCalibrationFactor] = useState(0);
  const { toast } = useToast();

  const resetWizard = () => {
    setStep(1);
    setKnownWeight("100");
    setRawValue(0);
    setCalibrationFactor(0);
  };

  const handleZero = async () => {
    try {
      await api.scaleZero();
      // Haptic feedback
      if (navigator.vibrate) {
        navigator.vibrate([30, 50, 30]);
      }
      setStep(2);
    } catch (error) {
      toast({
        title: "Error",
        description: "No se pudo realizar el zero",
        variant: "destructive",
      });
    }
  };

  const handleMeasure = () => {
    // In a real implementation, this would read from the scale
    // For now, we use the current weight as the raw value
    setRawValue(currentWeight);
    
    const known = parseFloat(knownWeight);
    if (known > 0 && currentWeight > 0) {
      const factor = currentWeight / known;
      setCalibrationFactor(factor);
      setStep(3);
    } else {
      toast({
        title: "Error",
        description: "Coloca el peso conocido en la báscula",
        variant: "destructive",
      });
    }
  };

  const handleSave = async () => {
    try {
      await api.setCalibrationFactor(calibrationFactor);
      storage.saveSettings({ calibrationFactor });
      
      toast({
        title: "¡Calibración completada!",
        description: `Factor de calibración: ${calibrationFactor.toFixed(4)}`,
      });

      // Haptic feedback
      if (navigator.vibrate) {
        navigator.vibrate([50, 100, 50, 100, 50]);
      }

      resetWizard();
      onClose();
    } catch (error) {
      toast({
        title: "Error",
        description: "No se pudo guardar la calibración",
        variant: "destructive",
      });
    }
  };

  const progress = (step / 3) * 100;

  return (
    <Dialog open={open} onOpenChange={(open) => {
      if (!open) {
        resetWizard();
        onClose();
      }
    }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-2xl flex items-center gap-2">
            <Scale className="h-6 w-6" />
            Asistente de Calibración
          </DialogTitle>
        </DialogHeader>

        <Progress value={progress} className="mb-4" />

        {/* Step 1: Zero */}
        {step === 1 && (
          <Card className="p-6">
            <div className="text-center space-y-6">
              <div className="flex justify-center">
                <div className="rounded-full bg-primary/20 p-6">
                  <Scale className="h-16 w-16 text-primary" />
                </div>
              </div>
              
              <div>
                <h3 className="text-2xl font-bold mb-2">Paso 1: Zero</h3>
                <p className="text-muted-foreground">
                  Retira todos los objetos de la báscula y presiona "Hacer Zero"
                </p>
              </div>

              <div className={cn(
                "text-6xl font-bold",
                currentWeight === 0 ? "text-success" : "text-warning"
              )}>
                {currentWeight.toFixed(1)} g
              </div>

              <Button
                onClick={handleZero}
                size="xxl"
                variant="glow"
                disabled={currentWeight > 5}
                className="w-full"
              >
                Hacer Zero
              </Button>

              {currentWeight > 5 && (
                <p className="text-sm text-warning">
                  ⚠️ Retira todos los objetos primero
                </p>
              )}
            </div>
          </Card>
        )}

        {/* Step 2: Known Weight */}
        {step === 2 && (
          <Card className="p-6">
            <div className="space-y-6">
              <div className="text-center">
                <div className="flex justify-center mb-4">
                  <div className="rounded-full bg-secondary/20 p-6">
                    <Weight className="h-16 w-16 text-secondary" />
                  </div>
                </div>
                
                <h3 className="text-2xl font-bold mb-2">Paso 2: Peso Conocido</h3>
                <p className="text-muted-foreground">
                  Coloca un peso conocido en la báscula
                </p>
              </div>

              <div className="space-y-3">
                <Label className="text-lg">Peso conocido (gramos)</Label>
                <Input
                  type="number"
                  value={knownWeight}
                  onChange={(e) => setKnownWeight(e.target.value)}
                  className="text-2xl h-16 text-center"
                  placeholder="100"
                />
                <p className="text-sm text-muted-foreground text-center">
                  Usa una moneda de 2€ (8.5g) o una pesa de cocina
                </p>
              </div>

              <div className="text-center">
                <p className="text-sm text-muted-foreground mb-2">Lectura actual:</p>
                <div className="text-5xl font-bold text-primary">
                  {currentWeight.toFixed(1)} g
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Button
                  onClick={() => setStep(1)}
                  size="lg"
                  variant="outline"
                >
                  Atrás
                </Button>
                <Button
                  onClick={handleMeasure}
                  size="lg"
                  variant="glow"
                  disabled={parseFloat(knownWeight) <= 0 || currentWeight <= 0}
                >
                  Medir
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* Step 3: Save */}
        {step === 3 && (
          <Card className="p-6">
            <div className="text-center space-y-6">
              <div className="flex justify-center">
                <div className="rounded-full bg-success/20 p-6">
                  <Check className="h-16 w-16 text-success" />
                </div>
              </div>
              
              <div>
                <h3 className="text-2xl font-bold mb-2">¡Calibración Lista!</h3>
                <p className="text-muted-foreground">
                  Verifica los resultados antes de guardar
                </p>
              </div>

              <div className="space-y-4 bg-muted p-4 rounded-lg">
                <div>
                  <p className="text-sm text-muted-foreground">Peso conocido:</p>
                  <p className="text-2xl font-bold">{knownWeight} g</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Valor medido:</p>
                  <p className="text-2xl font-bold">{rawValue.toFixed(1)} g</p>
                </div>
                <div className="border-t border-border pt-4">
                  <p className="text-sm text-muted-foreground">Factor de calibración:</p>
                  <p className="text-3xl font-bold text-primary">
                    {calibrationFactor.toFixed(4)}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Button
                  onClick={() => setStep(2)}
                  size="lg"
                  variant="outline"
                >
                  Repetir
                </Button>
                <Button
                  onClick={handleSave}
                  size="lg"
                  variant="success"
                >
                  <Check className="mr-2" />
                  Guardar
                </Button>
              </div>
            </div>
          </Card>
        )}
      </DialogContent>
    </Dialog>
  );
};
