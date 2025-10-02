import { Home, Camera, Timer, Book, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

interface NavigationProps {
  currentView: string;
  onViewChange: (view: string) => void;
}

const navItems = [
  { id: "home", icon: Home, label: "Inicio" },
  { id: "scanner", icon: Camera, label: "Escáner" },
  { id: "timer", icon: Timer, label: "Timer" },
  { id: "recipes", icon: Book, label: "Recetas" },
  { id: "settings", icon: Settings, label: "Ajustes" },
];

export const Navigation = ({ currentView, onViewChange }: NavigationProps) => {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-card/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-screen-xl justify-around">
        {navItems.map(({ id, icon: Icon, label }) => {
          const isActive = currentView === id;
          return (
            <button
              key={id}
              onClick={() => onViewChange(id)}
              className={cn(
                "flex flex-1 flex-col items-center gap-1 px-3 py-3 transition-smooth",
                isActive
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <div className={cn(
                "rounded-lg p-2 transition-smooth",
                isActive && "bg-primary/20 glow-cyan"
              )}>
                <Icon className="h-5 w-5" />
              </div>
              <span className="text-xs font-medium">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
