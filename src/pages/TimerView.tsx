import { useState, useEffect } from "react";
import { Play, Pause, RotateCcw, Plus, Minus } from "lucide-react";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export const TimerView = () => {
  const [seconds, setSeconds] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [inputMinutes, setInputMinutes] = useState(5);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isRunning && seconds > 0) {
      interval = setInterval(() => {
        setSeconds((s) => s - 1);
      }, 1000);
    } else if (seconds === 0 && isRunning) {
      setIsRunning(false);
      // Play notification sound
    }
    return () => clearInterval(interval);
  }, [isRunning, seconds]);

  const handleStart = () => {
    if (seconds === 0) {
      setSeconds(inputMinutes * 60);
    }
    setIsRunning(!isRunning);
  };

  const handleReset = () => {
    setSeconds(0);
    setIsRunning(false);
  };

  const formatTime = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const progress = seconds > 0 ? (seconds / (inputMinutes * 60)) * 100 : 0;

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header 
        title="Temporizador" 
        subtitle="Controla tus tiempos de cocción"
      />
      
      <main className="mx-auto max-w-screen-xl space-y-6 p-4">
        {/* Timer Display */}
        <Card className="relative overflow-hidden border-primary/30 glow-cyan">
          <div className="gradient-holographic absolute inset-0 opacity-30" />
          <div className="relative p-12 text-center">
            <div className="mb-8">
              <div className="text-8xl font-bold tracking-tight text-primary text-glow-cyan">
                {formatTime(seconds)}
              </div>
            </div>

            {/* Progress Ring */}
            <div className="mx-auto mb-8 h-48 w-48">
              <svg className="h-full w-full -rotate-90 transform">
                <circle
                  cx="96"
                  cy="96"
                  r="88"
                  stroke="currentColor"
                  strokeWidth="8"
                  fill="none"
                  className="text-muted"
                />
                <circle
                  cx="96"
                  cy="96"
                  r="88"
                  stroke="currentColor"
                  strokeWidth="8"
                  fill="none"
                  strokeDasharray={`${2 * Math.PI * 88}`}
                  strokeDashoffset={`${2 * Math.PI * 88 * (1 - progress / 100)}`}
                  className="text-primary transition-all duration-1000"
                  strokeLinecap="round"
                />
              </svg>
            </div>

            {/* Controls */}
            <div className="flex justify-center gap-4">
              <Button
                onClick={handleStart}
                size="xl"
                variant={isRunning ? "warning" : "glow"}
              >
                {isRunning ? (
                  <>
                    <Pause className="mr-2 h-5 w-5" />
                    Pausar
                  </>
                ) : (
                  <>
                    <Play className="mr-2 h-5 w-5" />
                    {seconds > 0 ? "Reanudar" : "Iniciar"}
                  </>
                )}
              </Button>
              <Button onClick={handleReset} size="xl" variant="outline">
                <RotateCcw className="mr-2 h-5 w-5" />
                Reiniciar
              </Button>
            </div>
          </div>
        </Card>

        {/* Time Presets */}
        {!isRunning && seconds === 0 && (
          <Card>
            <div className="p-6">
              <h2 className="mb-4 text-lg font-semibold">Configurar Tiempo</h2>
              
              <div className="mb-6 flex items-center justify-center gap-4">
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => setInputMinutes(Math.max(1, inputMinutes - 1))}
                >
                  <Minus className="h-4 w-4" />
                </Button>
                
                <div className="text-center">
                  <div className="text-4xl font-bold text-primary">{inputMinutes}</div>
                  <div className="text-sm text-muted-foreground">minutos</div>
                </div>
                
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => setInputMinutes(inputMinutes + 1)}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

              <div className="grid grid-cols-3 gap-3">
                {[1, 3, 5, 10, 15, 30].map((mins) => (
                  <Button
                    key={mins}
                    variant={inputMinutes === mins ? "default" : "outline"}
                    onClick={() => setInputMinutes(mins)}
                  >
                    {mins} min
                  </Button>
                ))}
              </div>
            </div>
          </Card>
        )}
      </main>
    </div>
  );
};
