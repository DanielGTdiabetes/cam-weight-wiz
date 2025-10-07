import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Clock, Scale, WifiOff, Settings2 } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useScaleWebSocket } from "@/hooks/useScaleWebSocket";
import { useScaleDecimals } from "@/hooks/useScaleDecimals";
import { formatWeight } from "@/lib/format";
import { api } from "@/services/api";

const formatSeconds = (totalSeconds: number): string => {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (safeSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
};

const buildConfigUrl = (): string => {
  if (typeof window === "undefined" || !window.location?.origin) {
    return "http://192.168.4.1/config";
  }
  const origin = window.location.origin.replace(/\/+$/, "");
  return `${origin}/config`;
};

const OfflineMode = () => {
  const { weight, isStable, unit, isConnected } = useScaleWebSocket();
  const decimals = useScaleDecimals();
  const [displayUnit, setDisplayUnit] = useState<"g" | "ml">("g");
  const [timerMinutes, setTimerMinutes] = useState(5);
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerRemaining, setTimerRemaining] = useState(0);
  const [updatingTimer, setUpdatingTimer] = useState(false);

  const displayedWeight = useMemo(() => {
    if (displayUnit === "ml" && unit === "g") {
      return weight;
    }
    return weight;
  }, [displayUnit, unit, weight]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await api.getTimerStatus();
        if (cancelled) {
          return;
        }
        setTimerRunning(status.running);
        setTimerRemaining(status.remaining ?? 0);
      } catch (error) {
        if (!cancelled) {
          setTimerRunning(false);
          setTimerRemaining(0);
        }
      }
    };

    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const handleToggleUnit = () => {
    setDisplayUnit((prev) => (prev === "g" ? "ml" : "g"));
    if (navigator.vibrate) {
      navigator.vibrate(30);
    }
  };

  const handleTare = async () => {
    try {
      await api.scaleTare();
    } catch (error) {
      console.warn("No se pudo aplicar la tara en modo offline", error);
    }
  };

  const handleStartTimer = async (minutes: number) => {
    const normalizedMinutes = Number.isFinite(minutes) ? Math.max(0.1, minutes) : 1;
    const seconds = Math.round(normalizedMinutes * 60);
    setUpdatingTimer(true);
    try {
      await api.startTimer(seconds);
      setTimerRunning(true);
      setTimerRemaining(seconds);
      setTimerMinutes(normalizedMinutes);
    } catch (error) {
      console.warn("No se pudo iniciar el temporizador en modo offline", error);
    } finally {
      setUpdatingTimer(false);
    }
  };

  const handleStopTimer = async () => {
    setUpdatingTimer(true);
    try {
      await api.stopTimer();
      setTimerRunning(false);
      setTimerRemaining(0);
    } catch (error) {
      console.warn("No se pudo detener el temporizador en modo offline", error);
    } finally {
      setUpdatingTimer(false);
    }
  };

  const configUrl = buildConfigUrl();

  return (
    <div className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <Card className="border-amber-300/30 bg-amber-500/5 p-6 text-amber-100">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-amber-500/20 p-2">
                <WifiOff className="h-6 w-6" />
              </div>
              <div className="space-y-1">
                <p className="text-lg font-semibold">Modo offline activado</p>
                <p className="text-sm text-amber-100/80">
                  Sin conexión a Internet. Puedes pesar y usar el temporizador; las funciones de IA y Nightscout están
                  desactivadas.
                </p>
                <p className="text-sm text-amber-100/70">
                  Configura la red desde otro dispositivo entrando en <span className="font-semibold">{configUrl}</span>.
                </p>
              </div>
            </div>
            <Button variant="outline" className="border-amber-300 text-amber-100 hover:bg-amber-500/20" asChild>
              <Link to="/config">
                <Settings2 className="mr-2 h-4 w-4" /> Abrir configuración
              </Link>
            </Button>
          </div>
        </Card>

        <div className="grid gap-6 md:grid-cols-2">
          <Card className="border-primary/30 bg-background/60 p-6 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-lg font-semibold">
                <Scale className="h-5 w-5 text-primary" /> Peso actual
              </div>
              <span className="rounded-full border border-primary/40 px-3 py-1 text-xs font-medium uppercase tracking-wide text-primary">
                {isConnected ? "Conectado" : "Sin datos"}
              </span>
            </div>
            <div className="flex flex-col items-center gap-4">
              <div className={`text-7xl font-bold tracking-tight ${isStable ? "text-primary" : "text-muted-foreground"}`}>
                {formatWeight(displayedWeight ?? 0, decimals)}
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className={`h-2 w-2 rounded-full ${isStable ? "bg-primary" : "bg-muted-foreground animate-pulse"}`} />
                {isStable ? "Peso estable" : "Estabilizando…"}
              </div>
              <div className="flex gap-3">
                <Button variant="outline" onClick={handleTare} disabled={!isConnected}>
                  Tara
                </Button>
                <Button variant="ghost" onClick={handleToggleUnit}>
                  Cambiar a {displayUnit === "g" ? "ml" : "g"}
                </Button>
              </div>
            </div>
          </Card>

          <Card className="border-primary/30 bg-background/60 p-6 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-lg font-semibold">
                <Clock className="h-5 w-5 text-primary" /> Temporizador
              </div>
              <span className="text-sm text-muted-foreground">
                {timerRunning ? "En marcha" : "Detenido"}
              </span>
            </div>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col items-center gap-2">
                <div className="text-5xl font-bold text-primary">{formatSeconds(timerRemaining)}</div>
                <p className="text-xs text-muted-foreground">
                  El temporizador funciona sin conexión para recordatorios básicos.
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {[1, 3, 5].map((preset) => (
                  <Button
                    key={preset}
                    variant="outline"
                    onClick={() => void handleStartTimer(preset)}
                    disabled={updatingTimer}
                  >
                    {preset} min
                  </Button>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <Input
                  type="number"
                  min={0.1}
                  step={0.5}
                  value={timerMinutes}
                  onChange={(event) => setTimerMinutes(Number(event.target.value))}
                  className="flex-1"
                />
                <Button
                  variant="glow"
                  onClick={() => void handleStartTimer(timerMinutes)}
                  disabled={updatingTimer}
                >
                  Iniciar
                </Button>
                <Button variant="outline" onClick={() => void handleStopTimer()} disabled={updatingTimer || !timerRunning}>
                  Detener
                </Button>
              </div>
            </div>
          </Card>
        </div>

        <Card className="border-border/60 bg-muted/20 p-5 text-sm text-muted-foreground">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 text-muted-foreground" />
            <div>
              <p>
                Cuando recuperes la conexión a Internet podrás volver a usar las funciones inteligentes desde la opción de
                configuración.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default OfflineMode;
