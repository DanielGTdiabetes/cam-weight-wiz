import { useCallback, useMemo, useState } from "react";
import { Camera, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

interface CaptureResponse {
  ok?: boolean;
  path?: string;
  size?: number;
  detail?: string;
  message?: string;
  error?: string;
}

export const ScannerView = () => {
  const [isCapturing, setIsCapturing] = useState(false);
  const [capturePath, setCapturePath] = useState<string | null>(null);
  const [captureTs, setCaptureTs] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { toast } = useToast();

  const imageUrl = useMemo(() => {
    if (!capturePath) {
      return null;
    }
    const tsValue = captureTs ?? Date.now();
    const basePath = capturePath.startsWith("http")
      ? capturePath
      : capturePath.startsWith("/")
        ? capturePath
        : `/${capturePath}`;
    const separator = basePath.includes("?") ? "&" : "?";
    return `${basePath}${separator}t=${tsValue}`;
  }, [capturePath, captureTs]);

  const handleCapture = useCallback(async () => {
    setIsCapturing(true);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/camera/capture-to-file", {
        method: "POST",
      });

      let payload: CaptureResponse | null = null;
      try {
        payload = (await response.json()) as CaptureResponse;
      } catch (parseError) {
        if (!response.ok) {
          throw parseError instanceof Error
            ? parseError
            : new Error("capture_failed");
        }
      }

      const captureOk = response.ok && (payload?.ok ?? true);
      if (!captureOk) {
        const backendMessage =
          payload?.detail || payload?.message || payload?.error;
        throw new Error(backendMessage || "capture_failed");
      }

      const pathValue = payload?.path;
      if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
        throw new Error("capture_missing_path");
      }

      setCapturePath(pathValue.trim());
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
  }, [toast]);

  return (
    <div className="flex h-full flex-col gap-4 bg-background p-4">
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
