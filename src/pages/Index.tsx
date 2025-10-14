import { useState, useEffect, useRef, useCallback } from "react";
import { MainMenu } from "@/components/MainMenu";
import { ScaleView } from "@/pages/ScaleView";
import { FoodScannerView } from "@/pages/FoodScannerView";
import { TimerFullView } from "@/pages/TimerFullView";
import { RecipesView } from "@/pages/RecipesView";
import { SettingsView } from "@/pages/SettingsView";
import { NotificationBar } from "@/components/NotificationBar";
import { TimerDialog } from "@/components/TimerDialog";
import { Mode1515Dialog } from "@/components/Mode1515Dialog";
import { RecoveryMode } from "@/components/RecoveryMode";
import { APModeScreen } from "@/components/APModeScreen";
import { BasculinMascot } from "@/components/BasculinMascot";
import { useGlucoseMonitor } from "@/hooks/useGlucoseMonitor";
import { useCountdown } from "@/hooks/useCountdown";
import { networkDetector, NetworkStatus } from "@/services/networkDetector";
import { api } from "@/services/api";
import { apiWrapper } from "@/services/apiWrapper";
import { storage } from "@/services/storage";
import { formatWeight } from "@/lib/format";
import { useScaleDecimals } from "@/hooks/useScaleDecimals";
import { useAudioPref } from "@/state/useAudio";
import { useTimerStore } from "@/state/timerStore";
import { AppShell } from "@/layouts/AppShell";

type BasculinMood = "normal" | "happy" | "worried" | "alert" | "sleeping";

const Index = () => {
  const [currentView, setCurrentView] = useState<string>("menu");
  const [showTimerDialog, setShowTimerDialog] = useState(false);
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
  const [basculinMood, setBasculinMood] = useState<BasculinMood>("normal");
  const durationMs = useTimerStore((state) => state.durationMs);
  const startedAt = useTimerStore((state) => state.startedAt);
  const startTimer = useTimerStore((state) => state.start);
  const previousNetworkStatus = useRef<NetworkStatus | null>(null);
  const scaleDecimals = useScaleDecimals();
  const { voiceEnabled: isVoiceActive, setEnabled: setVoiceEnabled } = useAudioPref();
  const [conversationHistory, setConversationHistory] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const lastSpokenRef = useRef<string>("");
  const handleTimerFinished = useCallback(() => {
    setMascoMsg("Temporizador finalizado");
    setBasculinMood("alert");
  }, []);
  const countdown = useCountdown({ durationMs, startedAt, onFinished: handleTimerFinished });

  const speakResponse = useCallback(
    async (text: string) => {
      if (!isVoiceActive) {
        return;
      }
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      if (trimmed === lastSpokenRef.current) {
        return;
      }
      const settings = storage.getSettings();
      const voiceId = typeof settings.voiceId === "string" && settings.voiceId.trim().length > 0 ? settings.voiceId : undefined;
      try {
        await api.speak(trimmed, voiceId);
        lastSpokenRef.current = trimmed;
      } catch (error) {
        console.error("Assistant speech playback failed", error);
      }
    },
    [isVoiceActive]
  );

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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const baseUrl = apiWrapper.getBaseUrl() || storage.getSettings().apiUrl;
    let eventsUrl: string;
    try {
      eventsUrl = new URL("/api/voice/coach/events", baseUrl).toString();
    } catch {
      eventsUrl = `${baseUrl.replace(/\/$/, "")}/api/voice/coach/events`;
    }

    const source = new EventSource(eventsUrl);

    const handleSpeechEvent = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { text?: string; spoken?: boolean; mode?: string };
        const text = typeof payload.text === "string" ? payload.text.trim() : "";
        if (!text) {
          return;
        }
        setMascoMsg(text);
        if (payload.mode === "recetas") {
          setBasculinMood("happy");
        } else {
          setBasculinMood((current) => (current === "sleeping" ? "normal" : current));
        }
      } catch (error) {
        console.error("Failed to parse coach speech event", error);
      }
    };

    source.addEventListener("speech", handleSpeechEvent as EventListener);
    source.onerror = () => {
      console.warn("Coach speech stream interrupted");
    };

    return () => {
      source.removeEventListener("speech", handleSpeechEvent as EventListener);
      source.close();
    };
  }, []);

  const handleTimerStart = useCallback(async (seconds: number) => {
    const previousState = useTimerStore.getState();
    startTimer(seconds * 1000);
    setShowTimerDialog(false);
    setMascoMsg("Temporizador iniciado");
    setBasculinMood("happy");

    try {
      await api.startTimer(seconds);
    } catch (err) {
      console.error("Failed to start timer:", err);
      const { hydrate } = useTimerStore.getState();
      hydrate(previousState.durationMs, previousState.startedAt);
      setBasculinMood("worried");
      setMascoMsg("Error al iniciar temporizador");
    }
  }, [startTimer]);

  const handleBackToMenu = () => {
    setCurrentView("menu");
    setBasculinMood("sleeping");
    setMascoMsg(undefined);
  };

  const handleNavigate = (view: string) => {
    console.log("Index: Changing view from", currentView, "to", view);
    setCurrentView(view);
  };

  const renderView = () => {
    console.log("Index: Rendering view:", currentView);
    switch (currentView) {
      case "menu":
        return <MainMenu onNavigate={handleNavigate} />;
      case "scale":
        return <ScaleView onNavigate={handleNavigate} />;
      case "scanner":
        return <FoodScannerView />;
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

  const topBarTimerSeconds = durationMs > 0 ? Math.floor(countdown.remainingMs / 1000) : undefined;

  const topBarProps = showTopBar
    ? {
        isVoiceActive,
        isWifiConnected:
          networkStatusState?.connectivity === "full"
            ? true
            : networkStatusState?.isWifiConnected ?? false,
        timerSeconds: topBarTimerSeconds,
        onSettingsClick: () => setCurrentView("settings"),
        onTimerClick: () => setShowTimerDialog(true),
        onVoiceToggle: () => {
          void setVoiceEnabled(!isVoiceActive);
        },
        onBackClick: handleBackToMenu,
        showBackButton: true,
        showTimerButton: currentView === "scale" || currentView === "scanner",
      }
    : undefined;

  // Show special screens first
  if (showRecovery) {
    return <RecoveryMode />;
  }

  if (showAPMode) {
    return <APModeScreen />;
  }

  return (
    <AppShell
      showTopBar={showTopBar}
      topBarProps={topBarProps}
      notifications={
        <>
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
      }
    >
      <>
        {show1515Mode && glucoseData && (
          <Mode1515Dialog
            glucose={glucoseData.glucose}
            onClose={() => setShow1515Mode(false)}
          />
        )}

        <BasculinMascot
          isActive={shouldShowMascot}
          message={mascoMsg}
          position="corner"
          mood={basculinMood}
          enableVoice={isVoiceActive}
        />

        {networkStatusState?.effectiveMode === "offline" && (
          <div className="pointer-events-none fixed right-4 top-4 z-40">
            <div className="flex items-center gap-2 rounded-full border border-amber-400/70 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-200 shadow-lg backdrop-blur">
              <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
              Offline
            </div>
          </div>
        )}

        <div className="min-h-full">
          {renderView()}
        </div>

        <TimerDialog
          open={showTimerDialog}
          onClose={() => setShowTimerDialog(false)}
          onStart={handleTimerStart}
        />
      </>
    </AppShell>
  );
};

export default Index;
