import { create } from "zustand";
import { api, type DiabetesStatus } from "@/services/api";
import { apiWrapper } from "@/services/apiWrapper";
import { storage } from "@/services/storage";
import { logger } from "@/services/logger";

export type GlucoseTrend = "up" | "up_slow" | "flat" | "down_slow" | "down";

export interface GlucoseState {
  enabled: boolean;
  nightscoutConnected: boolean;
  mgdl: number | null;
  trend: GlucoseTrend | null;
  updatedAt: string | null;
}

interface GlucoseStore extends GlucoseState {
  initialized: boolean;
  lowThreshold: number;
  lowWarn: number;
  highThreshold: number;
  history: Array<{ mgdl: number; ts: string }>;
  lastEventAt: number | null;
  loadInitial: () => Promise<void>;
  applyEvent: (event: { type?: string; mgdl?: number | null; trend?: string | null; ts?: string | null }) => void;
  markStale: () => void;
}

const isValidTrend = (value: unknown): value is GlucoseTrend =>
  value === "up" ||
  value === "up_slow" ||
  value === "flat" ||
  value === "down_slow" ||
  value === "down";

const toNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const formatIso = (value: Date): string => value.toISOString().replace(/\.[0-9]{3}Z$/, "Z");

const estimateTrend = (trend: GlucoseTrend | null, history: Array<{ mgdl: number; ts: string }>): GlucoseTrend | null => {
  if (trend) {
    return trend;
  }
  if (history.length < 2) {
    return null;
  }
  const first = history[0];
  const last = history[history.length - 1];
  const start = new Date(first.ts).getTime();
  const end = new Date(last.ts).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  const minutes = (end - start) / 60000;
  if (minutes <= 0) {
    return null;
  }
  const slope = (last.mgdl - first.mgdl) / minutes;
  if (slope >= 3) {
    return "up";
  }
  if (slope >= 1) {
    return "up_slow";
  }
  if (slope <= -3) {
    return "down";
  }
  if (slope <= -1) {
    return "down_slow";
  }
  return "flat";
};

const updateHistory = (
  history: Array<{ mgdl: number; ts: string }>,
  mgdl: number | null,
  timestamp: string | null,
): Array<{ mgdl: number; ts: string }> => {
  if (mgdl === null || !timestamp) {
    return history;
  }
  const next = [...history.filter((entry) => entry.ts !== timestamp)];
  next.push({ mgdl, ts: timestamp });
  if (next.length > 5) {
    next.splice(0, next.length - 5);
  }
  return next;
};

export const useGlucoseStore = create<GlucoseStore>((set) => ({
  enabled: false,
  nightscoutConnected: false,
  mgdl: null,
  trend: null,
  updatedAt: null,
  initialized: false,
  lowThreshold: 70,
  lowWarn: 80,
  highThreshold: 180,
  history: [],
  lastEventAt: null,
  loadInitial: async () => {
    try {
      const status = await api.getDiabetesStatus();
      const settings = storage.getSettings();
      const low = toNumber(settings.hypoAlarm) ?? 70;
      const high = toNumber(settings.hyperAlarm) ?? 180;
      const warn = Math.max(low + 10, 80);

      const normalized: DiabetesStatus = {
        enabled: Boolean(status?.enabled),
        nightscout_connected: Boolean(status?.nightscout_connected),
        mgdl: typeof status?.mgdl === "number" ? Math.round(status.mgdl) : null,
        trend: isValidTrend(status?.trend) ? status?.trend : null,
        updated_at: typeof status?.updated_at === "string" ? status.updated_at : null,
      };

      set((state) => {
        const history = updateHistory(state.history, normalized.mgdl, normalized.updated_at);
        const trend = estimateTrend(normalized.trend, history);
        return {
          enabled: normalized.enabled,
          nightscoutConnected: normalized.enabled && normalized.nightscout_connected,
          mgdl: normalized.mgdl,
          trend,
          updatedAt: normalized.updated_at,
          initialized: true,
          lowThreshold: low,
          lowWarn: warn,
          highThreshold: high,
          history,
          lastEventAt: Date.now(),
        };
      });
    } catch (error) {
      logger.error("GLUCOSE loadInitial failed", { error });
    }
  },
  applyEvent: (event) => {
    if (event?.type !== "glucose_update") {
      return;
    }
    const mgdl = typeof event.mgdl === "number" ? Math.round(event.mgdl) : null;
    const ts = typeof event.ts === "string" ? event.ts : formatIso(new Date());
    const trend = isValidTrend(event.trend) ? event.trend : null;

    set((state) => {
      const history = updateHistory(state.history, mgdl, ts);
      const nextTrend = estimateTrend(trend, history);
      return {
        mgdl,
        trend: nextTrend,
        updatedAt: ts,
        nightscoutConnected: state.enabled && mgdl !== null,
        history,
        lastEventAt: Date.now(),
        initialized: true,
      };
    });
  },
  markStale: () => {
    set((state) => {
      if (!state.nightscoutConnected) {
        return state;
      }
      return {
        nightscoutConnected: false,
      };
    });
  },
}));

export const glucoseStore = useGlucoseStore;

const resolveDiabetesEventsBase = (
  baseUrl: string,
): { origin?: string; path: string } => {
  const normalized = baseUrl.replace(/\/$/, "");
  if (!normalized) {
    return { path: "" };
  }
  try {
    const url = new URL(normalized);
    return {
      origin: url.origin,
      path: url.pathname.replace(/\/$/, ""),
    };
  } catch {
    const path = normalized.startsWith("/") ? normalized : `/${normalized}`;
    return { path };
  }
};

const buildDiabetesEventsPathFromBase = (path: string): string => {
  const trimmedPath = path.replace(/\/$/, "");
  if (!trimmedPath) {
    return "/api/diabetes/events";
  }
  return `${trimmedPath}/api/diabetes/events`;
};

export const buildDiabetesEventsPath = (): string => {
  const baseUrl = apiWrapper.getBaseUrl();
  const { path } = resolveDiabetesEventsBase(baseUrl);
  return buildDiabetesEventsPathFromBase(path);
};

export const buildDiabetesEventsUrl = (): string => {
  const baseUrl = apiWrapper.getBaseUrl();
  const { origin, path } = resolveDiabetesEventsBase(baseUrl);
  const eventsPath = buildDiabetesEventsPathFromBase(path);
  if (origin) {
    return `${origin}${eventsPath}`;
  }
  return eventsPath;
};
