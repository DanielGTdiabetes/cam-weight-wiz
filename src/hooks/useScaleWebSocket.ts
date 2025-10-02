import { useEffect, useState, useCallback } from "react";
import type { WeightData } from "@/services/api";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8080";

interface UseScaleWebSocketReturn {
  weight: number;
  isStable: boolean;
  unit: "g" | "ml";
  isConnected: boolean;
  error: string | null;
}

export const useScaleWebSocket = (): UseScaleWebSocketReturn => {
  const [weight, setWeight] = useState(0);
  const [isStable, setIsStable] = useState(false);
  const [unit, setUnit] = useState<"g" | "ml">("g");
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(() => {
    try {
      const ws = new WebSocket(`${WS_URL}/ws/scale`);

      ws.onopen = () => {
        console.log("Scale WebSocket connected");
        setIsConnected(true);
        setError(null);
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
        setIsConnected(false);
      };

      ws.onclose = () => {
        console.log("Scale WebSocket disconnected");
        setIsConnected(false);
        
        // Reconnect after 3 seconds
        setTimeout(() => {
          console.log("Attempting to reconnect...");
          connect();
        }, 3000);
      };

      return ws;
    } catch (err) {
      console.error("Failed to create WebSocket:", err);
      setError("No se pudo conectar con la báscula");
      setIsConnected(false);
      return null;
    }
  }, []);

  useEffect(() => {
    const ws = connect();

    return () => {
      if (ws) {
        ws.close();
      }
    };
  }, [connect]);

  return {
    weight,
    isStable,
    unit,
    isConnected,
    error,
  };
};
