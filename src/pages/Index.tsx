import { useState, useEffect } from "react";
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
import { networkDetector } from "@/services/networkDetector";
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
  const [mascoMsg, setMascoMsg] = useState<string | undefined>();
  const [basculinMood, setBasculinMood] = useState<"normal" | "happy" | "worried" | "alert" | "sleeping">("normal");

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
    if (isRecoveryNeeded) {
      setShowRecovery(true);
    }
  }, []);

  // Monitor network status for AP mode
  useEffect(() => {
    const handleNetworkStatus = (status: any) => {
      // Show AP mode screen if WiFi is not connected
      setShowAPMode(status.shouldActivateAP);
      
      // Show notification if reconnected
      if (status.isWifiConnected && showAPMode) {
        setNotification(`Conectado a ${status.ssid}`);
        setBasculinMood("happy");
        setMascoMsg("¡WiFi conectado!");
      }
    };

    // Subscribe to network status
    networkDetector.subscribe(handleNetworkStatus);
    
    // Start monitoring (check every 30 seconds)
    networkDetector.startMonitoring(30000);

    return () => {
      networkDetector.unsubscribe(handleNetworkStatus);
      networkDetector.stopMonitoring();
    };
  }, [showAPMode]);

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
            isWifiConnected={true}
            glucose={glucoseData?.glucose}
            glucoseTrend={glucoseData?.trend}
            timerSeconds={timerSeconds}
            onSettingsClick={() => setCurrentView("settings")}
            onTimerClick={() => setShowTimerDialog(true)}
            onVoiceToggle={() => setIsVoiceActive(!isVoiceActive)}
          />
          <NotificationBar
            message={notification}
            type="info"
            onClose={() => setNotification("")}
          />
        </>
      )}

      {/* Main Content */}
      <div className={showTopBar ? "h-[calc(100vh-60px)] overflow-y-auto" : "h-screen"}>
        {renderView()}
      </div>

      {/* Back to Menu Button - Show in all views except menu */}
      {currentView !== "menu" && (
        <Button
          onClick={handleBackToMenu}
          size="icon"
          variant="outline"
          className="fixed bottom-6 left-6 h-16 w-16 rounded-full"
        >
          <ArrowLeft className="h-8 w-8" />
        </Button>
      )}

      {/* Floating Timer Button - Only show in scale and scanner views */}
      {(currentView === "scale" || currentView === "scanner") && !timerSeconds && (
        <Button
          onClick={() => setShowTimerDialog(true)}
          size="icon"
          variant="glow"
          className="fixed bottom-6 right-6 h-16 w-16 rounded-full glow-cyan"
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
