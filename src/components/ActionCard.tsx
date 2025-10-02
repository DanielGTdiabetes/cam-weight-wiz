import { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface ActionCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "default";
}

export const ActionCard = ({ 
  icon: Icon, 
  title, 
  description, 
  onClick,
  variant = "default" 
}: ActionCardProps) => {
  return (
    <Card 
      className={cn(
        "group relative cursor-pointer overflow-hidden transition-smooth hover:scale-105",
        variant === "primary" && "border-primary/30 hover:border-primary glow-cyan",
        variant === "secondary" && "border-secondary/30 hover:border-secondary glow-magenta",
        variant === "default" && "border-border hover:border-primary/50"
      )}
      onClick={onClick}
    >
      <div className={cn(
        "absolute inset-0 opacity-0 transition-smooth group-hover:opacity-50",
        variant === "primary" && "gradient-primary",
        variant === "secondary" && "gradient-secondary",
        variant === "default" && "gradient-holographic"
      )} />
      
      <div className="relative p-6">
        <div className={cn(
          "mb-4 inline-flex rounded-lg p-3 transition-smooth",
          variant === "primary" && "bg-primary/20 text-primary group-hover:bg-primary group-hover:text-primary-foreground",
          variant === "secondary" && "bg-secondary/20 text-secondary group-hover:bg-secondary group-hover:text-secondary-foreground",
          variant === "default" && "bg-muted text-foreground"
        )}>
          <Icon className="h-6 w-6" />
        </div>
        
        <h3 className="mb-2 text-lg font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </Card>
  );
};
