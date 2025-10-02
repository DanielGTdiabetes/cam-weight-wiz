import { useState, useEffect } from "react";
import { AlertTriangle, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useVoice } from "@/hooks/useVoice";

interface Mode1515DialogProps {
  glucose: number;
  onClose: () => void;
}

export const Mode1515Dialog = ({ glucose, onClose }: Mode1515DialogProps) => {
  const [timerSeconds, setTimerSeconds] = useState(15 * 60); // 15 minutes
  const [isRunning, setIsRunning] = useState(false);
  const { speak } = useVoice(true);

  useEffect(() => {
    // Announce the hypoglycemia
    speak(`Atención: Hipoglucemia detectada. Tu glucosa está en ${glucose} miligramos por decilitro. Sigue el protocolo 15/15.`);
  }, []);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isRunning && timerSeconds > 0) {
      interval = setInterval(() => {
        setTimerSeconds((s) => {
          if (s <= 1) {
            setIsRunning(false);
            speak("Han pasado 15 minutos. Por favor, mide tu glucosa nuevamente.");
            return 0;
          }
          return s - 1;
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isRunning, timerSeconds, speak]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handleStart = () => {
    setIsRunning(true);
    speak("Temporizador de 15 minutos iniciado");
  };

  const protocol = [
    "Consume 15g de carbohidratos rápidos",
    "Ejemplos: 3-4 tabletas de glucosa, 150ml de zumo, o 1 cucharada de miel",
    "Espera 15 minutos",
    "Vuelve a medir tu glucosa",
    "Si sigue baja, repite el proceso",
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm">
      <Card className="w-full max-w-2xl border-destructive/50 bg-destructive/5 p-8">
        <div className="mb-6 text-center">
          <div className="mb-4 flex justify-center">
            <div className="animate-pulse rounded-full bg-destructive/20 p-4">
              <AlertTriangle className="h-16 w-16 text-destructive" />
            </div>
          </div>
          <h2 className="mb-2 text-4xl font-bold text-destructive">
            ⚠️ HIPOGLUCEMIA
          </h2>
          <p className="text-2xl font-semibold">
            Glucosa: {glucose} mg/dl
          </p>
        </div>

        {/* Protocol */}
        <div className="mb-6 space-y-3">
          <h3 className="text-xl font-bold">Protocolo 15/15:</h3>
          {protocol.map((step, index) => (
            <div
              key={index}
              className="flex items-start gap-3 rounded-lg bg-muted/30 p-4"
            >
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-destructive/20 text-lg font-bold text-destructive">
                {index + 1}
              </div>
              <p className="text-lg">{step}</p>
            </div>
          ))}
        </div>

        {/* Timer */}
        {isRunning && (
          <div className="mb-6 text-center">
            <p className="mb-2 text-sm text-muted-foreground">
              Tiempo restante:
            </p>
            <p className="text-6xl font-bold text-destructive">
              {formatTime(timerSeconds)}
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="grid grid-cols-2 gap-4">
          <Button
            onClick={onClose}
            variant="outline"
            size="xl"
            className="text-xl"
          >
            <X className="mr-2 h-6 w-6" />
            Cancelar
          </Button>
          
          {!isRunning ? (
            <Button
              onClick={handleStart}
              variant="destructive"
              size="xl"
              className="text-xl"
            >
              <Check className="mr-2 h-6 w-6" />
              Iniciar Temporizador
            </Button>
          ) : (
            <Button
              onClick={() => setIsRunning(false)}
              variant="warning"
              size="xl"
              className="text-xl"
            >
              Pausar
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
};
