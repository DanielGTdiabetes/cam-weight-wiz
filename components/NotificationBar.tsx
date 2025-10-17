import { AlertCircle, Info, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface NotificationBarProps {
  message?: string;
  type?: "info" | "warning" | "success" | "error";
  onClose?: () => void;
}

export const NotificationBar = ({ message, type = "info", onClose }: NotificationBarProps) => {
  if (!message) return null;

  const icons = {
    info: Info,
    warning: AlertCircle,
    success: CheckCircle2,
    error: XCircle,
  };

  const Icon = icons[type];

  const colors = {
    info: "bg-primary/10 text-primary border-primary/30",
    warning: "bg-warning/10 text-warning border-warning/30",
    success: "bg-success/10 text-success border-success/30",
    error: "bg-destructive/10 text-destructive border-destructive/30",
  };

  return (
    <div className={cn(
      "flex items-center gap-3 border-b px-4 py-3 text-sm font-medium transition-smooth",
      colors[type]
    )}>
      <Icon className="h-5 w-5 flex-shrink-0" />
      <p className="flex-1">{message}</p>
      {onClose && (
        <button
          onClick={onClose}
          className="flex-shrink-0 rounded p-1 hover:bg-background/20"
        >
          <XCircle className="h-4 w-4" />
        </button>
      )}
    </div>
  );
};
