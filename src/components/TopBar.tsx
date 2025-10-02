import { Volume2, VolumeX, Wifi, WifiOff, Settings, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface TopBarProps {
  isVoiceActive?: boolean;
  isWifiConnected?: boolean;
  glucose?: number;
  glucoseTrend?: "up" | "down" | "stable";
  timerSeconds?: number;
  onSettingsClick: () => void;
  onTimerClick?: () => void;
  onVoiceToggle?: () => void;
}

export const TopBar = ({
  isVoiceActive = false,
  isWifiConnected = true,
  glucose,
  glucoseTrend,
  timerSeconds,
  onSettingsClick,
  onTimerClick,
  onVoiceToggle,
}: TopBarProps) => {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="flex items-center justify-between border-b border-border bg-card/90 px-4 py-3 backdrop-blur-sm">
      {/* Left side - Voice & WiFi */}
      <div className="flex items-center gap-2">
        <Button
          size="icon"
          variant="ghost"
          onClick={onVoiceToggle}
          className="h-10 w-10"
        >
          {isVoiceActive ? (
            <Volume2 className="h-5 w-5 text-primary" />
          ) : (
            <VolumeX className="h-5 w-5 text-muted-foreground" />
          )}
        </Button>
        
        {isWifiConnected ? (
          <Wifi className="h-5 w-5 text-success" />
        ) : (
          <WifiOff className="h-5 w-5 text-destructive" />
        )}
      </div>

      {/* Center - Glucose & Timer */}
      <div className="flex items-center gap-4">
        {glucose !== undefined && (
          <div className="flex items-center gap-2 rounded-lg bg-primary/10 px-4 py-2">
            <span className="text-2xl font-bold text-primary">{glucose}</span>
            <span className="text-sm text-muted-foreground">mg/dl</span>
            {glucoseTrend && (
              <span className={cn(
                "text-xl",
                glucoseTrend === "up" && "text-warning",
                glucoseTrend === "down" && "text-destructive",
                glucoseTrend === "stable" && "text-success"
              )}>
                {glucoseTrend === "up" ? "↑" : glucoseTrend === "down" ? "↓" : "→"}
              </span>
            )}
          </div>
        )}
        
        {timerSeconds !== undefined && (
          <Button
            onClick={onTimerClick}
            variant="ghost"
            className="gap-2 text-xl font-mono"
          >
            <Clock className="h-5 w-5" />
            {formatTime(timerSeconds)}
          </Button>
        )}
      </div>

      {/* Right side - Settings */}
      <Button
        size="icon"
        variant="ghost"
        onClick={onSettingsClick}
        className="h-10 w-10"
      >
        <Settings className="h-5 w-5" />
      </Button>
    </div>
  );
};
