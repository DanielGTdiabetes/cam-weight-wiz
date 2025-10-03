import { useEffect, useState, useCallback, useRef } from "react";
import type { WeightData } from "@/services/api";
import { storage } from "@/services/storage";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://127.0.0.1:8080";
const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY = 1000; // 1 second
const MAX_RECONNECT_DELAY = 30000; // 30 seconds
const HTTP_POLL_MS = 500;
const ERROR_GRACE_MS = 5000;

type ReadResp = {
  ok?: boolean;
  grams?: number;
  stable?: boolean;
  weight?: number;
  reason?: string;
};

export interface UseScaleWebSocketReturn {
  weight: number;
  isStable: boolean;
  unit: "g" | "ml";
  isConnected: boolean;
  error: string | null;
  reconnectAttempts: number;
}

export const useScaleWebSocket = (): UseScaleWebSocketReturn => {
  const [weight, setWeight] = useState(0);
  const [isStable, setIsStable] = useState(false);
  const [unit, setUnit] = useState<"g" | "ml">("g");
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [lastHttpOkAt, setLastHttpOkAt] = useState<number>(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const shouldReconnectRef = useRef(true);
  const httpIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const httpAbortControllerRef = useRef<AbortController | null>(null);
  const httpInFlightRef = useRef(false);
  const isWsConnectedRef = useRef(false);
  const lastHttpOkAtRef = useRef(0);

  const settings = storage.getSettings();
  const defaultOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const apiBaseUrl = (settings.apiUrl || defaultOrigin).replace(/\/$/, "");
  const wsBaseUrl = (settings.wsUrl || WS_URL).replace(/\/$/, "");
  const hostname = typeof window !== "undefined" ? window.location.hostname : "";
  const isDemoMode = /\.lovable\.app$/i.test(hostname);

  const updateConnectivity = useCallback(() => {
    const now = Date.now();
    const hasRecentHttp =
      lastHttpOkAtRef.current > 0 && now - lastHttpOkAtRef.current <= ERROR_GRACE_MS;
    const wsConnected = isWsConnectedRef.current;

    setIsConnected(wsConnected || hasRecentHttp);

    const showConnError = !wsConnected && !hasRecentHttp;
    setError(showConnError ? "Error de conexión con la báscula" : null);
  }, [setError, setIsConnected]);

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

    const fetchRead = async () => {
      if (httpInFlightRef.current) {
        return;
      }

      httpInFlightRef.current = true;
      httpAbortControllerRef.current?.abort();
      const controller = new AbortController();
      httpAbortControllerRef.current = controller;

      try {
        const response = await fetch(`${apiBaseUrl}/api/scale/read`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          handleHttpOutcome(false);
          return;
        }

        const data: ReadResp = await response.json();

        if (data?.ok === false) {
          handleHttpOutcome(false);
          return;
        }

        const gramsValue =
          typeof data.grams === "number"
            ? data.grams
            : typeof data.weight === "number"
              ? data.weight
              : 0;

        setWeight(gramsValue);
        setUnit("g");

        if (typeof data.stable === "boolean") {
          setIsStable(data.stable);
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
  }, [apiBaseUrl, ensureGracePeriod, handleHttpOutcome, isDemoMode, setIsStable, setUnit, setWeight]);

  const getReconnectDelay = (attempt: number): number => {
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY * Math.pow(2, attempt),
      MAX_RECONNECT_DELAY
    );
    return delay + Math.random() * 1000;
  };

  const connect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      isWsConnectedRef.current = false;
      startHttpPolling();
      updateConnectivity();
      return;
    }

    try {
      const ws = new WebSocket(`${wsBaseUrl}/ws/scale`);
      wsRef.current = ws;

      ws.onopen = () => {
        stopHttpPolling();
        isWsConnectedRef.current = true;
        resetHttpTracking();
        setReconnectAttempts(0);
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
        isWsConnectedRef.current = false;
        wsRef.current = null;
        startHttpPolling();
        updateConnectivity();

        if (shouldReconnectRef.current && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          const delay = getReconnectDelay(reconnectAttempts);
          reconnectTimeoutRef.current = setTimeout(() => {
            setReconnectAttempts(prev => prev + 1);
            connect();
          }, delay);
        }
      };

      return ws;
    } catch (err) {
      console.error("Failed to create WebSocket:", err);
      isWsConnectedRef.current = false;
      startHttpPolling();
      updateConnectivity();

      if (shouldReconnectRef.current && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = getReconnectDelay(reconnectAttempts);
        reconnectTimeoutRef.current = setTimeout(() => {
          setReconnectAttempts(prev => prev + 1);
          connect();
        }, delay);
      }

      return null;
    }
  }, [reconnectAttempts, resetHttpTracking, setIsStable, setUnit, setWeight, startHttpPolling, stopHttpPolling, updateConnectivity, wsBaseUrl]);

  useEffect(() => {
    if (isDemoMode) {
      stopHttpPolling();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setWeight(127.5);
      setIsStable(true);
      setUnit("g");
      setIsConnected(true);
      setError(null);
      return () => {
        stopHttpPolling();
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
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
    };
  }, [connect, isDemoMode, stopHttpPolling]);

  useEffect(() => {
    lastHttpOkAtRef.current = lastHttpOkAt;
  }, [lastHttpOkAt]);

  return {
    weight,
    isStable,
    unit,
    isConnected,
    error,
    reconnectAttempts,
  };
};
