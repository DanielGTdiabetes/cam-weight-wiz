import { useState } from "react";
import { MainMenu } from "@/components/MainMenu";
import { ScaleView } from "@/pages/ScaleView";
import { FoodScannerView } from "@/pages/FoodScannerView";
import { TimerFullView } from "@/pages/TimerFullView";
import { RecipesView } from "@/pages/RecipesView";
import { SettingsView } from "@/pages/SettingsView";
import { TopBar } from "@/components/TopBar";
import { NotificationBar } from "@/components/NotificationBar";
import { TimerDialog } from "@/components/TimerDialog";
import { Clock, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGlucoseMonitor } from "@/hooks/useGlucoseMonitor";
import { api } from "@/services/api";

const Index = () => {
  const [currentView, setCurrentView] = useState<string>("menu");
  const [showTimerDialog, setShowTimerDialog] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState<number | undefined>(undefined);
  const [notification, setNotification] = useState<string>("");
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [diabetesMode, setDiabetesMode] = useState(false);

  // Monitor glucose if diabetes mode is enabled
  const glucoseData = useGlucoseMonitor(diabetesMode);

  const handleTimerStart = async (seconds: number) => {
    setTimerSeconds(seconds);
    setShowTimerDialog(false);
    
    try {
      await api.startTimer(seconds);
    } catch (err) {
      console.error("Failed to start timer:", err);
    }
  };

  const handleBackToMenu = () => {
    setCurrentView("menu");
    setTimerSeconds(undefined);
  };

  const renderView = () => {
    switch (currentView) {
      case "menu":
        return <MainMenu onNavigate={setCurrentView} />;
      case "scale":
        return <ScaleView onNavigate={setCurrentView} />;
      case "scanner":
        return <FoodScannerView />;
      case "timer":
        return <TimerFullView />;
      case "recipes":
        return <RecipesView />;
      case "settings":
        return <SettingsView />;
      default:
        return <MainMenu onNavigate={setCurrentView} />;
    }
  };

  const showTopBar = currentView !== "menu" && currentView !== "timer" && currentView !== "recipes";

  return (
    <div className="h-screen overflow-hidden bg-background">
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
