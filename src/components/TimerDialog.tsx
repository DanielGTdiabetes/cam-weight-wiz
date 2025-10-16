import { useState } from "react";
import { Play, X, Plus, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface TimerDialogProps {
  open: boolean;
  onClose: () => void;
  onStart: (seconds: number) => void;
}

export const TimerDialog = ({ open, onClose, onStart }: TimerDialogProps) => {
  const [minutes, setMinutes] = useState(5);
  const [seconds, setSeconds] = useState(0);

  const presets = [
    { label: "1 min", value: 60 },
    { label: "5 min", value: 300 },
    { label: "10 min", value: 600 },
    { label: "15 min", value: 900 },
  ];

  const handleStart = () => {
    const totalSeconds = minutes * 60 + seconds;
    if (totalSeconds > 0) {
      onStart(totalSeconds);
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-2xl">Configurar Temporizador</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Time Input */}
          <div className="flex items-center justify-center gap-4">
            <div className="flex flex-col items-center">
              <Button
                size="icon"
                variant="outline"
                onClick={() => setMinutes(Math.max(0, minutes - 1))}
                className="mb-2 h-12 w-12"
              >
                <Minus className="h-5 w-5" />
              </Button>
              <div className="text-center">
                <div className="text-5xl font-bold text-primary">{minutes}</div>
                <div className="text-sm text-muted-foreground">min</div>
              </div>
              <Button
                size="icon"
                variant="outline"
                onClick={() => setMinutes(Math.min(120, minutes + 1))}
                className="mt-2 h-12 w-12"
              >
                <Plus className="h-5 w-5" />
              </Button>
            </div>

            <div className="text-4xl font-bold text-muted-foreground">:</div>

            <div className="flex flex-col items-center">
              <Button
                size="icon"
                variant="outline"
                onClick={() => setSeconds(Math.max(0, seconds - 15))}
                className="mb-2 h-12 w-12"
              >
                <Minus className="h-5 w-5" />
              </Button>
              <div className="text-center">
                <div className="text-5xl font-bold text-primary">
                  {seconds.toString().padStart(2, "0")}
                </div>
                <div className="text-sm text-muted-foreground">seg</div>
              </div>
              <Button
                size="icon"
                variant="outline"
                onClick={() => setSeconds(Math.min(59, seconds + 15))}
                className="mt-2 h-12 w-12"
              >
                <Plus className="h-5 w-5" />
              </Button>
            </div>
          </div>

          {/* Presets */}
          <div className="grid grid-cols-4 gap-2">
            {presets.map((preset) => (
              <Button
                key={preset.value}
                variant="outline"
                size="lg"
                onClick={() => {
                  setMinutes(Math.floor(preset.value / 60));
                  setSeconds(preset.value % 60);
                }}
              >
                {preset.label}
              </Button>
            ))}
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <Button
              onClick={onClose}
              variant="outline"
              size="xl"
              className="flex-1"
            >
              <X className="mr-2 h-5 w-5" />
              Cancelar
            </Button>
            <Button
              onClick={handleStart}
              variant="glow"
              size="xl"
              className="flex-1"
              disabled={minutes === 0 && seconds === 0}
            >
              <Play className="mr-2 h-5 w-5" />
              Iniciar
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
