import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Play, Pause, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useNavSafeExit } from "@/hooks/useNavSafeExit";

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

interface TimerFullViewProps {
  context?: "page" | "modal";
  onClose?: () => void;
}

export const TimerFullView = ({ context = "page", onClose }: TimerFullViewProps = {}) => {
  const { navEnabled, isTouchDevice, goBack, handleClose, isModal } = useNavSafeExit({
    context,
    onClose,
  });
  const [seconds, setSeconds] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [inputMinutes, setInputMinutes] = useState(5);
  const [showPresets, setShowPresets] = useState(true);
  const audioContextRef = useRef<AudioContext | null>(null);
  const completionTriggeredRef = useRef(false);

  useEffect(() => () => {
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close();
      } catch (error) {
        console.error("Error closing audio context", error);
      }
    }
  }, []);

  const playAlarm = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextClass) {
      return;
    }
    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      audioContextRef.current = new AudioContextClass();
    }
    const context = audioContextRef.current;
    if (!context) {
      return;
    }
    if (context.state === "suspended") {
      void context.resume().catch(() => undefined);
    }
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, context.currentTime);
    gain.gain.setValueAtTime(0.0001, context.currentTime);

    oscillator.connect(gain);
    gain.connect(context.destination);

    oscillator.start();
    gain.gain.exponentialRampToValueAtTime(0.25, context.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 1.4);
    oscillator.stop(context.currentTime + 1.5);
  }, []);

  const triggerCompletionFeedback = useCallback(() => {
    if (completionTriggeredRef.current) {
      return;
    }
    completionTriggeredRef.current = true;
    playAlarm();
    void api.speak("Temporizador finalizado").catch(() => undefined);
  }, [playAlarm]);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isRunning && seconds > 0) {
      interval = setInterval(() => {
        setSeconds((s) => {
          if (s <= 1) {
            setIsRunning(false);
            triggerCompletionFeedback();
            return 0;
          }
          return s - 1;
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isRunning, seconds, triggerCompletionFeedback]);

  const handleStart = (mins?: number) => {
    completionTriggeredRef.current = false;
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

  useEffect(() => {
    if (!isRunning && seconds === 0) {
      completionTriggeredRef.current = false;
    }
  }, [isRunning, seconds]);

  const handleReset = () => {
    completionTriggeredRef.current = false;
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

  const navControls = navEnabled ? (
    <div className="flex items-center gap-2 p-4">
      <Button variant="outline" onClick={goBack} className="gap-2">
        <ArrowLeft className="h-4 w-4" />
        Atrás
      </Button>
      {isModal && (
        <Button variant="ghost" onClick={handleClose} className="gap-2">
          <X className="h-4 w-4" />
          Cerrar
        </Button>
      )}
    </div>
  ) : null;

  const setupView = (
    <div className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-2xl max-h-[560px] overflow-y-auto p-5">
        <h2 className="mb-4 text-center text-2xl font-bold leading-tight">
          Configurar Temporizador
        </h2>

        {/* Entrada manual */}
        <div className="mb-4 space-y-3">
          <div className="text-center">
            <p className="mb-2 text-base text-muted-foreground">Minutos</p>
            <div className="mx-auto w-48 rounded-lg border-2 border-primary/30 bg-card p-3">
              <p className="text-4xl font-bold text-primary">
                {customInput || "0"}
              </p>
            </div>
          </div>

          {/* Teclado numérico */}
          <div className="mx-auto max-w-sm">
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
                          size="lg"
                          onClick={handleBackspace}
                          className="h-12 text-lg"
                        >
                          ←
                        </Button>
                      );
                    }

                    return (
                      <Button
                        key={keyIndex}
                        variant="outline"
                        size="lg"
                        onClick={() => handleKeyPress(key)}
                        className="h-12 text-lg font-bold"
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
                size="lg"
                onClick={handleClearInput}
                className="h-12 text-base"
              >
                Borrar
              </Button>
              <Button
                variant="glow"
                size="lg"
                onClick={handleStartCustom}
                className="h-12 text-base"
                disabled={!customInput || parseInt(customInput) === 0}
              >
                Iniciar
              </Button>
            </div>
          </div>
        </div>

        {/* Presets */}
        <div className="border-t border-border pt-4">
          <p className="mb-3 text-center text-base text-muted-foreground">O elige un preset:</p>
          <div className="grid grid-cols-3 gap-2">
            {presets.map((preset) => (
              <Button
                key={preset.value}
                onClick={() => handleStart(preset.value)}
                variant="outline"
                className="h-14 text-base"
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );

  const runningView = (
    <div className="flex flex-1 items-center justify-center p-4">
      <Card className="relative w-full max-w-xl max-h-[560px] overflow-hidden border-primary/30 p-6 glow-cyan">
        <div className="gradient-holographic absolute inset-0 opacity-20" />

        <div className="relative text-center">
          {/* Timer Display */}
          <div className="mb-4">
            <div className={cn(
              "mb-3 text-7xl font-bold tracking-tight transition-smooth",
              isRunning ? "text-primary text-glow-cyan" : "text-muted-foreground"
            )}>
              {formatTime(seconds)}
            </div>
          </div>

          {/* Progress Ring */}
          <div className="mx-auto mb-4 h-48 w-48">
            <svg className="h-full w-full -rotate-90 transform">
              <circle
                cx="96"
                cy="96"
                r="88"
                stroke="currentColor"
                strokeWidth="12"
                fill="none"
                className="text-muted"
              />
              <circle
                cx="96"
                cy="96"
                r="88"
                stroke="currentColor"
                strokeWidth="12"
                fill="none"
                strokeDasharray={`${2 * Math.PI * 88}`}
                strokeDashoffset={`${2 * Math.PI * 88 * (1 - progress / 100)}`}
                className={cn(
                  "transition-all duration-1000",
                  isRunning ? "text-primary" : "text-warning"
                )}
                strokeLinecap="round"
              />
            </svg>
          </div>

          {/* Control Buttons */}
          <div className="flex justify-center gap-3">
            <Button
              onClick={handlePause}
              size="lg"
              variant={isRunning ? "warning" : "glow"}
              className="h-14 w-32 text-base"
            >
              {isRunning ? (
                <>
                  <Pause className="mr-2 h-5 w-5" />
                  Pausar
                </>
              ) : (
                <>
                  <Play className="mr-2 h-5 w-5" />
                  Reanudar
                </>
              )}
            </Button>
            <Button
              onClick={handleReset}
              size="lg"
              variant="outline"
              className="h-14 w-32 text-base"
            >
              <RotateCcw className="mr-2 h-5 w-5" />
              Reiniciar
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );

  return (
    <div className="relative flex h-full flex-col">
      {navControls}
      {showPresets ? setupView : runningView}
      {navEnabled && isTouchDevice && (
        <Button
          variant="glow"
          size="lg"
          onClick={goBack}
          className="fixed bottom-6 right-6 z-50 rounded-full px-6 py-6 shadow-lg"
        >
          Salir
        </Button>
      )}
    </div>
  );
};
