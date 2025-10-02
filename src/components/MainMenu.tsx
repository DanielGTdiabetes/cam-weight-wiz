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
      variant: "glow" as const,
    },
    {
      id: "scanner",
      icon: Camera,
      title: "Escáner",
      description: "Identificar alimentos",
      variant: "default" as const,
    },
    {
      id: "timer",
      icon: Timer,
      title: "Temporizador",
      description: "Temporizador de cocina",
      variant: "secondary" as const,
    },
    {
      id: "recipes",
      icon: Book,
      title: "Recetas",
      description: "Asistente de recetas",
      variant: "outline" as const,
    },
    {
      id: "settings",
      icon: SettingsIcon,
      title: "Ajustes",
      description: "Configuración",
      variant: "outline" as const,
    },
  ];

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      <div className="w-full max-w-4xl">
        <div className="mb-8 text-center">
          <h1 className="mb-2 text-5xl font-bold text-primary text-glow-cyan">
            Báscula Inteligente
          </h1>
          <p className="text-xl text-muted-foreground">
            Sistema de Nutrición y Diabetes
          </p>
        </div>

        <div className="grid grid-cols-2 gap-6">
          {menuItems.map(({ id, icon: Icon, title, description, variant }) => (
            <Card
              key={id}
              className="group cursor-pointer overflow-hidden border-primary/20 transition-smooth hover:scale-105 hover:border-primary/50 glow-cyan"
              onClick={() => onNavigate(id)}
            >
              <div className="gradient-holographic absolute inset-0 opacity-0 transition-smooth group-hover:opacity-30" />
              <div className="relative p-8 text-center">
                <div className="mb-4 flex justify-center">
                  <div className="rounded-xl bg-primary/20 p-6 transition-smooth group-hover:bg-primary group-hover:text-primary-foreground">
                    <Icon className="h-12 w-12" />
                  </div>
                </div>
                <h2 className="mb-2 text-2xl font-bold">{title}</h2>
                <p className="text-sm text-muted-foreground">{description}</p>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
};
