import { useState, useEffect } from "react";
import { Play, Pause, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const TimerFullView = () => {
  const [seconds, setSeconds] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [inputMinutes, setInputMinutes] = useState(5);
  const [showPresets, setShowPresets] = useState(true);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isRunning && seconds > 0) {
      interval = setInterval(() => {
        setSeconds((s) => {
          if (s <= 1) {
            setIsRunning(false);
            // TODO: Play alarm sound + voice if enabled
            return 0;
          }
          return s - 1;
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isRunning, seconds]);

  const handleStart = (mins?: number) => {
    if (mins !== undefined) {
      setSeconds(mins * 60);
      setInputMinutes(mins);
      setShowPresets(false);
    } else if (seconds === 0) {
      setSeconds(inputMinutes * 60);
      setShowPresets(false);
    }
    setIsRunning(true);
  };

  const handlePause = () => {
    setIsRunning(!isRunning);
  };

  const handleReset = () => {
    setSeconds(0);
    setIsRunning(false);
    setShowPresets(true);
  };

  const formatTime = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const progress = seconds > 0 && inputMinutes > 0 
    ? (seconds / (inputMinutes * 60)) * 100 
    : 0;

  const [customInput, setCustomInput] = useState("");

  const handleKeyPress = (key: string) => {
    if (customInput.length < 4) {
      setCustomInput(customInput + key);
    }
  };

  const handleBackspace = () => {
    setCustomInput(customInput.slice(0, -1));
  };

  const handleClearInput = () => {
    setCustomInput("");
  };

  const handleStartCustom = () => {
    const mins = parseInt(customInput) || 0;
    if (mins > 0) {
      handleStart(mins);
      setCustomInput("");
    }
  };

  const presets = [
    { label: "1 min", value: 1 },
    { label: "5 min", value: 5 },
    { label: "10 min", value: 10 },
    { label: "15 min", value: 15 },
    { label: "30 min", value: 30 },
    { label: "60 min", value: 60 },
  ];

  if (showPresets) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Card className="w-full max-w-3xl p-8">
          <h2 className="mb-8 text-center text-4xl font-bold">
            Configurar Temporizador
          </h2>
          
          {/* Entrada manual */}
          <div className="mb-8 space-y-4">
            <div className="text-center">
              <p className="mb-2 text-lg text-muted-foreground">Minutos</p>
              <div className="mx-auto w-64 rounded-lg border-2 border-primary/30 bg-card p-4">
                <p className="text-5xl font-bold text-primary">
                  {customInput || "0"}
                </p>
              </div>
            </div>
            
            {/* Teclado numérico */}
            <div className="mx-auto max-w-xs">
              <div className="grid gap-2">
                {[["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["", "0", "⌫"]].map((row, rowIndex) => (
                  <div key={rowIndex} className="grid grid-cols-3 gap-2">
                    {row.map((key, keyIndex) => {
                      if (!key) return <div key={keyIndex} />;
                      
                      if (key === "⌫") {
                        return (
                          <Button
                            key={keyIndex}
                            variant="outline"
                            size="xl"
                            onClick={handleBackspace}
                            className="h-16 text-2xl"
                          >
                            ←
                          </Button>
                        );
                      }

                      return (
                        <Button
                          key={keyIndex}
                          variant="outline"
                          size="xl"
                          onClick={() => handleKeyPress(key)}
                          className="h-16 text-2xl font-bold"
                        >
                          {key}
                        </Button>
                      );
                    })}
                  </div>
                ))}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Button
                  variant="destructive"
                  size="xl"
                  onClick={handleClearInput}
                  className="h-16 text-xl"
                >
                  Borrar
                </Button>
                <Button
                  variant="glow"
                  size="xl"
                  onClick={handleStartCustom}
                  className="h-16 text-xl"
                  disabled={!customInput || parseInt(customInput) === 0}
                >
                  Iniciar
                </Button>
              </div>
            </div>
          </div>

          {/* Presets */}
          <div className="border-t border-border pt-6">
            <p className="mb-4 text-center text-lg text-muted-foreground">O elige un preset:</p>
            <div className="grid grid-cols-3 gap-4">
              {presets.map((preset) => (
                <Button
                  key={preset.value}
                  onClick={() => handleStart(preset.value)}
                  variant="outline"
                  className="h-20 text-xl"
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center p-8">
      <Card className="relative w-full max-w-2xl overflow-hidden border-primary/30 p-12 glow-cyan">
        <div className="gradient-holographic absolute inset-0 opacity-20" />
        
        <div className="relative text-center">
          {/* Timer Display */}
          <div className="mb-8">
            <div className={cn(
              "mb-6 text-9xl font-bold tracking-tight transition-smooth",
              isRunning ? "text-primary text-glow-cyan" : "text-muted-foreground"
            )}>
              {formatTime(seconds)}
            </div>
          </div>

          {/* Progress Ring */}
          <div className="mx-auto mb-8 h-64 w-64">
            <svg className="h-full w-full -rotate-90 transform">
              <circle
                cx="128"
                cy="128"
                r="120"
                stroke="currentColor"
                strokeWidth="16"
                fill="none"
                className="text-muted"
              />
              <circle
                cx="128"
                cy="128"
                r="120"
                stroke="currentColor"
                strokeWidth="16"
                fill="none"
                strokeDasharray={`${2 * Math.PI * 120}`}
                strokeDashoffset={`${2 * Math.PI * 120 * (1 - progress / 100)}`}
                className={cn(
                  "transition-all duration-1000",
                  isRunning ? "text-primary" : "text-warning"
                )}
                strokeLinecap="round"
              />
            </svg>
          </div>

          {/* Control Buttons */}
          <div className="flex justify-center gap-4">
            <Button
              onClick={handlePause}
              size="xl"
              variant={isRunning ? "warning" : "glow"}
              className="h-20 w-40 text-xl"
            >
              {isRunning ? (
                <>
                  <Pause className="mr-2 h-6 w-6" />
                  Pausar
                </>
              ) : (
                <>
                  <Play className="mr-2 h-6 w-6" />
                  Reanudar
                </>
              )}
            </Button>
            <Button
              onClick={handleReset}
              size="xl"
              variant="outline"
              className="h-20 w-40 text-xl"
            >
              <RotateCcw className="mr-2 h-6 w-6" />
              Reiniciar
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
};
