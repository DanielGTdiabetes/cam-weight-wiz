import { useEffect, useMemo } from "react";
import { Droplet } from "lucide-react";
import {
  useGlucoseStore,
  glucoseStore,
  buildDiabetesEventsUrl,
  buildDiabetesEventsPath,
} from "@/state/glucose";
import { logger } from "@/services/logger";

const TREND_SYMBOLS: Record<string, string> = {
  up: "↑",
  up_slow: "↗",
  flat: "→",
  down_slow: "↘",
  down: "↓",
};

const TREND_LABELS: Record<string, string> = {
  up: "Subiendo rápido",
  up_slow: "Subiendo",
  flat: "Estable",
  down_slow: "Bajando",
  down: "Bajando rápido",
};

const formatTime = (iso: string | null): string => {
  if (!iso) {
    return "—";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
};

export const GlucoseHeaderBadge = () => {
  const { enabled, nightscoutConnected, mgdl, trend, updatedAt, lowThreshold, lowWarn, highThreshold } =
    useGlucoseStore((state) => ({
      enabled: state.enabled,
      nightscoutConnected: state.nightscoutConnected,
      mgdl: state.mgdl,
      trend: state.trend,
      updatedAt: state.updatedAt,
      lowThreshold: state.lowThreshold,
      lowWarn: state.lowWarn,
      highThreshold: state.highThreshold,
    }));
  const loadInitial = useGlucoseStore((state) => state.loadInitial);
  const applyEvent = useGlucoseStore((state) => state.applyEvent);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;
    let staleInterval: number | null = null;
    let pollInterval: number | null = null;

    const start = async () => {
      await loadInitial();
      if (disposed || typeof window === "undefined") {
        return;
      }
      staleInterval = window.setInterval(() => {
        const state = glucoseStore.getState();
        if (state.lastEventAt && Date.now() - state.lastEventAt > 15000) {
          state.markStale();
        }
      }, 5000);
      pollInterval = window.setInterval(() => {
        void loadInitial();
      }, 60000);

      if (typeof window.EventSource === "undefined") {
        return;
      }

      let url = buildDiabetesEventsUrl();
      if (typeof window !== "undefined" && window.location.protocol === "https:" && url.startsWith("http://")) {
        url = buildDiabetesEventsPath();
      }
      try {
        source = new EventSource(url);
      } catch (error) {
        logger.warn("GLUCOSE badge SSE unavailable", { error, url });
        return;
      }
      const handler = (event: MessageEvent<string>) => {
        try {
          const payload = JSON.parse(event.data) as { type?: string; mgdl?: number | null; trend?: string | null; ts?: string | null };
          applyEvent(payload);
        } catch (error) {
          logger.error("GLUCOSE badge failed to parse event", { error, raw: event.data });
        }
      };
      source.addEventListener("glucose_update", handler as EventListener);
      source.onerror = () => {
        logger.warn("GLUCOSE badge SSE disconnected");
      };

      return () => {
        source?.removeEventListener("glucose_update", handler as EventListener);
      };
    };

    let removeHandler: (() => void) | undefined;
    void start().then((cleanup) => {
      removeHandler = cleanup;
    });

    return () => {
      disposed = true;
      if (staleInterval !== null) {
        window.clearInterval(staleInterval);
      }
      if (pollInterval !== null) {
        window.clearInterval(pollInterval);
      }
      removeHandler?.();
      source?.close();
    };
  }, [applyEvent, loadInitial]);

  const { displayValue, unitLabel, badgeClass, trendSymbol, trendLabel, timeLabel } = useMemo(() => {
    const value = mgdl !== null ? `${mgdl}` : "—";
    let color = "text-emerald-400";
    if (mgdl === null) {
      color = "text-muted-foreground";
    } else if (mgdl < lowThreshold) {
      color = "text-sky-400";
    } else if (mgdl < lowWarn) {
      color = "text-amber-400";
    } else if (mgdl > highThreshold) {
      color = "text-rose-500";
    }
    const symbol = trend ? TREND_SYMBOLS[trend] ?? "" : "";
    const label = trend ? TREND_LABELS[trend] ?? "" : "";
    return {
      displayValue: value,
      unitLabel: "mg/dL",
      badgeClass: color,
      trendSymbol: symbol,
      trendLabel: label,
      timeLabel: formatTime(updatedAt),
    };
  }, [mgdl, trend, updatedAt, lowThreshold, lowWarn, highThreshold]);

  if (!enabled || !nightscoutConnected) {
    return null;
  }

  return (
    <div
      className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      aria-live="polite"
    >
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2 text-sm">
        <div className="flex items-center gap-2">
          <Droplet className="h-4 w-4 text-rose-400" aria-hidden="true" />
          <span className={`text-lg font-semibold ${badgeClass}`}>{displayValue}</span>
          <span className="text-xs uppercase tracking-wide text-muted-foreground">{unitLabel}</span>
          {trendSymbol && (
            <span className="text-lg" aria-label={trendLabel}>
              {trendSymbol}
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span>Actualizado</span>
          <span className="font-medium text-foreground">{timeLabel}</span>
        </div>
      </div>
    </div>
  );
};
