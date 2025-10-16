import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface UseCountdownOpts {
  durationMs: number;
  startedAt?: number | null;
  onFinished?: () => void;
}

export type CountdownPhase = "normal" | "warn" | "danger" | "done";

export interface UseCountdown {
  remainingMs: number;
  mmss: string;
  phase: CountdownPhase;
  isRunning: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export const useCountdown = ({ durationMs, startedAt, onFinished }: UseCountdownOpts): UseCountdown => {
  const safeDuration = Math.max(0, durationMs);

  const computeRemaining = useCallback(() => {
    if (!startedAt) {
      return safeDuration;
    }

    const endAt = startedAt + safeDuration;
    const remaining = clamp(endAt - Date.now(), 0, safeDuration);
    return remaining;
  }, [safeDuration, startedAt]);

  const [remainingMs, setRemainingMs] = useState<number>(() => computeRemaining());
  const previousPhaseRef = useRef<CountdownPhase>("normal");

  useEffect(() => {
    setRemainingMs(computeRemaining());
  }, [computeRemaining]);

  useEffect(() => {
    if (!startedAt || safeDuration <= 0) {
      return undefined;
    }

    const endAt = startedAt + safeDuration;

    const tick = () => {
      const remaining = clamp(endAt - Date.now(), 0, safeDuration);
      setRemainingMs((current) => {
        if (current === remaining) {
          return current;
        }
        return remaining;
      });

      if (remaining === 0) {
        clearInterval(intervalId);
      }
    };

    const intervalId = setInterval(tick, 250);
    tick();

    return () => {
      clearInterval(intervalId);
    };
  }, [safeDuration, startedAt]);

  const phase: CountdownPhase = useMemo(() => {
    if (remainingMs === 0) {
      return "done";
    }
    if (remainingMs <= 5_000) {
      return "danger";
    }
    if (remainingMs <= 10_000) {
      return "warn";
    }
    return "normal";
  }, [remainingMs]);

  useEffect(() => {
    if (phase === "done" && previousPhaseRef.current !== "done" && startedAt) {
      onFinished?.();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("timer:finished"));
      }
    }
    previousPhaseRef.current = phase;
  }, [phase, onFinished, startedAt]);

  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  const mmss = `${minutes}:${seconds}`;

  const isRunning = Boolean(startedAt) && remainingMs > 0;

  return {
    remainingMs,
    mmss,
    phase,
    isRunning,
  };
};
