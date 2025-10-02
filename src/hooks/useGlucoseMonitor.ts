import { useEffect, useState } from "react";
import { api, type GlucoseData } from "@/services/api";
import { useToast } from "@/hooks/use-toast";

interface UseGlucoseMonitorReturn extends GlucoseData {
  isLoading: boolean;
  error: string | null;
}

export const useGlucoseMonitor = (
  enabled: boolean,
  lowThreshold = 70,
  highThreshold = 180
): UseGlucoseMonitorReturn | null => {
  const [data, setData] = useState<GlucoseData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (!enabled) return;

    const fetchGlucose = async () => {
      try {
        setIsLoading(true);
        const glucoseData = await api.getGlucose();
        setData(glucoseData);
        setError(null);

        // Check for alarms
        if (glucoseData.glucose < lowThreshold) {
          toast({
            title: "⚠️ Hipoglucemia Detectada",
            description: `Glucosa: ${glucoseData.glucose} mg/dl`,
            variant: "destructive",
            duration: 10000,
          });
        } else if (glucoseData.glucose > highThreshold) {
          toast({
            title: "⚠️ Hiperglucemia Detectada",
            description: `Glucosa: ${glucoseData.glucose} mg/dl`,
            variant: "destructive",
            duration: 10000,
          });
        }
      } catch (err) {
        console.error("Failed to fetch glucose:", err);
        setError("Error al obtener datos de glucosa");
      } finally {
        setIsLoading(false);
      }
    };

    // Fetch immediately
    fetchGlucose();

    // Then every 5 minutes
    const interval = setInterval(fetchGlucose, 5 * 60 * 1000);

    return () => clearInterval(interval);
  }, [enabled, lowThreshold, highThreshold, toast]);

  if (!enabled || !data) return null;

  return {
    ...data,
    isLoading,
    error,
  };
};
