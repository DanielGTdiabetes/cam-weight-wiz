import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ClipboardPaste,
  Copy,
  Globe,
  Lock,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  TestTube,
  Unlock,
  Wifi,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { isLocalClient } from "@/lib/network";
import { logger } from "@/services/logger";

const DEFAULT_AP_SSID = "Bascula-AP";
const DEFAULT_AP_IP = "192.168.4.1";

const MINIWEB_VERSION =
  typeof __APP_VERSION__ === "string" && __APP_VERSION__.trim()
    ? __APP_VERSION__.trim()
    : "0.0.0";

interface WifiNetwork {
  ssid: string;
  secured: boolean;
  signal: number | null;
  inUse: boolean;
}

interface ScanNetworksResponse {
  networks?: Array<{
    ssid?: string;
    secured?: boolean;
    signal?: number;
    in_use?: boolean;
    sec?: string;
  }>;
}

interface MiniwebStatus {
  ssid: string | null;
  ip: string | null;
  connectivity: string | null;
  apActive: boolean;
}

interface IntegrationTestState {
  status: "idle" | "running" | "success" | "error";
  message?: string;
}

interface HealthState {
  ok: boolean;
  message: string;
  timestamp: Date | null;
}

const mapNetworks = (payload: ScanNetworksResponse | null | undefined): WifiNetwork[] => {
  if (!payload || !Array.isArray(payload.networks)) {
    return [];
  }

  return payload.networks
    .map((net) => {
      const ssid = typeof net?.ssid === "string" ? net.ssid.trim() : "";
      if (!ssid) {
        return null;
      }

      const securedFromResponse =
        typeof net?.secured === "boolean"
          ? net.secured
          : typeof net?.sec === "string"
            ? net.sec.toUpperCase() !== "NONE"
            : true;

      const signal = typeof net?.signal === "number" ? net.signal : null;
      const inUse = Boolean(net?.in_use);

      return {
        ssid,
        secured: securedFromResponse,
        signal,
        inUse,
      } satisfies WifiNetwork;
    })
    .filter((item): item is WifiNetwork => Boolean(item));
};

const formatErrorMessage = (value: unknown): string => {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (value && typeof value === "object") {
    try {
      const record = value as Record<string, unknown>;
      const detail = record.detail ?? record.message ?? record.error ?? record.reason;
      if (typeof detail === "string" && detail.trim()) {
        return detail.trim();
      }
      return JSON.stringify(record);
    } catch (error) {
      logger.debug("No se pudo formatear el error", { error, value });
    }
  }

  return "Ocurrió un error inesperado";
};

const parseErrorResponse = async (response: Response): Promise<string> => {
  try {
    const data = (await response.json()) as unknown;
    return formatErrorMessage(data);
  } catch {
    const text = await response.text().catch(() => "");
    if (text.trim()) {
      return text.trim();
    }
    return `HTTP ${response.status}`;
  }
};
export const MiniWebConfig = () => {
  const localClient = isLocalClient();
  const { toast } = useToast();

  const [pinInput, setPinInput] = useState("");
  const [pinVerified, setPinVerified] = useState(localClient);
  const [verifyingPin, setVerifyingPin] = useState(false);
  const [displayPin, setDisplayPin] = useState<string | null>(null);
  const [pinFeedback, setPinFeedback] = useState<{
    type: "info" | "error" | "success";
    message: string;
  } | null>(
    localClient
      ? null
      : {
          type: "info",
          message: "Ingresa el PIN mostrado en la pantalla de la báscula para autorizar cambios remotos.",
        },
  );

  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [scanningNetworks, setScanningNetworks] = useState(false);
  const [selectedNetwork, setSelectedNetwork] = useState("");
  const [selectedSecured, setSelectedSecured] = useState(true);
  const [networkPassword, setNetworkPassword] = useState("");
  const [networkStatus, setNetworkStatus] = useState<MiniwebStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [networkMessage, setNetworkMessage] = useState<{
    type: "info" | "error" | "success";
    message: string;
  } | null>(null);
  const [connectingWifi, setConnectingWifi] = useState(false);
  const [networkSelectionLocked, setNetworkSelectionLocked] = useState(false);

  const [openaiInput, setOpenaiInput] = useState("");
  const [openaiHasKey, setOpenaiHasKey] = useState(false);
  const [openaiDirty, setOpenaiDirty] = useState(false);

  const [nightscoutUrl, setNightscoutUrl] = useState("");
  const [nightscoutToken, setNightscoutToken] = useState("");
  const [nightscoutHasToken, setNightscoutHasToken] = useState(false);
  const [nightscoutUrlDirty, setNightscoutUrlDirty] = useState(false);
  const [nightscoutTokenDirty, setNightscoutTokenDirty] = useState(false);

  const [savingIntegrations, setSavingIntegrations] = useState(false);
  const [openaiTest, setOpenaiTest] = useState<IntegrationTestState>({ status: "idle" });
  const [nightscoutTest, setNightscoutTest] = useState<IntegrationTestState>({ status: "idle" });
  const [testingOpenAI, setTestingOpenAI] = useState(false);
  const [testingNightscout, setTestingNightscout] = useState(false);
  const [testingAll, setTestingAll] = useState(false);

  const [healthStatus, setHealthStatus] = useState<HealthState>({ ok: false, message: "Sin comprobar", timestamp: null });
  const redirectTimerRef = useRef<number | null>(null);

  const ensurePin = useCallback(
    (context: string): { allowed: boolean; pin?: string } => {
      if (localClient) {
        return { allowed: true };
      }

      const trimmed = pinInput.trim();
      if (!trimmed) {
        const message = `Ingresa el PIN mostrado en la báscula para ${context}.`;
        setPinFeedback({ type: "error", message });
        toast({ title: "PIN requerido", description: message, variant: "destructive" });
        return { allowed: false };
      }

      if (!pinVerified) {
        const message = `Verifica el PIN antes de ${context}.`;
        setPinFeedback({ type: "error", message });
        toast({ title: "PIN no verificado", description: message, variant: "destructive" });
        return { allowed: false };
      }

      return { allowed: true, pin: trimmed };
    },
    [localClient, pinInput, pinVerified, toast],
  );

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const response = await fetch("/api/miniweb/status", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as Record<string, unknown>;
      const ssid = typeof data.ssid === "string" && data.ssid.trim() ? data.ssid.trim() : null;
      const ipCandidate =
        typeof data.ip === "string" && data.ip.trim()
          ? data.ip.trim()
          : typeof data.ip_address === "string" && data.ip_address.trim()
            ? data.ip_address.trim()
            : null;
      const connectivity = typeof data.connectivity === "string" ? data.connectivity.trim() : null;
      const apActive = Boolean(data.ap_active);

      setNetworkStatus({ ssid, ip: ipCandidate, connectivity, apActive });

      if (!networkSelectionLocked && ssid) {
        setSelectedNetwork(ssid);
      }
    } catch (error) {
      logger.debug("No se pudo obtener el estado de red", { error });
      if (!networkStatus) {
        setNetworkStatus(null);
      }
    } finally {
      setStatusLoading(false);
    }
  }, [networkSelectionLocked, networkStatus]);

  const refreshNetworks = useCallback(async () => {
    setScanningNetworks(true);
    try {
      const response = await fetch("/api/miniweb/scan-networks", { cache: "no-store" });
      if (!response.ok) {
        const message = await parseErrorResponse(response);
        throw new Error(message);
      }
      const payload = (await response.json()) as ScanNetworksResponse;
      const mapped = mapNetworks(payload);
      mapped.sort((a, b) => (b.signal ?? -100) - (a.signal ?? -100));
      setNetworks(mapped);

      if (!networkSelectionLocked) {
        const current = mapped.find((item) => item.inUse) ?? mapped[0];
        if (current) {
          setSelectedNetwork(current.ssid);
          setSelectedSecured(current.secured);
          if (!current.secured) {
            setNetworkPassword("");
          }
        }
      }
    } catch (error) {
      const description = error instanceof Error ? error.message : "No se pudo escanear redes";
      toast({ title: "Error al escanear", description, variant: "destructive" });
    } finally {
      setScanningNetworks(false);
    }
  }, [networkSelectionLocked, toast]);

  const refreshSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/settings", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as Record<string, unknown>;
      const openaiHasKeyValue = Boolean((data.openai as { hasKey?: boolean } | undefined)?.hasKey);
      setOpenaiHasKey(openaiHasKeyValue);
      setOpenaiInput("");
      setOpenaiDirty(false);

      const nightscoutData = data.nightscout as { url?: string; hasToken?: boolean } | undefined;
      const urlValue = typeof nightscoutData?.url === "string" ? nightscoutData.url.trim() : "";
      setNightscoutUrl(urlValue);
      setNightscoutHasToken(Boolean(nightscoutData?.hasToken));
      setNightscoutToken("");
      setNightscoutUrlDirty(false);
      setNightscoutTokenDirty(false);

      const networkData = (data.network as { status?: Record<string, unknown> } | undefined)?.status;
      if (networkData) {
        const ssid = typeof networkData.ssid === "string" && networkData.ssid.trim() ? networkData.ssid.trim() : null;
        const ipCandidate =
          typeof networkData.ip === "string" && networkData.ip.trim()
            ? networkData.ip.trim()
            : typeof networkData.ip_address === "string" && networkData.ip_address.trim()
              ? networkData.ip_address.trim()
              : null;
        const connectivity = typeof networkData.connectivity === "string" ? networkData.connectivity.trim() : null;
        const apActive = Boolean(networkData.ap_active);
        setNetworkStatus({ ssid, ip: ipCandidate, connectivity, apActive });
        if (!networkSelectionLocked && ssid) {
          setSelectedNetwork(ssid);
        }
      }
    } catch (error) {
      logger.debug("No se pudieron cargar los ajustes desde el backend", { error });
      toast({
        title: "Error al cargar ajustes",
        description: "No se pudieron obtener las integraciones actuales.",
        variant: "destructive",
      });
    }
  }, [networkSelectionLocked, toast]);

  const refreshHealth = useCallback(async () => {
    try {
      const response = await fetch("/health", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as { ok?: boolean; status?: string } | null;
      const ok = data?.ok === true || data?.status === "ok";
      setHealthStatus({ ok, message: ok ? "Backend operativo" : "Estado desconocido", timestamp: new Date() });
    } catch (error) {
      logger.debug("No se pudo comprobar la salud del backend", { error });
      setHealthStatus({ ok: false, message: "No se pudo contactar con el backend", timestamp: new Date() });
    }
  }, []);

  useEffect(() => {
    if (!localClient) {
      setDisplayPin(null);
      setPinVerified(false);
      setPinFeedback({
        type: "info",
        message: "Ingresa el PIN mostrado en la pantalla de la báscula para realizar cambios remotos.",
      });
      return;
    }

    let cancelled = false;
    setPinVerified(true);
    setPinFeedback(null);

    const fetchPin = async () => {
      try {
        const response = await fetch("/api/miniweb/pin", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = (await response.json()) as { pin?: string };
        if (cancelled) {
          return;
        }
        if (typeof data?.pin === "string" && data.pin.trim()) {
          setDisplayPin(data.pin.trim());
        } else {
          setDisplayPin(null);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        logger.debug("No se pudo obtener el PIN actual", { error });
        setDisplayPin(null);
        setPinFeedback({
          type: "error",
          message: "No se pudo obtener el PIN automáticamente. Revisa la pantalla de la báscula.",
        });
      }
    };

    fetchPin();

    return () => {
      cancelled = true;
    };
  }, [localClient]);

  useEffect(() => {
    void refreshStatus();
    void refreshNetworks();
    void refreshSettings();
    void refreshHealth();
  }, [refreshHealth, refreshNetworks, refreshSettings, refreshStatus]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let unsubscribed = false;
    let source: EventSource | null = null;

    const scheduleRedirect = () => {
      if (redirectTimerRef.current) {
        window.clearTimeout(redirectTimerRef.current);
      }
      const target = window.location?.origin ? `${window.location.origin.replace(/\/+$/, "")}/` : "/";
      redirectTimerRef.current = window.setTimeout(() => {
        try {
          window.location.replace(target);
        } catch (error) {
          logger.warn("No se pudo redirigir tras wifi_connected", { error });
        }
        redirectTimerRef.current = null;
      }, 2_000);
    };

    const handleWifiConnected = (event: MessageEvent<string>) => {
      if (unsubscribed) {
        return;
      }

      let payload: { ssid?: string; ip?: string } | null = null;
      try {
        payload = event.data ? (JSON.parse(event.data) as { ssid?: string; ip?: string }) : null;
      } catch (error) {
        logger.debug("No se pudo parsear wifi_connected", { error, raw: event.data });
      }

      const ssidLabel = payload?.ssid ? ` '${payload.ssid}'` : "";
      const message = `Conexión completada a${ssidLabel || " la red seleccionada"}.`;

      setConnectingWifi(false);
      setNetworkMessage({ type: "success", message });
      toast({
        title: "Wi-Fi conectada",
        description: "La báscula se conectó correctamente. Volviendo a la app principal…",
      });
      void refreshStatus();
      scheduleRedirect();
    };

    const handleWifiFailed = (event: MessageEvent<string>) => {
      if (unsubscribed) {
        return;
      }

      if (redirectTimerRef.current) {
        window.clearTimeout(redirectTimerRef.current);
        redirectTimerRef.current = null;
      }

      let payload: { message?: string; code?: string } | null = null;
      try {
        payload = event.data ? (JSON.parse(event.data) as { message?: string; code?: string }) : null;
      } catch (error) {
        logger.debug("No se pudo parsear wifi_failed", { error, raw: event.data });
      }

      const reason = payload?.message?.trim() || "No se pudo conectar a la red Wi-Fi.";
      setConnectingWifi(false);
      setNetworkMessage({ type: "error", message: reason });
      toast({
        title: "Conexión fallida",
        description: reason,
        variant: "destructive",
      });
      void refreshStatus();
    };

    const closeSource = () => {
      if (source) {
        source.removeEventListener("wifi_connected", handleWifiConnected as EventListener);
        source.removeEventListener("wifi_failed", handleWifiFailed as EventListener);
        source.close();
        source = null;
      }
    };

    try {
      source = new EventSource("/api/net/events");
      source.addEventListener("wifi_connected", handleWifiConnected as EventListener);
      source.addEventListener("wifi_failed", handleWifiFailed as EventListener);
    } catch (error) {
      logger.debug("No se pudo abrir el stream de eventos de red", { error });
      return () => undefined;
    }

    return () => {
      unsubscribed = true;
      if (redirectTimerRef.current) {
        window.clearTimeout(redirectTimerRef.current);
        redirectTimerRef.current = null;
      }
      closeSource();
    };
  }, [refreshStatus, toast]);
  const handleVerifyPin = async () => {
    if (localClient) {
      setPinVerified(true);
      setPinFeedback(null);
      return;
    }

    const candidate = pinInput.trim();
    if (!/^[0-9]{4}$/.test(candidate)) {
      const message = "Ingresa los 4 dígitos del PIN.";
      setPinFeedback({ type: "error", message });
      toast({ title: "PIN inválido", description: message, variant: "destructive" });
      return;
    }

    setVerifyingPin(true);
    try {
      const response = await fetch("/api/miniweb/verify-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: candidate }),
      });

      if (response.ok) {
        setPinVerified(true);
        setPinFeedback({ type: "success", message: "PIN verificado correctamente." });
        toast({ title: "PIN verificado", description: "Ya puedes realizar cambios remotos." });
        return;
      }

      if (response.status === 429) {
        const message = "Demasiados intentos fallidos. Espera un momento antes de reintentar.";
        setPinFeedback({ type: "error", message });
        toast({ title: "PIN bloqueado temporalmente", description: message, variant: "destructive" });
        setPinVerified(false);
        return;
      }

      const message = "PIN incorrecto. Verifica el código mostrado en la báscula.";
      setPinFeedback({ type: "error", message });
      toast({ title: "PIN incorrecto", description: message, variant: "destructive" });
      setPinVerified(false);
    } catch (error) {
      logger.error("No se pudo verificar el PIN de la mini-web", { error });
      const message = "No se pudo verificar el PIN. Revisa la conexión.";
      setPinFeedback({ type: "error", message });
      toast({ title: "Error de conexión", description: message, variant: "destructive" });
      setPinVerified(false);
    } finally {
      setVerifyingPin(false);
    }
  };

  const handleCopyPin = async () => {
    if (!displayPin) {
      return;
    }
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        throw new Error("clipboard_unavailable");
      }
      await navigator.clipboard.writeText(displayPin);
      toast({ title: "PIN copiado", description: "El PIN se copió al portapapeles." });
    } catch (error) {
      toast({
        title: "No se pudo copiar",
        description: "Autoriza el acceso al portapapeles para copiar el PIN.",
        variant: "destructive",
      });
    }
  };

  const handlePaste = async (setter: (value: string) => void) => {
    const notifyFailure = () => {
      toast({
        title: "No hay permisos de portapapeles",
        description: "Concede acceso al portapapeles desde el navegador.",
        variant: "destructive",
      });
    };

    const tryClipboardApi = async (): Promise<string | null> => {
      try {
        if (!navigator.clipboard || !navigator.clipboard.readText) {
          return null;
        }
        return await navigator.clipboard.readText();
      } catch (error) {
        logger.debug("navigator.clipboard.readText falló", { error });
        return null;
      }
    };

    const tryExecCommand = (): string | null => {
      if (typeof document === "undefined") {
        return null;
      }

      const textarea = document.createElement("textarea");
      textarea.setAttribute("aria-hidden", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      document.body.appendChild(textarea);

      let pasted: string | null = null;
      try {
        textarea.focus();
        const ok = document.execCommand("paste");
        if (ok) {
          pasted = textarea.value;
        }
      } catch (error) {
        logger.debug("document.execCommand('paste') falló", { error });
      } finally {
        textarea.remove();
      }

      return pasted;
    };

    const clipboardText = await tryClipboardApi();
    if (clipboardText !== null) {
      setter(clipboardText);
      return;
    }

    const execText = tryExecCommand();
    if (execText !== null) {
      setter(execText);
      return;
    }

    notifyFailure();
  };

  const handleSelectNetwork = (network: WifiNetwork) => {
    setSelectedNetwork(network.ssid);
    setSelectedSecured(network.secured);
    if (!network.secured) {
      setNetworkPassword("");
    }
    setNetworkSelectionLocked(true);
  };

  const handleConnectNetwork = async () => {
    const ssid = selectedNetwork.trim();
    setNetworkMessage(null);

    if (!ssid) {
      setNetworkMessage({ type: "error", message: "Selecciona o escribe el nombre de la red Wi-Fi." });
      return;
    }

    if (selectedSecured && !networkPassword.trim()) {
      setNetworkMessage({ type: "error", message: "Ingresa la contraseña de la red seleccionada." });
      return;
    }

    const { allowed, pin } = ensurePin("cambiar la red Wi-Fi");
    if (!allowed) {
      return;
    }

    const body: Record<string, unknown> = {
      ssid,
      secured: selectedSecured,
      open: !selectedSecured,
    };
    if (selectedSecured) {
      body.password = networkPassword;
    }
    if (pin) {
      body.pin = pin;
    }

    setConnectingWifi(true);
    try {
      const response = await fetch("/api/miniweb/connect-wifi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const message = await parseErrorResponse(response);
        setNetworkMessage({ type: "error", message });
        return;
      }

      setNetworkMessage({ type: "success", message: "Solicitud enviada. Verificando la conexión…" });
      toast({ title: "Conectando", description: "La báscula está intentando conectarse a la red seleccionada." });
      await refreshStatus();
    } catch (error) {
      logger.error("No se pudo iniciar la conexión Wi-Fi", { error });
      setNetworkMessage({ type: "error", message: "No se pudo conectar a la red. Inténtalo nuevamente." });
      toast({
        title: "Error de conexión",
        description: "Ocurrió un problema al conectar con la red Wi-Fi.",
        variant: "destructive",
      });
    } finally {
      setConnectingWifi(false);
    }
  };

  const hasIntegrationChanges = openaiDirty || nightscoutUrlDirty || nightscoutTokenDirty;

  const handleSaveIntegrations = async () => {
    if (!hasIntegrationChanges) {
      toast({ title: "Sin cambios", description: "No hay cambios pendientes para guardar." });
      return;
    }

    const { allowed, pin } = ensurePin("guardar las integraciones");
    if (!allowed) {
      return;
    }

    const payload: Record<string, unknown> = {};
    if (openaiDirty) {
      payload.openai = { apiKey: openaiInput.trim() || null };
    }
    if (nightscoutUrlDirty || nightscoutTokenDirty) {
      payload.nightscout = {
        url: nightscoutUrlDirty ? nightscoutUrl.trim() || null : undefined,
        token: nightscoutTokenDirty ? nightscoutToken.trim() || null : undefined,
      };
    }
    if (pin) {
      payload.pin = pin;
    }

    setSavingIntegrations(true);
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const message = await parseErrorResponse(response);
        throw new Error(message);
      }
      toast({ title: "Integraciones guardadas", description: "Los cambios se aplicaron correctamente." });
      setOpenaiDirty(false);
      setNightscoutUrlDirty(false);
      setNightscoutTokenDirty(false);
      await refreshSettings();
    } catch (error) {
      const description = error instanceof Error ? error.message : "No se pudieron guardar las integraciones.";
      toast({ title: "Error al guardar", description, variant: "destructive" });
    } finally {
      setSavingIntegrations(false);
    }
  };

  const executeOpenAITest = useCallback(
    async (pinOverride?: string) => {
      const body: Record<string, unknown> = {};
      const trimmedKey = openaiInput.trim();
      if (trimmedKey) {
        body.apiKey = trimmedKey;
      }
      if (pinOverride) {
        body.pin = pinOverride;
      }

      setTestingOpenAI(true);
      setOpenaiTest({ status: "running" });
      try {
        const response = await fetch("/api/settings/test/openai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await response.json().catch(() => ({}))) as { ok?: boolean; reason?: string; details?: unknown; model?: string };
        if (response.ok && data?.ok) {
          const model = typeof data.model === "string" && data.model.trim() ? ` (${data.model})` : "";
          const message = `Conexión correcta${model}.`;
          setOpenaiTest({ status: "success", message });
          toast({ title: "OpenAI disponible", description: message });
          return true;
        }
        const reason = data?.reason ? formatErrorMessage(data.reason) : await parseErrorResponse(response);
        setOpenaiTest({ status: "error", message: reason });
        toast({ title: "OpenAI no respondió", description: reason, variant: "destructive" });
        return false;
      } catch (error) {
        logger.error("No se pudo probar la conexión con OpenAI", { error });
        const message = "No se pudo conectar con OpenAI. Verifica la clave y la conexión.";
        setOpenaiTest({ status: "error", message });
        toast({ title: "Error", description: message, variant: "destructive" });
        return false;
      } finally {
        setTestingOpenAI(false);
      }
    },
    [openaiInput, toast],
  );

  const executeNightscoutTest = useCallback(
    async (pinOverride?: string) => {
      const urlTrimmed = nightscoutUrl.trim();
      const tokenTrimmed = nightscoutToken.trim();
      const params = new URLSearchParams();
      if (urlTrimmed) {
        params.set("url", urlTrimmed);
      }
      if (tokenTrimmed) {
        params.set("token", tokenTrimmed);
      }
      if (pinOverride) {
        params.set("pin", pinOverride);
      }
      const query = params.toString();
      const endpoint = query ? `/api/nightscout/test?${query}` : "/api/nightscout/test";

      setTestingNightscout(true);
      setNightscoutTest({ status: "running" });
      try {
        const response = await fetch(endpoint, { method: "GET", cache: "no-store" });
        const data = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          reason?: string;
          details?: unknown;
          message?: string;
          status?: number;
        };
        if (response.ok && data?.ok) {
          const message = data.message ?? "Conexión con Nightscout verificada.";
          setNightscoutTest({ status: "success", message });
          toast({ title: "Nightscout disponible", description: message });
          return true;
        }
        const reason =
          data?.message?.trim() ||
          (data?.reason ? formatErrorMessage(data.reason) : await parseErrorResponse(response));
        setNightscoutTest({ status: "error", message: reason });
        toast({ title: "Nightscout no respondió", description: reason, variant: "destructive" });
        return false;
      } catch (error) {
        logger.error("No se pudo probar Nightscout", { error });
        const message = "No se pudo conectar con Nightscout. Verifica la URL y el token.";
        setNightscoutTest({ status: "error", message });
        toast({ title: "Error", description: message, variant: "destructive" });
        return false;
      } finally {
        setTestingNightscout(false);
      }
    },
    [nightscoutToken, nightscoutUrl, toast],
  );

  const handleTestOpenAI = async () => {
    const { allowed, pin } = ensurePin("probar la conexión con OpenAI");
    if (!allowed) {
      return;
    }
    await executeOpenAITest(pin);
  };

  const handleTestNightscout = async () => {
    const { allowed, pin } = ensurePin("probar la conexión con Nightscout");
    if (!allowed) {
      return;
    }
    await executeNightscoutTest(pin);
  };

  const handleTestAllIntegrations = async () => {
    const { allowed, pin } = ensurePin("probar las integraciones");
    if (!allowed) {
      return;
    }
    setTestingAll(true);
    const openaiOk = await executeOpenAITest(pin);
    const nightscoutOk = await executeNightscoutTest(pin);
    if (openaiOk && nightscoutOk) {
      toast({ title: "Pruebas completadas", description: "Todas las integraciones respondieron correctamente." });
    } else if (!openaiOk || !nightscoutOk) {
      toast({
        title: "Pruebas con problemas",
        description: "Revisa el detalle en cada integración para más información.",
        variant: "destructive",
      });
    }
    setTestingAll(false);
  };

  const connectivityLabel = useMemo(() => {
    if (!networkStatus) {
      return "Desconocido";
    }
    if (networkStatus.apActive) {
      return "Modo AP activo";
    }
    if (networkStatus.connectivity) {
      return networkStatus.connectivity;
    }
    return networkStatus.ssid ? "En línea" : "Desconectado";
  }, [networkStatus]);

  const sortedNetworks = useMemo(() => networks, [networks]);

  const lastHealthCheck = healthStatus.timestamp
    ? healthStatus.timestamp.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "Nunca";
  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/40">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-10">
        <Card className="border border-primary/20 bg-background/80 shadow-lg">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-col gap-3">
              <h1 className="text-3xl font-bold tracking-tight">Configuración de la báscula</h1>
              <p className="text-muted-foreground">
                Gestiona la conexión Wi-Fi y las integraciones principales de la báscula desde esta mini-web segura.
                Los cambios se aplican directamente en el dispositivo.
              </p>
            </div>
            <Badge variant="outline" className="self-start font-mono text-xs uppercase tracking-wider">
              Mini-web {MINIWEB_VERSION}
            </Badge>
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-lg font-semibold">
                  <ShieldCheck className="h-5 w-5 text-primary" /> PIN y acceso seguro
                </div>
                <p className="text-sm text-muted-foreground">
                  El PIN protege los cambios de red e integraciones cuando accedes desde otro dispositivo. En la báscula se
                  muestra automáticamente.
                </p>
              </div>
              {localClient ? (
                <div className="flex items-center gap-3">
                  <div className="min-h-[3rem] min-w-[6rem] rounded-md border border-border bg-muted/30 px-4 py-2 text-3xl font-mono tracking-[0.4em]">
                    {displayPin ? displayPin : "—"}
                  </div>
                  <Button type="button" variant="outline" onClick={() => void handleCopyPin()} disabled={!displayPin}>
                    <Copy className="mr-2 h-4 w-4" /> Copiar PIN
                  </Button>
                </div>
              ) : (
                <div className="flex w-full flex-col gap-2 sm:w-64">
                  <Input
                    value={pinInput}
                    onChange={(event) => {
                      const digits = event.target.value.replace(/[^0-9]/g, "");
                      setPinInput(digits);
                      setPinVerified(false);
                      setPinFeedback(null);
                    }}
                    placeholder="PIN de la báscula"
                    maxLength={4}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="one-time-code"
                  />
                  <Button
                    type="button"
                    variant="glow"
                    onClick={() => void handleVerifyPin()}
                    disabled={verifyingPin || pinInput.trim().length !== 4}
                  >
                    {verifyingPin ? (
                      <>
                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Verificando…
                      </>
                    ) : (
                      <>
                        <ShieldCheck className="mr-2 h-4 w-4" /> Verificar PIN
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>
            {pinFeedback ? (
              <div
                className={
                  pinFeedback.type === "success"
                    ? "flex items-center gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success"
                    : "flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-foreground"
                }
              >
                <AlertCircle className="h-4 w-4" />
                <span>{pinFeedback.message}</span>
              </div>
            ) : null}
            {!localClient && pinVerified ? (
              <div className="flex items-center gap-2 text-sm font-medium text-success">
                <ShieldCheck className="h-4 w-4" /> PIN verificado para esta sesión.
              </div>
            ) : null}
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-lg font-semibold">
                  <Wifi className="h-5 w-5 text-primary" /> Red Wi-Fi
                </div>
                <p className="text-sm text-muted-foreground">
                  Selecciona la red Wi-Fi de tu hogar o introduce manualmente los datos. Tras conectar, la báscula volverá a su
                  modo normal automáticamente.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void refreshStatus()}
                  disabled={statusLoading}
                >
                  <RefreshCw className={`mr-2 h-4 w-4 ${statusLoading ? "animate-spin" : ""}`} /> Actualizar estado
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void refreshNetworks()}
                  disabled={scanningNetworks}
                >
                  <RefreshCw className={`mr-2 h-4 w-4 ${scanningNetworks ? "animate-spin" : ""}`} /> Escanear redes
                </Button>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-4 rounded-lg border border-border/60 bg-muted/20 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">Estado actual</span>
                  <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
                    {connectivityLabel}
                  </Badge>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Wifi className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">SSID:</span>
                    <span>{networkStatus?.ssid ?? "Sin conexión"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Globe className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">IP:</span>
                    <span>{networkStatus?.ip ?? "—"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">Modo AP:</span>
                    <span>{networkStatus?.apActive ? "Activo" : "Desactivado"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Lock className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">Punto de acceso:</span>
                    <span>
                      {DEFAULT_AP_SSID} ({DEFAULT_AP_IP})
                    </span>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">Redes disponibles</p>
                <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-border/60 bg-muted/10 p-2">
                  {sortedNetworks.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
                      <Wifi className="h-8 w-8" />
                      <span>No se detectaron redes. Intenta escanear nuevamente.</span>
                    </div>
                  ) : (
                    sortedNetworks.map((network) => {
                      const isSelected = selectedNetwork === network.ssid;
                      return (
                        <button
                          key={network.ssid}
                          type="button"
                          onClick={() => handleSelectNetwork(network)}
                          className={`w-full rounded-md border px-4 py-3 text-left transition hover:border-primary/60 hover:bg-primary/5 ${
                            isSelected ? "border-primary bg-primary/10" : "border-border"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <Wifi className={`h-4 w-4 ${network.inUse ? "text-primary" : "text-muted-foreground"}`} />
                              <div>
                                <div className="font-medium">{network.ssid}</div>
                                <div className="text-xs text-muted-foreground">
                                  Señal: {network.signal !== null ? `${network.signal}%` : "s/d"}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              {network.inUse ? <Badge variant="outline">En uso</Badge> : null}
                              {network.secured ? (
                                <Lock className="h-4 w-4 text-muted-foreground" />
                              ) : (
                                <Unlock className="h-4 w-4 text-muted-foreground" />
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-4 rounded-lg border border-border/60 bg-muted/20 p-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Nombre de la red (SSID)</Label>
                  <Input
                    value={selectedNetwork}
                    onChange={(event) => {
                      setSelectedNetwork(event.target.value);
                      setNetworkSelectionLocked(true);
                    }}
                    placeholder="MiRed"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Contraseña</Label>
                  <Input
                    value={networkPassword}
                    onChange={(event) => {
                      setNetworkPassword(event.target.value);
                      setNetworkSelectionLocked(true);
                    }}
                    placeholder={selectedSecured ? "••••••••" : "Red abierta"}
                    type="password"
                    autoComplete="off"
                    disabled={!selectedSecured}
                  />
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={!selectedSecured}
                      onCheckedChange={(checked) => {
                        setSelectedSecured(!checked);
                        if (checked) {
                          setNetworkPassword("");
                        }
                        setNetworkSelectionLocked(true);
                      }}
                    />
                    <span className="text-xs text-muted-foreground">Red abierta (sin contraseña)</span>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <Button
                  type="button"
                  variant="glow"
                  size="lg"
                  onClick={() => void handleConnectNetwork()}
                  disabled={connectingWifi || (!localClient && !pinVerified)}
                  title={!localClient && !pinVerified ? "Verifica el PIN antes de conectar" : undefined}
                >
                  {connectingWifi ? (
                    <>
                      <RefreshCw className="mr-2 h-5 w-5 animate-spin" /> Conectando…
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="mr-2 h-5 w-5" /> Conectar a la red
                    </>
                  )}
                </Button>
                {networkMessage ? (
                  <p
                    className={
                      networkMessage.type === "success"
                        ? "text-sm font-medium text-success"
                        : networkMessage.type === "error"
                          ? "text-sm font-medium text-destructive"
                          : "text-sm text-muted-foreground"
                    }
                  >
                    {networkMessage.message}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-lg font-semibold">
                  <Activity className="h-5 w-5 text-primary" /> Integraciones
                </div>
                <p className="text-sm text-muted-foreground">
                  Configura tus credenciales de OpenAI y Nightscout. Puedes probar la conexión antes de guardar los cambios.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleTestAllIntegrations()}
                  disabled={testingAll || (!localClient && !pinVerified)}
                  title={!localClient && !pinVerified ? "Verifica el PIN antes de probar" : undefined}
                >
                  {testingAll ? (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Probando…
                    </>
                  ) : (
                    <>
                      <TestTube className="mr-2 h-4 w-4" /> Probar conexiones
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="glow"
                  onClick={() => void handleSaveIntegrations()}
                  disabled={savingIntegrations || (!localClient && !pinVerified)}
                  title={
                    !localClient && !pinVerified ? "Verifica el PIN antes de guardar" : undefined
                  }
                >
                  {savingIntegrations ? (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Guardando…
                    </>
                  ) : (
                    <>
                      <Save className="mr-2 h-4 w-4" /> Guardar cambios
                    </>
                  )}
                </Button>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-4 rounded-lg border border-border/60 bg-muted/20 p-4">
                <div className="space-y-2">
                  <Label>OpenAI API Key</Label>
                  <div className="relative">
                    <Input
                      type="password"
                      value={openaiInput}
                      onChange={(event) => {
                        setOpenaiInput(event.target.value);
                        setOpenaiDirty(true);
                      }}
                      placeholder={openaiHasKey ? "••••••••" : "sk-..."}
                      autoComplete="off"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-1 top-1/2 -translate-y-1/2"
                      onClick={() =>
                        void handlePaste((value) => {
                          setOpenaiInput(value);
                          setOpenaiDirty(true);
                        })
                      }
                    >
                      <ClipboardPaste className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Estado: {openaiHasKey ? <span className="text-success">Clave almacenada en la báscula</span> : "Sin configurar"}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => void handleTestOpenAI()}
                  disabled={testingOpenAI || (!localClient && !pinVerified)}
                  title={!localClient && !pinVerified ? "Verifica el PIN antes de probar" : undefined}
                >
                  {testingOpenAI ? (
                    <>
                      <RefreshCw className="mr-2 h-5 w-5 animate-spin" /> Probando…
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="mr-2 h-5 w-5" /> Probar OpenAI
                    </>
                  )}
                </Button>
                {openaiTest.status !== "idle" ? (
                  <p
                    className={
                      openaiTest.status === "success"
                        ? "text-sm text-success"
                        : openaiTest.status === "error"
                          ? "text-sm text-destructive"
                          : "text-sm text-muted-foreground"
                    }
                  >
                    {openaiTest.message ?? (openaiTest.status === "running" ? "Ejecutando prueba…" : "")}
                  </p>
                ) : null}
              </div>

              <div className="space-y-4 rounded-lg border border-border/60 bg-muted/20 p-4">
                <div className="space-y-2">
                  <Label>Nightscout URL</Label>
                  <div className="relative">
                    <Input
                      type="url"
                      value={nightscoutUrl}
                      onChange={(event) => {
                        setNightscoutUrl(event.target.value);
                        setNightscoutUrlDirty(true);
                      }}
                      placeholder="https://midominio.herokuapp.com"
                      autoComplete="url"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-1 top-1/2 -translate-y-1/2"
                      onClick={() =>
                        void handlePaste((value) => {
                          setNightscoutUrl(value);
                          setNightscoutUrlDirty(true);
                        })
                      }
                    >
                      <ClipboardPaste className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Nightscout Token</Label>
                  <div className="relative">
                    <Input
                      type="password"
                      value={nightscoutToken}
                      onChange={(event) => {
                        setNightscoutToken(event.target.value);
                        setNightscoutTokenDirty(true);
                      }}
                      placeholder={nightscoutHasToken ? "••••••" : "token"}
                      autoComplete="new-password"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-1 top-1/2 -translate-y-1/2"
                      onClick={() =>
                        void handlePaste((value) => {
                          setNightscoutToken(value);
                          setNightscoutTokenDirty(true);
                        })
                      }
                    >
                      <ClipboardPaste className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Estado: {nightscoutUrl ? nightscoutUrl : "Sin URL"} {nightscoutHasToken ? "· Token almacenado" : ""}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => void handleTestNightscout()}
                  disabled={testingNightscout || (!localClient && !pinVerified)}
                  title={!localClient && !pinVerified ? "Verifica el PIN antes de probar" : undefined}
                >
                  {testingNightscout ? (
                    <>
                      <RefreshCw className="mr-2 h-5 w-5 animate-spin" /> Probando…
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="mr-2 h-5 w-5" /> Probar Nightscout
                    </>
                  )}
                </Button>
                {nightscoutTest.status !== "idle" ? (
                  <p
                    className={
                      nightscoutTest.status === "success"
                        ? "text-sm text-success"
                        : nightscoutTest.status === "error"
                          ? "text-sm text-destructive"
                          : "text-sm text-muted-foreground"
                    }
                  >
                    {nightscoutTest.message ?? (nightscoutTest.status === "running" ? "Ejecutando prueba…" : "")}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-lg font-semibold">
                  <Server className="h-5 w-5 text-primary" /> Estado general
                </div>
                <p className="text-sm text-muted-foreground">
                  Comprueba la salud del backend y el modo de red actual de la báscula.
                </p>
              </div>
              <Button type="button" variant="outline" onClick={() => void refreshHealth()}>
                <RefreshCw className="mr-2 h-4 w-4" /> Volver a comprobar
              </Button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/20 p-4">
                <Server className="h-5 w-5 text-muted-foreground" />
                <div>
                  <div className="text-sm font-medium text-muted-foreground">Backend</div>
                  <div className={healthStatus.ok ? "text-sm text-success" : "text-sm text-destructive"}>
                    {healthStatus.ok ? "Operativo" : "Sin conexión"}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/20 p-4">
                <Globe className="h-5 w-5 text-muted-foreground" />
                <div>
                  <div className="text-sm font-medium text-muted-foreground">Modo actual</div>
                  <div className="text-sm">
                    {networkStatus?.apActive ? "Punto de acceso habilitado" : "Conectado a red cliente"}
                  </div>
                </div>
              </div>
            </div>

            <div className="text-sm text-muted-foreground">
              Última comprobación: {lastHealthCheck}
            </div>
          </div>
        </Card>
        <p className="pb-6 text-center text-xs text-muted-foreground">
          Versión mini-web {MINIWEB_VERSION}
        </p>
      </div>
    </div>
  );
};
