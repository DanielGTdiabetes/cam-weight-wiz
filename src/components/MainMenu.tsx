import { Scale, Camera, Timer, Book, Settings as SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface MainMenuProps {
  onNavigate: (view: string) => void;
}

export const MainMenu = ({ onNavigate }: MainMenuProps) => {
  const menuItems = [
    {
      id: "scale",
      icon: Scale,
      title: "Báscula",
      description: "Pesar alimentos",
      borderColor: "border-primary/30",
      hoverBorder: "hover:border-primary",
      iconBg: "bg-primary/20",
      iconHoverBg: "group-hover:bg-primary",
      glowClass: "glow-cyan",
    },
    {
      id: "scanner",
      icon: Camera,
      title: "Escáner",
      description: "Identificar alimentos",
      borderColor: "border-secondary/30",
      hoverBorder: "hover:border-secondary",
      iconBg: "bg-secondary/20",
      iconHoverBg: "group-hover:bg-secondary",
      glowClass: "group-hover:glow-magenta",
    },
    {
      id: "timer",
      icon: Timer,
      title: "Temporizador",
      description: "Temporizador de cocina",
      borderColor: "border-success/30",
      hoverBorder: "hover:border-success",
      iconBg: "bg-success/20",
      iconHoverBg: "group-hover:bg-success",
      glowClass: "group-hover:glow-green",
    },
    {
      id: "recipes",
      icon: Book,
      title: "Recetas",
      description: "Asistente de recetas",
      borderColor: "border-warning/30",
      hoverBorder: "hover:border-warning",
      iconBg: "bg-warning/20",
      iconHoverBg: "group-hover:bg-warning",
      glowClass: "group-hover:shadow-[0_0_20px_hsl(40_100%_55%/0.3)]",
    },
  ];

  return (
    <div className="flex h-[600px] items-center justify-center bg-background p-3">
      <div className="w-full max-w-5xl relative">
        {/* Settings Icon - Top Right */}
        <button
          onClick={() => onNavigate("settings")}
          className="absolute -top-12 right-0 z-10 rounded-full bg-muted/50 p-3 hover:bg-muted transition-smooth border border-muted"
        >
          <SettingsIcon className="h-8 w-8" />
        </button>

        <div className="grid grid-cols-2 gap-4">
          {menuItems.map(({ id, icon: Icon, title, description, borderColor, hoverBorder, iconBg, iconHoverBg, glowClass }) => {
            const handleClick = (e: React.MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              console.log("MainMenu: Navigating to:", id);
              onNavigate(id);
            };

            return (
              <Card
                key={id}
                className={`group cursor-pointer overflow-hidden border-2 ${borderColor} ${hoverBorder} ${glowClass} transition-smooth hover:scale-[1.02] active:scale-[0.98]`}
                onClick={handleClick}
              >
                <div className="gradient-holographic absolute inset-0 opacity-0 transition-smooth group-hover:opacity-20 pointer-events-none" />
                <div className="relative py-5 px-4 text-center pointer-events-none">
                  <div className="mb-2 flex justify-center">
                    <div className={`rounded-2xl ${iconBg} ${iconHoverBg} p-4 transition-smooth group-hover:text-primary-foreground`}>
                      <Icon className="h-12 w-12" />
                    </div>
                  </div>
                  <h2 className="mb-1 text-2xl font-bold leading-tight">{title}</h2>
                  <p className="text-base text-muted-foreground leading-tight">{description}</p>
                </div>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
};
