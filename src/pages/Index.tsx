import { useState } from "react";
import { MainMenu } from "@/components/MainMenu";
import { ScaleView } from "@/pages/ScaleView";
import { TopBar } from "@/components/TopBar";
import { NotificationBar } from "@/components/NotificationBar";
import { TimerDialog } from "@/components/TimerDialog";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";

const Index = () => {
  const [currentView, setCurrentView] = useState<string>("menu");
  const [showTimerDialog, setShowTimerDialog] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState<number | undefined>(undefined);
  const [notification, setNotification] = useState<string>("");
  const [isVoiceActive, setIsVoiceActive] = useState(false);

  const handleTimerStart = (seconds: number) => {
    setTimerSeconds(seconds);
    // TODO: Start countdown
  };

  const renderView = () => {
    switch (currentView) {
      case "menu":
        return <MainMenu onNavigate={setCurrentView} />;
      case "scale":
        return <ScaleView onNavigate={setCurrentView} />;
      case "scanner":
        return (
          <div className="flex h-screen items-center justify-center">
            <div className="text-center">
              <h1 className="mb-4 text-4xl font-bold">Escáner de Alimentos</h1>
              <p className="text-muted-foreground">Próximamente...</p>
            </div>
          </div>
        );
      case "timer":
      case "recipes":
      case "settings":
        return (
          <div className="flex h-screen items-center justify-center">
            <div className="text-center">
              <h1 className="mb-4 text-4xl font-bold">
                {currentView === "timer" && "Temporizador"}
                {currentView === "recipes" && "Recetas"}
                {currentView === "settings" && "Ajustes"}
              </h1>
              <p className="text-muted-foreground">Próximamente...</p>
            </div>
          </div>
        );
      default:
        return <MainMenu onNavigate={setCurrentView} />;
    }
  };

  return (
    <div className="h-screen overflow-hidden bg-background">
      {/* Top Bar - Only show in scale/scanner views */}
      {currentView !== "menu" && (
        <>
          <TopBar
            isVoiceActive={isVoiceActive}
            isWifiConnected={true}
            glucose={120}
            glucoseTrend="stable"
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
      <div className={currentView !== "menu" ? "h-[calc(100vh-60px)]" : "h-screen"}>
        {renderView()}
      </div>

      {/* Floating Timer Button - Only show in scale view */}
      {currentView === "scale" && !timerSeconds && (
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
