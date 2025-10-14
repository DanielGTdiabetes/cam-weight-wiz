import { CountdownPhase } from "@/hooks/useCountdown";
import { cn } from "@/lib/utils";

interface CountdownProps {
  remainingMs: number;
  mmss: string;
  phase: CountdownPhase;
  className?: string;
}

export const Countdown = ({ remainingMs, mmss, phase, className }: CountdownProps) => {
  const phaseClass = (() => {
    switch (phase) {
      case "warn":
        return "text-orange-500";
      case "danger":
        return "text-red-600";
      case "done":
        return "text-gray-500";
      default:
        return undefined;
    }
  })();

  const shouldBlink = phase === "danger";

  return (
    <span
      role="timer"
      aria-live="polite"
      data-remaining-ms={remainingMs}
      data-phase={phase}
      className={cn("font-mono text-4xl", phaseClass, shouldBlink && "blink", className)}
    >
      {mmss}
    </span>
  );
};

export default Countdown;
