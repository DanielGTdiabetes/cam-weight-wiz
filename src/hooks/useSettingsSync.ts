/**
 * Hook para sincronización en tiempo real de configuración
 */
import { useEffect, useRef, useCallback } from 'react';
import { storage } from "@/services/storage";
import type { AppSettingsUpdate } from "@/services/storage";
import { logger } from "@/services/logger";
import { buildAppSettingsUpdateFromBackend } from "@/lib/backendSettings";

const normalizeHostnameForWs = (hostname: string) => {
  if (hostname.includes(":") && !hostname.startsWith("[") && !hostname.endsWith("]")) {
    return `[${hostname}]`;
  }
  return hostname;
};

const WS_BASE_URL = (() => {
  if (typeof window !== 'undefined' && window.location?.origin) {
    const loc = window.location;
    const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
    // For settings sync, always use backend port (8081) not miniweb (8080)
    // This ensures external browsers can sync settings with the main backend
    const hostname = loc.hostname;
    const normalizedHostname = normalizeHostnameForWs(hostname);
    const port = loc.port;

    // If accessing via localhost/127.0.0.1, force backend port
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return `${scheme}://${normalizedHostname}:8081`;
    }

    // For external access, try to determine if we're on port 8080 (miniweb) and switch to 8081
    if (port === '8080') {
      return `${scheme}://${normalizedHostname}:8081`;
    }

    return `${scheme}://${loc.host}`;
  }
  return import.meta.env.VITE_WS_URL || "ws://127.0.0.1:8081";
})();

const RECONNECT_DELAY = 3000;
const PING_INTERVAL = 30000;

interface SettingsChangedMessage {
  type: 'settings.changed';
  version: number;
  fields: string[];
  metadata: Record<string, unknown>;
  timestamp: string;
}

interface SettingsInitialMessage {
  type: 'settings.initial';
  data: Record<string, unknown>;
}

type SettingsMessage = SettingsChangedMessage | SettingsInitialMessage;

export const useSettingsSync = () => {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const pingIntervalRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const cleanup = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (pingIntervalRef.current) {
      window.clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const handleSettingsChanged = useCallback((message: SettingsChangedMessage) => {
    logger.debug('[SettingsSync] Settings changed', {
      fields: message.fields,
      version: message.version,
    });

    // Recargar configuración del backend
    fetch("/api/settings", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        const payload = data as Record<string, unknown>;
        const updates = buildAppSettingsUpdateFromBackend(payload);
        if (Object.keys(updates).length > 0) {
          storage.saveSettings(updates as AppSettingsUpdate);
          window.dispatchEvent(
            new CustomEvent("settings-synced", {
              detail: { fields: message.fields, updates },
            }),
          );
        }
      })
      .catch((err) => {
        const error = err instanceof Error ? err.message : "Unknown error";
        logger.error("[SettingsSync] Failed to reload settings", { error });
      });
  }, []);

  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const message: SettingsMessage = JSON.parse(event.data);
      
      if (message.type === "settings.initial") {
        logger.debug("[SettingsSync] Received initial settings");
        const updates = buildAppSettingsUpdateFromBackend(message.data);
        if (Object.keys(updates).length > 0) {
          storage.saveSettings(updates as AppSettingsUpdate);
          window.dispatchEvent(
            new CustomEvent("settings-synced", {
              detail: { fields: ["initial"], updates },
            }),
          );
        }
      } else if (message.type === "settings.changed") {
        handleSettingsChanged(message);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown error";
      logger.debug("[SettingsSync] Failed to parse message", { error });
    }
  }, [handleSettingsChanged]);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    
    cleanup();

    try {
      const ws = new WebSocket(`${WS_BASE_URL}/ws/updates`);
      wsRef.current = ws;

      ws.onopen = () => {
        logger.debug("[SettingsSync] Connected");
        
        // Iniciar ping para mantener conexión
        pingIntervalRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('ping');
          }
        }, PING_INTERVAL);
      };

      ws.onmessage = handleMessage;

      ws.onerror = () => {
        logger.debug("[SettingsSync] WebSocket error");
      };

      ws.onclose = () => {
        logger.debug("[SettingsSync] Disconnected");
        
        if (pingIntervalRef.current) {
          window.clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        // Reconectar si aún está montado
        if (mountedRef.current) {
          reconnectTimeoutRef.current = window.setTimeout(() => {
            connect();
          }, RECONNECT_DELAY);
        }
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown error";
      logger.error("[SettingsSync] Failed to create WebSocket", { error });
      
      // Reconectar
      if (mountedRef.current) {
        reconnectTimeoutRef.current = window.setTimeout(() => {
          connect();
        }, RECONNECT_DELAY);
      }
    }
  }, [cleanup, handleMessage]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [connect, cleanup]);
};
