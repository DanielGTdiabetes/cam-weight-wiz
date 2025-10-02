import { useState } from "react";
import { Navigation } from "@/components/Navigation";
import { Home } from "@/pages/Home";
import { Scanner } from "@/pages/Scanner";
import { TimerView } from "@/pages/TimerView";

const Index = () => {
  const [currentView, setCurrentView] = useState("home");

  const renderView = () => {
    switch (currentView) {
      case "home":
        return <Home onNavigate={setCurrentView} />;
      case "scanner":
        return <Scanner />;
      case "timer":
        return <TimerView />;
      case "recipes":
        return <div className="min-h-screen bg-background p-4 pb-24 pt-20 text-center"><h1 className="text-2xl font-bold">Recetas - Próximamente</h1></div>;
      case "settings":
        return <div className="min-h-screen bg-background p-4 pb-24 pt-20 text-center"><h1 className="text-2xl font-bold">Ajustes - Próximamente</h1></div>;
      default:
        return <Home onNavigate={setCurrentView} />;
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {renderView()}
      <Navigation currentView={currentView} onViewChange={setCurrentView} />
    </div>
  );
};

export default Index;
