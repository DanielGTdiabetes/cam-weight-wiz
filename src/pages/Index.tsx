import { useState, useEffect, useRef, useCallback } from "react";
import { MainMenu } from "@/components/MainMenu";
import { ScaleView } from "@/pages/ScaleView";
import { ScannerView } from "@/pages/ScannerView";
import { TimerFullView } from "@/pages/TimerFullView";
import { RecipesView } from "@/pages/RecipesView";
import { SettingsView } from "@/pages/SettingsView";
import { TopBar } from "@/components/TopBar";
import { NotificationBar } from "@/components/NotificationBar";
import { TimerDialog } from "@/components/TimerDialog";
import { Mode1515Dialog } from "@/components/Mode1515Dialog";
import { RecoveryMode } from "@/components/RecoveryMode";
import { APModeScreen } from "@/components/APModeScreen";
import { BasculinMascot } from "@/components/BasculinMascot";
import { Clock, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGlucoseMonitor } from "@/hooks/useGlucoseMonitor";
import { networkDetector, NetworkStatus } from "@/services/networkDetector";
import { api, type WakeEvent, type WakeStatus } from "@/services/api";
import { apiWrapper } from "@/services/apiWrapper";
import { storage, type AppSettings } from "@/services/storage";
import { formatWeight } from "@/lib/format";
import { useScaleDecimals } from "@/hooks/useScaleDecimals";
import { useAudioPref } from "@/state/useAudio";

const Index = () => {
  const [currentView, setCurrentView] = useState<string>("menu");
  const [showTimerDialog, setShowTimerDialog] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState<number | undefined>(undefined);
  const [notification, setNotification] = useState<string>("");
  const [diabetesMode, setDiabetesMode] = useState(true); // Enable by default for demo
  const [show1515Mode, setShow1515Mode] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [showAPMode, setShowAPMode] = useState(false);
  const [networkStatusState, setNetworkStatusState] = useState<NetworkStatus | null>(null);
  const [networkNotice, setNetworkNotice] = useState<
    { message: string; type: "info" | "warning" | "success" | "error" } | null
  >(null);
  const [mascoMsg, setMascoMsg] = useState<string | undefined>();
  const [basculinMood, setBasculinMood] = useState<"normal" | "happy" | "worried" | "alert" | "sleeping">("normal");
  const [wakeWordEnabled, setWakeWordEnabled] = useState(() => storage.getSettings().wakeWordEnabled ?? false);
  const [wakeStatus, setWakeStatus] = useState<WakeStatus | null>(null);
  const [wakeListening, setWakeListening] = useState(false);
  const previousNetworkStatus = useRef<NetworkStatus | null>(null);
  const wakeOverlayTimeoutRef = useRef<number | null>(null);
  const wakeEventSourceRef = useRef<EventSource | null>(null);
  const wakeReconnectTimeoutRef = useRef<number | null>(null);
  const scaleDecimals = useScaleDecimals();
  const { voiceEnabled: isVoiceActive, setEnabled: setVoiceEnabled } = useAudioPref();

  // Monitor glucose if diabetes mode is enabled
  const glucoseData = useGlucoseMonitor(diabetesMode);

  // Check for hypoglycemia
  useEffect(() => {
    if (glucoseData && glucoseData.glucose < 70 && diabetesMode) {
      setShow1515Mode(true);
      setBasculinMood("alert");
      setMascoMsg("¡Alerta! Glucosa baja detectada");
    } else if (glucoseData && glucoseData.glucose >= 70 && glucoseData.glucose <= 180) {
      setBasculinMood("happy");
    } else if (glucoseData && glucoseData.glucose > 180) {
      setBasculinMood("worried");
    }
  }, [glucoseData, diabetesMode]);

  // Detect recovery mode (simulate detection)
  useEffect(() => {
    const isRecoveryNeeded = localStorage.getItem("recovery_mode") === "true";
    if (!isRecoveryNeeded) {
      return;
    }

    let cancelled = false;

    const verifyBackend = async () => {
      try {
        const response = await fetch('/api/miniweb/status', { cache: 'no-store' });
        if (!response.ok) {
          return;
        }
      } catch (error) {
        console.error('Backend unreachable, enabling recovery mode', error);
        if (!cancelled) {
          setShowRecovery(true);
        }
        return;
      }
    };

    void verifyBackend();

    return () => {
      cancelled = true;
    };
  }, []);

  // Monitor network status for AP mode
  useEffect(() => {
    const handleNetworkStatus = (status: NetworkStatus) => {
      setNetworkStatusState(status);
      setShowAPMode(status.showAPScreen);

      const previous = previousNetworkStatus.current;

      if (status.effectiveMode === "offline") {
        setNetworkNotice({
          message: "Modo offline: sin conexión a Internet",
          type: "warning",
        });
        setBasculinMood("worried");
        setMascoMsg("Modo offline activo");
      } else if (status.showAPScreen) {
        setNetworkNotice({
          message: "Modo punto de acceso activo para provisión de Wi-Fi",
          type: "info",
        });
        setBasculinMood("alert");
        setMascoMsg("Configura la Wi-Fi desde el modo AP");
      } else if (status.connectivity === "full") {
        if (!previous || previous.connectivity !== "full" || previous.showAPScreen) {
          const ssidLabel = status.ssid ? `Conectado a ${status.ssid}` : "Conectado a Internet";
          setNetworkNotice({ message: ssidLabel, type: "success" });
          setBasculinMood("happy");
          setMascoMsg("¡WiFi conectado!");
        } else {
          setNetworkNotice(null);
        }
      } else if (!status.showAPScreen && status.savedWifiProfiles) {
        if (!previous || previous.connectivity === "full" || previous.showAPScreen) {
          setNetworkNotice({ message: "Sin conexión (reintentando)", type: "warning" });
          setBasculinMood("worried");
          setMascoMsg("Reintentando conexión Wi-Fi…");
        }
      } else {
        setNetworkNotice(null);
      }

      previousNetworkStatus.current = status;
    };

    networkDetector.subscribe(handleNetworkStatus);
    networkDetector.startMonitoring(2500);

    return () => {
      networkDetector.unsubscribe(handleNetworkStatus);
      networkDetector.stopMonitoring();
    };
  }, []);

  const handleTimerStart = useCallback(async (seconds: number) => {
    setTimerSeconds(seconds);
    setShowTimerDialog(false);
    setMascoMsg("Temporizador iniciado");
    setBasculinMood("happy");

    try {
      await api.startTimer(seconds);
    } catch (err) {
      console.error("Failed to start timer:", err);
      setBasculinMood("worried");
      setMascoMsg("Error al iniciar temporizador");
    }
  }, []);

  const handleBackToMenu = () => {
    setCurrentView("menu");
    setTimerSeconds(undefined);
    setBasculinMood("sleeping");
    setMascoMsg(undefined);
  };

  const handleNavigate = (view: string) => {
    console.log("Index: Changing view from", currentView, "to", view);
    setCurrentView(view);
  };

  const handleWakeEvent = useCallback(
    async (event: WakeEvent) => {
      if (event.type === "wake") {
        const isoTs = new Date(event.ts * 1000).toISOString();
        setWakeStatus((prev) => ({
          enabled: true,
          running: true,
          last_wake_ts: isoTs,
          wake_count: (prev?.wake_count ?? 0) + 1,
          intent_count: prev?.intent_count ?? 0,
          errors: prev?.errors,
          backend: prev?.backend ?? null,
        }));
        setWakeListening(true);
        setBasculinMood("alert");
        if (wakeOverlayTimeoutRef.current) {
          window.clearTimeout(wakeOverlayTimeoutRef.current);
        }
        wakeOverlayTimeoutRef.current = window.setTimeout(() => {
          setWakeListening(false);
          setBasculinMood((currentMood) => (currentMood === "alert" ? "normal" : currentMood));
          wakeOverlayTimeoutRef.current = null;
        }, 3500);
        return;
      }

      if (event.type !== "intent" || !event.intent) {
        return;
      }

      const isoTs = new Date(event.ts * 1000).toISOString();
      setWakeStatus((prev) => ({
        enabled: prev?.enabled ?? true,
        running: prev?.running ?? true,
        last_wake_ts: isoTs,
        wake_count: prev?.wake_count ?? 0,
        intent_count: (prev?.intent_count ?? 0) + 1,
        errors: prev?.errors,
        backend: prev?.backend ?? null,
      }));

      const intent = event.intent;
      setWakeListening(false);
      if (wakeOverlayTimeoutRef.current) {
        window.clearTimeout(wakeOverlayTimeoutRef.current);
        wakeOverlayTimeoutRef.current = null;
      }

      switch (intent.kind) {
        case "timer": {
          const seconds = intent.seconds ?? 0;
          if (seconds <= 0) {
            setMascoMsg("No entendí el temporizador.");
            setBasculinMood("worried");
            return;
          }
          await handleTimerStart(seconds);
          const minutes = Math.floor(seconds / 60);
          const remainder = seconds % 60;
          let message: string;
          if (minutes > 0 && remainder > 0) {
            message = `Temporizador de ${minutes} minuto${minutes === 1 ? '' : 's'} y ${remainder} segundo${remainder === 1 ? '' : 's'}.`;
          } else if (minutes > 0) {
            message = `Temporizador de ${minutes} minuto${minutes === 1 ? '' : 's'}.`;
          } else {
            message = `Temporizador de ${seconds} segundo${seconds === 1 ? '' : 's'}.`;
          }
          setMascoMsg(message);
          setBasculinMood("happy");
          return;
        }
        case "weight_status": {
          try {
            const response = await api.getScaleWeight();
            const value = typeof response.value === 'number' ? response.value : null;
            if (value !== null) {
              const formatted = formatWeight(value, scaleDecimals);
              const messageWeight = formatted === '–' ? formatted : `${formatted} gramos`;
              setMascoMsg(`Peso estable: ${messageWeight}.`);
              setBasculinMood("happy");
            } else {
              setMascoMsg("No detecto peso estable ahora mismo.");
              setBasculinMood("worried");
            }
          } catch (error) {
            console.error('Failed to read weight', error);
            setMascoMsg("No pude consultar la báscula.");
            setBasculinMood("worried");
          }
          return;
        }
        case "tare": {
          try {
            await api.scaleTare();
            setMascoMsg("Báscula a cero.");
            setBasculinMood("happy");
          } catch (error) {
            console.error('Failed to tare scale', error);
            setMascoMsg("No se pudo poner a cero la báscula.");
            setBasculinMood("worried");
          }
          return;
        }
        case "recipe_start": {
          const recipeName = intent.name?.trim();
          setCurrentView("recipes");
          setMascoMsg(
            recipeName && recipeName.length > 0
              ? `Buscando receta ${recipeName}.`
              : "Abriendo recetario."
          );
          setBasculinMood("happy");
          return;
        }
        case "calibrate": {
          setCurrentView("settings");
          setMascoMsg("Iniciando asistente de calibración.");
          setBasculinMood("happy");
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new Event('open-calibration-wizard'));
          }
          return;
        }
        case "smalltalk": {
          const responses = [
            "Aquí estoy, ¿qué necesitas?",
            "Te escucho.",
            "Hola, ¿en qué te ayudo?",
          ];
          const message = responses[Math.floor(Math.random() * responses.length)];
          setMascoMsg(message);
          setBasculinMood("happy");
          return;
        }
        default:
          return;
      }
    },
    [handleTimerStart, scaleDecimals]
  );

  useEffect(() => {
    let cancelled = false;
    const loadStatus = async () => {
      try {
        const status = await api.getWakeStatus();
        if (!cancelled) {
          setWakeStatus(status);
          if (typeof status.enabled === 'boolean') {
            setWakeWordEnabled(status.enabled);
          }
        }
      } catch (error) {
        console.warn('Wake status unavailable', error);
      }
    };

    void loadStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ settings?: AppSettings }>).detail;
      if (detail?.settings && typeof detail.settings.wakeWordEnabled === 'boolean') {
        setWakeWordEnabled(detail.settings.wakeWordEnabled);
      }
    };
    window.addEventListener('app-settings-updated', handler);
    return () => {
      window.removeEventListener('app-settings-updated', handler);
    };
  }, []);

  useEffect(() => {
    if (!wakeWordEnabled) {
      setWakeListening(false);
    }
  }, [wakeWordEnabled]);

  useEffect(() => {
    return () => {
      if (wakeOverlayTimeoutRef.current) {
        window.clearTimeout(wakeOverlayTimeoutRef.current);
        wakeOverlayTimeoutRef.current = null;
      }
      if (wakeReconnectTimeoutRef.current) {
        window.clearTimeout(wakeReconnectTimeoutRef.current);
        wakeReconnectTimeoutRef.current = null;
      }
      if (wakeEventSourceRef.current) {
        wakeEventSourceRef.current.close();
        wakeEventSourceRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!wakeWordEnabled) {
      if (wakeReconnectTimeoutRef.current) {
        window.clearTimeout(wakeReconnectTimeoutRef.current);
        wakeReconnectTimeoutRef.current = null;
      }
      if (wakeEventSourceRef.current) {
        wakeEventSourceRef.current.close();
        wakeEventSourceRef.current = null;
      }
      setWakeStatus((prev) => (prev ? { ...prev, running: false } : prev));
      return;
    }

    let cancelled = false;

    const connect = () => {
      if (cancelled) {
        return;
      }

      const baseUrl = apiWrapper.getBaseUrl() || storage.getSettings().apiUrl;
      let eventsUrl: string;
      try {
        eventsUrl = new URL('/api/voice/wake/events', baseUrl).toString();
      } catch {
        eventsUrl = `${baseUrl.replace(/\/$/, '')}/api/voice/wake/events`;
      }

      const source = new EventSource(eventsUrl);
      wakeEventSourceRef.current = source;

      source.onopen = () => {
        setWakeStatus((prev) => ({
          enabled: true,
          running: true,
          last_wake_ts: prev?.last_wake_ts ?? null,
          wake_count: prev?.wake_count ?? 0,
          intent_count: prev?.intent_count ?? 0,
          errors: prev?.errors,
          backend: prev?.backend ?? null,
        }));
      };

      const handleSseMessage = (messageEvent: MessageEvent<string>) => {
        try {
          const payload = JSON.parse(messageEvent.data) as WakeEvent;
          void handleWakeEvent(payload);
        } catch (error) {
          console.error('Failed to parse wake event payload', error);
        }
      };

      source.addEventListener('wake', (event) => {
        handleSseMessage(event as MessageEvent<string>);
      });
      source.addEventListener('intent', (event) => {
        handleSseMessage(event as MessageEvent<string>);
      });

      source.onmessage = (messageEvent) => {
        handleSseMessage(messageEvent as MessageEvent<string>);
      };

      source.onerror = () => {
        source.close();
        if (wakeEventSourceRef.current === source) {
          wakeEventSourceRef.current = null;
        }
        setWakeStatus((prev) => (prev ? { ...prev, running: false } : prev));
        if (!cancelled) {
          wakeReconnectTimeoutRef.current = window.setTimeout(connect, 5000);
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (wakeReconnectTimeoutRef.current) {
        window.clearTimeout(wakeReconnectTimeoutRef.current);
        wakeReconnectTimeoutRef.current = null;
      }
      if (wakeEventSourceRef.current) {
        wakeEventSourceRef.current.close();
        wakeEventSourceRef.current = null;
      }
    };
  }, [wakeWordEnabled, handleWakeEvent]);

  const renderView = () => {
    console.log("Index: Rendering view:", currentView);
    switch (currentView) {
      case "menu":
        return <MainMenu onNavigate={handleNavigate} />;
      case "scale":
        return <ScaleView onNavigate={handleNavigate} />;
      case "scanner":
        return <ScannerView />;
      case "timer":
        return <TimerFullView onClose={handleBackToMenu} />;
      case "recipes":
        return <RecipesView onClose={handleBackToMenu} />;
      case "settings":
        return <SettingsView />;
      default:
        return <MainMenu onNavigate={handleNavigate} />;
    }
  };

  const showTopBar = currentView !== "menu" && currentView !== "timer" && currentView !== "recipes";
  const shouldShowMascot = !showRecovery && !showAPMode;

  // Show special screens first
  if (showRecovery) {
    return <RecoveryMode />;
  }

  if (showAPMode) {
    return <APModeScreen />;
  }

  return (
    <div className="h-screen overflow-hidden bg-background">
      {/* Mode 15/15 Dialog */}
      {show1515Mode && glucoseData && (
        <Mode1515Dialog
          glucose={glucoseData.glucose}
          onClose={() => setShow1515Mode(false)}
        />
      )}

      {/* Basculin Mascot */}
      <BasculinMascot
        isActive={shouldShowMascot}
        message={mascoMsg}
        position="corner"
        mood={basculinMood}
        enableVoice={isVoiceActive}
      />

      {wakeListening && (
        <div className="pointer-events-none fixed inset-x-0 top-24 z-40 flex justify-center">
          <div className="flex items-center gap-2 rounded-full border border-primary/40 bg-background/95 px-5 py-2 text-sm font-medium text-primary shadow-lg">
            <span className="animate-pulse">🎤</span>
            <span>Te escucho…</span>
          </div>
        </div>
      )}

      {networkStatusState?.effectiveMode === "offline" && (
        <div className="pointer-events-none fixed right-4 top-4 z-40">
          <div className="flex items-center gap-2 rounded-full border border-amber-400/70 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-200 shadow-lg backdrop-blur">
            <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
            Offline
          </div>
        </div>
      )}

      {/* Top Bar - Show in most views except menu, timer, recipes */}
      {showTopBar && (
        <>
          <TopBar
            isVoiceActive={isVoiceActive}
            isWifiConnected={
              networkStatusState?.connectivity === "full"
                ? true
                : networkStatusState?.isWifiConnected ?? false
            }
            glucose={glucoseData?.glucose}
            glucoseTrend={glucoseData?.trend}
            timerSeconds={timerSeconds}
            onSettingsClick={() => setCurrentView("settings")}
            onTimerClick={() => setShowTimerDialog(true)}
            onVoiceToggle={() => {
              void setVoiceEnabled(!isVoiceActive);
            }}
            onBackClick={handleBackToMenu}
            showBackButton={true}
            showTimerButton={currentView === "scale" || currentView === "scanner"}
          />
          {networkNotice && (
            <NotificationBar
              message={networkNotice.message}
              type={networkNotice.type}
              onClose={() => setNetworkNotice(null)}
            />
          )}
          {notification && (
            <NotificationBar message={notification} type="info" onClose={() => setNotification("")} />
          )}
        </>
      )}

      {/* Main Content */}
      <div className={showTopBar ? "h-[calc(100vh-60px)] overflow-y-auto" : "h-screen"}>
        {renderView()}
      </div>

      {/* Timer Dialog */}
      <TimerDialog
        open={showTimerDialog}
        onClose={() => setShowTimerDialog(false)}
        onStart={handleTimerStart}
      />
    </div>
  );
};

export default Index;
