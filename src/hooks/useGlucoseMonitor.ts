import { useEffect, useMemo, useRef } from "react";
import { type GlucoseData } from "@/services/api";
import { useToast } from "@/hooks/use-toast";
import { useGlucoseStore } from "@/state/glucose";

interface UseGlucoseMonitorReturn extends GlucoseData {
  isLoading: boolean;
  error: string | null;
}

export const useGlucoseMonitor = (
  enabled: boolean,
  lowThreshold = 70,
  highThreshold = 180
): UseGlucoseMonitorReturn | null => {
  const { toast } = useToast();
  const mgdl = useGlucoseStore((state) => state.mgdl);
  const trend = useGlucoseStore((state) => state.trend);
  const updatedAt = useGlucoseStore((state) => state.updatedAt);
  const nightscoutConnected = useGlucoseStore((state) => state.nightscoutConnected);
  const initialized = useGlucoseStore((state) => state.initialized);
  const storeLow = useGlucoseStore((state) => state.lowThreshold);
  const storeHigh = useGlucoseStore((state) => state.highThreshold);

  const lastAlertRef = useRef<"low" | "high" | null>(null);

  const effectiveLow = storeLow ?? lowThreshold;
  const effectiveHigh = storeHigh ?? highThreshold;

  useEffect(() => {
    if (!enabled) {
      lastAlertRef.current = null;
      return;
    }
    if (!nightscoutConnected || mgdl === null) {
      return;
    }
    if (mgdl < effectiveLow) {
      if (lastAlertRef.current !== "low") {
        toast({
          title: "⚠️ Hipoglucemia Detectada",
          description: `Glucosa: ${mgdl} mg/dl`,
          variant: "destructive",
          duration: 10000,
        });
        lastAlertRef.current = "low";
      }
      return;
    }
    if (mgdl > effectiveHigh) {
      if (lastAlertRef.current !== "high") {
        toast({
          title: "⚠️ Hiperglucemia Detectada",
          description: `Glucosa: ${mgdl} mg/dl`,
          variant: "destructive",
          duration: 10000,
        });
        lastAlertRef.current = "high";
      }
      return;
    }
    lastAlertRef.current = null;
  }, [enabled, mgdl, nightscoutConnected, effectiveLow, effectiveHigh, toast]);

  const normalizedTrend = useMemo(() => {
    if (!trend) {
      return "stable" as const;
    }
    if (trend === "up" || trend === "up_slow") {
      return "up" as const;
    }
    if (trend === "down" || trend === "down_slow") {
      return "down" as const;
    }
    return "stable" as const;
  }, [trend]);

  if (!enabled || !nightscoutConnected || mgdl === null) {
    return null;
  }

  return {
    glucose: mgdl,
    trend: normalizedTrend,
    timestamp: updatedAt ?? "",
    isLoading: !initialized,
    error: null,
  };
};
