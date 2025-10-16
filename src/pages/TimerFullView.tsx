import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Play, Pause, RotateCcw, X, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { apiWrapper } from "@/services/apiWrapper";
import { storage } from "@/services/storage";
import { useNavSafeExit } from "@/hooks/useNavSafeExit";
import { useNavigate } from "react-router-dom";

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
  const navigate = useNavigate();
  const settings = storage.getSettings();
  const navEnabled = settings.ui.flags.navSafeExit ?? true;
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [inputMinutes, setInputMinutes] = useState(5);
  const [showPresets, setShowPresets] = useState(true);
  const [alarmActive, setAlarmActive] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const beepBaseRef = useRef<HTMLAudioElement | null>(null);
  const completionTriggeredRef = useRef(false);
  const alarmIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const alarmTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setIsTouchDevice("ontouchstart" in window);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const preload = new Audio("/sounds/beep.mp3");
    preload.preload = "auto";
    beepBaseRef.current = preload;
  }, []);

  const playBeepFallback = useCallback((volume = 1) => {
    if (typeof window === "undefined") {
      return;
    }

    const normalizedVolume = Math.min(Math.max(volume, 0), 1);
    if (normalizedVolume <= 0) {
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

    const targetGain = Math.max(0.0001, 0.25 * normalizedVolume);

    oscillator.connect(gain);
    gain.connect(context.destination);

    oscillator.start();
    gain.gain.exponentialRampToValueAtTime(targetGain, context.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 1.4);
    oscillator.stop(context.currentTime + 1.5);
  }, []);

  const playBeep = useCallback(
    (volume = 1) => {
      if (typeof window === "undefined") {
        return;
      }

      const normalizedVolume = Math.min(Math.max(volume, 0), 1);
      if (normalizedVolume <= 0) {
        return;
      }

      const base = beepBaseRef.current ?? (() => {
        const element = new Audio("/sounds/beep.mp3");
        element.preload = "auto";
        beepBaseRef.current = element;
        return element;
      })();

      const instance = base.cloneNode(true) as HTMLAudioElement;
      instance.volume = normalizedVolume;
      const playResult = instance.play();
      if (playResult && typeof playResult.catch === "function") {
        playResult.catch((error) => {
          console.warn("Fallo al reproducir beep.mp3, usando fallback", error);
          playBeepFallback(normalizedVolume);
        });
      }
    },
    [playBeepFallback]
  );

  const stopAlarmFeedback = useCallback(() => {
    if (alarmIntervalRef.current) {
      clearInterval(alarmIntervalRef.current);
      alarmIntervalRef.current = null;
    }

    if (alarmTimeoutRef.current) {
      clearTimeout(alarmTimeoutRef.current);
      alarmTimeoutRef.current = null;
    }

    setAlarmActive(false);
  }, []);

  useEffect(() => () => {
    stopAlarmFeedback();
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close();
      } catch (error) {
        console.error("Error closing audio context", error);
      }
    }
  }, [stopAlarmFeedback]);

  const triggerCompletionFeedback = useCallback(() => {
    if (completionTriggeredRef.current) {
      return;
    }

    completionTriggeredRef.current = true;

    const settings = storage.getSettings();
    const volume = Math.min(Math.max(settings.uiVolume ?? 1, 0), 1);
    const timerAlarmsEnabled = Boolean(settings.ui.flags.timerAlarms);
    const voiceEnabled = Boolean(settings.isVoiceActive);

    stopAlarmFeedback();

    if (timerAlarmsEnabled) {
      if (settings.timerAlarmSoundEnabled && volume > 0) {
        playBeep(volume);
        if (alarmIntervalRef.current) {
          clearInterval(alarmIntervalRef.current);
        }
        alarmIntervalRef.current = setInterval(() => {
          playBeep(volume);
          if (alarmTimeoutRef.current) {
            clearTimeout(alarmTimeoutRef.current);
          }
          alarmTimeoutRef.current = setTimeout(() => {
            playBeep(volume);
          }, 400);
        }, 3000);
        setAlarmActive(true);
      }

      if (voiceEnabled && settings.timerVoiceAnnouncementsEnabled) {
        const params = new URLSearchParams({ text: "Tiempo finalizado" });
        if (settings.voiceId) {
          params.set("voice", settings.voiceId);
        }

        void apiWrapper
          .post(`/api/voice/tts/say?${params.toString()}`)
          .catch((error) => {
            console.error("Failed to send timer completion TTS", error);
            void api
              .speak("Tiempo finalizado", settings.voiceId)
              .catch(() => undefined);
          });
      }

      if (!settings.timerAlarmSoundEnabled || volume === 0) {
        setAlarmActive(false);
      }
    } else {
      playBeep(volume);
      if (voiceEnabled) {
        void api.speak("Tiempo finalizado", settings.voiceId).catch(() => undefined);
      }
    }
  }, [playBeep, stopAlarmFeedback]);

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
    stopAlarmFeedback();
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
    stopAlarmFeedback();
    setSeconds(0);
    setIsRunning(false);
    setShowPresets(true);
  };

  const handleStopAlarm = () => {
    stopAlarmFeedback();
  };

  const handleStop = useCallback(() => {
    completionTriggeredRef.current = false;
    stopAlarmFeedback();
    setSeconds(0);
    setIsRunning(false);
    
    if (typeof window !== "undefined" && window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/", { replace: true });
    }
  }, [navigate, stopAlarmFeedback]);

  const handleCancel = useCallback(() => {
    completionTriggeredRef.current = false;
    stopAlarmFeedback();
    setSeconds(0);
    setIsRunning(false);
    setShowPresets(true);
  }, [stopAlarmFeedback]);

  const handleBack = useCallback(() => {
    if (onClose) {
      onClose();
      return;
    }
    
    if (typeof window !== "undefined" && window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/", { replace: true });
    }
  }, [navigate, onClose]);

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

  const setupView = (
    <div className="flex flex-1 flex-col p-4">
      {/* Header with back button */}
      <div className="mb-4 flex items-center justify-between">
        <Button
          variant="outline"
          size="lg"
          onClick={handleBack}
          className="gap-2 min-h-[44px] min-w-[44px]"
        >
          <ArrowLeft className="h-5 w-5" />
          Atrás
        </Button>
        <h1 className="text-xl font-bold">Configurar Temporizador</h1>
        <div className="w-[100px]" /> {/* Spacer for centering */}
      </div>

      <div className="flex flex-1 items-center justify-center">
        <Card className="w-full max-w-2xl max-h-[560px] overflow-y-auto p-5">

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
    </div>
  );

  const runningView = (
    <div className="flex flex-1 flex-col p-4">
      {/* Header with back button */}
      <div className="mb-4 flex items-center justify-between">
        <Button
          variant="outline"
          size="lg"
          onClick={handleBack}
          className="gap-2 min-h-[44px] min-w-[44px]"
        >
          <ArrowLeft className="h-5 w-5" />
          Atrás
        </Button>
        <h1 className="text-xl font-bold">Temporizador</h1>
        <div className="w-[100px]" /> {/* Spacer for centering */}
      </div>

      <div className="flex flex-1 items-center justify-center">
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
          <div className="flex flex-wrap justify-center gap-3">
            <Button
              onClick={handlePause}
              size="lg"
              variant={isRunning ? "warning" : "glow"}
              className="h-14 min-w-[120px] text-base"
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
              onClick={handleCancel}
              size="lg"
              variant="outline"
              className="h-14 min-w-[120px] text-base"
            >
              <RotateCcw className="mr-2 h-5 w-5" />
              Cancelar
            </Button>
            <Button
              onClick={handleStop}
              size="lg"
              variant="destructive"
              className="h-14 min-w-[120px] text-base"
            >
              <X className="mr-2 h-5 w-5" />
              Detener
            </Button>
            {alarmActive && (
              <Button
                onClick={handleStopAlarm}
                size="lg"
                variant="destructive"
                className="h-14 min-w-[120px] text-base"
              >
                <X className="mr-2 h-5 w-5" />
                Silenciar
              </Button>
            )}
          </div>
        </div>
        </Card>
      </div>
    </div>
  );

  return (
    <div className="relative flex h-full flex-col">
      {showPresets ? setupView : runningView}
      {navEnabled && isTouchDevice && (
        <Button
          variant="glow"
          size="lg"
          onClick={handleBack}
          className="fixed bottom-6 right-6 z-50 rounded-full min-h-[56px] min-w-[56px] shadow-lg"
          aria-label="Salir"
        >
          <LogOut className="h-6 w-6" />
        </Button>
      )}
    </div>
  );
};
