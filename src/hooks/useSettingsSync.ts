/**
 * Hook para sincronización en tiempo real de configuración
 */
import { useEffect, useRef, useCallback } from 'react';
import { storage } from '@/services/storage';
import type { AppSettingsUpdate } from '@/services/storage';
import { logger } from '@/services/logger';

const WS_BASE_URL = (() => {
  if (typeof window !== 'undefined' && window.location?.origin) {
    const loc = window.location;
    const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${loc.host}`;
  }
  return import.meta.env.VITE_WS_URL || "ws://127.0.0.1:8080";
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
    fetch('/api/settings', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        // Actualizar storage local
        const updates: Record<string, unknown> = {};
        
        const networkChanged = message.fields.includes('network') || message.fields.includes('openai');
        if (networkChanged && data.network?.openai_api_key) {
          updates.chatGptKey = data.network.openai_api_key === '__stored__' ? '' : data.network.openai_api_key;
        }

        const diabetesChanged = message.fields.includes('diabetes') || message.fields.includes('nightscout');
        if (diabetesChanged && data.diabetes) {
          if (
            typeof data.diabetes.nightscout_url === 'string' &&
            data.diabetes.nightscout_url !== '__stored__'
          ) {
            updates.nightscoutUrl = data.diabetes.nightscout_url;
          }
          if (data.diabetes.nightscout_token === '__stored__') {
            // Mantener el token actual si está guardado
          } else if (data.diabetes.nightscout_token) {
            updates.nightscoutToken = data.diabetes.nightscout_token;
          }
        }
        
        if (message.fields.includes('ui') && data.ui) {
          if (data.ui.flags) {
            updates.ui = { flags: data.ui.flags };
          }
        }
        
        if (Object.keys(updates).length > 0) {
          storage.saveSettings(updates as AppSettingsUpdate);
          
          // Dispatch event para que componentes reaccionen
          window.dispatchEvent(new CustomEvent('settings-synced', {
            detail: { fields: message.fields, updates },
          }));
        }
      })
      .catch((err) => {
        const error = err instanceof Error ? err.message : 'Unknown error';
        logger.error('[SettingsSync] Failed to reload settings', { error });
      });
  }, []);

  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const message: SettingsMessage = JSON.parse(event.data);
      
      if (message.type === 'settings.initial') {
        logger.debug('[SettingsSync] Received initial settings');
      } else if (message.type === 'settings.changed') {
        handleSettingsChanged(message);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      logger.debug('[SettingsSync] Failed to parse message', { error });
    }
  }, [handleSettingsChanged]);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    
    cleanup();

    try {
      const ws = new WebSocket(`${WS_BASE_URL}/ws/updates`);
      wsRef.current = ws;

      ws.onopen = () => {
        logger.debug('[SettingsSync] Connected');
        
        // Iniciar ping para mantener conexión
        pingIntervalRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('ping');
          }
        }, PING_INTERVAL);
      };

      ws.onmessage = handleMessage;

      ws.onerror = () => {
        logger.debug('[SettingsSync] WebSocket error');
      };

      ws.onclose = () => {
        logger.debug('[SettingsSync] Disconnected');
        
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
      const error = err instanceof Error ? err.message : 'Unknown error';
      logger.error('[SettingsSync] Failed to create WebSocket', { error });
      
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
