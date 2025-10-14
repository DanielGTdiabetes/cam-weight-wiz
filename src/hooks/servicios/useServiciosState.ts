import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackendStatePayload } from '@/services/api';
import { logger } from '@/services/logger';

type ApiWrapper = typeof import('@/services/apiWrapper')['apiWrapper'];

let apiWrapperPromise: Promise<ApiWrapper> | null = null;

const getApiWrapper = (): Promise<ApiWrapper> => {
  if (apiWrapperPromise === null) {
    apiWrapperPromise = import('@/services/apiWrapper').then((module) => module.apiWrapper);
  }
  return apiWrapperPromise;
};

interface FailureCounts {
  health: number;
  settings: number;
  scale: number;
}

type CriticalKey = keyof FailureCounts;

interface CriticalEndpoint {
  key: CriticalKey;
  url: string;
}

const CRITICAL_ENDPOINTS: CriticalEndpoint[] = [
  { key: 'health', url: '/api/health' },
  { key: 'settings', url: '/api/settings' },
  { key: 'scale', url: '/api/scale/status' },
];

const FAILURE_THRESHOLD = 3;
const POLL_INTERVAL_MS = 8000;
const STATE_TIMEOUT_MS = 3500;
const CRITICAL_TIMEOUT_MS = 4000;

const DEFAULT_FAILURE_COUNTS: FailureCounts = {
  health: 0,
  settings: 0,
  scale: 0,
};

export interface ServiciosStateResult {
  state: BackendStatePayload | null;
  warning: string | null;
  recoveryActive: boolean;
  lastUpdated: number | null;
}

export const useServiciosState = (): ServiciosStateResult => {
  const [state, setState] = useState<BackendStatePayload | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [recoveryActive, setRecoveryActive] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const failureCountsRef = useRef<FailureCounts>({ ...DEFAULT_FAILURE_COUNTS });
  const recoveryTriggeredRef = useRef(false);
  const pollTimeoutRef = useRef<number | null>(null);
  const mountedRef = useRef(false);

  const refreshState = useCallback(async () => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const wrapper = await getApiWrapper();
      const payload = await wrapper.request<BackendStatePayload>('/api/state', {
        timeout: STATE_TIMEOUT_MS,
      });
      if (!mountedRef.current) {
        return;
      }
      setState(payload);
      setLastUpdated(Date.now());
      if (warning !== null) {
        setWarning(null);
      }
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }

      const message = error instanceof Error ? error.message : 'error desconocido';
      logger.debug('[ServiciosState] /api/state falló', {
        message,
      });

      setWarning('No se pudo obtener el estado del sistema (se reintentará).');
    }
  }, [warning]);

  const pingEndpoint = useCallback(async (endpoint: CriticalEndpoint): Promise<boolean> => {
    if (typeof window === 'undefined') {
      return true;
    }

    try {
      const wrapper = await getApiWrapper();
      await wrapper.request<unknown>(endpoint.url, { timeout: CRITICAL_TIMEOUT_MS });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'error desconocido';
      logger.debug(`[ServiciosState] ping falló ${endpoint.url}`, { message });
      return false;
    }
  }, []);

  const refreshCriticalEndpoints = useCallback(async () => {
    let countsChanged = false;

    for (const endpoint of CRITICAL_ENDPOINTS) {
      const ok = await pingEndpoint(endpoint);
      const previous = failureCountsRef.current[endpoint.key];
      if (ok) {
        if (previous !== 0) {
          failureCountsRef.current[endpoint.key] = 0;
          countsChanged = true;
        }
      } else {
        const next = Math.min(FAILURE_THRESHOLD, previous + 1);
        if (next !== previous) {
          failureCountsRef.current[endpoint.key] = next;
          countsChanged = true;
        }
      }
    }

    if (!mountedRef.current) {
      return;
    }

    const shouldRecover = Object.values(failureCountsRef.current).some((count) => count >= FAILURE_THRESHOLD);

    setRecoveryActive((prev) => (prev !== shouldRecover ? shouldRecover : prev));

    if (shouldRecover && !recoveryTriggeredRef.current && typeof window !== 'undefined') {
      recoveryTriggeredRef.current = true;
      try {
        localStorage.setItem('recovery_mode', 'true');
      } catch (error) {
        logger.debug('[ServiciosState] No se pudo marcar recovery_mode en localStorage', {
          error: error instanceof Error ? error.message : error,
        });
      }
    }

    if (countsChanged) {
      logger.debug('[ServiciosState] Estado crítico actualizado', failureCountsRef.current);
    }
  }, [pingEndpoint]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    mountedRef.current = true;

    const poll = async () => {
      if (!mountedRef.current) {
        return;
      }

      await refreshState();
      await refreshCriticalEndpoints();

      if (!mountedRef.current) {
        return;
      }

      pollTimeoutRef.current = window.setTimeout(poll, POLL_INTERVAL_MS);
    };

    void poll();

    return () => {
      mountedRef.current = false;
      if (pollTimeoutRef.current) {
        window.clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    };
  }, [refreshCriticalEndpoints, refreshState]);

  return {
    state,
    warning,
    recoveryActive,
    lastUpdated,
  };
};
