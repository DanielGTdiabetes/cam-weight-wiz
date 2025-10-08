import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useConfigStore,
  selectSettings,
  selectNetworkStatus,
  type NetworkStatus,
  type SettingsResponse,
  type WifiNetwork,
  type ToastLevel,
} from "@/stores/configStore";
import { ConfigToastManager } from "@/components/config/ConfigToastManager";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  Globe,
  Keyboard,
  Loader2,
  Lock,
  RefreshCw,
  RotateCw,
  Router,
  ShieldAlert,
  ShieldCheck,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Unlock,
  Wifi,
} from "lucide-react";

const CONNECTIVITY_LABELS: Record<string, string> = {
  full: "Conectado",
  limited: "Limitado",
  offline: "Sin conexión",
};

const CONNECTIVITY_STYLES: Record<string, string> = {
  full: "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-200",
  limited: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-100",
  offline: "bg-red-100 text-red-900 dark:bg-red-500/20 dark:text-red-200",
  unknown: "bg-slate-100 text-slate-800 dark:bg-slate-500/20 dark:text-slate-200",
};

const resolveConnectivity = (status: NetworkStatus | null): "full" | "limited" | "offline" | "unknown" => {
  if (!status) {
    return "unknown";
  }
  const raw = (status.connectivity || "").toLowerCase();
  if (raw === "full" || raw === "limited" || raw === "offline") {
    return raw;
  }
  if (status.internet === true) {
    return "full";
  }
  if (status.online === true) {
    return "limited";
  }
  return "offline";
};

const safeString = (value: unknown): string => (typeof value === "string" ? value : "");

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
};

const extractMessage = (payload: unknown): string | undefined => {
  if (typeof payload === "string") {
    return payload;
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const detail = record.detail ?? record.message ?? record.error ?? record.reason;
    if (typeof detail === "string") {
      return detail;
    }
  }
  return undefined;
};

const computeSignalIcon = (signal?: number) => {
  if (typeof signal !== "number") {
    return <SignalLow className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
  }
  if (signal >= 75) {
    return <SignalHigh className="h-4 w-4 text-emerald-500" aria-hidden="true" />;
  }
  if (signal >= 45) {
    return <SignalMedium className="h-4 w-4 text-amber-500" aria-hidden="true" />;
  }
  return <SignalLow className="h-4 w-4 text-red-500" aria-hidden="true" />;
};

const resolveSecretFromSettings = (
  settings: SettingsResponse | null,
  keys: Array<{ path: (settings: SettingsResponse) => unknown }>,
): { stored: boolean; value: string } => {
  if (!settings) {
    return { stored: false, value: "" };
  }

  for (const key of keys) {
    try {
      const candidate = key.path(settings);
      if (typeof candidate === "string") {
        if (candidate === "__stored__") {
          return { stored: true, value: "" };
        }
        if (candidate.trim().length > 0) {
          return { stored: false, value: candidate };
        }
      }
    } catch (error) {
      // Ignore malformed paths
    }
  }

  return { stored: false, value: "" };
};

const isLocalDevice = (): boolean => {
  const host = window.location.hostname;
  const ua = window.navigator.userAgent.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return true;
  }
  if (host.endsWith(".local")) {
    return true;
  }
  if (ua.includes("bascula")) {
    return true;
  }
  if (ua.includes("raspberry") || ua.includes("armv7") || ua.includes("aarch64")) {
    return true;
  }
  return false;
};

export const MiniWebConfig = () => {
  const settings = useConfigStore(selectSettings);
  const networkStatus = useConfigStore(selectNetworkStatus);
  const setSettings = useConfigStore((state) => state.setSettings);
  const setNetwork = useConfigStore((state) => state.setNetworkStatus);
  const setBusy = useConfigStore((state) => state.setBusy);
  const pushToast = useConfigStore((state) => state.addToast);

  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [scanningNetworks, setScanningNetworks] = useState(false);
  const [connectingWifi, setConnectingWifi] = useState(false);
  const [offlineSaving, setOfflineSaving] = useState(false);
  const [openaiSaving, setOpenaiSaving] = useState(false);
  const [openaiTesting, setOpenaiTesting] = useState(false);
  const [nightscoutSaving, setNightscoutSaving] = useState(false);
  const [nightscoutTesting, setNightscoutTesting] = useState(false);
  const [uiRefreshing, setUiRefreshing] = useState(false);

  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [selectedSsid, setSelectedSsid] = useState("");
  const [selectedNetwork, setSelectedNetwork] = useState<WifiNetwork | null>(null);
  const [wifiPassword, setWifiPassword] = useState("");
  const [connectFeedback, setConnectFeedback] = useState<string | null>(null);

  const openaiEditedRef = useRef(false);
  const nightscoutUrlEditedRef = useRef(false);
  const nightscoutTokenEditedRef = useRef(false);
  const userSelectedNetworkRef = useRef(false);

  const [openaiInput, setOpenaiInput] = useState("");
  const [openaiStored, setOpenaiStored] = useState(false);
  const [nightscoutUrl, setNightscoutUrl] = useState("");
  const [nightscoutToken, setNightscoutToken] = useState("");
  const [nightscoutUrlStored, setNightscoutUrlStored] = useState(false);
  const [nightscoutTokenStored, setNightscoutTokenStored] = useState(false);

  const apiOrigin = useMemo(() => window.location.origin, []);

  const buildUrl = useCallback(
    (path: string) => new URL(path, apiOrigin).toString(),
    [apiOrigin],
  );

  const addToast = useCallback(
    (type: ToastLevel, title: string, description?: string) => {
      pushToast({ type, title, description });
    },
    [pushToast],
  );

  const syncSecretsFromSettings = useCallback(
    (payload: SettingsResponse | null) => {
      const openaiInfo = resolveSecretFromSettings(payload, [
        { path: (data) => data?.network?.openai_api_key },
        { path: (data) => data?.openai_api_key },
        {
          path: (data) =>
            data && typeof data.integrations === "object"
              ? (data.integrations as Record<string, unknown>)?.openai_api_key
              : undefined,
        },
      ]);
      setOpenaiStored(openaiInfo.stored);
      if (!openaiEditedRef.current) {
        setOpenaiInput(openaiInfo.stored ? "" : openaiInfo.value);
      }

      const nightscoutUrlInfo = resolveSecretFromSettings(payload, [
        { path: (data) => data?.diabetes?.nightscout_url },
        { path: (data) => data?.nightscout_url },
        {
          path: (data) =>
            data && typeof data.diabetes === "object"
              ? (data.diabetes as Record<string, unknown>)?.ns_url
              : undefined,
        },
      ]);
      setNightscoutUrlStored(nightscoutUrlInfo.stored);
      if (!nightscoutUrlEditedRef.current) {
        setNightscoutUrl(nightscoutUrlInfo.stored ? "" : nightscoutUrlInfo.value);
      }

      const nightscoutTokenInfo = resolveSecretFromSettings(payload, [
        { path: (data) => data?.diabetes?.nightscout_token },
        { path: (data) => data?.nightscout_token },
        {
          path: (data) =>
            data && typeof data.diabetes === "object"
              ? (data.diabetes as Record<string, unknown>)?.ns_token
              : undefined,
        },
      ]);
      setNightscoutTokenStored(nightscoutTokenInfo.stored);
      if (!nightscoutTokenEditedRef.current) {
        setNightscoutToken(nightscoutTokenInfo.stored ? "" : nightscoutTokenInfo.value);
      }
    },
    [],
  );

  const applySettingsPayload = useCallback(
    (payload: SettingsResponse | null) => {
      setSettings(payload ?? null);
      const status =
        payload && typeof payload.network === "object"
          ? (payload.network?.status as NetworkStatus | null)
          : null;
      setNetwork(status ?? null);
      syncSecretsFromSettings(payload ?? null);

      if (!userSelectedNetworkRef.current && status) {
        const ssidCandidate = safeString(status.ssid || status.wifi?.ssid);
        if (ssidCandidate) {
          setSelectedSsid(ssidCandidate);
        }
      }
    },
    [setSettings, setNetwork, syncSecretsFromSettings],
  );

  const fetchSettings = useCallback(
    async (showErrors = true) => {
      try {
        const response = await fetch(buildUrl("/api/settings"), { cache: "no-store" });
        if (!response.ok) {
          const payload = await readJson(response);
          if (showErrors) {
            const message =
              response.status === 422
                ? extractMessage(payload) ?? "Datos inválidos"
                : extractMessage(payload) ?? "No se pudo obtener la configuración.";
            const type: ToastLevel = response.status === 422 ? "warning" : "error";
            addToast(type, response.status === 422 ? "Datos inválidos" : "Error al cargar", message);
          }
          return false;
        }
        const data = (await readJson(response)) as SettingsResponse | null;
        applySettingsPayload(data ?? null);
        return true;
      } catch (error) {
        if (showErrors) {
          addToast("error", "Error de red", "No se pudo obtener la configuración.");
        }
        return false;
      }
    },
    [addToast, applySettingsPayload, buildUrl],
  );

  const handleLoadSettings = useCallback(async () => {
    setBusy("settings", true);
    const ok = await fetchSettings(true);
    if (!ok) {
      setNetworks([]);
    }
    setBusy("settings", false);
  }, [fetchSettings, setBusy]);

  const handleRefreshStatus = useCallback(async () => {
    setBusy("settings", true);
    setStatusRefreshing(true);
    await fetchSettings(true);
    setStatusRefreshing(false);
    setBusy("settings", false);
  }, [fetchSettings, setBusy]);

  useEffect(() => {
    void handleLoadSettings();
  }, [handleLoadSettings]);

  const handleScanNetworks = useCallback(async () => {
    setScanningNetworks(true);
    setBusy("wifi-scan", true);
    try {
      const response = await fetch(buildUrl("/api/wifi/scan"), {
        method: "POST",
        cache: "no-store",
      });
      if (!response.ok) {
        const payload = await readJson(response);
        const message = extractMessage(payload) ?? "No se pudieron escanear las redes.";
        const level: ToastLevel = response.status === 422 ? "warning" : "error";
        const title = response.status === 422 ? "Datos inválidos" : "Error al escanear";
        addToast(level, title, message);
        return;
      }
      const data = (await readJson(response)) as { networks?: WifiNetwork[] } | null;
      const items = Array.isArray(data?.networks) ? data!.networks : [];
      setNetworks(items);
      if (!userSelectedNetworkRef.current && items.length > 0) {
        const active = safeString(networkStatus?.ssid || networkStatus?.wifi?.ssid);
        if (active) {
          const match = items.find((item) => item.ssid === active);
          if (match) {
            setSelectedNetwork(match);
            setSelectedSsid(match.ssid);
          }
        }
      }
    } catch (error) {
      addToast("error", "Error de red", "No se pudo escanear redes Wi-Fi.");
    } finally {
      setScanningNetworks(false);
      setBusy("wifi-scan", false);
    }
  }, [addToast, buildUrl, networkStatus, setBusy]);
  const handleSelectNetwork = useCallback((network: WifiNetwork) => {
    userSelectedNetworkRef.current = true;
    setSelectedNetwork(network);
    setSelectedSsid(network.ssid);
    setConnectFeedback(null);
    if (network.secured === false) {
      setWifiPassword("");
    }
  }, []);

  const handleWifiConnect = useCallback(async () => {
    if (!selectedSsid.trim()) {
      addToast("warning", "Selecciona una red", "Elige una red Wi-Fi antes de conectar.");
      return;
    }
    const payload: Record<string, unknown> = {
      ssid: selectedSsid,
    };
    if (selectedNetwork?.secured === false) {
      payload.open = true;
    } else {
      payload.password = wifiPassword;
      payload.secured = true;
    }

    setConnectingWifi(true);
    setConnectFeedback("Conectando…");
    setBusy("wifi-connect", true);
    try {
      const response = await fetch(buildUrl("/api/wifi/connect"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await readJson(response);
      if (!response.ok) {
        const message = extractMessage(data) ?? "No se pudo conectar a la red seleccionada.";
        if (response.status === 422) {
          addToast("warning", "Datos inválidos", message);
        } else if (response.status === 401 || response.status === 403) {
          addToast("error", "No autorizado", message);
        } else {
          addToast("error", "Error al conectar", message);
        }
        setConnectFeedback(message);
        return;
      }

      const message =
        (data && typeof data === "object" && "message" in data && typeof (data as Record<string, unknown>).message === "string"
          ? (data as Record<string, unknown>).message
          : `Conectado a "${selectedSsid}"`) ?? `Conectado a "${selectedSsid}"`;
      addToast("success", "Conectado", message);
      setConnectFeedback(message);
      openaiEditedRef.current = false;
      nightscoutUrlEditedRef.current = false;
      nightscoutTokenEditedRef.current = false;
      await fetchSettings(false);
    } catch (error) {
      addToast("error", "Error de red", "No se pudo conectar a la red Wi-Fi.");
      setConnectFeedback("Error de red al conectar.");
    } finally {
      setConnectingWifi(false);
      setBusy("wifi-connect", false);
    }
  }, [addToast, buildUrl, fetchSettings, selectedNetwork, selectedSsid, wifiPassword]);

  const handleOfflineToggle = useCallback(
    async (value: boolean) => {
      setOfflineSaving(true);
      setBusy("offline-mode", true);
      try {
        const response = await fetch(buildUrl("/api/settings"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offline_mode: value }),
        });
        const data = await readJson(response);
        if (!response.ok) {
          const message = extractMessage(data) ?? "No se pudo actualizar el modo offline.";
          if (response.status === 422) {
            addToast("warning", "Datos inválidos", message);
          } else if (response.status === 401 || response.status === 403) {
            addToast("error", "No autorizado", message);
          } else {
            addToast("error", "Error", message);
          }
          return;
        }
        addToast("success", "Guardado correctamente", value ? "Modo offline activado." : "Modo offline desactivado.");
        applySettingsPayload(data as SettingsResponse | null);
      } catch (error) {
        addToast("error", "Error de red", "No se pudo actualizar el modo offline.");
      } finally {
        setOfflineSaving(false);
        setBusy("offline-mode", false);
      }
    },
    [addToast, applySettingsPayload, buildUrl, setBusy],
  );

  const handleSaveOpenAI = useCallback(async () => {
    setOpenaiSaving(true);
    setBusy("openai-save", true);
    try {
      const response = await fetch(buildUrl("/api/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: { openai_api_key: openaiInput.trim() } }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        const message = extractMessage(data) ?? "No se pudo guardar la clave de OpenAI.";
        if (response.status === 422) {
          addToast("warning", "Datos inválidos", message);
        } else if (response.status === 401 || response.status === 403) {
          addToast("error", "No autorizado", message);
        } else {
          addToast("error", "Error", message);
        }
        return;
      }
      addToast("success", "Guardado correctamente", "Clave de OpenAI actualizada.");
      openaiEditedRef.current = false;
      applySettingsPayload(data as SettingsResponse | null);
    } catch (error) {
      addToast("error", "Error de red", "No se pudo guardar la clave de OpenAI.");
    } finally {
      setOpenaiSaving(false);
      setBusy("openai-save", false);
    }
  }, [addToast, applySettingsPayload, buildUrl, openaiInput, setBusy]);

  const handleTestOpenAI = useCallback(async () => {
    setOpenaiTesting(true);
    setBusy("openai-test", true);
    try {
      const response = await fetch(buildUrl("/api/settings/test/openai"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: openaiInput.trim() || undefined }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        const message = extractMessage(data) ?? "No se pudo verificar la clave de OpenAI.";
        if (response.status === 422) {
          addToast("warning", "Datos inválidos", message);
        } else if (response.status === 401 || response.status === 403) {
          addToast("error", "No autorizado", message);
        } else {
          addToast("error", "Error", message);
        }
        return;
      }
      const successMessage =
        (data && typeof data === "object" && "message" in data && typeof (data as Record<string, unknown>).message === "string"
          ? (data as Record<string, unknown>).message
          : "OpenAI respondió correctamente.");
      addToast("success", "Prueba completada", successMessage);
    } catch (error) {
      addToast("error", "Error de red", "No se pudo contactar con OpenAI.");
    } finally {
      setOpenaiTesting(false);
      setBusy("openai-test", false);
    }
  }, [addToast, buildUrl, openaiInput, setBusy]);

  const handleSaveNightscout = useCallback(async () => {
    setNightscoutSaving(true);
    setBusy("nightscout-save", true);
    try {
      const trimmedUrl = nightscoutUrl.trim();
      const trimmedToken = nightscoutToken.trim();
      const payload: { diabetes: Record<string, string | undefined> } = {
        diabetes: {
          nightscout_url: trimmedUrl || undefined,
        },
      };

      if (nightscoutTokenEditedRef.current) {
        payload.diabetes.nightscout_token = trimmedToken || undefined;
      } else if (nightscoutTokenStored) {
        payload.diabetes.nightscout_token = "__stored__";
      } else if (trimmedToken) {
        payload.diabetes.nightscout_token = trimmedToken;
      }

      const response = await fetch(buildUrl("/api/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await readJson(response);
      if (!response.ok) {
        const message = extractMessage(data) ?? "No se pudo guardar Nightscout.";
        if (response.status === 422) {
          addToast("warning", "Datos inválidos", message);
        } else if (response.status === 401 || response.status === 403) {
          addToast("error", "No autorizado", message);
        } else {
          addToast("error", "Error", message);
        }
        return;
      }
      addToast("success", "Guardado correctamente", "Nightscout actualizado.");
      nightscoutUrlEditedRef.current = false;
      nightscoutTokenEditedRef.current = false;
      applySettingsPayload(data as SettingsResponse | null);
    } catch (error) {
      addToast("error", "Error de red", "No se pudo guardar Nightscout.");
    } finally {
      setNightscoutSaving(false);
      setBusy("nightscout-save", false);
    }
  }, [
    addToast,
    applySettingsPayload,
    buildUrl,
    nightscoutToken,
    nightscoutTokenStored,
    nightscoutUrl,
    setBusy,
  ]);

  const handleTestNightscout = useCallback(async () => {
    setNightscoutTesting(true);
    setBusy("nightscout-test", true);
    try {
      const response = await fetch(buildUrl("/api/settings/test/nightscout"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nightscout_url: nightscoutUrl.trim() || undefined,
          nightscout_token: nightscoutToken.trim() || undefined,
        }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        const message = extractMessage(data) ?? "No se pudo verificar Nightscout.";
        if (response.status === 422) {
          addToast("warning", "Datos inválidos", message);
        } else if (response.status === 401 || response.status === 403) {
          addToast("error", "No autorizado", message);
        } else {
          addToast("error", "Error", message);
        }
        return;
      }
      const message =
        (data && typeof data === "object" && "message" in data && typeof (data as Record<string, unknown>).message === "string"
          ? (data as Record<string, unknown>).message
          : "Nightscout respondió correctamente.");
      addToast("success", "Prueba completada", message);
    } catch (error) {
      addToast("error", "Error de red", "No se pudo contactar con Nightscout.");
    } finally {
      setNightscoutTesting(false);
      setBusy("nightscout-test", false);
    }
  }, [addToast, buildUrl, nightscoutToken, nightscoutUrl, setBusy]);

  const handleLaunchKeyboard = useCallback(async () => {
    setBusy("osk", true);
    try {
      const response = await fetch(buildUrl("/api/util/osk"), { method: "POST" });
      if (!response.ok) {
        const payload = await readJson(response);
        const message = extractMessage(payload) ?? "No se pudo abrir el teclado en pantalla.";
        if (response.status === 401 || response.status === 403) {
          addToast("error", "No autorizado", message);
        } else {
          addToast("error", "Error", message);
        }
        return;
      }
      addToast("success", "Teclado abierto", "El teclado en pantalla se está mostrando.");
    } catch (error) {
      addToast("error", "Error de red", "No se pudo abrir el teclado en pantalla.");
    } finally {
      setBusy("osk", false);
    }
  }, [addToast, buildUrl, setBusy]);

  const handleRefreshUi = useCallback(async () => {
    setUiRefreshing(true);
    setBusy("refresh-ui", true);
    addToast("info", "Actualizando UI", "Recargando recursos de la interfaz…");
    try {
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(
          registrations.map(async (registration) => {
            try {
              await registration.update();
            } catch (error) {
              // Ignorar actualizaciones individuales fallidas
            }
          }),
        );
      }
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
      window.location.reload();
    } catch (error) {
      addToast("error", "Error", "No se pudo refrescar la interfaz.");
    } finally {
      setUiRefreshing(false);
      setBusy("refresh-ui", false);
    }
  }, [addToast, setBusy]);

  const connectivity = resolveConnectivity(networkStatus);
  const connectivityLabel = CONNECTIVITY_LABELS[connectivity] ?? "Desconocido";
  const connectivityClass = CONNECTIVITY_STYLES[connectivity] ?? CONNECTIVITY_STYLES.unknown;

  const activeSsid = safeString(networkStatus?.ssid || networkStatus?.wifi?.ssid);
  const activeIp = safeString(networkStatus?.ip_address || networkStatus?.ip || networkStatus?.wifi?.ip);
  const activeInterface = safeString(networkStatus?.interface || (networkStatus?.wifi ? "wlan0" : ""));
  const apActive = networkStatus?.ap_active === true;
  const offlineMode = networkStatus?.offline_mode ?? settings?.ui?.offline_mode ?? false;

  const localDevice = useMemo(() => isLocalDevice(), []);
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/40">
      <ConfigToastManager />
      <div className="mx-auto w-full max-w-5xl px-4 py-10">
        <div className="mb-8 space-y-2">
          <h1 className="text-3xl font-semibold">Configuración del dispositivo</h1>
          <p className="text-muted-foreground">
            Administra la conectividad, integraciones y utilidades sin necesidad de PIN.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[2fr,3fr]">
          <Card>
            <CardHeader>
              <CardTitle>Estado rápido</CardTitle>
              <CardDescription>Resumen de conectividad y acceso actual.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Conectividad</span>
                <Badge className={connectivityClass}>{connectivityLabel}</Badge>
              </div>
              <Separator />
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Wifi className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> SSID actual
                  </span>
                  <span className="font-medium text-foreground">{activeSsid || "—"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Router className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> Dirección IP
                  </span>
                  <span className="font-medium text-foreground">{activeIp || "—"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Globe className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> Interfaz
                  </span>
                  <span className="font-medium text-foreground">{activeInterface || "—"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    {apActive ? (
                      <ShieldAlert className="h-4 w-4 text-amber-500" aria-hidden="true" />
                    ) : (
                      <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    )}
                    AP activo
                  </span>
                  <span className="font-medium text-foreground">{apActive ? "Sí" : "No"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Modo offline</span>
                  <div className="flex items-center gap-3">
                    {offlineSaving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
                    <Switch
                      checked={offlineMode}
                      onCheckedChange={(value) => void handleOfflineToggle(value)}
                      disabled={offlineSaving}
                      aria-label="Alternar modo offline"
                    />
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 pt-2">
                <Button variant="outline" size="sm" onClick={() => void handleRefreshStatus()} disabled={statusRefreshing}>
                  {statusRefreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />}
                  Actualizar estado
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="lg:row-span-2">
            <CardHeader>
              <CardTitle>Wi-Fi</CardTitle>
              <CardDescription>Selecciona una red disponible y conecta el dispositivo.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => void handleScanNetworks()} disabled={scanningNetworks}>
                  {scanningNetworks ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />}
                  Escanear redes
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void handleRefreshStatus()} disabled={statusRefreshing}>
                  {statusRefreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <RotateCw className="mr-2 h-4 w-4" aria-hidden="true" />}
                  Actualizar estado
                </Button>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                {networks.map((network) => {
                  const selected = network.ssid === selectedSsid;
                  const secured = network.secured !== false;
                  return (
                    <button
                      key={`${network.ssid}-${network.signal}-${network.sec}`}
                      type="button"
                      onClick={() => handleSelectNetwork(network)}
                      className={cn(
                        "flex w-full flex-col gap-2 rounded-lg border bg-background p-3 text-left shadow-sm transition focus:outline-none",
                        selected
                          ? "border-primary ring-2 ring-primary/40"
                          : "border-border hover:border-primary/60 hover:shadow",
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-foreground">{network.ssid}</span>
                        {computeSignalIcon(network.signal)}
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          {secured ? (
                            <Lock className="h-3 w-3" aria-hidden="true" />
                          ) : (
                            <Unlock className="h-3 w-3" aria-hidden="true" />
                          )}
                          {secured ? "Protegida" : "Abierta"}
                        </span>
                        {network.signal !== undefined && <span>{network.signal}%</span>}
                      </div>
                    </button>
                  );
                })}
                {networks.length === 0 && !scanningNetworks && (
                  <div className="col-span-full rounded-lg border border-dashed border-muted-foreground/40 p-4 text-center text-sm text-muted-foreground">
                    No hay redes escaneadas todavía. Pulsa “Escanear redes” para buscar.
                  </div>
                )}
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="wifi-ssid">SSID seleccionado</Label>
                  <Input
                    id="wifi-ssid"
                    value={selectedSsid}
                    onChange={(event) => {
                      setSelectedSsid(event.target.value);
                      userSelectedNetworkRef.current = true;
                    }}
                    placeholder="Nombre de la red"
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wifi-password">Contraseña</Label>
                  <Input
                    id="wifi-password"
                    type="password"
                    value={wifiPassword}
                    onChange={(event) => setWifiPassword(event.target.value)}
                    placeholder={selectedNetwork?.secured === false ? "No requerida" : "Introduce la contraseña"}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    disabled={selectedNetwork?.secured === false}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={() => void handleWifiConnect()} disabled={connectingWifi}>
                    {connectingWifi ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Wifi className="mr-2 h-4 w-4" aria-hidden="true" />}
                    {connectingWifi ? "Conectando…" : "Conectar"}
                  </Button>
                  {connectFeedback && <span className="text-sm text-muted-foreground">{connectFeedback}</span>}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>OpenAI</CardTitle>
              <CardDescription>Gestiona la clave API para las integraciones de IA.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between text-sm">
                <Label htmlFor="openai-key">Clave API</Label>
                {openaiStored && <Badge variant="secondary">Guardado</Badge>}
              </div>
              <Input
                id="openai-key"
                type="password"
                value={openaiInput}
                onChange={(event) => {
                  openaiEditedRef.current = true;
                  setOpenaiInput(event.target.value);
                }}
                placeholder={openaiStored ? "Clave almacenada — puedes reemplazarla" : "Introduce tu clave"}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => void handleSaveOpenAI()} disabled={openaiSaving}>
                  {openaiSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />}
                  Guardar
                </Button>
                <Button variant="outline" onClick={() => void handleTestOpenAI()} disabled={openaiTesting}>
                  {openaiTesting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Globe className="mr-2 h-4 w-4" aria-hidden="true" />}
                  Probar
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Nightscout</CardTitle>
              <CardDescription>Configura la URL y token de acceso.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <Label htmlFor="nightscout-url">URL</Label>
                  {nightscoutUrlStored && <Badge variant="secondary">Guardado</Badge>}
                </div>
                <Input
                  id="nightscout-url"
                  value={nightscoutUrl}
                  onChange={(event) => {
                    nightscoutUrlEditedRef.current = true;
                    setNightscoutUrl(event.target.value);
                  }}
                  placeholder={nightscoutUrlStored ? "URL almacenada — puedes reemplazarla" : "https://tu-nightscout"}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <Label htmlFor="nightscout-token">Token</Label>
                  {nightscoutTokenStored && <Badge variant="secondary">Guardado</Badge>}
                </div>
                <Input
                  id="nightscout-token"
                  type="password"
                  value={nightscoutToken}
                  onChange={(event) => {
                    nightscoutTokenEditedRef.current = true;
                    setNightscoutToken(event.target.value);
                  }}
                  placeholder={nightscoutTokenStored ? "Token almacenado — puedes reemplazarlo" : "Token de Nightscout"}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => void handleSaveNightscout()} disabled={nightscoutSaving}>
                  {nightscoutSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />}
                  Guardar
                </Button>
                <Button variant="outline" onClick={() => void handleTestNightscout()} disabled={nightscoutTesting}>
                  {nightscoutTesting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Globe className="mr-2 h-4 w-4" aria-hidden="true" />}
                  Probar
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Utilidades</CardTitle>
            <CardDescription>Herramientas adicionales para mantenimiento rápido.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            {localDevice && (
              <Button variant="secondary" onClick={() => void handleLaunchKeyboard()}>
                <Keyboard className="mr-2 h-4 w-4" aria-hidden="true" /> Teclado en pantalla
              </Button>
            )}
            <Button variant="outline" onClick={() => void handleRefreshUi()} disabled={uiRefreshing}>
              {uiRefreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <RotateCw className="mr-2 h-4 w-4" aria-hidden="true" />}
              Recargar UI
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
