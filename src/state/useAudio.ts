import { useCallback, useEffect, useSyncExternalStore } from "react";
import { storage } from "@/services/storage";

const LS_KEY = "bascula.voiceEnabled";
const LEGACY_MUTED_KEY = "bascula.voiceMuted";

type Listener = () => void;

let voiceEnabledState = true;
const listeners = new Set<Listener>();
let hasInitialized = false;
let attemptedRemoteFallback = false;

const notify = () => {
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: Listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => voiceEnabledState;

const normalizeBoolean = (value: unknown): boolean | null => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "n", "off"].includes(normalized)) {
      return false;
    }
  }

  return null;
};

const persistSettings = (enabled: boolean, shouldPersist: boolean, updateSettings: boolean) => {
  if (typeof window !== "undefined" && shouldPersist) {
    try {
      window.localStorage.setItem(LS_KEY, String(enabled));
    } catch (error) {
      console.warn("No se pudo guardar bascula.voiceEnabled en localStorage", error);
    }
  }

  if (typeof window !== "undefined" && updateSettings) {
    try {
      storage.saveSettings({ isVoiceActive: enabled });
    } catch (error) {
      console.warn("No se pudo sincronizar la preferencia de voz con storage", error);
    }
  }
};

const applyState = (
  next: boolean,
  { persist = false, updateSettings = false }: { persist?: boolean; updateSettings?: boolean } = {}
) => {
  const changed = voiceEnabledState !== next;
  voiceEnabledState = next;
  persistSettings(next, persist, updateSettings);

  if (changed) {
    notify();
  }
};

const syncFromLegacyKey = () => {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    const legacy = window.localStorage.getItem(LEGACY_MUTED_KEY);
    if (legacy === null) {
      return false;
    }

    const normalized = normalizeBoolean(legacy);
    const enabled = normalized === null ? voiceEnabledState : !normalized;
    window.localStorage.removeItem(LEGACY_MUTED_KEY);
    applyState(enabled, { persist: true, updateSettings: true });
    return true;
  } catch (error) {
    console.warn("No se pudo migrar la preferencia legacy de voz", error);
    return false;
  }
};

const attemptRemoteFallback = async () => {
  if (attemptedRemoteFallback || typeof fetch !== "function") {
    return;
  }
  attemptedRemoteFallback = true;

  try {
    const response = await fetch("/api/voice/state", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return;
    }

    const data = (await response.json()) as { enabled?: unknown } | undefined;
    const normalized = normalizeBoolean(data?.enabled);
    if (normalized !== null) {
      applyState(normalized, { persist: true, updateSettings: true });
    }
  } catch (error) {
    console.warn("No se pudo obtener el estado de voz del backend", error);
  }
};

const ensureInitialized = () => {
  if (hasInitialized || typeof window === "undefined") {
    return;
  }
  hasInitialized = true;

  try {
    const stored = window.localStorage.getItem(LS_KEY);
    if (stored !== null) {
      const normalized = normalizeBoolean(stored);
      if (normalized !== null) {
        applyState(normalized);
        return;
      }
    }
  } catch (error) {
    console.warn("No se pudo leer bascula.voiceEnabled", error);
  }

  if (syncFromLegacyKey()) {
    return;
  }

  try {
    const settingsValue = storage.getSettings().isVoiceActive;
    if (typeof settingsValue === "boolean") {
      applyState(settingsValue, { persist: true });
      return;
    }
  } catch (error) {
    console.warn("No se pudo sincronizar la preferencia de voz desde settings", error);
  }

  applyState(true, { persist: true, updateSettings: true });
  void attemptRemoteFallback();
};

const postVoicePreference = async (enabled: boolean) => {
  if (typeof fetch !== "function") {
    return;
  }

  try {
    await fetch("/api/voice/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
  } catch (error) {
    console.warn("No se pudo enviar la preferencia de voz al backend", error);
  }
};

export const useAudioPref = () => {
  ensureInitialized();

  const voiceEnabled = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    ensureInitialized();
  }, []);

  const setEnabled = useCallback(async (next: boolean) => {
    if (voiceEnabledState === next) {
      persistSettings(next, true, true);
      return;
    }

    applyState(next, { persist: true, updateSettings: true });
    await postVoicePreference(next);
  }, []);

  return { voiceEnabled, setEnabled } as const;
};
