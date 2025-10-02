import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useVoice } from "@/hooks/useVoice";

interface BasculinMascotProps {
  isActive?: boolean;
  message?: string;
  position?: "corner" | "center";
  mood?: "normal" | "happy" | "worried" | "alert" | "sleeping";
  enableVoice?: boolean;
}

export const BasculinMascot = ({
  isActive = false,
  message,
  position = "corner",
  mood = "normal",
  enableVoice = false,
}: BasculinMascotProps) => {
  const [isAnimating, setIsAnimating] = useState(false);
  const [currentMessage, setCurrentMessage] = useState(message);
  const [currentMood, setCurrentMood] = useState(mood);
  const { speak } = useVoice(enableVoice);

  useEffect(() => {
    if (message) {
      setCurrentMessage(message);
      setIsAnimating(true);
      
      // Hablar el mensaje si está habilitado
      if (enableVoice) {
        speak(message);
      }
      
      const timer = setTimeout(() => setIsAnimating(false), 4000);
      return () => clearTimeout(timer);
    }
  }, [message, enableVoice, speak]);

  useEffect(() => {
    setCurrentMood(mood);
  }, [mood]);

  if (!isActive) return null;

  // Basculin Fish SVG Component
  const BasculinFish = () => {
    const getMoodColors = () => {
      switch (currentMood) {
        case "happy":
          return { body: "fill-success", accent: "fill-success-foreground" };
        case "worried":
          return { body: "fill-warning", accent: "fill-warning-foreground" };
        case "alert":
          return { body: "fill-destructive", accent: "fill-destructive-foreground" };
        case "sleeping":
          return { body: "fill-muted", accent: "fill-muted-foreground" };
        default:
          return { body: "fill-primary", accent: "fill-secondary" };
      }
    };

    const colors = getMoodColors();
    const eyeState = currentMood === "sleeping" ? "M" : "C";

    return (
      <svg
        viewBox="0 0 100 100"
        className="h-full w-full"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Body */}
        <ellipse cx="50" cy="50" rx="35" ry="25" className={colors.body} />
        
        {/* Tail */}
        <path
          d="M 15 50 Q 5 40, 8 35 Q 10 45, 10 50 Q 10 55, 8 65 Q 5 60, 15 50 Z"
          className={colors.accent}
        />
        
        {/* Top Fin */}
        <path
          d="M 45 25 Q 42 15, 50 18 Q 58 15, 55 25 Z"
          className={colors.accent}
        />
        
        {/* Bottom Fin */}
        <path
          d="M 45 75 Q 42 85, 50 82 Q 58 85, 55 75 Z"
          className={colors.accent}
        />
        
        {/* Side Stripes */}
        <path
          d="M 30 45 Q 35 40, 40 45 Q 35 50, 30 45 Z"
          className={colors.accent}
          opacity="0.6"
        />
        <path
          d="M 30 55 Q 35 50, 40 55 Q 35 60, 30 55 Z"
          className={colors.accent}
          opacity="0.6"
        />
        
        {/* Eyes */}
        <ellipse cx="60" cy="45" rx="6" ry="7" fill="white" />
        <ellipse cx="62" cy="45" rx="3" ry="4" fill="black">
          {isAnimating && (
            <animate
              attributeName="ry"
              values="4;1;4"
              dur="0.3s"
              repeatCount="indefinite"
            />
          )}
        </ellipse>
        
        {/* Mouth */}
        <path
          d={
            currentMood === "happy"
              ? "M 70 52 Q 75 57, 80 52"
              : currentMood === "worried"
              ? "M 70 57 Q 75 52, 80 57"
              : "M 70 54 L 80 54"
          }
          stroke="black"
          strokeWidth="2"
          fill="none"
        />
        
        {/* Bubbles when animating */}
        {isAnimating && (
          <>
            <circle cx="85" cy="35" r="3" fill="white" opacity="0.7">
              <animate
                attributeName="cy"
                values="35;25;35"
                dur="2s"
                repeatCount="indefinite"
              />
            </circle>
            <circle cx="90" cy="40" r="2" fill="white" opacity="0.5">
              <animate
                attributeName="cy"
                values="40;30;40"
                dur="2.5s"
                repeatCount="indefinite"
              />
            </circle>
          </>
        )}
      </svg>
    );
  };

  return (
    <div
      className={cn(
        "fixed z-40 transition-all duration-500",
        position === "corner" ? "bottom-24 left-4" : "bottom-1/2 left-1/2 -translate-x-1/2 translate-y-1/2"
      )}
    >
      {/* Message Bubble */}
      {currentMessage && (
        <div
          className={cn(
            "mb-3 max-w-xs rounded-2xl bg-card/95 border border-primary/30 backdrop-blur-sm p-4 text-sm text-card-foreground shadow-xl transition-all duration-500",
            isAnimating ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-4 scale-95"
          )}
        >
          <div className="flex items-start gap-2">
            <span className="text-primary text-lg">💬</span>
            <p className="flex-1">{currentMessage}</p>
          </div>
        </div>
      )}

      {/* Mascot Container */}
      <div
        className={cn(
          "relative flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-secondary/20 backdrop-blur-sm border-2 border-primary/30 shadow-2xl transition-all duration-500 glow-cyan",
          isAnimating && "scale-110",
          currentMood === "sleeping" && "opacity-60"
        )}
        style={{
          animation: isAnimating ? "bounce 0.5s ease-in-out infinite" : undefined,
        }}
      >
        <div
          className={cn(
            "h-20 w-20 transition-transform duration-300",
            isAnimating && "scale-110"
          )}
          style={{
            animation: currentMood === "sleeping" 
              ? "pulse 3s ease-in-out infinite" 
              : undefined,
          }}
        >
          <BasculinFish />
        </div>

        {/* Animated rings */}
        {isAnimating && currentMood !== "sleeping" && (
          <>
            <div className="absolute inset-0 animate-ping rounded-full bg-primary/20" />
            <div className="absolute inset-0 animate-pulse rounded-full bg-secondary/10" />
          </>
        )}
        
        {/* Status indicator */}
        <div
          className={cn(
            "absolute -top-1 -right-1 h-4 w-4 rounded-full border-2 border-background",
            currentMood === "happy" && "bg-success animate-pulse",
            currentMood === "worried" && "bg-warning animate-pulse",
            currentMood === "alert" && "bg-destructive animate-ping",
            currentMood === "normal" && "bg-primary",
            currentMood === "sleeping" && "bg-muted"
          )}
        />
      </div>
    </div>
  );
};
