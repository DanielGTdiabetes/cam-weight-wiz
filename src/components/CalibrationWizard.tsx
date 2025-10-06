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
import { formatWeight } from "@/lib/format";
import { useScaleDecimals } from "@/hooks/useScaleDecimals";

interface CalibrationWizardProps {
  open: boolean;
  onClose: () => void;
  currentWeight?: number;
  isCalibrationV2?: boolean;
}

interface CalibrationWizardBaseProps {
  open: boolean;
  onClose: () => void;
  currentWeight: number;
}

const CalibrationWizardV2 = ({ open, onClose, currentWeight }: CalibrationWizardBaseProps) => {
  const [step, setStep] = useState<1 | 2>(1);
  const [referenceWeight, setReferenceWeight] = useState("100");
  const [isApplying, setIsApplying] = useState(false);
  const { toast } = useToast();
  const decimals = useScaleDecimals();

  const resetWizard = () => {
    setStep(1);
    setReferenceWeight("100");
    setIsApplying(false);
  };

  const totalSteps = 2;
  const progress = ((step - 1) / (totalSteps - 1)) * 100;
  const parsedReference = parseFloat(referenceWeight);
  const referenceValid = Number.isFinite(parsedReference) && parsedReference > 0;
  const hasReferenceOnScale = Math.abs(currentWeight) > 0.05;

  const handleApply = async () => {
    if (!referenceValid) {
      toast({
        title: "Peso inválido",
        description: "Introduce un peso de referencia mayor a 0 g.",
        variant: "destructive",
      });
      return;
    }

    setIsApplying(true);
    try {
      const response = await api.applyCalibration(parsedReference);
      if (response.ok) {
        if (typeof response.calibration_factor === "number" && Number.isFinite(response.calibration_factor)) {
          storage.saveSettings({ calibrationFactor: response.calibration_factor });
        }

        toast({
          title: "Calibración aplicada",
          description: response.message ?? `Referencia registrada: ${formatWeight(parsedReference, decimals)} g`,
        });

        if (navigator.vibrate) {
          navigator.vibrate([40, 60, 40]);
        }

        resetWizard();
        onClose();
      } else {
        toast({
          title: "Error",
          description: response.message ?? "No se pudo aplicar la calibración",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "No se pudo aplicar la calibración",
        variant: "destructive",
      });
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(dialogOpen) => {
        if (!dialogOpen) {
          resetWizard();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-2xl">
            <Scale className="h-6 w-6" />
            Asistente de Calibración
          </DialogTitle>
        </DialogHeader>

        <Progress value={Number.isFinite(progress) ? progress : 0} className="mb-4" />

        {step === 1 ? (
          <Card className="p-6">
            <div className="space-y-6 text-center">
              <div className="flex justify-center">
                <div className="rounded-full bg-primary/20 p-6">
                  <Weight className="h-16 w-16 text-primary" />
                </div>
              </div>

              <div className="space-y-2">
                <h3 className="text-2xl font-bold">Paso 1: Coloca el peso de referencia</h3>
                <p className="text-muted-foreground">
                  Asegúrate de que la báscula marque el peso estable antes de continuar.
                </p>
                <p className="text-sm text-muted-foreground">
                  Usa el botón <span className="font-semibold text-foreground">Cero</span> si necesitas ajustar la tara antes de
                  colocar el peso.
                </p>
              </div>

              <div
                className={cn("text-6xl font-bold", hasReferenceOnScale ? "text-primary" : "text-muted-foreground")}
                style={{ fontFeatureSettings: '"tnum"' }}
              >
                {formatWeight(currentWeight, decimals)} g
              </div>

              {!hasReferenceOnScale && (
                <p className="text-sm text-warning">
                  Espera a que la báscula detecte el peso de referencia.
                </p>
              )}

              <Button
                onClick={() => setStep(2)}
                size="xxl"
                variant="glow"
                className="w-full"
              >
                Continuar
              </Button>
            </div>
          </Card>
        ) : (
          <Card className="p-6">
            <div className="space-y-6">
              <div className="space-y-2 text-center">
                <div className="flex justify-center">
                  <div className="rounded-full bg-secondary/20 p-6">
                    <Scale className="h-16 w-16 text-secondary" />
                  </div>
                </div>
                <h3 className="text-2xl font-bold">Paso 2: Introduce el peso exacto</h3>
                <p className="text-muted-foreground">
                  Escribe el valor en gramos de tu peso de referencia para aplicar la calibración.
                </p>
              </div>

              <div className="space-y-3">
                <Label className="text-lg">Peso de referencia (g)</Label>
                <Input
                  type="number"
                  value={referenceWeight}
                  onChange={(event) => setReferenceWeight(event.target.value)}
                  className="h-16 text-center text-2xl"
                  placeholder="100"
                  min="0"
                />
                <p className="text-sm text-muted-foreground text-center">
                  Ejemplo: pesa calibrada de 100 g o cualquier referencia certificada.
                </p>
              </div>

              <div className="text-center">
                <p className="mb-2 text-sm text-muted-foreground">Lectura actual</p>
                <div
                  className="text-5xl font-bold text-primary"
                  style={{ fontFeatureSettings: '"tnum"' }}
                >
                  {formatWeight(currentWeight, decimals)} g
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Button onClick={() => setStep(1)} size="lg" variant="outline" disabled={isApplying}>
                  Atrás
                </Button>
                <Button
                  onClick={handleApply}
                  size="lg"
                  variant="glow"
                  className="flex items-center justify-center"
                  disabled={isApplying || !referenceValid}
                >
                  {isApplying ? "Aplicando..." : "Aplicar"}
                </Button>
              </div>
            </div>
          </Card>
        )}
      </DialogContent>
    </Dialog>
  );
};

const CalibrationWizardLegacy = ({ open, onClose, currentWeight }: CalibrationWizardBaseProps) => {
  const [step, setStep] = useState(1);
  const [knownWeight, setKnownWeight] = useState("100");
  const [rawValue, setRawValue] = useState(0);
  const [calibrationFactor, setCalibrationFactor] = useState(0);
  const { toast } = useToast();
  const decimals = useScaleDecimals();

  const resetWizard = () => {
    setStep(1);
    setKnownWeight("100");
    setRawValue(0);
    setCalibrationFactor(0);
  };

  const handleZero = async () => {
    try {
      await api.scaleZero();
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
    <Dialog
      open={open}
      onOpenChange={(dialogOpen) => {
        if (!dialogOpen) {
          resetWizard();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-2xl flex items-center gap-2">
            <Scale className="h-6 w-6" />
            Asistente de Calibración
          </DialogTitle>
        </DialogHeader>

        <Progress value={progress} className="mb-4" />

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

              <div
                className={cn(
                  "text-6xl font-bold",
                  currentWeight === 0 ? "text-success" : "text-warning"
                )}
                style={{ fontFeatureSettings: '"tnum"' }}
              >
                {formatWeight(currentWeight, decimals)} g
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
                <div
                  className="text-5xl font-bold text-primary"
                  style={{ fontFeatureSettings: '"tnum"' }}
                >
                  {formatWeight(currentWeight, decimals)} g
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
                  <p className="text-2xl font-bold" style={{ fontFeatureSettings: '"tnum"' }}>
                    {formatWeight(rawValue, decimals)} g
                  </p>
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

export const CalibrationWizard = ({
  open,
  onClose,
  currentWeight = 0,
  isCalibrationV2 = false,
}: CalibrationWizardProps) => {
  if (isCalibrationV2) {
    return <CalibrationWizardV2 open={open} onClose={onClose} currentWeight={currentWeight} />;
  }

  return <CalibrationWizardLegacy open={open} onClose={onClose} currentWeight={currentWeight} />;
};
