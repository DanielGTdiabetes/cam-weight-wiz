import { Volume2, VolumeX, Wifi, WifiOff, Settings, Clock, ArrowLeft } from "lucide-react";
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
  onBackClick?: () => void;
  showBackButton?: boolean;
  showTimerButton?: boolean;
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
  onBackClick,
  showBackButton = false,
  showTimerButton = false,
}: TopBarProps) => {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="flex items-center justify-between border-b-2 border-border bg-card/90 px-5 py-3 backdrop-blur-sm">
      {/* Left side - Voice, WiFi & Back button */}
      <div className="flex items-center gap-3">
        <Button
          size="icon"
          variant="ghost"
          onClick={onVoiceToggle}
        >
          {isVoiceActive ? (
            <Volume2 className="h-7 w-7 text-primary" />
          ) : (
            <VolumeX className="h-7 w-7 text-muted-foreground" />
          )}
        </Button>
        
        {isWifiConnected ? (
          <Wifi className="h-7 w-7 text-success" />
        ) : (
          <WifiOff className="h-7 w-7 text-destructive" />
        )}

        {showBackButton && (
          <Button
            size="icon"
            variant="outline"
            onClick={onBackClick}
            className="h-10 w-10"
          >
            <ArrowLeft className="h-6 w-6" />
          </Button>
        )}
      </div>

      {/* Center - Glucose & Timer */}
      <div className="flex items-center gap-4">
        {glucose !== undefined && (
          <div className="flex items-center gap-3 rounded-xl bg-primary/10 px-5 py-3">
            <span className="text-3xl font-bold text-primary">{glucose}</span>
            <span className="text-base text-muted-foreground">mg/dl</span>
            {glucoseTrend && (
              <span className={cn(
                "text-2xl",
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
            className="gap-2 text-2xl font-mono h-14"
          >
            <Clock className="h-6 w-6" />
            {formatTime(timerSeconds)}
          </Button>
        )}
      </div>

      {/* Right side - Timer & Settings */}
      <div className="flex items-center gap-3">
        {showTimerButton && (
          <Button
            size="icon"
            variant="glow"
            onClick={onTimerClick}
            className="h-10 w-10 glow-cyan"
          >
            <Clock className="h-6 w-6" />
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          onClick={onSettingsClick}
        >
          <Settings className="h-7 w-7" />
        </Button>
      </div>
    </div>
  );
};
