import { useState, useEffect, useRef } from "react";
import { MainMenu } from "@/components/MainMenu";
import { ScaleView } from "@/pages/ScaleView";
import { FoodScannerView } from "@/pages/FoodScannerView";
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
import { api } from "@/services/api";

const Index = () => {
  const [currentView, setCurrentView] = useState<string>("menu");
  const [showTimerDialog, setShowTimerDialog] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState<number | undefined>(undefined);
  const [notification, setNotification] = useState<string>("");
  const [isVoiceActive, setIsVoiceActive] = useState(false);
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
  const previousNetworkStatus = useRef<NetworkStatus | null>(null);

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

      if (status.showAPScreen) {
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

  const handleTimerStart = async (seconds: number) => {
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
  };

  const handleBackToMenu = () => {
    setCurrentView("menu");
    setTimerSeconds(undefined);
    setBasculinMood("sleeping");
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
        return <TimerFullView />;
      case "recipes":
        return <RecipesView />;
      case "settings":
        return <SettingsView />;
      default:
        return <MainMenu onNavigate={handleNavigate} />;
    }
  };

  const showTopBar = currentView !== "menu" && currentView !== "timer" && currentView !== "recipes";

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
        isActive={currentView !== "menu"}
        message={mascoMsg}
        position="corner"
        mood={basculinMood}
        enableVoice={isVoiceActive}
      />

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
            onVoiceToggle={() => setIsVoiceActive(!isVoiceActive)}
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

      {/* Back to Menu Button - Show in all views except menu - Moved higher to avoid TARA overlap */}
      {currentView !== "menu" && (
        <Button
          onClick={handleBackToMenu}
          size="icon"
          variant="outline"
          className="fixed top-20 left-6 h-16 w-16 rounded-full z-50 shadow-lg"
        >
          <ArrowLeft className="h-8 w-8" />
        </Button>
      )}

      {/* Floating Timer Button - Only show in scale and scanner views - Moved higher to avoid button overlap */}
      {(currentView === "scale" || currentView === "scanner") && !timerSeconds && (
        <Button
          onClick={() => setShowTimerDialog(true)}
          size="icon"
          variant="glow"
          className="fixed top-20 right-6 h-16 w-16 rounded-full glow-cyan z-50 shadow-lg"
        >
          <Clock className="h-8 w-8" />
        </Button>
      )}

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
