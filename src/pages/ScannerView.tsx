import { useCallback, useEffect, useMemo, useState } from "react";
import { Camera, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Countdown } from "@/components/Countdown";
import { useCountdown } from "@/hooks/useCountdown";
import { useTimerStore } from "@/state/timerStore";
import { storage } from "@/services/storage";

interface CaptureResponse {
  ok?: boolean;
  path?: string;
  url?: string;
  size?: number;
  detail?: string;
  message?: string;
  error?: string;
}

export const ScannerView = () => {
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureUrl, setCaptureUrl] = useState<string | null>(null);
  const [captureTs, setCaptureTs] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { toast } = useToast();
  const durationMs = useTimerStore((state) => state.durationMs);
  const startedAt = useTimerStore((state) => state.startedAt);
  const { remainingMs, mmss, phase } = useCountdown({ durationMs, startedAt });
  const showCountdown = durationMs > 0 || startedAt !== null;

  const backendOrigin = useMemo(() => {
    // 1) Preferir apiUrl de settings persistidos
    try {
      const settings = storage.getSettings();
      const apiUrl = typeof settings?.apiUrl === "string" ? settings.apiUrl.trim() : "";
      if (apiUrl) return apiUrl;
    } catch {
      // Intentionally empty - fall through to next strategy
    }

    // 2) Derivar a partir de la URL actual
    if (typeof window === "undefined") {
      return "http://127.0.0.1:8081";
    }

    try {
      const current = new URL(window.location.href);
      const port = current.port; // cadena o "" si sin puerto explícito

      // Si estamos en miniweb (8080), cambiar a 8081
      if (port === "8080") {
        current.port = "8081";
        return current.origin;
      }

      // Si estamos en 80, 443 o SIN puerto (nginx estático), forzar 8081
      if (port === "" || port === "80" || port === "443") {
        // Mantener protocolo/host, solo fijar puerto 8081
        current.port = "8081";
        return current.origin;
      }

      // Si ya estamos en 8081 u otro puerto explícito, usar tal cual
      return current.origin;
    } catch (e) {
      console.warn("No se pudo resolver el origen actual, fallback 127.0.0.1:8081", e);
      return "http://127.0.0.1:8081";
    }
  }, []);

  useEffect(() => {
    console.debug("[scanner] backendOrigin =", backendOrigin);
  }, [backendOrigin]);

  const buildUrl = useCallback(
    (path: string) => {
      if (!path) {
        return backendOrigin;
      }

      if (/^https?:\/\//i.test(path)) {
        return path;
      }

      try {
        return new URL(path, backendOrigin).toString();
      } catch (error) {
        console.warn("No se pudo componer la URL absoluta", { path, error });
        return path;
      }
    },
    [backendOrigin],
  );

  const imageUrl = useMemo(() => {
    if (!captureUrl) {
      return null;
    }
    const tsValue = captureTs ?? Date.now();
    const separator = captureUrl.includes("?") ? "&" : "?";
    return `${captureUrl}${separator}t=${tsValue}`;
  }, [captureUrl, captureTs]);

  const handleCapture = useCallback(async () => {
    setIsCapturing(true);
    setErrorMessage(null);

    try {
      const response = await fetch(buildUrl("/api/camera/capture-to-file"), {
        method: "POST",
      });

      let payload: CaptureResponse | null = null;
      try {
        payload = (await response.json()) as CaptureResponse;
      } catch (parseError) {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
      }

      if (!response.ok) {
        const backendMessage =
          payload?.detail || payload?.message || payload?.error;
        throw new Error(backendMessage || `HTTP ${response.status}`);
      }

      const captureOk = payload?.ok ?? true;
      if (!captureOk) {
        const backendMessage =
          payload?.detail || payload?.message || payload?.error;
        throw new Error(backendMessage || "capture_failed");
      }

      const pathValue = payload?.url ?? payload?.path;
      if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
        throw new Error("capture_missing_path");
      }

      const normalizedPath = pathValue.trim();
      const absoluteUrl = buildUrl(normalizedPath);
      setCaptureUrl(absoluteUrl);
      setCaptureTs(Date.now());
    } catch (error) {
      console.error("Error al capturar imagen", error);
      const fallback = "Error al capturar imagen";
      const rawMessage =
        error instanceof Error &&
        error.message &&
        !["capture_failed", "capture_missing_path"].includes(error.message)
          ? error.message
          : null;
      const message = rawMessage ?? fallback;
      setErrorMessage(message);
      toast({
        title: "Captura fallida",
        description: rawMessage ?? "Revisa la cámara y vuelve a intentarlo.",
        variant: "destructive",
      });
    } finally {
      setIsCapturing(false);
    }
  }, [buildUrl, toast]);

  return (
    <div className="flex h-full flex-col gap-4 bg-background p-4">
      {showCountdown && (
        <div className="flex justify-end">
          <Countdown
            remainingMs={remainingMs}
            mmss={mmss}
            phase={phase}
            className="text-5xl font-semibold tracking-tight"
          />
        </div>
      )}

      <Card className="flex flex-1 flex-col items-center gap-6 border-primary/40 bg-muted/30 p-6 text-center">
        <div className="max-w-3xl space-y-2">
          <h2 className="text-3xl font-bold">Escáner de alimentos</h2>
          <p className="text-base text-muted-foreground">
            Pulsa “Activar cámara” para tomar una foto desde la báscula y ver el
            resultado al instante.
          </p>
        </div>

        <Button
          onClick={handleCapture}
          disabled={isCapturing}
          size="lg"
          className="h-16 min-w-[240px] px-10 text-xl"
        >
          {isCapturing ? (
            <>
              <Loader2 className="mr-3 h-6 w-6 animate-spin" />
              Capturando…
            </>
          ) : (
            <>
              <Camera className="mr-3 h-6 w-6" />
              {captureTs ? "Capturar de nuevo" : "Activar cámara"}
            </>
          )}
        </Button>

        {errorMessage && (
          <div className="w-full max-w-xl rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-base font-medium text-destructive">
            {errorMessage}
          </div>
        )}

        <div className="flex w-full flex-1 items-center justify-center">
          {imageUrl ? (
            <img
              key={imageUrl}
              src={imageUrl}
              alt="Última captura de la cámara"
              className="max-h-[440px] w-auto max-w-full rounded-2xl border border-border bg-black object-contain shadow-lg"
            />
          ) : (
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <div className="rounded-full border border-dashed border-muted-foreground/40 p-6">
                <Camera className="h-16 w-16 opacity-30" />
              </div>
              <p className="text-lg font-medium">
                Aún no hay captura disponible.
              </p>
              <p className="max-w-xs text-sm text-muted-foreground/80">
                Cuando captures desde la mini-web, la imagen aparecerá aquí con
                un identificador único para evitar la caché.
              </p>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};

export default ScannerView;
