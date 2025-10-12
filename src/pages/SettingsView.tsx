import { useState, useEffect, useCallback, useRef } from "react";
import {
  Settings,
  Scale,
  Wifi,
  Heart,
  Download,
  Save,
  Upload,
  Trash2,
  Volume2,
  CheckCircle2,
  ClipboardPaste,
  MonitorSpeaker,
  Globe,
  BellRing,
  AlertCircle,
  Info,
  Loader2,
  ExternalLink,
  KeyRound,
  Eye,
  EyeOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Progress } from "@/components/ui/progress";
import { KeyboardDialog } from "@/components/KeyboardDialog";
import { CalibrationWizard } from "@/components/CalibrationWizard";
import { storage } from "@/services/storage";
import { logger } from "@/services/logger";
import { getFeatureFlags, setFeatureFlag, type FeatureFlags } from "@/services/featureFlags";
import { useToast } from "@/hooks/use-toast";
import { useScaleWebSocket } from "@/hooks/useScaleWebSocket";
import { useSettingsSync } from "@/hooks/useSettingsSync";
import { useAudioPref } from "@/state/useAudio";
import { cn } from "@/lib/utils";
import { api, setApiBaseUrl, type BackendSettingsUpdate, type OtaJobState, type WakeStatus } from "@/services/api";
import { ApiError } from "@/services/apiWrapper";
import { isLocalClient } from "@/lib/network";

type VoiceBackend = "piper" | "espeak" | "custom";

interface VoiceOption {
  id: string;
  label: string;
  backend: VoiceBackend;
  description?: string;
}

interface PiperModelResponse {
  id?: string;
  name?: string;
  path?: string;
}

interface VoicesResponse {
  piper_models?: PiperModelResponse[];
  espeak_available?: boolean;
}

type NetworkModalStatus = {
  type: "idle" | "info" | "error" | "success";
  message: string;
};

type MiniWebStatusResponse = {
  ip?: string;
  ip_address?: string;
  ssid?: string;
  ap_active?: boolean;
  connectivity?: string;
  [key: string]: unknown;
};

type MiniEbStatusState = {
  status: "loading" | "ready" | "error";
  ip?: string;
  ssid?: string;
  error?: string;
};

type OtaStatus = {
  current: string;
  latest: string;
  hasUpdate: boolean;
};

const MAX_OTA_LOG_LINES = 400;

const APP_VERSION =
  typeof __APP_VERSION__ === "string" && __APP_VERSION__.trim()
    ? __APP_VERSION__.trim()
    : "0.0.0";

const trimLogLines = (content: string, maxLines = MAX_OTA_LOG_LINES): string => {
  if (!content) {
    return "";
  }

  const normalised = content.replace(/\r\n/g, "\n");
  const lines = normalised.split("\n");
  if (lines.length <= maxLines) {
    return normalised.trimEnd();
  }

  return lines.slice(-maxLines).join("\n").trimEnd();
};

export const SettingsView = () => {
  const { toast } = useToast();
  const { weight } = useScaleWebSocket();
  useSettingsSync(); // Enable real-time settings sync
  const localClient = isLocalClient();
  const [showCalibrationWizard, setShowCalibrationWizard] = useState(false);
  const [featureFlags, setFeatureFlags] = useState<FeatureFlags>(() => getFeatureFlags());
  const { voiceEnabled, setEnabled: setVoicePreference } = useAudioPref();
  const [voiceId, setVoiceId] = useState<string | undefined>(undefined);
  const voiceIdRef = useRef<string | undefined>(undefined);
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
  const [wakeStatus, setWakeStatus] = useState<WakeStatus | null>(null);
  const [isWakeUpdating, setIsWakeUpdating] = useState(false);
  const miniEbErrorNotifiedRef = useRef(false);
  const [voiceOptions, setVoiceOptions] = useState<VoiceOption[]>([]);
  const [isLoadingVoices, setIsLoadingVoices] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [isTestingDeviceVoice, setIsTestingDeviceVoice] = useState(false);
  const [isTestingBrowserVoice, setIsTestingBrowserVoice] = useState(false);
  const [diabetesMode, setDiabetesMode] = useState(false);
  const [bolusAssistant, setBolusAssistant] = useState(false);
  const [timerAlarmSoundEnabled, setTimerAlarmSoundEnabled] = useState(true);
  const [timerVoiceAnnouncementsEnabled, setTimerVoiceAnnouncementsEnabled] = useState(false);
  const [uiVolume, setUiVolume] = useState(1);
  
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [keyboardConfig, setKeyboardConfig] = useState<{
    title: string;
    type: "numeric" | "text" | "password" | "url" | "apikey";
    showDecimal?: boolean;
    field: string;
    min?: number;
    max?: number;
    allowEmpty?: boolean;
    maxLength?: number;
  }>({ title: "", type: "text", field: "" });

  const [calibrationFactor, setCalibrationFactor] = useState("420.5");
  const [decimals, setDecimals] = useState("1");
  const [apiUrl, setApiUrl] = useState("http://127.0.0.1:8081");
  const [wsUrl, setWsUrl] = useState("ws://127.0.0.1:8081");
  const [chatGptKey, setChatGptKey] = useState("");
  const [nightscoutUrl, setNightscoutUrl] = useState("");
  const [nightscoutToken, setNightscoutToken] = useState("");
  const [showOpenAiKey, setShowOpenAiKey] = useState(false);
  const [showNightscoutToken, setShowNightscoutToken] = useState(false);
  const [correctionFactor, setCorrectionFactor] = useState("30");
  const [carbRatio, setCarbRatio] = useState("10");
  const [targetGlucose, setTargetGlucose] = useState("100");
  const [hypoAlarm, setHypoAlarm] = useState("70");
  const [hyperAlarm, setHyperAlarm] = useState("180");
  const [networkIP, setNetworkIP] = useState<string | null>(null);
  const [miniEbStatus, setMiniEbStatus] = useState<MiniEbStatusState>({ status: "loading" });
  const [isApRecoveryMode, setIsApRecoveryMode] = useState(false);

  const [tempValue, setTempValue] = useState("");
  const [isTestingAudio, setIsTestingAudio] = useState(false);
  const [isTestingOpenAI, setIsTestingOpenAI] = useState(false);
  const [isTestingNightscout, setIsTestingNightscout] = useState(false);
  const [isSavingNightscout, setIsSavingNightscout] = useState(false);
  const [isSavingOpenAI, setIsSavingOpenAI] = useState(false);
  const [backendHasOpenAIKey, setBackendHasOpenAIKey] = useState(false);
  const [backendNightscoutUrl, setBackendNightscoutUrl] = useState<string | null>(null);
  const [backendNightscoutHasToken, setBackendNightscoutHasToken] = useState(false);
  const [otaStatus, setOtaStatus] = useState<OtaStatus | null>(null);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [otaJobState, setOtaJobState] = useState<OtaJobState | null>(null);
  const [otaLogs, setOtaLogs] = useState("");
  const [otaPanelOpen, setOtaPanelOpen] = useState(false);
  const [otaApplyDialogOpen, setOtaApplyDialogOpen] = useState(false);
  const [isApplyingUpdate, setIsApplyingUpdate] = useState(false);
  const [otaTargetOverride, setOtaTargetOverride] = useState("");
  const [networkSSID, setNetworkSSID] = useState<string>("—");
  const [networkIP2, setNetworkIP2] = useState<string>("—");
  const [internalKeyboardEnabled, setInternalKeyboardEnabled] = useState(localClient);
  const [networkModalOpen, setNetworkModalOpen] = useState(false);
  const [legacyNetworkDialogOpen, setLegacyNetworkDialogOpen] = useState(false);
  const [networkModalSSID, setNetworkModalSSID] = useState("");
  const [networkModalPassword, setNetworkModalPassword] = useState("");
  const [networkModalStatus, setNetworkModalStatus] = useState<NetworkModalStatus | null>(null);
  const [isNetworkModalConnecting, setIsNetworkModalConnecting] = useState(false);
  const effectiveNetworkIp = networkIP2 && networkIP2 !== "—" ? networkIP2 : networkIP;
  const browserHost = typeof window !== "undefined" ? window.location.hostname : "";
  const suggestedApiFromNetwork = effectiveNetworkIp ? `http://${effectiveNetworkIp}:8081` : null;
  const suggestedWsFromNetwork = effectiveNetworkIp ? `ws://${effectiveNetworkIp}:8081` : null;
  const suggestedApiFromBrowserHost =
    browserHost && browserHost !== "localhost" && browserHost !== "127.0.0.1"
      ? `http://${browserHost}:8081`
      : null;
  const suggestedWsFromBrowserHost =
    browserHost && browserHost !== "localhost" && browserHost !== "127.0.0.1"
      ? `ws://${browserHost}:8081`
      : null;
  const configUrlHint = effectiveNetworkIp ? `http://${effectiveNetworkIp}/config` : "http://<IP_de_la_báscula>/config";
  const remoteLocked = false;
  const openAiKeyboardEnabled = internalKeyboardEnabled && localClient;
  const nightscoutKeyboardEnabled = internalKeyboardEnabled && localClient;
  const showVoiceSelector = true;
  const autoAppliedEndpointsRef = useRef(false);

  useEffect(() => {
    const keysToForce: Array<keyof FeatureFlags> = [
      "navSafeExit",
      "voiceSelector",
      "timerAlarms",
      "calibrationV2",
      "networkModal",
      "miniEbStable",
      "otaCheck",
      "otaApply",
    ];
    const missing = keysToForce.filter((key) => !featureFlags[key]);
    if (missing.length === 0) {
      return;
    }
    let updated = featureFlags;
    missing.forEach((key) => {
      updated = setFeatureFlag(key, true);
    });
    setFeatureFlags(updated);
  }, [featureFlags]);
  
  const eventSourceRef = useRef<EventSource | null>(null);
  const otaPollIntervalRef = useRef<number | null>(null);
  const otaSlowPollTimeoutRef = useRef<number | null>(null);
  const otaLastStatusRef = useRef<OtaJobState["status"] | null>(null);
  const otaLogsRef = useRef<HTMLDivElement | null>(null);

  const buildApiUrl = useCallback(
    (path: string) => {
      try {
        return new URL(path, apiUrl).toString();
      } catch (error) {
        console.error("Invalid API URL", error);
        return path;
      }
    },
    [apiUrl]
  );

  const formatVersion = (value?: string) => {
    if (!value) {
      return "—";
    }

    const normalized = value.trim();
    if (!normalized || normalized.toLowerCase() === "unknown") {
      return "—";
    }

    return normalized.startsWith("v") ? normalized : `v${normalized}`;
  };

  const refreshNetworkStatus = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      const debugEnabled = featureFlags.debugLogs;
      const logDebug = (...args: unknown[]) => {
        if (debugEnabled) {
          console.debug("[SettingsView][MINI-EB]", ...args);
        }
      };

      if (!silent) {
        setMiniEbStatus({ status: "loading" });
      }

      const fetchStatus = async (): Promise<MiniWebStatusResponse> => {
        if (!featureFlags.miniEbStable) {
          const response = await fetch("/api/miniweb/status", { cache: "no-store" });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return (await response.json()) as MiniWebStatusResponse;
        }

        const delays = [0, 1000, 2000, 4000];
        let lastError: unknown;

        for (let attempt = 0; attempt < delays.length; attempt++) {
          const delay = delays[attempt];
          if (delay > 0) {
            logDebug(`Esperando ${delay}ms antes del intento ${attempt + 1}`);
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, delay);
            });
          }

          try {
            logDebug(`Intento MINI-EB ${attempt + 1}`);
            const controller = new AbortController();
            const timeoutId = window.setTimeout(() => controller.abort(), 5000);

            try {
              const response = await fetch("/api/miniweb/status", {
                cache: "no-store",
                signal: controller.signal,
              });

              if (response.ok) {
                const data = (await response.json()) as MiniWebStatusResponse;
                logDebug("Respuesta MINI-EB OK", data);
                return data;
              }

              const bodyText = await response.text().catch(() => "");
              lastError = new Error(`HTTP ${response.status}: ${bodyText}`);
              logDebug("Respuesta MINI-EB no OK", response.status, bodyText);
            } finally {
              window.clearTimeout(timeoutId);
            }
          } catch (error) {
            lastError = error;
            if (error instanceof DOMException && error.name === 'AbortError') {
              logDebug("Intento MINI-EB expirado (timeout)");
            } else {
              logDebug("Error al consultar MINI-EB", error);
            }
          }
        }

        throw lastError ?? new Error("No se pudo obtener el estado MINI-EB");
      };

      try {
        logDebug("Consultando estado MINI-EB", { silent });
        const status = await fetchStatus();
        const connectivity =
          typeof status?.connectivity === "string" ? status.connectivity.toLowerCase() : undefined;
        const apActive = Boolean(status?.ap_active);
        setIsApRecoveryMode(apActive || (connectivity ? connectivity !== "full" : false));
        const rawIp =
          typeof status?.ip === "string" && status.ip.trim().length > 0
            ? status.ip.trim()
            : typeof status?.ip_address === "string" && status.ip_address.trim().length > 0
              ? status.ip_address.trim()
              : null;
        const ssid =
          typeof status?.ssid === "string" && status.ssid.trim().length > 0
            ? status.ssid.trim()
            : "—";

        if (!rawIp) {
          throw new Error("Respuesta MINI-EB sin IP");
        }

        setNetworkIP(rawIp);
        setNetworkSSID(ssid);
        setNetworkIP2(rawIp);
        setMiniEbStatus({ status: "ready", ip: rawIp, ssid });
        miniEbErrorNotifiedRef.current = false;
        logDebug("MINI-EB listo", { ip: rawIp, ssid });
      } catch (error) {
        setNetworkIP(null);
        setNetworkSSID("—");
        setNetworkIP2("—");
        setIsApRecoveryMode(false);
        setMiniEbStatus({
          status: "error",
          error: "No se pudo obtener el acceso MINI-EB. Inténtalo de nuevo.",
        });

        if (featureFlags.miniEbStable && !miniEbErrorNotifiedRef.current) {
          toast({
            title: "Error MINI-EB",
            description: "No se pudo obtener el acceso MINI-EB.",
            variant: "destructive",
          });
          miniEbErrorNotifiedRef.current = true;
        }

        logDebug("Fallo al consultar MINI-EB", error);
      }
    },
    [featureFlags.debugLogs, featureFlags.miniEbStable, toast]
  );

  const refreshWakeStatus = useCallback(
    async (silent = false) => {
      try {
        const status = await api.getWakeStatus();
        setWakeStatus(status);
        setWakeWordEnabled(status.enabled);
        const current = storage.getSettings();
        if (current.wakeWordEnabled !== status.enabled) {
          storage.saveSettings({ wakeWordEnabled: status.enabled });
        }
      } catch (error) {
        logger.error('Error fetching wake status', error);
        if (!silent) {
          toast({
            title: "No se pudo consultar 'Hey Basculin'",
            description: "Verifica la conexión con el backend.",
            variant: "destructive",
          });
        }
      }
    },
    [toast]
  );

  // Load settings on mount
  useEffect(() => {
    const settings = storage.getSettings();
    setVoiceId(settings.voiceId);
    voiceIdRef.current = settings.voiceId;
    setWakeWordEnabled(settings.wakeWordEnabled ?? false);
    setDiabetesMode(settings.diabetesMode);
    setCalibrationFactor(settings.calibrationFactor.toString());
    setDecimals(settings.scale?.decimals?.toString() ?? "1");
    setApiUrl(settings.apiUrl);
    setWsUrl(settings.wsUrl);
    setChatGptKey(settings.chatGptKey);
    setNightscoutUrl(settings.nightscoutUrl);
    setNightscoutToken(settings.nightscoutToken);
    setCorrectionFactor(settings.correctionFactor.toString());
    setCarbRatio(settings.carbRatio.toString());
    setTargetGlucose(settings.targetGlucose.toString());
    setHypoAlarm(settings.hypoAlarm.toString());
    setHyperAlarm(settings.hyperAlarm.toString());
    setTimerAlarmSoundEnabled(settings.timerAlarmSoundEnabled);
    setTimerVoiceAnnouncementsEnabled(settings.timerVoiceAnnouncementsEnabled);
    setUiVolume(settings.uiVolume ?? 1);
    setFeatureFlags(getFeatureFlags());

    void refreshNetworkStatus();
    void refreshWakeStatus(true);

    // Refresh network status every 10 seconds
    const interval = setInterval(() => {
      void refreshNetworkStatus({ silent: true });
    }, 10000);

    return () => clearInterval(interval);
  }, [refreshNetworkStatus, refreshWakeStatus]);

  useEffect(() => {
    let cancelled = false;

    const loadBackendSettings = async () => {
      try {
        const payload = await api.fetchBackendSettings();
        if (cancelled) {
          return;
        }

        const openAiValue =
          typeof payload.network?.openai_api_key === "string" ? payload.network.openai_api_key.trim() : "";
        const openAiStored = openAiValue === "__stored__";
        setBackendHasOpenAIKey(openAiStored || Boolean(openAiValue));
        if (openAiValue && !openAiStored) {
          setChatGptKey(openAiValue);
          storage.saveSettings({ chatGptKey: openAiValue });
        }

        const nightscoutSection =
          payload && typeof payload.nightscout === "object"
            ? (payload.nightscout as { url?: string | null; token?: string | null; hasToken?: boolean | null })
            : null;

        const legacyDiabetes = payload.diabetes;
        const rawUrl = typeof nightscoutSection?.url === "string"
          ? nightscoutSection.url.trim()
          : typeof legacyDiabetes?.nightscout_url === "string"
            ? legacyDiabetes.nightscout_url.trim()
            : "";
        const sanitizedUrl = rawUrl === "__stored__" ? "" : rawUrl;
        setBackendNightscoutUrl(sanitizedUrl || null);
        if (sanitizedUrl) {
          setNightscoutUrl(sanitizedUrl);
          storage.saveSettings({ nightscoutUrl: sanitizedUrl });
        }

        const sectionToken = typeof nightscoutSection?.token === "string" ? nightscoutSection.token.trim() : "";
        const legacyToken = typeof legacyDiabetes?.nightscout_token === "string"
          ? legacyDiabetes.nightscout_token.trim()
          : "";
        const hasToken =
          nightscoutSection?.hasToken === true ||
          sectionToken === "__stored__" ||
          legacyToken === "__stored__" ||
          (sectionToken !== "" && sectionToken !== "__stored__") ||
          (legacyToken !== "" && legacyToken !== "__stored__");
        setBackendNightscoutHasToken(hasToken);

        if (!sanitizedUrl && !hasToken) {
          setBackendNightscoutUrl(null);
          setBackendNightscoutHasToken(false);
        }
      } catch (error) {
        logger.debug("No se pudo cargar ajustes agregados del backend", { error });
      }
    };

    void loadBackendSettings();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (networkModalOpen) {
      setNetworkModalStatus(null);
      setIsNetworkModalConnecting(false);
      setNetworkModalPassword('');
      setNetworkModalSSID((current) => {
        if (current) {
          return current;
        }
        if (networkSSID && networkSSID !== '—') {
          return networkSSID;
        }
        return '';
      });
      return;
    }

    setNetworkModalPassword('');
    setNetworkModalStatus(null);
    setIsNetworkModalConnecting(false);
    setNetworkModalSSID('');
  }, [networkModalOpen, networkSSID]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handler = () => setShowCalibrationWizard(true);
    window.addEventListener('open-calibration-wizard', handler);
    return () => {
      window.removeEventListener('open-calibration-wizard', handler);
    };
  }, []);

  const handleOpenNetworkModal = () => {
    setNetworkModalOpen(true);
  };

  const handleNetworkModalConnect = async () => {
    const ssid = networkModalSSID.trim();

    if (!ssid) {
      setNetworkModalStatus({ type: 'error', message: 'Ingresa el nombre de la red Wi-Fi.' });
      return;
    }

    const password = networkModalPassword.trim();
    const isOpenNetwork = password.length === 0;
    const payload: Record<string, unknown> = {
      ssid,
      secured: !isOpenNetwork,
      open: isOpenNetwork,
    };

    if (!isOpenNetwork) {
      payload.password = password;
    }

    setIsNetworkModalConnecting(true);
    setNetworkModalStatus({ type: 'info', message: 'Enviando datos a la báscula…' });

    try {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 15000);

      const response = await fetch('/api/miniweb/connect-wifi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).finally(() => {
        window.clearTimeout(timeoutId);
      });

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as
          | { detail?: unknown; message?: unknown }
          | null;

        const detail =
          typeof errorBody?.detail === 'string'
            ? errorBody.detail
            : typeof errorBody?.detail === 'object' && errorBody.detail !== null
              ? (() => {
                  const maybeMessage = (errorBody.detail as { message?: unknown }).message;
                  return typeof maybeMessage === 'string' ? maybeMessage : undefined;
                })()
              : undefined;

        const message =
          (typeof errorBody?.message === 'string' ? errorBody.message : undefined) ||
          detail ||
          'No se pudo iniciar la conexión.';

        setNetworkModalStatus({ type: 'error', message });
        return;
      }

      setNetworkModalStatus({
        type: 'info',
        message: 'Conectando… verificando el estado de la red.',
      });

      const started = Date.now();
      const timeoutMs = 30000;
      const delay = (ms: number) =>
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, ms);
        });

      while (Date.now() - started < timeoutMs) {
        try {
          const statusResponse = await fetch('/api/miniweb/status', { cache: 'no-store' });
          if (!statusResponse.ok) {
            await delay(2000);
            continue;
          }

          const status = await statusResponse.json();
          if (
            status?.ap_active === false &&
            typeof status?.connectivity === 'string' &&
            status.connectivity.toLowerCase() === 'full'
          ) {
            await refreshNetworkStatus();
            setNetworkModalStatus({
              type: 'success',
              message: `Conectado a ${status.ssid || ssid}.`,
            });
            return;
          }
        } catch (error) {
          console.error('Failed to fetch status during Wi-Fi connect', error);
        }

        await delay(2000);
      }

      setNetworkModalStatus({
        type: 'info',
        message:
          'Conectando… Si pierdes esta página es normal: cambia tu Wi-Fi al punto de acceso/red seleccionada y vuelve a abrir la app.',
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setNetworkModalStatus({
          type: 'info',
          message:
            'Conectando… Si pierdes esta página es normal: cambia tu Wi-Fi al punto de acceso/red seleccionada y vuelve a abrir la app.',
        });
      } else {
        console.error('Failed to connect Wi-Fi', error);
        setNetworkModalStatus({ type: 'error', message: 'Error al conectar. Inténtalo de nuevo.' });
      }
    } finally {
      setIsNetworkModalConnecting(false);
    }
  };

  const handleApplyEndpointTemplate = useCallback(
    (template: { api: string; ws: string }) => {
      setApiUrl(template.api);
      setWsUrl(template.ws);
      storage.saveSettings({ apiUrl: template.api, wsUrl: template.ws });
      setApiBaseUrl(template.api);
      toast({
        title: "Guardado",
        description: "Se actualizaron las URLs para integraciones remotas.",
      });
    },
    [setApiBaseUrl, toast]
  );

  useEffect(() => {
    if (autoAppliedEndpointsRef.current || remoteLocked) {
      return;
    }

    const looksLocal = (value: string | undefined) =>
      !value || /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(value);

    const apiIsLocal = looksLocal(apiUrl);
    const wsIsLocal = !wsUrl || /^wss?:\/\/(localhost|127\.0\.0\.1)/i.test(wsUrl);

    let targetApi = "";
    let targetWs = "";
    if (suggestedApiFromBrowserHost && apiIsLocal) {
      targetApi = suggestedApiFromBrowserHost;
      targetWs = suggestedWsFromBrowserHost || suggestedWsFromNetwork || wsUrl;
    } else if (suggestedApiFromNetwork && apiIsLocal) {
      targetApi = suggestedApiFromNetwork;
      targetWs = suggestedWsFromNetwork || wsUrl;
    }

    if (targetApi && (apiIsLocal || wsIsLocal)) {
      const resolvedWs = targetWs || (targetApi.startsWith("https") ? targetApi.replace(/^https/, "wss") : targetApi.replace(/^http/, "ws"));
      handleApplyEndpointTemplate({ api: targetApi, ws: resolvedWs });
      autoAppliedEndpointsRef.current = true;
    }
  }, [apiUrl, wsUrl, suggestedApiFromBrowserHost, suggestedWsFromBrowserHost, suggestedApiFromNetwork, suggestedWsFromNetwork, handleApplyEndpointTemplate, remoteLocked]);

  const handleLegacyNetworkDialogOpen = () => {
    setLegacyNetworkDialogOpen(true);
  };

  const loadVoices = useCallback(async () => {

    setIsLoadingVoices(true);
    setVoiceError(null);

    try {
      const response = await fetch(buildApiUrl('/api/voice/tts/voices'));
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as VoicesResponse;
      const piperModels = Array.isArray(data.piper_models) ? data.piper_models : [];

      let options: VoiceOption[] = [];

      if (piperModels.length > 0) {
        options = piperModels
          .map((model) => {
            if (!model) {
              return null;
            }

            const id =
              typeof model.id === 'string'
                ? model.id
                : typeof model.path === 'string'
                  ? model.path
                  : undefined;
            if (!id) {
              return null;
            }

            const readableName = typeof model.name === 'string' && model.name.trim().length > 0 ? model.name : id;
            const description = typeof model.path === 'string' ? model.path : undefined;

            const option: VoiceOption = {
              id,
              label: readableName,
              backend: 'piper',
              description: description && description !== readableName ? description : undefined,
            };

            return option;
          })
          .filter((option): option is VoiceOption => option !== null);
      } else if (data.espeak_available) {
        options = [
          {
            id: 'espeak',
            label: 'eSpeak NG',
            backend: 'espeak',
            description: 'Motor eSpeak NG',
          },
        ];
      }

      const currentVoiceId = voiceIdRef.current;
      if (currentVoiceId && !options.some((option) => option.id === currentVoiceId)) {
        options = [
          {
            id: currentVoiceId,
            label: currentVoiceId,
            backend: 'custom',
            description: 'Configuración personalizada',
          },
          ...options,
        ];
      }

      setVoiceOptions(options);

      if (!currentVoiceId && options.length > 0) {
        const defaultVoice = options[0];
        setVoiceId(defaultVoice.id);
        voiceIdRef.current = defaultVoice.id;
        storage.saveSettings({ voiceId: defaultVoice.id });
      }

      if (options.length === 0) {
        setVoiceError('No hay voces disponibles en el servidor');
      }
    } catch (error) {
      console.error('Failed to load voices', error);
      setVoiceError('No se pudieron cargar las voces disponibles');
      setVoiceOptions([]);
    } finally {
      setIsLoadingVoices(false);
    }
  }, [buildApiUrl]);

  // Save settings when they change
  useEffect(() => {
    storage.saveSettings({ isVoiceActive: voiceEnabled });
  }, [voiceEnabled]);

  useEffect(() => {
    storage.saveSettings({ timerAlarmSoundEnabled });
  }, [timerAlarmSoundEnabled]);

  useEffect(() => {
    storage.saveSettings({ timerVoiceAnnouncementsEnabled });
  }, [timerVoiceAnnouncementsEnabled]);

  useEffect(() => {
    storage.saveSettings({ uiVolume });
  }, [uiVolume]);

  useEffect(() => {
    voiceIdRef.current = voiceId;
  }, [voiceId]);

  useEffect(() => {
    storage.saveSettings({ diabetesMode });
  }, [diabetesMode]);

  useEffect(() => {
    void loadVoices();
  }, [loadVoices]);

  const openKeyboard = (
    title: string,
    type: "numeric" | "text" | "password" | "url" | "apikey",
    field: string,
    showDecimal = false,
    min?: number,
    max?: number,
    allowEmpty = false,
    maxLength?: number
  ) => {
    setKeyboardConfig({ title, type, field, showDecimal, min, max, allowEmpty, maxLength });
    const currentValue = getCurrentValue(field);
    setTempValue(currentValue);
    setKeyboardOpen(true);
  };

  const getCurrentValue = (field: string): string => {
    const values: Record<string, string> = {
      calibrationFactor,
      decimals,
      apiUrl,
      wsUrl,
      chatGptKey,
      nightscoutUrl,
      nightscoutToken,
      correctionFactor,
      carbRatio,
      targetGlucose,
      hypoAlarm,
      hyperAlarm,
      networkModalSSID,
      networkModalPassword,
      otaTargetOverride,
    };
    return values[field] || "";
  };

  const handleKeyboardConfirm = () => {
    const setters: Record<string, (value: string) => void> = {
      calibrationFactor: setCalibrationFactor,
      decimals: (value: string) => setDecimals(parseDecimalsPreference(value).toString()),
      chatGptKey: setChatGptKey,
      nightscoutUrl: setNightscoutUrl,
      nightscoutToken: setNightscoutToken,
      correctionFactor: setCorrectionFactor,
      carbRatio: setCarbRatio,
      targetGlucose: setTargetGlucose,
      hypoAlarm: setHypoAlarm,
      hyperAlarm: setHyperAlarm,
      apiUrl: setApiUrl,
      wsUrl: setWsUrl,
      networkModalSSID: setNetworkModalSSID,
      networkModalPassword: setNetworkModalPassword,
      otaTargetOverride: setOtaTargetOverride,
    };

    const setter = setters[keyboardConfig.field];
    if (setter) {
      setter(tempValue);

      // Save to storage based on field
      const field = keyboardConfig.field;
      if (field === "otaTargetOverride") {
        toast({
          title: "Objetivo actualizado",
          description: "Se usará en la próxima actualización OTA",
        });
        return;
      }

      if (field === 'calibrationFactor') {
        storage.saveSettings({ calibrationFactor: parseFloat(tempValue) || 1 });
      } else if (field === 'decimals') {
        storage.saveSettings({ scale: { decimals: parseDecimalsPreference(tempValue) } });
      } else if (field === 'chatGptKey') {
        storage.saveSettings({ chatGptKey: tempValue });
      } else if (field === 'nightscoutUrl') {
        storage.saveSettings({ nightscoutUrl: tempValue });
      } else if (field === 'nightscoutToken') {
        storage.saveSettings({ nightscoutToken: tempValue });
      } else if (field === 'correctionFactor') {
        storage.saveSettings({ correctionFactor: parseFloat(tempValue) || 50 });
      } else if (field === 'carbRatio') {
        storage.saveSettings({ carbRatio: parseFloat(tempValue) || 10 });
      } else if (field === 'targetGlucose') {
        storage.saveSettings({ targetGlucose: parseFloat(tempValue) || 100 });
      } else if (field === 'hypoAlarm') {
        storage.saveSettings({ hypoAlarm: parseFloat(tempValue) || 70 });
      } else if (field === 'hyperAlarm') {
        storage.saveSettings({ hyperAlarm: parseFloat(tempValue) || 180 });
      } else if (field === 'apiUrl') {
        storage.saveSettings({ apiUrl: tempValue });
        setApiBaseUrl(tempValue);
      } else if (field === 'wsUrl') {
        storage.saveSettings({ wsUrl: tempValue });
      }
      
      // Haptic feedback on save
      if (navigator.vibrate) {
        navigator.vibrate(30);
      }
      
      toast({
        title: "Guardado",
        description: "Configuración actualizada correctamente",
      });
    }
  };

  const handlePasteToField = async (setter: (value: string) => void) => {
    const fallbackToast = () => {
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
        logger.debug("No se pudo leer desde navigator.clipboard", { error });
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
        const successful = document.execCommand("paste");
        if (successful) {
          pasted = textarea.value;
        }
      } catch (error) {
        logger.debug("document.execCommand('paste') no disponible", { error });
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

    const execCommandText = tryExecCommand();
    if (execCommandText !== null) {
      setter(execCommandText);
      return;
    }

    fallbackToast();
  };

  const handleExportData = () => {
    try {
      const data = storage.exportData();
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bascula-backup-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      
      toast({
        title: "Exportado",
        description: "Datos exportados correctamente",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "No se pudo exportar los datos",
        variant: "destructive",
      });
    }
  };

  const handleImportData = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          try {
            const content = event.target?.result as string;
            const success = storage.importData(content);
            if (success) {
              toast({
                title: "Importado",
                description: "Datos importados correctamente. Recarga la página.",
              });
              // Reload page to apply settings
              setTimeout(() => window.location.reload(), 2000);
            } else {
              throw new Error('Invalid data');
            }
          } catch (error) {
            toast({
              title: "Error",
              description: "Archivo inválido",
              variant: "destructive",
            });
          }
        };
        reader.readAsText(file);
      }
    };
    input.click();
  };

  const handleResetSettings = () => {
    if (confirm('¿Estás seguro? Se perderán todas las configuraciones.')) {
      storage.resetSettings();
      toast({
        title: "Reiniciado",
        description: "Configuraciones restauradas a valores por defecto",
      });
      setTimeout(() => window.location.reload(), 1000);
    }
  };

  const handleTestAudio = async () => {
    setIsTestingAudio(true);
    try {
      await api.speak("Hola, este es un test del sistema de audio");
      toast({
        title: "Test de Audio",
        description: "Audio funcionando correctamente",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "No se pudo reproducir el audio",
        variant: "destructive",
      });
    } finally {
      setIsTestingAudio(false);
    }
  };

  const handleWakeToggle = async (enabled: boolean) => {
    const previous = wakeWordEnabled;
    setWakeWordEnabled(enabled);
    setIsWakeUpdating(true);
    try {
      if (enabled) {
        await api.enableWake();
      } else {
        await api.disableWake();
      }
      storage.saveSettings({ wakeWordEnabled: enabled });
      await refreshWakeStatus(true);
    } catch (error) {
      logger.error('Failed to toggle wake word', error);
      setWakeWordEnabled(previous);
      toast({
        title: "No se pudo actualizar 'Hey Basculin'",
        description: "Inténtalo de nuevo en unos segundos.",
        variant: "destructive",
      });
    } finally {
      setIsWakeUpdating(false);
    }
  };

  const handleDeviceVoiceTest = async () => {
    if (!voiceEnabled) {
      return;
    }

    setIsTestingDeviceVoice(true);
    try {
      const params = new URLSearchParams({ text: "Esta es una prueba" });
      const selectedVoice = voiceIdRef.current;
      if (selectedVoice) {
        params.set("voice", selectedVoice);
      }

      const response = await fetch(buildApiUrl(`/api/voice/tts/say?${params.toString()}`), {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      toast({
        title: "Prueba de voz",
        description: "Se envió la prueba al dispositivo",
      });
    } catch (error) {
      console.error("Device voice test failed", error);
      toast({
        title: "Error",
        description: "No se pudo reproducir la voz en el dispositivo",
        variant: "destructive",
      });
    } finally {
      setIsTestingDeviceVoice(false);
    }
  };

  const handleBrowserVoiceTest = async () => {
    if (!voiceEnabled) {
      return;
    }

    setIsTestingBrowserVoice(true);
    try {
      const params = new URLSearchParams({ text: "Esta es una prueba" });
      const selectedVoice = voiceIdRef.current;
      if (selectedVoice) {
        params.set("voice", selectedVoice);
      }

      const response = await fetch(buildApiUrl(`/api/voice/tts/synthesize?${params.toString()}`), {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(objectUrl);

      const cleanup = () => {
        URL.revokeObjectURL(objectUrl);
        audio.onended = null;
        audio.onerror = null;
      };

      audio.onended = cleanup;
      audio.onerror = cleanup;

      try {
        await audio.play();
      } catch (playError) {
        cleanup();
        throw playError;
      }

      toast({
        title: "Prueba en navegador",
        description: "Reproduciendo voz sintetizada",
      });
    } catch (error) {
      console.error("Browser voice test failed", error);
      toast({
        title: "Error",
        description: "No se pudo reproducir la voz en el navegador",
        variant: "destructive",
      });
    } finally {
      setIsTestingBrowserVoice(false);
    }
  };

  const handlePlayBeep = () => {
    if (!voiceEnabled) {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const extendedWindow = window as typeof window & {
      playSound?: (sound: string) => void;
      webkitAudioContext?: typeof AudioContext;
    };

    try {
      if (typeof extendedWindow.playSound === "function") {
        extendedWindow.playSound("beep");
        return;
      }

      const AudioContextClass = window.AudioContext ?? extendedWindow.webkitAudioContext;
      if (!AudioContextClass) {
        console.warn("AudioContext no disponible");
        return;
      }

      const context = new AudioContextClass();
      if (context.state === "suspended") {
        void context.resume().catch(() => undefined);
      }

      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, context.currentTime);
      gain.gain.setValueAtTime(0.0001, context.currentTime);

      oscillator.connect(gain);
      gain.connect(context.destination);

      oscillator.start();
      gain.gain.exponentialRampToValueAtTime(0.2, context.currentTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.4);
      oscillator.stop(context.currentTime + 0.5);

      oscillator.onended = () => {
        void context.close().catch(() => undefined);
      };
    } catch (error) {
      console.error("No se pudo reproducir el beep", error);
    }
  };

  const handleTestOpenAI = async () => {
    const candidateKey = chatGptKey.trim();
    setIsTestingOpenAI(true);
    try {
      const response = await api.testOpenAI(candidateKey || undefined, undefined);
      if (response.ok) {
        toast({
          title: "OpenAI listo",
          description: response.message ?? "Conexión con OpenAI verificada",
        });
      } else {
        const parts: string[] = [];
        if (response.message) {
          parts.push(response.message);
        }
        toast({
          title: "OpenAI no disponible",
          description: parts.join(" · ") || "El backend no pudo validar la API key.",
          variant: "destructive",
        });
      }
    } catch (error) {
      let description = "No se pudo conectar con OpenAI. Verifica tu API key.";
      if (error instanceof ApiError && error.message) {
        description = error.message;
      }
      toast({ title: "Error", description, variant: "destructive" });
    } finally {
      setIsTestingOpenAI(false);
    }
  };

  const handleTestNightscout = async () => {
    const urlCandidate = nightscoutUrl.trim();
    const tokenCandidate = nightscoutToken.trim();
    setIsTestingNightscout(true);
    try {
      const response = await api.testNightscout(urlCandidate || undefined, tokenCandidate || undefined, undefined);
      if (response.ok) {
        toast({
          title: "Nightscout listo",
          description: response.message ?? "Conexión con Nightscout verificada",
        });
      } else {
        const pieces: string[] = [];
        if (response.message) {
          pieces.push(response.message);
        }
        toast({
          title: "Nightscout no respondió",
          description: pieces.join(" · ") || "Verifica la URL y el token.",
          variant: "destructive",
        });
      }
    } catch (error) {
      let description = "No se pudo conectar con Nightscout. Verifica la URL y token.";
      if (error instanceof ApiError && error.message) {
        description = error.message;
      }
      toast({ title: "Error", description, variant: "destructive" });
    } finally {
      setIsTestingNightscout(false);
    }
  };

  const handleSaveOpenAI = async () => {
    const trimmedKey = chatGptKey.trim();

    setIsSavingOpenAI(true);
    try {
      const payload: BackendSettingsUpdate = {
        network: { openai_api_key: trimmedKey || null },
      };
      const response = await api.updateBackendSettings(payload);

      const persistedKey = Boolean(
        (typeof response.network?.openai_api_key === "string" && response.network.openai_api_key === "__stored__") ||
          trimmedKey,
      );
      setBackendHasOpenAIKey(persistedKey);
      setChatGptKey(trimmedKey);
      storage.saveSettings({ chatGptKey: trimmedKey });

      toast({
        title: "OpenAI guardado",
        description: "La clave se sincronizó con el backend.",
      });
    } catch (error) {
      let description = "No se pudo guardar la clave de OpenAI.";
      if (error instanceof ApiError && error.message) {
        description = error.message;
      }
      toast({ title: "Error", description, variant: "destructive" });
    } finally {
      setIsSavingOpenAI(false);
    }
  };

  const handleSaveNightscout = async () => {
    const trimmedUrl = nightscoutUrl.trim();
    const trimmedToken = nightscoutToken.trim();

    setIsSavingNightscout(true);
    try {
      const payload: BackendSettingsUpdate = {
        nightscout: { url: trimmedUrl || null, token: trimmedToken || null },
      };
      const response = await api.updateBackendSettings(payload);

      const responseUrl =
        typeof response.nightscout?.url === "string"
          ? response.nightscout.url.trim()
          : typeof response.diabetes?.nightscout_url === "string"
            ? response.diabetes.nightscout_url.trim()
            : "";
      const backendUrl = responseUrl === "__stored__" ? trimmedUrl : responseUrl || trimmedUrl;
      setBackendNightscoutUrl(backendUrl || null);
      const responseToken =
        typeof response.nightscout?.token === "string"
          ? response.nightscout.token.trim()
          : typeof response.diabetes?.nightscout_token === "string"
            ? response.diabetes.nightscout_token.trim()
            : "";
      const persistedToken =
        response.nightscout?.hasToken === true ||
        responseToken === "__stored__" ||
        Boolean(trimmedToken);
      setBackendNightscoutHasToken(persistedToken);

      setNightscoutUrl(trimmedUrl);
      setNightscoutToken(trimmedToken);

      storage.saveSettings({
        nightscoutUrl: trimmedUrl,
        nightscoutToken: trimmedToken,
      });

      toast({
        title: "Nightscout guardado",
        description: "Los cambios se sincronizaron con el backend.",
      });
    } catch (error) {
      let description = "No se pudo guardar la configuración de Nightscout.";
      if (error instanceof ApiError && error.message) {
        description = error.message;
      }
      toast({ title: "Error", description, variant: "destructive" });
    } finally {
      setIsSavingNightscout(false);
    }
  };

  const handleCheckUpdates = async () => {
    setIsCheckingUpdates(true);
    try {
      const result = await api.getOtaStatus();
      setOtaStatus(result);

      if (result.hasUpdate) {
        toast({
          title: "Actualización disponible",
          description: `Versión ${result.latest} lista para instalar`,
        });
      } else {
        toast({
          title: "Sistema actualizado",
          description: `La versión actual es ${result.current}`,
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "No se pudo verificar actualizaciones",
        variant: "destructive",
      });
    } finally {
      setIsCheckingUpdates(false);
    }
  };

  const refreshOtaStatus = useCallback(async () => {
    if (!featureFlags.otaApply) {
      return;
    }

    try {
      const status = await api.getOtaJobStatus();
      logger.debug("OTA status actualizado", { status });
      setOtaJobState(status);
    } catch (error) {
      if (error instanceof ApiError) {
        logger.warn("No se pudo obtener estado OTA", {
          status: error.status,
          message: error.message,
        });
      } else {
        console.warn("No se pudo obtener estado OTA", error);
      }
    }
  }, [featureFlags.otaApply]);

  const refreshOtaLogs = useCallback(
    async (lines = MAX_OTA_LOG_LINES) => {
      if (!featureFlags.otaApply) {
        return;
      }

      try {
        const text = await api.getOtaLogs(lines);
        logger.debug("OTA logs actualizados", { lines });
        setOtaLogs(trimLogLines(text, lines));
      } catch (error) {
        if (error instanceof ApiError) {
          logger.warn("No se pudieron obtener logs OTA", {
            status: error.status,
            message: error.message,
          });
        } else {
          console.warn("No se pudieron obtener logs OTA", error);
        }
      }
    },
    [featureFlags.otaApply]
  );

  const stopOtaEventStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const stopOtaPolling = useCallback(() => {
    if (otaPollIntervalRef.current) {
      window.clearInterval(otaPollIntervalRef.current);
      otaPollIntervalRef.current = null;
    }
    if (otaSlowPollTimeoutRef.current) {
      window.clearTimeout(otaSlowPollTimeoutRef.current);
      otaSlowPollTimeoutRef.current = null;
    }
  }, []);

  const startOtaPolling = useCallback(
    (intervalMs: number, lifespanMs?: number) => {
      stopOtaEventStream();
      stopOtaPolling();

      void refreshOtaStatus();
      void refreshOtaLogs();

      otaPollIntervalRef.current = window.setInterval(() => {
        void refreshOtaStatus();
        void refreshOtaLogs();
      }, intervalMs);

      if (lifespanMs) {
        otaSlowPollTimeoutRef.current = window.setTimeout(() => {
          stopOtaPolling();
        }, lifespanMs);
      }
    },
    [refreshOtaLogs, refreshOtaStatus, stopOtaEventStream, stopOtaPolling]
  );

  const startOtaEventStream = useCallback(() => {
    stopOtaPolling();

    try {
      const url = buildApiUrl("/api/ota/events");
      const source = new EventSource(url);
      eventSourceRef.current = source;

      source.onopen = () => {
        logger.debug("SSE OTA conectado");
        void refreshOtaLogs();
      };

      source.addEventListener("state", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as OtaJobState;
          logger.debug("Estado OTA (SSE)", { status: payload.status, progress: payload.progress });
          setOtaJobState(payload);
        } catch (error) {
          logger.warn("No se pudo parsear estado OTA SSE", { error });
        }
      });

      source.addEventListener("log", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { line?: string };
          if (payload.line) {
            setOtaLogs((prev) => {
              const next = prev ? `${prev}\n${payload.line}` : payload.line;
              return trimLogLines(next);
            });
          }
        } catch (error) {
          logger.warn("No se pudo parsear log OTA SSE", { error });
        }
      });

      source.onerror = () => {
        logger.warn("SSE OTA con error, cambiando a polling");
        stopOtaEventStream();
        startOtaPolling(1000, 60000);
      };

      return true;
    } catch (error) {
      logger.warn("No se pudo iniciar SSE OTA", { error });
      stopOtaEventStream();
      startOtaPolling(1000, 60000);
      return false;
    }
  }, [buildApiUrl, refreshOtaLogs, startOtaPolling, stopOtaEventStream, stopOtaPolling]);

  const handleApplyUpdate = useCallback(async () => {
    if (!featureFlags.otaApply) {
      return;
    }

    const target = otaTargetOverride.trim();
    setIsApplyingUpdate(true);
    setOtaPanelOpen(true);

    try {
      logger.debug("Solicitando OTA apply", { target: target || "latest" });
      await api.applyOtaUpdate(target || undefined);
      toast({
        title: "Actualización iniciada",
        description: "El proceso continúa en segundo plano",
      });
      await refreshOtaStatus();
      await refreshOtaLogs();
      if (!eventSourceRef.current) {
        startOtaEventStream();
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast({
          title: "Actualización en curso",
          description: "Ya hay una actualización en curso",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Error",
          description: "No se pudo iniciar la actualización",
          variant: "destructive",
        });
      }
      logger.error("Fallo al solicitar OTA", { error });
    } finally {
      setIsApplyingUpdate(false);
    }
  }, [api, eventSourceRef, featureFlags.otaApply, otaTargetOverride, refreshOtaLogs, refreshOtaStatus, startOtaEventStream, toast]);

  useEffect(() => {
    if (!featureFlags.otaApply) {
      return;
    }

    if (otaJobState?.status === "running") {
      setOtaPanelOpen(true);
    } else if (otaJobState) {
      setIsApplyingUpdate(false);
    }

    if (!otaJobState) {
      return;
    }

    if (otaLastStatusRef.current !== otaJobState.status) {
      if (otaJobState.status === "success") {
        toast({
          title: "Actualización aplicada",
          description: "Puedes volver al inicio cuando quieras",
        });
      } else if (otaJobState.status === "error") {
        toast({
          title: "Actualización fallida",
          description: otaJobState.message || "Revisa los registros para más detalles",
          variant: "destructive",
        });
      }
    }

    otaLastStatusRef.current = otaJobState.status;
  }, [featureFlags.otaApply, otaJobState, toast]);

  useEffect(() => {
    if (!featureFlags.otaApply) {
      stopOtaEventStream();
      stopOtaPolling();
      return;
    }

    const shouldStream = otaPanelOpen || otaJobState?.status === "running";
    if (shouldStream) {
      if (!eventSourceRef.current) {
        const started = startOtaEventStream();
        if (!started) {
          startOtaPolling(1000, 60000);
        }
      }
    } else {
      stopOtaEventStream();
      stopOtaPolling();
    }
  }, [eventSourceRef, featureFlags.otaApply, otaJobState?.status, otaPanelOpen, startOtaEventStream, startOtaPolling, stopOtaEventStream, stopOtaPolling]);

  useEffect(() => {
    if (!featureFlags.otaApply) {
      setOtaJobState(null);
      setOtaLogs("");
      setOtaPanelOpen(false);
      setOtaApplyDialogOpen(false);
      otaLastStatusRef.current = null;
      return;
    }

    void refreshOtaStatus();
  }, [featureFlags.otaApply, refreshOtaStatus]);

  useEffect(() => {
    if (!featureFlags.otaApply) {
      return;
    }

    if (otaPanelOpen || otaJobState?.status === "running") {
      void refreshOtaLogs();
    }
  }, [featureFlags.otaApply, otaJobState?.status, otaPanelOpen, refreshOtaLogs]);

  useEffect(() => {
    if (!otaPanelOpen) {
      return;
    }
    const container = otaLogsRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [otaLogs, otaPanelOpen]);

  useEffect(() => {
    return () => {
      stopOtaEventStream();
      stopOtaPolling();
    };
  }, [stopOtaEventStream, stopOtaPolling]);

  const wakeStatusLabel = !wakeStatus
    ? 'Consultando…'
    : !wakeWordEnabled
      ? 'Desactivado'
      : wakeStatus.running
        ? 'Escuchando'
        : 'En espera';
  const wakeLastDetection = wakeStatus?.last_wake_ts
    ? new Date(wakeStatus.last_wake_ts).toLocaleTimeString()
    : null;
  const wakeLastError = wakeStatus?.errors && wakeStatus.errors.length > 0
    ? wakeStatus.errors[wakeStatus.errors.length - 1]
    : null;

  return (
    <div className="h-full overflow-y-auto p-4">
      <Tabs defaultValue="general" className="w-full">
        <TabsList className="mb-4 grid w-full grid-cols-5 h-16">
          <TabsTrigger value="general" className="flex flex-col gap-1 text-xs">
            <Settings className="h-5 w-5" />
            General
          </TabsTrigger>
          <TabsTrigger value="scale" className="flex flex-col gap-1 text-xs">
            <Scale className="h-5 w-5" />
            Báscula
          </TabsTrigger>
          <TabsTrigger value="network" className="flex flex-col gap-1 text-xs">
            <Wifi className="h-5 w-5" />
            Red
          </TabsTrigger>
          <TabsTrigger value="diabetes" className="flex flex-col gap-1 text-xs">
            <Heart className="h-5 w-5" />
            Diabetes
          </TabsTrigger>
          <TabsTrigger value="updates" className="flex flex-col gap-1 text-xs">
            <Download className="h-5 w-5" />
            OTA
          </TabsTrigger>
        </TabsList>

        {/* General Tab */}
        <TabsContent value="general" className="space-y-4">
          <Card className="p-6">
            <h3 className="mb-4 text-2xl font-bold">Configuración General</h3>

            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-lg font-medium">Modo Voz</Label>
                  <p className="text-sm text-muted-foreground">
                    Activar narración de texto y respuestas por voz
                  </p>
                </div>
                <Switch
                  checked={voiceEnabled}
                  onCheckedChange={(value) => {
                    void setVoicePreference(value);
                  }}
                  className="scale-150"
                />
              </div>

              {showVoiceSelector ? (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label className="text-lg font-medium">Seleccionar Voz</Label>
                    <select
                      className="w-full rounded-lg border border-input bg-background px-4 py-3 text-lg"
                      value={voiceId ?? ""}
                      onChange={(event) => {
                        const value = event.target.value || undefined;
                        setVoiceId(value);
                        voiceIdRef.current = value;
                        storage.saveSettings({ voiceId: value });
                      }}
                      disabled={isLoadingVoices || !voiceEnabled || voiceOptions.length === 0}
                    >
                      <option value="" disabled>
                        {isLoadingVoices ? "Cargando voces..." : "Selecciona una voz"}
                      </option>
                      {voiceOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                          {option.description ? ` • ${option.description}` : ""}
                        </option>
                      ))}
                    </select>
                    {voiceError ? (
                      <p className="text-sm text-destructive">{voiceError}</p>
                    ) : isLoadingVoices ? (
                      <p className="text-sm text-muted-foreground">Buscando voces disponibles…</p>
                    ) : null}
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    <Button
                      variant="outline"
                      size="lg"
                      className="w-full justify-start"
                      onClick={handleDeviceVoiceTest}
                      disabled={isTestingDeviceVoice || !voiceEnabled || isLoadingVoices}
                    >
                      <MonitorSpeaker className="mr-2 h-5 w-5" />
                      {isTestingDeviceVoice ? "Enviando..." : "Probar en dispositivo"}
                    </Button>
                    <Button
                      variant="outline"
                      size="lg"
                      className="w-full justify-start"
                      onClick={handleBrowserVoiceTest}
                      disabled={isTestingBrowserVoice || !voiceEnabled || isLoadingVoices}
                    >
                      <Globe className="mr-2 h-5 w-5" />
                      {isTestingBrowserVoice ? "Sintetizando..." : "Probar en navegador"}
                    </Button>
                    <Button
                      variant="outline"
                      size="lg"
                      className="w-full justify-start"
                      onClick={handlePlayBeep}
                      disabled={!voiceEnabled}
                    >
                      <BellRing className="mr-2 h-5 w-5" />
                      Beep
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="lg"
                  className="w-full justify-start"
                  onClick={handleTestAudio}
                  disabled={isTestingAudio || !voiceEnabled}
                >
                  <Volume2 className="mr-2 h-5 w-5" />
                  {isTestingAudio ? "Probando..." : "Probar Audio"}
                </Button>
              )}

              <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/20 p-4 md:flex-row md:items-center md:justify-between">
                <div className="space-y-2">
                  <div>
                    <Label className="text-lg font-medium">Activar 'Hey Basculin'</Label>
                    <p className="text-sm text-muted-foreground">
                      Escucha continua sin conexión para activar comandos de voz automáticamente.
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Estado: {wakeStatusLabel}
                    {wakeLastDetection ? ` • Último: ${wakeLastDetection}` : ''}
                    {wakeStatus?.backend ? ` • Fuente: ${wakeStatus.backend}` : ''}
                  </p>
                  {wakeLastError ? (
                    <p className="text-xs text-destructive">Error reciente: {wakeLastError}</p>
                  ) : null}
                </div>
                <Switch
                  checked={wakeWordEnabled}
                  onCheckedChange={(checked) => {
                    void handleWakeToggle(checked);
                  }}
                  disabled={isWakeUpdating}
                  className="scale-150 self-start md:self-center"
                />
              </div>

              {featureFlags.timerAlarms ? (
                <div className="space-y-6 border-t border-border pt-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-lg font-medium">Alarmas sonoras</Label>
                      <p className="text-sm text-muted-foreground">
                        Reproduce beeps cuando el temporizador finaliza.
                      </p>
                    </div>
                    <Switch
                      checked={timerAlarmSoundEnabled}
                      onCheckedChange={setTimerAlarmSoundEnabled}
                      className="scale-150"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-lg font-medium">Anunciar por voz</Label>
                      <p className="text-sm text-muted-foreground">
                        Envía un mensaje hablado al terminar el temporizador.
                      </p>
                    </div>
                    <Switch
                      checked={timerVoiceAnnouncementsEnabled}
                      onCheckedChange={setTimerVoiceAnnouncementsEnabled}
                      className="scale-150"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-lg font-medium">Volumen de interfaz</Label>
                    <p className="text-sm text-muted-foreground">
                      Ajusta el volumen de los sonidos (0 = silencio, 1 = máximo).
                    </p>
                    <div className="flex items-center gap-4">
                      <Slider
                        min={0}
                        max={1}
                        step={0.05}
                        value={[uiVolume]}
                        onValueChange={(value) => {
                          const [first] = value;
                          const clamped = Math.min(Math.max(first ?? 0, 0), 1);
                          setUiVolume(Number(clamped.toFixed(2)));
                        }}
                        className="max-w-[240px]"
                      />
                      <Input
                        type="number"
                        step="0.05"
                        min="0"
                        max="1"
                        value={uiVolume}
                        onChange={(event) => {
                          const numeric = Number(event.target.value);
                          if (Number.isNaN(numeric)) {
                            return;
                          }
                          const clamped = Math.min(Math.max(numeric, 0), 1);
                          setUiVolume(Number(clamped.toFixed(2)));
                        }}
                        className="w-24"
                      />
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </Card>

          <Card className="p-6">
            <h3 className="text-2xl font-bold">Animaciones</h3>
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label className="text-lg font-medium">Animación de mascota</Label>
                <p className="text-sm text-muted-foreground">
                  Activa movimiento y reacciones animadas de Basculin en la pantalla principal.
                </p>
              </div>
              <Switch
                checked={featureFlags.mascotMotion}
                onCheckedChange={(value) => {
                  setFeatureFlags(setFeatureFlag('mascotMotion', value));
                  toast({
                    title: value ? 'Animación activada' : 'Animación desactivada',
                    description: 'Los cambios se aplican inmediatamente.',
                  });
                }}
                className="scale-150"
              />
            </div>
          </Card>
        </TabsContent>

        {/* Scale Tab */}
        <TabsContent value="scale" className="space-y-4">
          <Card className="p-6">
            <h3 className="mb-4 text-2xl font-bold">Configuración de Báscula</h3>
            
            <div className="space-y-6">
              <div className="space-y-2">
                <Label className="text-lg font-medium">Decimales</Label>
                <select 
                  className="w-full rounded-lg border border-input bg-background px-4 py-3 text-lg"
                  value={decimals}
                  onChange={(e) => {
                    const nextDecimals = parseDecimalsPreference(e.target.value);
                    setDecimals(nextDecimals.toString());
                    storage.saveSettings({ scale: { decimals: nextDecimals } });
                    toast({
                      title: "Guardado",
                      description: "Preferencia de decimales actualizada",
                    });
                  }}
                >
                  <option value="0">Sin decimales (0)</option>
                  <option value="1">Un decimal (0.0)</option>
                </select>
              </div>

              <div className="space-y-2">
                <Label className="text-lg font-medium">Calibración</Label>
                <p className="text-sm text-muted-foreground mb-2">
                  Factor de calibración actual: {calibrationFactor}
                </p>
                <div className="flex gap-2">
                  <Input
                    type="text"
                    value={calibrationFactor}
                    readOnly
                    onClick={() => openKeyboard("Factor de Calibración", "numeric", "calibrationFactor", true, 0.1, 10000)}
                    placeholder="Nuevo factor"
                    className="flex-1 cursor-pointer text-lg"
                  />
                  {!featureFlags.calibrationV2 && (
                    <Button
                      size="lg"
                      variant="secondary"
                      onClick={() => setShowCalibrationWizard(true)}
                    >
                      Calibrar
                    </Button>
                  )}
                </div>
              </div>

              <Button
                variant="glow"
                size="lg"
                className="w-full"
                onClick={() => setShowCalibrationWizard(true)}
              >
                <Scale className="mr-2 h-5 w-5" />
                {featureFlags.calibrationV2 ? "Asistente de calibración" : "Ejecutar Asistente de Calibración"}
              </Button>
            </div>
          </Card>
        </TabsContent>

        {/* Network Tab */}
        <TabsContent value="network" className="space-y-4">
          <Card className="p-6">
            <h3 className="mb-4 text-2xl font-bold">Configuración de Red</h3>

            <div className="space-y-6">
              <div className="space-y-2 rounded-lg border border-border/70 bg-muted/10 p-4">
                <Label className="flex items-center gap-2 text-lg font-semibold">
                  <KeyRound className="h-5 w-5 text-primary" /> Acceso directo
                </Label>
                <p className="text-sm text-muted-foreground">
                  Los cambios remotos ya no requieren PIN. Puedes administrar la red y otros ajustes directamente.
                </p>
              </div>

              <div>
                <Label className="text-lg font-medium mb-2 block">WiFi Conectado</Label>
                <div className="rounded-lg bg-success/10 p-4">
                  <p className="text-lg font-medium">{networkSSID}</p>
                  <p className="text-sm text-muted-foreground">{networkIP2}</p>
                </div>
              </div>

              <div className="rounded-lg border border-primary/40 bg-primary/5 p-4">
                <p className="text-sm text-muted-foreground">
                  También puedes configurar Wi-Fi y claves desde otro dispositivo navegando a{' '}
                  <span className="font-mono font-semibold text-primary">{configUrlHint}</span>.
                </p>
              </div>

              {isApRecoveryMode && (
                <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/10 p-4">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="mt-1 h-5 w-5 text-warning" />
                    <div className="space-y-1">
                      <p className="font-semibold text-warning-foreground">Modo recuperación activo</p>
                      <p className="text-sm text-warning-foreground/80">
                        La báscula está emitiendo la Wi-Fi "Bascula-AP". Usa la mini-web para conectarla a tu red habitual.
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="glow"
                    size="lg"
                    className="w-full justify-center sm:w-auto"
                    onClick={() => window.open('http://192.168.4.1:8080/config', '_blank', 'noopener,noreferrer')}
                  >
                    <ExternalLink className="mr-2 h-5 w-5" />
                    Abrir Mini-Web (http://192.168.4.1:8080/config)
                  </Button>
                </div>
              )}

              <Button
                variant="outline"
                size="lg"
                className="w-full"
                onClick={() => {
                  if (featureFlags.networkModal) {
                    handleOpenNetworkModal();
                  } else {
                    handleLegacyNetworkDialogOpen();
                  }
                }}
                
              >
                Cambiar Red WiFi
              </Button>

              <div>
                <Label className="text-lg font-medium mb-2 block">Acceso Mini-Web</Label>
                <div className="rounded-lg border border-border p-4 space-y-3">
                  {featureFlags.miniEbStable ? (
                    <>
                      {miniEbStatus.status === "loading" && (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Loader2 className="h-5 w-5 animate-spin" />
                          <span>Cargando acceso MINI-EB…</span>
                        </div>
                      )}

                      {miniEbStatus.status === "error" && (
                        <div className="space-y-3">
                          <div className="flex items-center gap-2 text-destructive">
                            <AlertCircle className="h-5 w-5" />
                            <span>{miniEbStatus.error ?? "No se pudo obtener el acceso MINI-EB."}</span>
                          </div>
                          <Button variant="outline" size="sm" onClick={() => void refreshNetworkStatus()}>
                            Reintentar
                          </Button>
                        </div>
                      )}

                      {miniEbStatus.status === "ready" && miniEbStatus.ip && (
                        <div className="space-y-3">
                          <div className="flex items-center gap-2 text-success">
                            <CheckCircle2 className="h-5 w-5" />
                            <span>Listo</span>
                          </div>
                          <div>
                            <p className="text-sm text-muted-foreground">URL:</p>
                            <p className="text-lg font-mono break-all">{`http://${miniEbStatus.ip}:8080`}</p>
                          </div>
                          <div>
                            <p className="text-sm text-muted-foreground">Red conectada:</p>
                            <p className="text-lg font-medium">{miniEbStatus.ssid ?? "—"}</p>
                          </div>
                          <div className="flex justify-center rounded bg-white py-3">
                            <img
                              src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=http://${miniEbStatus.ip}:8080`}
                              alt="Código QR MINI-EB"
                              className="h-48 w-48"
                            />
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div>
                        <p className="text-sm text-muted-foreground">URL:</p>
                        <p className="text-lg font-mono break-all">
                          {networkIP ? `http://${networkIP}:8080` : "Obteniendo..."}
                        </p>
                      </div>
                      {networkIP && (
                        <div className="flex justify-center py-3 bg-white rounded">
                          <img
                            src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=http://${networkIP!}:8080`}
                            alt="QR Code"
                            className="w-48 h-48"
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </Card>

          <Card className="space-y-6 p-6">
            <div>
              <h3 className="text-2xl font-bold">Integración remota</h3>
              <p className="text-sm text-muted-foreground">
                Configura las URLs que usan otros dispositivos para conectar con la báscula. Verifica el PIN si accedes
                desde fuera para poder editarlas.
              </p>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-lg font-medium">URL API (HTTP)</Label>
                <Input
                  type="url"
                  value={apiUrl}
                  readOnly
                  disabled={remoteLocked}
                  onClick={() => {
                    if (remoteLocked) {
                      return;
                    }
                    openKeyboard("URL API del backend", "url", "apiUrl", false, undefined, undefined, false, 200);
                  }}
                  className={cn(
                    "text-lg",
                    remoteLocked ? "cursor-not-allowed opacity-70" : "cursor-pointer"
                  )}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-lg font-medium">URL WebSocket</Label>
                <Input
                  type="url"
                  value={wsUrl}
                  readOnly
                  disabled={remoteLocked}
                  onClick={() => {
                    if (remoteLocked) {
                      return;
                    }
                    openKeyboard("URL WebSocket", "url", "wsUrl", false, undefined, undefined, false, 200);
                  }}
                  className={cn(
                    "text-lg",
                    remoteLocked ? "cursor-not-allowed opacity-70" : "cursor-pointer"
                  )}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Button
                  variant="outline"
                  size="lg"
                  disabled={!suggestedApiFromNetwork || !suggestedWsFromNetwork || remoteLocked}
                  onClick={() => {
                    if (!suggestedApiFromNetwork || !suggestedWsFromNetwork) {
                      toast({
                        title: "Sin IP detectada",
                        description: "Aún no se detectó la IP de la báscula en la red.",
                        variant: "destructive",
                      });
                      return;
                    }
                    handleApplyEndpointTemplate({
                      api: suggestedApiFromNetwork,
                      ws: suggestedWsFromNetwork,
                    });
                  }}
                >
                  {suggestedApiFromNetwork ? `Usar IP de la báscula (${effectiveNetworkIp})` : "Detectando IP…"}
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  disabled={!suggestedApiFromBrowserHost || !suggestedWsFromBrowserHost || remoteLocked}
                  onClick={() => {
                    if (!suggestedApiFromBrowserHost || !suggestedWsFromBrowserHost) {
                      toast({
                        title: "Sin host del navegador",
                        description: "Recarga la página desde el navegador conectado a la báscula.",
                        variant: "destructive",
                      });
                      return;
                    }
                    handleApplyEndpointTemplate({
                      api: suggestedApiFromBrowserHost,
                      ws: suggestedWsFromBrowserHost,
                    });
                  }}
                >
                  Usar host del navegador ({browserHost || "—"})
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">
                El campo API debe apuntar al puerto 8081 de la báscula y WebSocket al mismo host con protocolo <code>ws://</code>.
                Si accedes desde otra red, asegúrate de exponer esos puertos en tu router o VPN.
              </p>
            </div>
          </Card>

        <Card className="p-6 space-y-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-2xl font-bold">OpenAI API Key</h3>
              <p className="text-sm text-muted-foreground">
                Configura la clave usada por el asistente inteligente y los servicios de IA.
              </p>
            </div>
            <Button
              type="button"
              variant="glow"
              size="lg"
              className="w-full justify-center sm:w-auto"
              onClick={() => void handleSaveOpenAI()}
              disabled={isSavingOpenAI}
            >
              {isSavingOpenAI ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Guardando…
                </>
              ) : (
                <>
                  <Save className="mr-2 h-5 w-5" /> Guardar clave
                </>
              )}
            </Button>
          </div>

            <div className="space-y-4 rounded-lg border border-border/70 bg-muted/20 p-4">
              <div className="space-y-2">
                <Label className="text-lg font-medium">OpenAI API Key</Label>
                <div className="relative">
                  <Input
                  type={showOpenAiKey ? 'text' : 'password'}
                  value={chatGptKey}
                  autoComplete="off"
                  readOnly={openAiKeyboardEnabled}
                  disabled={remoteLocked}
                  onClick={() => {
                    if (!openAiKeyboardEnabled) {
                      return;
                    }
                    openKeyboard('OpenAI API Key', 'apikey', 'chatGptKey', false, undefined, undefined, true);
                  }}
                  onChange={(event) => setChatGptKey(event.target.value)}
                  placeholder={backendHasOpenAIKey ? '••••••••••' : 'sk-...'}
                  className={cn(
                    'text-lg pr-24',
                    openAiKeyboardEnabled && 'cursor-pointer',
                    remoteLocked && 'cursor-not-allowed opacity-70'
                  )}
                />
                <div className="absolute inset-y-0 right-1 my-auto flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setShowOpenAiKey((value) => !value)}
                    disabled={remoteLocked}
                  >
                    {showOpenAiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    <span className="sr-only">{showOpenAiKey ? 'Ocultar' : 'Mostrar'} API Key</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => void handlePasteToField(setChatGptKey)}
                    disabled={remoteLocked}
                  >
                    <ClipboardPaste className="h-4 w-4" />
                    <span className="sr-only">Pegar API Key</span>
                  </Button>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                Estado:{' '}
                {backendHasOpenAIKey ? (
                  <span className="font-medium text-success">Clave almacenada en el backend</span>
                ) : (
                  <span className="font-medium text-warning">Sin configurar</span>
                )}
              </p>
            </div>

            <Button
              variant="outline"
              size="lg"
              className="w-full justify-start"
              onClick={handleTestOpenAI}
              disabled={
                isTestingOpenAI || (!chatGptKey.trim() && !backendHasOpenAIKey)
              }
            >
              {isTestingOpenAI ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Probando…
                </>
              ) : (
                <>
                  <CheckCircle2 className="mr-2 h-5 w-5" /> Probar conexión OpenAI
                </>
              )}
            </Button>
          </div>
        </Card>
      </TabsContent>

      {/* Diabetes Tab */}
        <TabsContent value="diabetes" className="space-y-4">
          <Card className="p-6">
            <h3 className="mb-4 text-2xl font-bold">Configuración Diabetes</h3>

            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-lg font-medium">Modo Diabetes</Label>
                  <p className="text-sm text-muted-foreground">
                    Habilitar funciones de diabetes
                  </p>
                </div>
                <Switch
                  checked={diabetesMode}
                  onCheckedChange={setDiabetesMode}
                  className="scale-150"
                />
              </div>

              {diabetesMode && (
                <>
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-lg font-medium">Asistente de Bolos</Label>
                      <p className="text-sm text-muted-foreground">
                        Calcular dosis de insulina
                      </p>
                    </div>
                    <Switch
                      checked={bolusAssistant}
                      onCheckedChange={setBolusAssistant}
                      className="scale-150"
                    />
                  </div>

                  <div className="space-y-4">
                    {bolusAssistant && (
                      <>
                        <div className="space-y-2">
                          <Label>Factor de Corrección</Label>
                          <Input
                            type="text"
                            value={correctionFactor}
                            readOnly
                            onClick={() => openKeyboard("Factor de Corrección", "numeric", "correctionFactor", false, 1, 200)}
                            placeholder="30"
                            className="cursor-pointer"
                          />
                        </div>
                        
                        <div className="space-y-2">
                          <Label>Ratio Carbohidratos</Label>
                          <Input
                            type="text"
                            value={carbRatio}
                            readOnly
                            onClick={() => openKeyboard("Ratio Carbohidratos", "numeric", "carbRatio", false, 1, 100)}
                            placeholder="10"
                            className="cursor-pointer"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label>Objetivo Glucosa (mg/dl)</Label>
                          <Input
                            type="text"
                            value={targetGlucose}
                            readOnly
                            onClick={() => openKeyboard("Objetivo Glucosa", "numeric", "targetGlucose", false, 70, 180)}
                            placeholder="100"
                            className="cursor-pointer"
                          />
                        </div>
                      </>
                    )}

                    <div className="space-y-2">
                      <Label>Alarma Hipoglucemia (mg/dl)</Label>
                      <Input
                        type="text"
                        value={hypoAlarm}
                        readOnly
                        onClick={() => openKeyboard("Alarma Hipoglucemia", "numeric", "hypoAlarm", false, 40, 90)}
                        placeholder="70"
                        className="cursor-pointer"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Alarma Hiperglucemia (mg/dl)</Label>
                      <Input
                        type="text"
                        value={hyperAlarm}
                        readOnly
                        onClick={() => openKeyboard("Alarma Hiperglucemia", "numeric", "hyperAlarm", false, 150, 300)}
                        placeholder="180"
                        className="cursor-pointer"
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          </Card>

          <Card className="p-6 space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-2xl font-bold">Nightscout</h3>
                <p className="text-sm text-muted-foreground">
                  Configura la URL y el token de tu instancia Nightscout.
                </p>
              </div>
              <Button
                type="button"
                variant="glow"
                size="lg"
                className="w-full justify-center sm:w-auto"
                onClick={() => void handleSaveNightscout()}
                disabled={isSavingNightscout}
              >
                {isSavingNightscout ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Guardando…
                  </>
                ) : (
                  <>
                    <Save className="mr-2 h-5 w-5" /> Guardar Nightscout
                  </>
                )}
              </Button>
            </div>

            <div className="flex flex-col gap-3 rounded-lg border border-border/70 bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <Label className="text-lg font-medium">Teclado interno</Label>
                <p className="text-sm text-muted-foreground">
                  {internalKeyboardEnabled
                    ? "Usar teclado táctil integrado para introducir datos sensibles."
                    : "Usar teclado del sistema y pegado nativo."}
                </p>
              </div>
              <Switch
                checked={internalKeyboardEnabled}
                onCheckedChange={setInternalKeyboardEnabled}
                className="scale-125"
              />
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label className="text-lg font-medium">Nightscout URL</Label>
                <div className="relative">
                  <Input
                    type="url"
                    value={nightscoutUrl}
                    autoComplete="url"
                    readOnly={nightscoutKeyboardEnabled}
                    disabled={remoteLocked}
                    onClick={() => {
                      if (!nightscoutKeyboardEnabled) {
                        return;
                      }
                      openKeyboard("Nightscout URL", "url", "nightscoutUrl", false, undefined, undefined, false, 200);
                    }}
                    onChange={(event) => setNightscoutUrl(event.target.value)}
                    placeholder="https://mi-nightscout.com"
                    className={cn(
                      "text-lg pr-24",
                      nightscoutKeyboardEnabled && "cursor-pointer",
                      remoteLocked && "cursor-not-allowed opacity-70"
                    )}
                  />
                  <div className="absolute inset-y-0 right-1 my-auto flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => void handlePasteToField(setNightscoutUrl)}
                      disabled={remoteLocked}
                    >
                      <ClipboardPaste className="h-4 w-4" />
                      <span className="sr-only">Pegar URL Nightscout</span>
                    </Button>
                  </div>
                </div>

                <Label className="text-lg font-medium">Nightscout Token</Label>
                <div className="relative">
                  <Input
                    type={showNightscoutToken ? 'text' : 'password'}
                    value={nightscoutToken}
                    autoComplete="new-password"
                    readOnly={nightscoutKeyboardEnabled}
                    disabled={remoteLocked}
                    onClick={() => {
                      if (!nightscoutKeyboardEnabled) {
                        return;
                      }
                      openKeyboard("Nightscout Token", "apikey", "nightscoutToken", false, undefined, undefined, true);
                    }}
                    onChange={(event) => setNightscoutToken(event.target.value)}
                    placeholder={backendNightscoutHasToken ? "••••••••" : "token"}
                    className={cn(
                      "text-lg pr-24",
                      nightscoutKeyboardEnabled && "cursor-pointer",
                      remoteLocked && "cursor-not-allowed opacity-70"
                    )}
                  />
                  <div className="absolute inset-y-0 right-1 my-auto flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setShowNightscoutToken((value) => !value)}
                      disabled={remoteLocked}
                    >
                      {showNightscoutToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      <span className="sr-only">{showNightscoutToken ? 'Ocultar' : 'Mostrar'} token Nightscout</span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => void handlePasteToField(setNightscoutToken)}
                      disabled={remoteLocked}
                    >
                      <ClipboardPaste className="h-4 w-4" />
                      <span className="sr-only">Pegar token Nightscout</span>
                    </Button>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  Estado: {backendNightscoutUrl ? (
                    <span className="font-medium text-success">
                      {backendNightscoutUrl} {backendNightscoutHasToken ? "· Token almacenado" : ""}
                    </span>
                  ) : (
                    <span className="font-medium text-warning">Sin configurar</span>
                  )}
                </p>
              </div>

              <Button
                variant="outline"
                size="lg"
                className="w-full justify-start"
                onClick={handleTestNightscout}
              disabled={
                isTestingNightscout || (!nightscoutUrl.trim() && !backendNightscoutUrl)
              }
              >
                {isTestingNightscout ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Probando…
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="mr-2 h-5 w-5" /> Probar conexión Nightscout
                  </>
                )}
              </Button>
            </div>
          </Card>
        </TabsContent>

        {/* Updates Tab */}
        <TabsContent value="updates" className="space-y-4">
          <Card className="p-6">
            <h3 className="mb-4 text-2xl font-bold">Actualizaciones OTA</h3>
            
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-lg bg-muted p-6 text-center">
                  <p className="mb-2 text-sm text-muted-foreground">Versión Actual</p>
                  <p className="text-4xl font-bold text-primary">{formatVersion(otaStatus?.current)}</p>
                </div>
                <div className="rounded-lg bg-muted p-6 text-center">
                  <p className="mb-2 text-sm text-muted-foreground">Última disponible</p>
                  <p className="text-3xl font-semibold">{formatVersion(otaStatus?.latest)}</p>
                  {otaStatus && (
                    <p className={`mt-2 text-sm ${otaStatus.hasUpdate ? "text-warning" : "text-success"}`}>
                      {otaStatus.hasUpdate ? "Actualización pendiente" : "Sistema al día"}
                    </p>
                  )}
                </div>
              </div>

              <Button
                variant="glow"
                size="xl"
                className="w-full text-xl"
                onClick={handleCheckUpdates}
                disabled={isCheckingUpdates}
              >
                <Download className="mr-2 h-6 w-6 animate-bounce" />
                {isCheckingUpdates ? "Verificando..." : "Buscar Actualizaciones"}
              </Button>

              {otaStatus && (
                <div className={`rounded-lg border p-4 animate-fade-in ${otaStatus.hasUpdate ? "border-primary bg-primary/5" : "border-success bg-success/5"}`}>
                  {otaStatus.hasUpdate ? (
                    <div className="space-y-3">
                      <p className="font-medium text-primary">
                        📦 Nueva versión disponible: {formatVersion(otaStatus.latest)}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Usa la sección inferior para aplicar la actualización cuando estés listo.
                      </p>
                    </div>
                  ) : (
                    <p className="font-medium text-success">✓ El sistema está actualizado</p>
                  )}
                </div>
              )}

              {featureFlags.otaApply && (
                <div className="space-y-4 rounded-lg border border-primary/40 bg-primary/5 p-4">
                  <div className="grid gap-3 md:grid-cols-[2fr,1fr] md:items-end">
                    <div className="space-y-2">
                      <Label className="text-sm font-medium">Objetivo de actualización (opcional)</Label>
                      <Input
                        value={otaTargetOverride}
                        placeholder="tag o commit"
                        readOnly={internalKeyboardEnabled}
                        onClick={() => {
                          if (!internalKeyboardEnabled) {
                            return;
                          }
                          openKeyboard(
                            "Objetivo OTA",
                            "text",
                            "otaTargetOverride",
                            false,
                            undefined,
                            undefined,
                            false,
                            80
                          );
                        }}
                        onChange={(event) => {
                          if (internalKeyboardEnabled) {
                            return;
                          }
                          setOtaTargetOverride(event.target.value);
                        }}
                        className={cn("text-lg", internalKeyboardEnabled && "cursor-pointer")}
                      />
                      <p className="text-xs text-muted-foreground">
                        Déjalo vacío para aplicar la última versión disponible.
                      </p>
                    </div>
                    <Button
                      variant="glow"
                      size="lg"
                      className="w-full"
                      onClick={() => setOtaApplyDialogOpen(true)}
                      disabled={isApplyingUpdate || otaJobState?.status === "running"}
                    >
                      {isApplyingUpdate || otaJobState?.status === "running" ? (
                        <>
                          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                          Aplicando...
                        </>
                      ) : (
                        <>
                          <Download className="mr-2 h-5 w-5" />
                          Aplicar actualización
                        </>
                      )}
                    </Button>
                  </div>

                  {otaJobState?.status === "running" && (
                    <div className="flex items-center gap-2 text-warning">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>
                        Actualización en progreso ({otaJobState.progress}%){otaJobState.message ? ` — ${otaJobState.message}` : ""}
                      </span>
                    </div>
                  )}

                  <p className="text-xs text-muted-foreground">
                    La interfaz puede parpadear durante el proceso. Si pierdes la conexión, vuelve a abrir Ajustes &gt; OTA para reanudar el seguimiento.
                  </p>
                </div>
              )}

              <div className="rounded-lg border-warning/50 border bg-warning/5 p-4">
                <p className="text-sm font-medium text-warning">
                  ⚠️ Después de actualizar, el sistema se reiniciará automáticamente
                </p>
              </div>
            </div>
          </Card>
        </TabsContent>
      </Tabs>

      <AlertDialog open={otaApplyDialogOpen} onOpenChange={setOtaApplyDialogOpen}>
        <AlertDialogContent className="max-w-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Aplicar actualización OTA</AlertDialogTitle>
            <AlertDialogDescription>
              El sistema seguirá funcionando mientras se instala la actualización, pero la interfaz puede parpadear o recargar la página.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              La instalación reiniciará servicios críticos y puede tardar varios minutos. Asegúrate de no desconectar la báscula.
            </p>
            <p>
              Puedes seguir el progreso y revisar los registros en la ventana de actualización.
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setOtaApplyDialogOpen(false);
                void handleApplyUpdate();
              }}
            >
              Confirmar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={otaPanelOpen}
        onOpenChange={(open) => {
          if (otaJobState?.status === "running" && !open) {
            return;
          }
          setOtaPanelOpen(open);
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-3xl">Progreso de actualización OTA</DialogTitle>
            <DialogDescription>
              Seguimiento en tiempo real del proceso de actualización.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <div>
                <span className="font-semibold">Estado:</span>{" "}
                <span
                  className={cn(
                    otaJobState?.status === "success" && "text-success",
                    otaJobState?.status === "error" && "text-destructive",
                    otaJobState?.status === "running" && "text-warning"
                  )}
                >
                  {otaJobState?.status ?? "idle"}
                </span>
              </div>
              <div>
                <span className="font-semibold">Actual:</span>{" "}
                <span className="font-mono">{otaJobState?.current || "—"}</span>
              </div>
              <div>
                <span className="font-semibold">Objetivo:</span>{" "}
                <span className="font-mono">{otaJobState?.target || "—"}</span>
              </div>
            </div>

            <Progress value={otaJobState?.progress ?? 0} className="h-3" aria-label="Progreso de actualización" />

            {otaJobState?.message && (
              <div
                className={cn(
                  "rounded border p-3 text-sm",
                  otaJobState.status === "error"
                    ? "border-destructive/40 bg-destructive/10 text-destructive"
                    : "border-muted bg-muted/30 text-muted-foreground"
                )}
              >
                {otaJobState.message}
              </div>
            )}

            <div className="space-y-2">
              <Label className="text-sm font-medium">Registros recientes</Label>
              <div
                ref={otaLogsRef}
                className="max-h-64 overflow-y-auto rounded border border-border/60 bg-black/80 p-3 font-mono text-[11px] leading-5 text-emerald-200"
              >
                {otaLogs ? (
                  otaLogs.split("\n").map((line, index) => (
                    <div key={index} className="whitespace-pre-wrap">
                      {line || "\u00a0"}
                    </div>
                  ))
                ) : (
                  <p className="text-muted-foreground">Sin registros disponibles todavía.</p>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-dashed border-muted-foreground/40 bg-muted/20 p-3 text-xs text-muted-foreground">
              <p className="font-semibold text-foreground">Rollback manual</p>
              <p>En caso de necesitar volver a la versión anterior, ejecuta:</p>
              <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-5 text-foreground">
{`sudo ln -sfn /opt/bascula/releases/<anterior> /opt/bascula/current
sudo systemctl daemon-reload
sudo systemctl restart bascula-miniweb bascula-ui`}
              </pre>
            </div>
          </div>

          <DialogFooter className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOtaPanelOpen(false)}
              disabled={otaJobState?.status === "running"}
            >
              Cerrar
            </Button>
            {otaJobState?.status === "error" && (
              <Button type="button" variant="glow" onClick={() => setOtaApplyDialogOpen(true)}>
                Reintentar
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={networkModalOpen}
        onOpenChange={(open) => {
          setNetworkModalOpen(open);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-3xl">Cambiar red Wi-Fi</DialogTitle>
            <DialogDescription>
              Ingresa el nombre y la contraseña de la red. Si el teclado interno está activo podrás usarlo tocando los campos.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="space-y-2">
              <Label className="text-sm font-medium">Nombre de la red (SSID)</Label>
              <Input
                value={networkModalSSID}
                placeholder="MiRed"
                readOnly={internalKeyboardEnabled}
                onClick={() => {
                  if (!internalKeyboardEnabled) {
                    return;
                  }
                  openKeyboard(
                    "Nombre de la red Wi-Fi",
                    "text",
                    "networkModalSSID",
                    false,
                    undefined,
                    undefined,
                    false,
                    32
                  );
                }}
                onChange={(event) => {
                  if (internalKeyboardEnabled) {
                    return;
                  }
                  setNetworkModalSSID(event.target.value);
                }}
                className={cn("text-lg", internalKeyboardEnabled && "cursor-pointer")}
              />
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-medium">Contraseña</Label>
              <Input
                type="password"
                value={networkModalPassword}
                placeholder="••••••••"
                readOnly={internalKeyboardEnabled}
                onClick={() => {
                  if (!internalKeyboardEnabled) {
                    return;
                  }
                  openKeyboard(
                    "Contraseña Wi-Fi",
                    "password",
                    "networkModalPassword",
                    false,
                    undefined,
                    undefined,
                    true,
                    63
                  );
                }}
                onChange={(event) => {
                  if (internalKeyboardEnabled) {
                    return;
                  }
                  setNetworkModalPassword(event.target.value);
                }}
                className={cn("text-lg", internalKeyboardEnabled && "cursor-pointer")}
              />
              <p className="text-xs text-muted-foreground">Deja el campo vacío si la red es abierta.</p>
            </div>

            {networkModalStatus?.message ? (
              <div
                className={cn(
                  "flex items-start gap-3 rounded-lg border px-4 py-3 text-sm",
                  networkModalStatus.type === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
                  networkModalStatus.type === "success" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
                  networkModalStatus.type === "info" && "border-primary/40 bg-primary/10 text-primary"
                )}
              >
                {networkModalStatus.type === 'success' ? (
                  <CheckCircle2 className="mt-0.5 h-5 w-5" />
                ) : networkModalStatus.type === 'error' ? (
                  <AlertCircle className="mt-0.5 h-5 w-5" />
                ) : (
                  <Info className="mt-0.5 h-5 w-5" />
                )}
                <p>{networkModalStatus.message}</p>
              </div>
            ) : null}
          </div>

          <DialogFooter className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="w-full sm:w-auto"
                onClick={() => {
                  setNetworkModalOpen(false);
                }}
              >
                Cancelar
              </Button>
              <Button
                type="button"
                variant="glow"
                size="lg"
                className="w-full sm:w-auto"
                onClick={handleNetworkModalConnect}
                disabled={isNetworkModalConnecting}
              >
                {isNetworkModalConnecting ? 'Conectando…' : 'Conectar'}
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              className="w-full justify-start text-sm text-muted-foreground hover:text-foreground"
              onClick={() => {
                setNetworkModalOpen(false);
                setLegacyNetworkDialogOpen(true);
              }}
            >
              ¿Necesitas el asistente AP? Ábrelo en una nueva pestaña.
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={legacyNetworkDialogOpen}
        onOpenChange={(open) => {
          setLegacyNetworkDialogOpen(open);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-2xl">Asistente Wi-Fi clásico</DialogTitle>
            <DialogDescription>
              Abriremos el asistente en una nueva pestaña para que nunca pierdas esta pantalla.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm text-muted-foreground">
            <p>1. Pulsa «Abrir asistente» para lanzar la configuración en modo AP.</p>
            <p>2. Sigue las instrucciones y, al terminar, vuelve aquí y toca «Cerrar».</p>
          </div>

          <DialogFooter className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full sm:w-auto"
              onClick={() => {
                setLegacyNetworkDialogOpen(false);
              }}
            >
              Cerrar
            </Button>
            <Button
              type="button"
              variant="glow"
              size="lg"
              className="w-full sm:w-auto"
              onClick={() => {
                window.open('/config', '_blank', 'noopener,noreferrer');
              }}
            >
              Abrir asistente
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="mt-8 text-center text-xs text-muted-foreground">
        Versión de la interfaz {APP_VERSION}
      </div>

      <KeyboardDialog
        open={keyboardOpen}
        onClose={() => setKeyboardOpen(false)}
        value={tempValue}
        onChange={setTempValue}
        onConfirm={handleKeyboardConfirm}
        title={keyboardConfig.title}
        type={keyboardConfig.type}
        showDecimal={keyboardConfig.showDecimal}
        min={keyboardConfig.min}
        max={keyboardConfig.max}
        allowEmpty={keyboardConfig.allowEmpty}
        maxLength={keyboardConfig.maxLength}
      />

      <CalibrationWizard
        open={showCalibrationWizard}
        onClose={() => setShowCalibrationWizard(false)}
        currentWeight={weight}
        isCalibrationV2={featureFlags.calibrationV2}
      />
    </div>
  );
};
  const parseDecimalsPreference = (value: string): 0 | 1 => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      return 1;
    }
    return parsed >= 1 ? 1 : 0;
  };
