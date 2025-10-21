import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { storage } from "@/services/storage";
import { resolveApiBaseUrl } from "@/services/apiWrapper";

type Debounced<T extends (...args: unknown[]) => void> = (...args: Parameters<T>) => void;

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): Debounced<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      timeout = undefined;
      fn(...args);
    }, ms);
  };
}

const buildApiUrl = (path: string): string => {
  const settings = storage.getSettings();
  const normalized = resolveApiBaseUrl(settings.apiUrl);
  const candidates = [
    normalized && normalized.trim() ? normalized : null,
    typeof window !== "undefined" && window.location?.origin ? window.location.origin : null,
  ].filter((value): value is string => Boolean(value));

  for (const base of candidates) {
    try {
      return new URL(path, base).toString();
    } catch {
      // try next
    }
  }

  try {
    return new URL(path).toString();
  } catch {
    return path;
  }
};

export function useVolume(debounceMs = 200) {
  const [level, setLevel] = useState<number>(0.8);
  const [percent, setPercent] = useState<number>(80);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    const fetchVolume = async () => {
      try {
        setLoading(true);
        const response = await fetch(buildApiUrl("/api/audio/volume"), {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        const data = await response.json();
        if (!aliveRef.current) {
          return;
        }
        if (data?.ok && typeof data?.level === "number") {
          const lvl = Math.min(1, Math.max(0, data.level));
          setLevel(lvl);
          setPercent(Math.round(lvl * 100));
          setError(null);
          storage.saveSettings({ uiVolume: lvl });
        } else {
          setError("No se pudo leer el volumen");
        }
      } catch (err) {
        if (!aliveRef.current) {
          return;
        }
        setError(err instanceof Error ? err.message : "Error obteniendo volumen");
      } finally {
        if (aliveRef.current) {
          setLoading(false);
        }
      }
    };

    void fetchVolume();
  }, []);

  const apply = useMemo(
    () =>
      debounce(async (lvl: number) => {
        try {
          setLoading(true);
          const url = buildApiUrl(`/api/audio/volume?level=${lvl}`);
          const response = await fetch(url, { method: "POST", headers: { Accept: "application/json" } });
          const data = await response.json();
          if (!aliveRef.current) {
            return;
          }
          if (data?.ok && typeof data?.percent === "number") {
            const pct = Math.round(data.percent);
            const lvl = Math.min(1, Math.max(0, pct / 100));
            setPercent(pct);
            storage.saveSettings({ uiVolume: lvl });
            setError(null);
          } else {
            setError("No se pudo ajustar el volumen");
          }
        } catch (err) {
          if (!aliveRef.current) {
            return;
          }
          setError(err instanceof Error ? err.message : "Error ajustando volumen");
        } finally {
          if (aliveRef.current) {
            setLoading(false);
          }
        }
      }, debounceMs),
    [debounceMs]
  );

  const setLevelAndApply = useCallback(
    (lvl: number) => {
      const clamped = Math.min(1, Math.max(0, lvl));
      setLevel(clamped);
      setPercent(Math.round(clamped * 100));
      storage.saveSettings({ uiVolume: clamped });
      apply(clamped);
    },
    [apply]
  );

  return { level, percent, setLevel: setLevelAndApply, loading, error };
}
