import { Scale, Camera, Timer, Book, Settings as SettingsIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useRecipeAvailability } from "@/hooks/useRecipeAvailability";
import { useToast } from "@/hooks/use-toast";

interface MainMenuProps {
  onNavigate: (view: string) => void;
}

export const MainMenu = ({ onNavigate }: MainMenuProps) => {
  const { toast } = useToast();
  const {
    loading: recipesLoading,
    enabled: recipesEnabled,
    reason: recipesReason,
    model: recipeModel,
  } = useRecipeAvailability();

  const menuItems = [
    {
      id: "scale",
      icon: Scale,
      title: "Báscula",
      description: "Pesar alimentos",
      borderColor: "border-primary/70",
      hoverBorder: "hover:border-primary hover:shadow-[0_0_30px_hsl(180_100%_50%/0.5)]",
      iconBg: "bg-primary/40",
      iconHoverBg: "group-hover:bg-primary",
      glowClass: "shadow-[0_0_25px_hsl(180_100%_50%/0.6),0_0_50px_hsl(180_100%_50%/0.3)] hover:glow-cyan",
    },
    {
      id: "scanner",
      icon: Camera,
      title: "Escáner",
      description: "Identificar alimentos",
      borderColor: "border-secondary/70",
      hoverBorder: "hover:border-secondary hover:shadow-[0_0_30px_hsl(300_80%_55%/0.5)]",
      iconBg: "bg-secondary/40",
      iconHoverBg: "group-hover:bg-secondary",
      glowClass: "shadow-[0_0_25px_hsl(300_80%_55%/0.6),0_0_50px_hsl(300_80%_55%/0.3)] hover:glow-magenta",
    },
    {
      id: "timer",
      icon: Timer,
      title: "Temporizador",
      description: "Temporizador de cocina",
      borderColor: "border-success/70",
      hoverBorder: "hover:border-success hover:shadow-[0_0_30px_hsl(150_70%_50%/0.5)]",
      iconBg: "bg-success/40",
      iconHoverBg: "group-hover:bg-success",
      glowClass: "shadow-[0_0_25px_hsl(150_70%_50%/0.6),0_0_50px_hsl(150_70%_50%/0.3)] hover:glow-green",
    },
    {
      id: "recipes",
      icon: Book,
      title: "Recetas",
      description: "Asistente de recetas",
      borderColor: "border-warning/70",
      hoverBorder: "hover:border-warning hover:shadow-[0_0_30px_hsl(40_100%_55%/0.5)]",
      iconBg: "bg-warning/40",
      iconHoverBg: "group-hover:bg-warning",
      glowClass: "shadow-[0_0_25px_hsl(40_100%_55%/0.6),0_0_50px_hsl(40_100%_55%/0.3)] hover:glow-yellow",
    },
  ];

  return (
    <div className="flex h-[600px] items-center justify-center bg-background p-3">
      <div className="w-full max-w-5xl relative">
        {/* Settings Icon - Top Right */}
        <button
          onClick={() => onNavigate("settings")}
          className="absolute -top-24 right-0 z-10 rounded-full bg-muted/50 p-3 hover:bg-muted transition-smooth border border-muted"
        >
          <SettingsIcon className="h-9 w-9" />
        </button>

        <div className="grid grid-cols-2 gap-4">
          {menuItems.map(({ id, icon: Icon, title, description, borderColor, hoverBorder, iconBg, iconHoverBg, glowClass }) => {
            const handleClick = (e: React.MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              const isRecipeItem = id === "recipes";
              if (isRecipeItem) {
                if (recipesLoading) {
                  toast({
                    title: "Comprobando asistente de recetas",
                    description: "Espera un momento mientras se verifica la conexión con ChatGPT.",
                  });
                  return;
                }
                if (!recipesEnabled) {
                  toast({
                    title: "Recetas no disponibles",
                    description: recipesReason ?? "Configura tu clave de OpenAI en Ajustes para activarlas.",
                    variant: "destructive",
                  });
                  return;
                }
              }

              console.log("MainMenu: Navigating to:", id);
              onNavigate(id);
            };

            const isRecipeItem = id === "recipes";
            const recipeDisabled = !recipesLoading && !recipesEnabled;
            const itemDisabled = isRecipeItem && recipeDisabled;
            const interactiveClasses = !itemDisabled
              ? `${hoverBorder} ${glowClass} cursor-pointer hover:scale-[1.02] active:scale-[0.98]`
              : "cursor-not-allowed opacity-60";
            const itemDescription = isRecipeItem
              ? recipesLoading
                ? "Comprobando disponibilidad..."
                : recipeDisabled
                ? recipesReason ?? "Configura ChatGPT para habilitarlo"
                : description
              : description;

            return (
              <Card
                key={id}
                className={`group overflow-hidden border-2 ${borderColor} ${interactiveClasses} transition-smooth`}
                onClick={handleClick}
                aria-disabled={itemDisabled}
              >
                <div className="gradient-holographic absolute inset-0 opacity-0 transition-smooth group-hover:opacity-20 pointer-events-none" />
                <div className="relative py-5 px-4 text-center pointer-events-none">
                  <div className="mb-2 flex justify-center">
                    <div
                      className={`rounded-2xl ${iconBg} ${!itemDisabled ? iconHoverBg : ""} p-4 transition-smooth group-hover:text-primary-foreground`}
                    >
                      <Icon className="h-12 w-12" />
                    </div>
                  </div>
                  <h2 className="mb-1 text-2xl font-bold leading-tight">{title}</h2>
                  <p className="text-base text-muted-foreground leading-tight">{itemDescription}</p>
                  {isRecipeItem && recipesEnabled && recipeModel && (
                    <div className="mt-2 flex justify-center">
                      <Badge variant="outline" className="text-xs font-medium">
                        IA: {recipeModel}
                      </Badge>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
};
