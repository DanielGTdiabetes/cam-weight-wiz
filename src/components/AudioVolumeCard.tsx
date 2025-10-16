import { Volume2 } from "lucide-react";
import { useVolume } from "@/hooks/useVolume";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface AudioVolumeCardProps {
  className?: string;
}

export default function AudioVolumeCard({ className }: AudioVolumeCardProps) {
  const { level, percent, setLevel, loading, error } = useVolume();

  const handleStep = (delta: number) => {
    setLevel(level + delta);
  };

  return (
    <div className={cn("rounded-2xl border border-border/60 bg-card p-6 shadow-sm", className)}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Volume2 className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">Volumen altavoz</h3>
            <p className="text-sm text-muted-foreground">
              Ajusta el amplificador MAX98357A desde ALSA ({percent}%).
            </p>
          </div>
        </div>
        <span className="text-sm font-medium tabular-nums">
          {percent}% {loading ? "…" : ""}
        </span>
      </div>

      <input
        type="range"
        min={0}
        max={100}
        value={percent}
        onChange={(event) => setLevel(Number(event.target.value) / 100)}
        className="w-full accent-primary"
        aria-label="Volumen del altavoz"
      />

      <div className="mt-4 flex items-center justify-between gap-2">
        <Button variant="outline" size="sm" onClick={() => handleStep(-0.05)} disabled={loading}>
          -5%
        </Button>
        <Button variant="outline" size="sm" onClick={() => handleStep(-0.01)} disabled={loading}>
          -1%
        </Button>
        <Button variant="outline" size="sm" onClick={() => handleStep(0.01)} disabled={loading}>
          +1%
        </Button>
        <Button variant="outline" size="sm" onClick={() => handleStep(0.05)} disabled={loading}>
          +5%
        </Button>
      </div>

      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      <p className="mt-3 text-xs text-muted-foreground">
        Este control sincroniza el volumen real de la tarjeta ALSA &quot;sndrpihifiberry&quot; (control Digital). El
        ajuste se aplica con leve retardo para evitar saltos bruscos.
      </p>
    </div>
  );
}
