import { create } from "zustand";

export type ConnectivityLevel = "full" | "limited" | "offline" | "unknown";

export interface WifiNetwork {
  ssid: string;
  signal?: number;
  sec?: string;
  secured?: boolean;
  in_use?: boolean;
}

export interface NetworkStatus {
  connectivity?: string | null;
  mode?: string | null;
  effective_mode?: string | null;
  wifi?: {
    connected?: boolean;
    ssid?: string | null;
    ip?: string | null;
  } | null;
  ssid?: string | null;
  ip?: string | null;
  ip_address?: string | null;
  ethernet_connected?: boolean;
  ap_active?: boolean;
  interface?: string | null;
  should_activate_ap?: boolean;
  internet?: boolean;
  online?: boolean;
  offline_mode?: boolean;
  [key: string]: unknown;
}

export interface SettingsResponse {
  network?: {
    status?: NetworkStatus | null;
    openai_api_key?: string | null;
    [key: string]: unknown;
  } | null;
  nightscout?: {
    url?: string | null;
    token?: string | null;
    hasToken?: boolean | null;
    [key: string]: unknown;
  } | null;
  diabetes?: {
    nightscout_url?: string | null;
    nightscout_token?: string | null;
    [key: string]: unknown;
  } | null;
  ui?: {
    offline_mode?: boolean;
    [key: string]: unknown;
  } | null;
  nightscout_url?: string | null;
  nightscout_token?: string | null;
  openai_api_key?: string | null;
  [key: string]: unknown;
}

export type ToastLevel = "success" | "warning" | "error" | "info";

export interface ConfigToast {
  id: string;
  type: ToastLevel;
  title: string;
  description?: string;
  duration?: number;
}

export interface BusyState {
  [key: string]: boolean;
}

interface ConfigState {
  settings: SettingsResponse | null;
  networkStatus: NetworkStatus | null;
  busy: BusyState;
  toasts: ConfigToast[];
  setSettings: (settings: SettingsResponse | null) => void;
  setNetworkStatus: (status: NetworkStatus | null) => void;
  setBusy: (key: string, value: boolean) => void;
  addToast: (toast: Omit<ConfigToast, "id"> & { id?: string }) => string;
  removeToast: (id: string) => void;
  clearToasts: () => void;
}

const generateId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
};

export const useConfigStore = create<ConfigState>((set) => ({
  settings: null,
  networkStatus: null,
  busy: {},
  toasts: [],
  setSettings: (settings) =>
    set((state) => {
      const status =
        settings?.network && typeof settings.network === "object"
          ? (settings.network.status as NetworkStatus | null)
          : null;
      return {
        settings,
        networkStatus: status ?? state.networkStatus,
      };
    }),
  setNetworkStatus: (networkStatus) => set({ networkStatus }),
  setBusy: (key, value) =>
    set((state) => {
      const updated = { ...state.busy };
      if (!value) {
        delete updated[key];
      } else {
        updated[key] = true;
      }
      return { busy: updated };
    }),
  addToast: (toast) => {
    const id = toast.id ?? generateId();
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    return id;
  },
  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
  clearToasts: () => set({ toasts: [] }),
}));

export const selectSettings = (state: ConfigState) => state.settings;
export const selectNetworkStatus = (state: ConfigState) => state.networkStatus;
export const selectBusy = (state: ConfigState, key: string) => Boolean(state.busy[key]);
export const selectToasts = (state: ConfigState) => state.toasts;
