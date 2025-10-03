import { useEffect, useState, useCallback, useRef } from "react";
import type { WeightData } from "@/services/api";
import { storage } from "@/services/storage";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8080";
const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY = 1000; // 1 second
const MAX_RECONNECT_DELAY = 30000; // 30 seconds

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
  const mockIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Load settings
  const settings = storage.getSettings();
  
  // Detect if we're in demo/preview mode (no real backend)
  const isDemoMode = window.location.hostname.includes('lovable.app') || 
                     window.location.hostname === 'localhost';

  // Calculate exponential backoff delay
  const getReconnectDelay = (attempt: number): number => {
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY * Math.pow(2, attempt),
      MAX_RECONNECT_DELAY
    );
    // Add jitter to prevent thundering herd
    return delay + Math.random() * 1000;
  };

  const connect = useCallback(() => {
    // Clear any existing reconnect timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Stop if max attempts reached
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      setError(`No se pudo conectar después de ${MAX_RECONNECT_ATTEMPTS} intentos`);
      console.error("Max reconnect attempts reached");
      return;
    }

    try {
      const wsUrl = settings.wsUrl || WS_URL;
      const ws = new WebSocket(`${wsUrl}/ws/scale`);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("Scale WebSocket connected");
        setIsConnected(true);
        setError(null);
        setReconnectAttempts(0); // Reset on successful connection
      };

      ws.onmessage = (event) => {
        try {
          const data: WeightData = JSON.parse(event.data);
          setWeight(data.weight);
          setIsStable(data.stable);
          setUnit(data.unit);
        } catch (err) {
          console.error("Failed to parse WebSocket message:", err);
        }
      };

      ws.onerror = (event) => {
        console.error("WebSocket error:", event);
        setError("Error de conexión con la báscula");
      };

      ws.onclose = (event) => {
        console.log("Scale WebSocket disconnected", event.code, event.reason);
        setIsConnected(false);
        wsRef.current = null;
        
        // Only reconnect if component is still mounted and we should reconnect
        if (shouldReconnectRef.current && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          const delay = getReconnectDelay(reconnectAttempts);
          console.log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
          
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
      
      // Retry connection
      if (shouldReconnectRef.current && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = getReconnectDelay(reconnectAttempts);
        reconnectTimeoutRef.current = setTimeout(() => {
          setReconnectAttempts(prev => prev + 1);
          connect();
        }, delay);
      }
      
      return null;
    }
  }, [reconnectAttempts, settings.wsUrl]);

  useEffect(() => {
    // In demo mode, generate mock weight data
    if (isDemoMode) {
      console.log("🎭 Demo mode: Using mock weight data");
      setIsConnected(true);
      setError(null);
      
      // Simulate weight fluctuations
      let mockWeight = 125.0;
      let stable = false;
      let cycles = 0;
      
      mockIntervalRef.current = setInterval(() => {
        cycles++;
        
        // Simulate stabilization after 3 seconds
        if (cycles > 6) {
          stable = true;
          mockWeight = 127.5 + (Math.random() * 0.2 - 0.1);
        } else {
          stable = false;
          mockWeight = 125 + Math.random() * 5;
        }
        
        setWeight(Number(mockWeight.toFixed(1)));
        setIsStable(stable);
        setUnit("g");
      }, 500);
      
      return () => {
        if (mockIntervalRef.current) {
          clearInterval(mockIntervalRef.current);
        }
      };
    }
    
    // Real WebSocket connection for production
    shouldReconnectRef.current = true;
    connect();

    return () => {
      shouldReconnectRef.current = false;
      
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      
      if (mockIntervalRef.current) {
        clearInterval(mockIntervalRef.current);
      }
    };
  }, [connect, isDemoMode]);

  return {
    weight,
    isStable,
    unit,
    isConnected,
    error,
    reconnectAttempts,
  };
};
