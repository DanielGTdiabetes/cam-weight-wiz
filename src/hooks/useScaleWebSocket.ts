import { useEffect, useState, useCallback, useRef } from "react";
import type { WeightData } from "@/services/api";
import { storage } from "@/services/storage";
import { isLocalClient } from "@/lib/network";
import { apiWrapper } from "@/services/apiWrapper";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://127.0.0.1:8080";
const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY = 1000; // 1 second
const MAX_RECONNECT_DELAY = 30000; // 30 seconds
const HTTP_POLL_MS = 500;
const ERROR_GRACE_MS = 5000;
const LOOPBACK_REGEX = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_WS_REGEX = /^(wss?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

type ConnectionState = "connected" | "reconnecting" | "no-data";

type WeightResponse = {
  value?: number | string | null;
  weight?: number | string | null;
  grams?: number | string | null;
  ts?: string | null;
  stable?: boolean | null;
  unit?: "g" | "ml" | string | null;
};

export interface UseScaleWebSocketReturn {
  weight: number;
  isStable: boolean;
  unit: "g" | "ml";
  isConnected: boolean;
  error: string | null;
  reconnectAttempts: number;
  connectionState: "connected" | "reconnecting" | "no-data";
}

export const useScaleWebSocket = (): UseScaleWebSocketReturn => {
  const [weight, setWeight] = useState(0);
  const [isStable, setIsStable] = useState(false);
  const [unit, setUnit] = useState<"g" | "ml">("g");
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const reconnectAttemptsRef = useRef(0);
  const [lastHttpOkAt, setLastHttpOkAt] = useState<number>(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>("reconnecting");

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const shouldReconnectRef = useRef(true);
  const httpIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const httpAbortControllerRef = useRef<AbortController | null>(null);
  const httpInFlightRef = useRef(false);
  const realtimeConnectedRef = useRef(false);
  const lastHttpOkAtRef = useRef(0);
  const sseRef = useRef<EventSource | null>(null);
  const sseReconnectRef = useRef<NodeJS.Timeout | null>(null);
  const remoteSseActiveRef = useRef(false);

  const settings = storage.getSettings();
  const defaultOrigin = typeof window !== "undefined" ? window.location.origin.replace(/\/$/, "") : "";
  const resolvedApiBase = (() => {
    const base = apiWrapper.getBaseUrl();
    if (base) {
      return base.replace(/\/$/, "");
    }
    if (settings.apiUrl && !LOOPBACK_REGEX.test(settings.apiUrl)) {
      return settings.apiUrl.replace(/\/$/, "");
    }
    return defaultOrigin;
  })();
  const apiBaseUrl = resolvedApiBase || "";

  const wsBaseUrl = (() => {
    const configured = (settings.wsUrl || "").trim();
    if (configured && !LOOPBACK_WS_REGEX.test(configured)) {
      return configured.replace(/\/$/, "");
    }
    if (apiBaseUrl) {
      try {
        const url = new URL(apiBaseUrl);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        return url.origin;
      } catch {
        // Fallback handled below
      }
    }
    if (defaultOrigin) {
      try {
        const url = new URL(defaultOrigin);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        return url.origin;
      } catch {
        // Continue to fallback
      }
    }
    return WS_URL.replace(/\/$/, "");
  })();
  const localClient = isLocalClient();
  const hostname = typeof window !== "undefined" ? window.location.hostname : "";
  const isDemoMode = /\.lovable\.app$/i.test(hostname);

  const updateConnectivity = useCallback(() => {
    const now = Date.now();
    const hasRecentHttp =
      lastHttpOkAtRef.current > 0 && now - lastHttpOkAtRef.current <= ERROR_GRACE_MS;
    const realtimeConnected = realtimeConnectedRef.current;

    setIsConnected(realtimeConnected || hasRecentHttp);

    if (realtimeConnected || hasRecentHttp) {
      setConnectionState("connected");
    } else {
      setConnectionState("no-data");
    }

    const showConnError = !realtimeConnected && !hasRecentHttp;
    setError(showConnError ? "Error de conexión con la báscula" : null);
  }, [setConnectionState, setError, setIsConnected]);

  const ensureGracePeriod = useCallback(() => {
    if (lastHttpOkAtRef.current === 0) {
      const now = Date.now();
      lastHttpOkAtRef.current = now;
      setLastHttpOkAt(now);
    }
  }, [setLastHttpOkAt]);

  const resetHttpTracking = useCallback(() => {
    lastHttpOkAtRef.current = 0;
    setLastHttpOkAt(0);
  }, [setLastHttpOkAt]);

  const stopHttpPolling = useCallback(() => {
    if (httpIntervalRef.current) {
      clearInterval(httpIntervalRef.current);
      httpIntervalRef.current = null;
    }

    if (httpAbortControllerRef.current) {
      httpAbortControllerRef.current.abort();
      httpAbortControllerRef.current = null;
    }

    httpInFlightRef.current = false;
  }, []);

  const handleHttpOutcome = useCallback((ok: boolean) => {
    if (ok) {
      const now = Date.now();
      lastHttpOkAtRef.current = now;
      setLastHttpOkAt(now);
    } else if (lastHttpOkAtRef.current === 0) {
      const now = Date.now();
      lastHttpOkAtRef.current = now;
      setLastHttpOkAt(now);
    }

    updateConnectivity();
  }, [setLastHttpOkAt, updateConnectivity]);

  const startHttpPolling = useCallback(() => {
    if (isDemoMode || httpIntervalRef.current) {
      return;
    }

    ensureGracePeriod();
    updateConnectivity();

    const fetchRead = async () => {
      if (httpInFlightRef.current) {
        return;
      }

      httpInFlightRef.current = true;
      httpAbortControllerRef.current?.abort();
      const controller = new AbortController();
      httpAbortControllerRef.current = controller;

      try {
        const weightPath = "/api/scale/weight";
        const weightBase = apiBaseUrl || "";
        const weightUrl = weightBase ? `${weightBase}${weightPath}` : weightPath;
        const response = await fetch(weightUrl, {
          signal: controller.signal,
        });

        if (!response.ok) {
          handleHttpOutcome(false);
          return;
        }

        const data: WeightResponse = await response.json();

        const candidateSources: Array<number | string | null | undefined> = [
          data?.value,
          data?.weight,
          data?.grams,
        ];

        let gramsValue: number | null = null;
        for (const raw of candidateSources) {
          if (typeof raw === "number" && Number.isFinite(raw)) {
            gramsValue = raw;
            break;
          }
          if (typeof raw === "string") {
            const parsed = Number(raw);
            if (!Number.isNaN(parsed)) {
              gramsValue = parsed;
              break;
            }
          }
          if (raw === null) {
            gramsValue = null;
            break;
          }
        }

        if (gramsValue === null) {
          handleHttpOutcome(false);
          return;
        }

        setWeight(gramsValue);
        if (data?.unit === "ml" || data?.unit === "g") {
          setUnit(data.unit);
        } else {
          setUnit("g");
        }
        if (typeof data?.stable === "boolean") {
          setIsStable(data.stable);
        } else {
          setIsStable(false);
        }

        handleHttpOutcome(true);
      } catch (err) {
        if ((err as DOMException).name !== "AbortError") {
          handleHttpOutcome(false);
        }
      } finally {
        httpInFlightRef.current = false;
      }
    };

    void fetchRead();

    httpIntervalRef.current = setInterval(() => {
      void fetchRead();
    }, HTTP_POLL_MS);
  }, [apiBaseUrl, ensureGracePeriod, handleHttpOutcome, isDemoMode, setIsStable, setUnit, setWeight, updateConnectivity]);

  const getReconnectDelay = (attempt: number): number => {
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY * Math.pow(2, attempt),
      MAX_RECONNECT_DELAY
    );
    return delay + Math.random() * 1000;
  };

  const updateReconnectAttempts = useCallback((updater: number | ((prev: number) => number)) => {
    setReconnectAttempts(prev => {
      const nextValue = typeof updater === "function"
        ? (updater as (value: number) => number)(prev)
        : updater;
      const clamped = Math.max(0, Math.min(nextValue, MAX_RECONNECT_ATTEMPTS));
      reconnectAttemptsRef.current = clamped;
      return clamped;
    });
  }, [setReconnectAttempts]);

  const connect = useCallback(() => {
    if (!localClient) {
      return null;
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const attempts = reconnectAttemptsRef.current;

    if (attempts >= MAX_RECONNECT_ATTEMPTS) {
      realtimeConnectedRef.current = false;
      startHttpPolling();
      updateConnectivity();
      return;
    }

    try {
      const ws = new WebSocket(`${wsBaseUrl}/ws/scale`);
      wsRef.current = ws;

      ws.onopen = () => {
        stopHttpPolling();
        realtimeConnectedRef.current = true;
        resetHttpTracking();
        updateReconnectAttempts(0);
        updateConnectivity();
      };

      ws.onmessage = (event) => {
        try {
          const data: WeightData = JSON.parse(event.data);
          if (typeof data.weight === "number") {
            setWeight(data.weight);
          }
          if (typeof data.stable === "boolean") {
            setIsStable(data.stable);
          }
          if (data.unit === "g" || data.unit === "ml") {
            setUnit(data.unit);
          }
        } catch (err) {
          console.error("Failed to parse WebSocket message:", err);
        }
      };

      ws.onerror = (event) => {
        console.error("WebSocket error:", event);
      };

      ws.onclose = (event) => {
        console.log("Scale WebSocket disconnected", event.code, event.reason);
        realtimeConnectedRef.current = false;
        wsRef.current = null;
        startHttpPolling();
        updateConnectivity();

        if (shouldReconnectRef.current && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          const currentAttempts = reconnectAttemptsRef.current;
          if (currentAttempts >= MAX_RECONNECT_ATTEMPTS) {
            return;
          }

          const delay = getReconnectDelay(currentAttempts);
          reconnectTimeoutRef.current = setTimeout(() => {
            updateReconnectAttempts(prev => prev + 1);
            connect();
          }, delay);
        }
      };

      return ws;
    } catch (err) {
      console.error("Failed to create WebSocket:", err);
      realtimeConnectedRef.current = false;
      startHttpPolling();
      updateConnectivity();

      if (shouldReconnectRef.current && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
        const currentAttempts = reconnectAttemptsRef.current;
        if (currentAttempts >= MAX_RECONNECT_ATTEMPTS) {
          return;
        }

        const delay = getReconnectDelay(currentAttempts);
        reconnectTimeoutRef.current = setTimeout(() => {
          updateReconnectAttempts(prev => prev + 1);
          connect();
        }, delay);
      }

      return null;
    }
  }, [localClient, resetHttpTracking, setIsStable, setUnit, setWeight, startHttpPolling, stopHttpPolling, updateConnectivity, updateReconnectAttempts, wsBaseUrl]);

  useEffect(() => {
    if (isDemoMode) {
      stopHttpPolling();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
      if (sseReconnectRef.current) {
        clearTimeout(sseReconnectRef.current);
        sseReconnectRef.current = null;
      }
      remoteSseActiveRef.current = false;
      realtimeConnectedRef.current = true;
      const now = Date.now();
      lastHttpOkAtRef.current = now;
      setLastHttpOkAt(now);
      setWeight(127.5);
      setIsStable(true);
      setUnit("g");
      setIsConnected(true);
      setError(null);
      setConnectionState("connected");
      return () => {
        realtimeConnectedRef.current = false;
        stopHttpPolling();
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
        if (sseReconnectRef.current) {
          clearTimeout(sseReconnectRef.current);
          sseReconnectRef.current = null;
        }
        updateConnectivity();
      };
    }

    if (!localClient) {
      shouldReconnectRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      realtimeConnectedRef.current = false;
      updateConnectivity();
      return () => {
        stopHttpPolling();
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }
      };
    }

    shouldReconnectRef.current = true;
    connect();

    return () => {
      shouldReconnectRef.current = false;
      stopHttpPolling();

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      realtimeConnectedRef.current = false;
      updateConnectivity();
    };
  }, [connect, isDemoMode, localClient, stopHttpPolling, updateConnectivity]);

  useEffect(() => {
    lastHttpOkAtRef.current = lastHttpOkAt;
  }, [lastHttpOkAt]);

  useEffect(() => {
    if (isDemoMode || localClient) {
      return;
    }

    if (typeof window === "undefined" || typeof window.EventSource === "undefined") {
      realtimeConnectedRef.current = false;
      updateConnectivity();
      startHttpPolling();
      return () => {
        stopHttpPolling();
      };
    }

    remoteSseActiveRef.current = true;

    const scheduleReconnect = () => {
      if (!remoteSseActiveRef.current) {
        return;
      }
      if (sseReconnectRef.current) {
        clearTimeout(sseReconnectRef.current);
      }
      sseReconnectRef.current = setTimeout(() => {
        if (!remoteSseActiveRef.current) {
          return;
        }
        realtimeConnectedRef.current = false;
        updateConnectivity();
        connectSse();
      }, 1500);
    };

    const connectSse = () => {
      if (!remoteSseActiveRef.current) {
        return;
      }

      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }

      try {
        const ssePath = "/api/scale/events";
        const sseBase = apiBaseUrl || "";
        const sseUrl = sseBase ? `${sseBase}${ssePath}` : ssePath;
        const source = new EventSource(sseUrl);
        sseRef.current = source;

        source.onopen = () => {
          if (!remoteSseActiveRef.current) {
            return;
          }
          realtimeConnectedRef.current = true;
          resetHttpTracking();
          stopHttpPolling();
          setError(null);
          updateReconnectAttempts(0);
          updateConnectivity();
        };

        source.addEventListener("weight", event => {
          if (!remoteSseActiveRef.current) {
            return;
          }

          try {
            const message = event as MessageEvent<string>;
            const payload = JSON.parse(message.data) as WeightResponse;
            const candidates: Array<number | string | null | undefined> = [
              payload?.value,
              payload?.weight,
              payload?.grams,
            ];
            let nextWeight: number | null = null;
            for (const raw of candidates) {
              if (typeof raw === "number" && Number.isFinite(raw)) {
                nextWeight = raw;
                break;
              }
              if (typeof raw === "string") {
                const parsed = Number(raw);
                if (!Number.isNaN(parsed)) {
                  nextWeight = parsed;
                  break;
                }
              }
              if (raw === null) {
                nextWeight = null;
                break;
              }
            }

            if (nextWeight === null) {
              return;
            }

            setWeight(nextWeight);
            if (typeof payload?.stable === "boolean") {
              setIsStable(payload.stable);
            } else {
              setIsStable(false);
            }
            if (payload?.unit === "ml" || payload?.unit === "g") {
              setUnit(payload.unit);
            } else {
              setUnit("g");
            }
            realtimeConnectedRef.current = true;
            updateConnectivity();
          } catch (err) {
            console.error("Failed to parse SSE weight event", err);
          }
        });

        source.onerror = () => {
          if (!remoteSseActiveRef.current) {
            return;
          }
          realtimeConnectedRef.current = false;
          updateConnectivity();
          startHttpPolling();
          scheduleReconnect();
        };
      } catch (err) {
        console.error("Failed to initialise SSE connection", err);
        realtimeConnectedRef.current = false;
        updateConnectivity();
        startHttpPolling();
        scheduleReconnect();
      }
    };

    connectSse();

    return () => {
      remoteSseActiveRef.current = false;
      if (sseReconnectRef.current) {
        clearTimeout(sseReconnectRef.current);
        sseReconnectRef.current = null;
      }
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
      stopHttpPolling();
      realtimeConnectedRef.current = false;
      updateConnectivity();
    };
  }, [
    isDemoMode,
    localClient,
    resetHttpTracking,
    setError,
    setIsStable,
    updateReconnectAttempts,
    setUnit,
    setWeight,
    startHttpPolling,
    stopHttpPolling,
    updateConnectivity,
    apiBaseUrl,
  ]);

  return {
    weight,
    isStable,
    unit,
    isConnected,
    error,
    reconnectAttempts,
    connectionState,
  };
};
