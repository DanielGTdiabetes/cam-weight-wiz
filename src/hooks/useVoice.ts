import { useState, useCallback } from "react";
import { api } from "@/services/api";
import { storage } from "@/services/storage";

interface UseVoiceReturn {
  speak: (text: string) => Promise<void>;
  isSpeaking: boolean;
  error: string | null;
}

export const useVoice = (enabled: boolean): UseVoiceReturn => {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const speak = useCallback(
    async (text: string) => {
      if (!enabled) return;

      try {
        setIsSpeaking(true);
        setError(null);
        const voiceId = storage.getSettings().voiceId;
        await api.speak(text, voiceId ?? undefined);
      } catch (err) {
        console.error("Failed to speak:", err);
        setError("Error al reproducir voz");
      } finally {
        setIsSpeaking(false);
      }
    },
    [enabled]
  );

  return { speak, isSpeaking, error };
};
