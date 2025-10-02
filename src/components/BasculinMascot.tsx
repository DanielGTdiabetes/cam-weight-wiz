import { useState, useEffect } from "react";
import { Cat } from "lucide-react";
import { cn } from "@/lib/utils";

interface BasculinMascotProps {
  isActive?: boolean;
  message?: string;
  position?: "corner" | "center";
}

export const BasculinMascot = ({
  isActive = false,
  message,
  position = "corner",
}: BasculinMascotProps) => {
  const [isAnimating, setIsAnimating] = useState(false);
  const [currentMessage, setCurrentMessage] = useState(message);

  useEffect(() => {
    if (message) {
      setCurrentMessage(message);
      setIsAnimating(true);
      const timer = setTimeout(() => setIsAnimating(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  if (!isActive) return null;

  return (
    <div
      className={cn(
        "fixed z-40 transition-all duration-300",
        position === "corner" ? "bottom-24 left-4" : "bottom-1/2 left-1/2 -translate-x-1/2 translate-y-1/2"
      )}
    >
      {/* Message Bubble */}
      {currentMessage && (
        <div
          className={cn(
            "mb-2 max-w-xs rounded-lg bg-primary/90 p-3 text-sm text-primary-foreground shadow-lg transition-all duration-300",
            isAnimating ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
          )}
        >
          {currentMessage}
        </div>
      )}

      {/* Mascot */}
      <div
        className={cn(
          "flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-primary to-secondary shadow-lg transition-transform glow-cyan",
          isAnimating && "scale-110 animate-bounce"
        )}
      >
        <Cat className="h-10 w-10 text-primary-foreground" />
      </div>

      {/* Animated rings */}
      {isAnimating && (
        <>
          <div className="absolute inset-0 animate-ping rounded-full bg-primary/20" />
          <div className="absolute inset-0 animate-pulse rounded-full bg-primary/10" />
        </>
      )}
    </div>
  );
};
