import { useEffect, useState, useCallback, useRef } from "react";
import type { WeightData } from "@/services/api";
import { storage } from "@/services/storage";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8080";
const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY = 1000; // 1 second
const MAX_RECONNECT_DELAY = 30000; // 30 seconds
const READ_POLL_INTERVAL = 300; // ms
const STATUS_POLL_INTERVAL = 2000; // ms

interface UseScaleWebSocketReturn {
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

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const shouldReconnectRef = useRef(true);
  const readIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const statusIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const readAbortControllerRef = useRef<AbortController | null>(null);
  const statusAbortControllerRef = useRef<AbortController | null>(null);
  const readInFlightRef = useRef(false);
  const statusInFlightRef = useRef(false);
  const isPollingRef = useRef(false);

  const settings = storage.getSettings();
  const defaultOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const apiBaseUrl = (settings.apiUrl || defaultOrigin).replace(/\/$/, "");
  const wsBaseUrl = (settings.wsUrl || WS_URL).replace(/\/$/, "");
  const isDemoMode = import.meta.env.VITE_DEMO === "true";

  const getReconnectDelay = (attempt: number): number => {
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY * Math.pow(2, attempt),
      MAX_RECONNECT_DELAY
    );
    return delay + Math.random() * 1000;
  };

  const stopPolling = useCallback(() => {
    if (readIntervalRef.current) {
      clearInterval(readIntervalRef.current);
      readIntervalRef.current = null;
    }

    if (statusIntervalRef.current) {
      clearInterval(statusIntervalRef.current);
      statusIntervalRef.current = null;
    }

    if (readAbortControllerRef.current) {
      readAbortControllerRef.current.abort();
      readAbortControllerRef.current = null;
    }

    if (statusAbortControllerRef.current) {
      statusAbortControllerRef.current.abort();
      statusAbortControllerRef.current = null;
    }

    readInFlightRef.current = false;
    statusInFlightRef.current = false;
    isPollingRef.current = false;
  }, []);

  const startPolling = useCallback(() => {
    if (isDemoMode || isPollingRef.current) {
      return;
    }

    isPollingRef.current = true;

    const fetchRead = async () => {
      if (readInFlightRef.current) {
        return;
      }

      readInFlightRef.current = true;
      readAbortControllerRef.current?.abort();
      const controller = new AbortController();
      readAbortControllerRef.current = controller;

      try {
        const response = await fetch(`${apiBaseUrl}/api/scale/read`, {
          signal: controller.signal,
        });

        if (response.status === 404) {
          setIsConnected(false);
          setError("Endpoint de lectura no encontrado");
          return;
        }

        if (!response.ok) {
          setIsConnected(false);
          setError("Error al leer la báscula");
          return;
        }

        const data = await response.json();

        if (data?.ok === true) {
          const gramsValue = typeof data.grams === "number"
            ? data.grams
            : typeof data.weight === "number"
              ? data.weight
              : 0;
          const stableValue = typeof data.stable === "boolean"
            ? data.stable
            : false;

          setWeight(gramsValue);
          setIsStable(stableValue);
          setUnit("g");
          setIsConnected(true);
          setError(null);
        } else {
          setIsConnected(false);
          if (typeof data?.reason === "string") {
            setError(data.reason);
          }
        }
      } catch (err) {
        if ((err as DOMException).name !== "AbortError") {
          setIsConnected(false);
          setError("No se pudo obtener el peso");
        }
      } finally {
        readInFlightRef.current = false;
      }
    };

    const fetchStatus = async () => {
      if (statusInFlightRef.current) {
        return;
      }

      statusInFlightRef.current = true;
      statusAbortControllerRef.current?.abort();
      const controller = new AbortController();
      statusAbortControllerRef.current = controller;

      try {
        const response = await fetch(`${apiBaseUrl}/api/scale/status`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          setIsConnected(false);
          return;
        }

        const data = await response.json();
        if (data?.ok === true) {
          setIsConnected(true);
        } else {
          setIsConnected(false);
          if (typeof data?.reason === "string") {
            setError(data.reason);
          }
        }
      } catch (err) {
        if ((err as DOMException).name !== "AbortError") {
          setIsConnected(false);
        }
      } finally {
        statusInFlightRef.current = false;
      }
    };

    void fetchRead();
    void fetchStatus();

    readIntervalRef.current = setInterval(() => {
      void fetchRead();
    }, READ_POLL_INTERVAL);

    statusIntervalRef.current = setInterval(() => {
      void fetchStatus();
    }, STATUS_POLL_INTERVAL);
  }, [apiBaseUrl, isDemoMode]);

  const connect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      setError(`No se pudo conectar después de ${MAX_RECONNECT_ATTEMPTS} intentos`);
      startPolling();
      return;
    }

    try {
      const ws = new WebSocket(`${wsBaseUrl}/ws/scale`);
      wsRef.current = ws;

      ws.onopen = () => {
        stopPolling();
        setIsConnected(true);
        setError(null);
        setReconnectAttempts(0);
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
        setError("Error de conexión con la báscula");
        setIsConnected(false);
        startPolling();
      };

      ws.onclose = (event) => {
        console.log("Scale WebSocket disconnected", event.code, event.reason);
        setIsConnected(false);
        wsRef.current = null;
        startPolling();

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
      setError("No se pudo conectar con la báscula");
      setIsConnected(false);
      startPolling();

      if (shouldReconnectRef.current && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = getReconnectDelay(reconnectAttempts);
        reconnectTimeoutRef.current = setTimeout(() => {
          setReconnectAttempts(prev => prev + 1);
          connect();
        }, delay);
      }

      return null;
    }
  }, [reconnectAttempts, startPolling, stopPolling, wsBaseUrl]);

  useEffect(() => {
    if (isDemoMode) {
      stopPolling();
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
        stopPolling();
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
      stopPolling();

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect, isDemoMode, stopPolling]);

  return {
    weight,
    isStable,
    unit,
    isConnected,
    error,
    reconnectAttempts,
  };
};
