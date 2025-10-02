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
      color: "cyan",
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
      color: "magenta",
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
      color: "green",
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
      color: "amber",
      borderColor: "border-warning/30",
      hoverBorder: "hover:border-warning",
      iconBg: "bg-warning/20",
      iconHoverBg: "group-hover:bg-warning",
      glowClass: "group-hover:shadow-[0_0_20px_hsl(40_100%_55%/0.3)]",
    },
    {
      id: "settings",
      icon: SettingsIcon,
      title: "Ajustes",
      description: "Configuración",
      color: "muted",
      borderColor: "border-muted/30",
      hoverBorder: "hover:border-muted",
      iconBg: "bg-muted/30",
      iconHoverBg: "group-hover:bg-muted",
      glowClass: "group-hover:shadow-[0_0_15px_hsl(220_15%_20%/0.5)]",
    },
  ];

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-5xl">
        <div className="mb-6 text-center">
          <h1 className="mb-3 text-6xl font-bold text-primary text-glow-cyan">
            Báscula Inteligente
          </h1>
          <p className="text-2xl text-muted-foreground">
            Sistema de Nutrición y Diabetes
          </p>
        </div>

        <div className="grid grid-cols-2 gap-5">
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
                <div className="relative p-6 text-center pointer-events-none">
                  <div className="mb-3 flex justify-center">
                    <div className={`rounded-2xl ${iconBg} ${iconHoverBg} p-5 transition-smooth group-hover:text-primary-foreground`}>
                      <Icon className="h-14 w-14" />
                    </div>
                  </div>
                  <h2 className="mb-2 text-3xl font-bold">{title}</h2>
                  <p className="text-lg text-muted-foreground">{description}</p>
                </div>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
};
