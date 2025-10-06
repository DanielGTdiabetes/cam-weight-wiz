import { useEffect, useState } from "react";
import {
  Wifi,
  QrCode,
  Settings,
  KeyRound,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ExternalLink,
  Home,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export const APModeScreen = () => {
  const apSSID = "Bascula-Setup";
  const apPassword = "Bascula1234";
  const appURL = "http://192.168.4.1:8080";
  const configURL = "http://192.168.4.1:8080/config";
  const [miniWebPin, setMiniWebPin] = useState<string | null>(null);
  const [pinMessage, setPinMessage] = useState<string | null>(null);
  const [verifyState, setVerifyState] = useState<{
    status: "idle" | "checking" | "success" | "error";
    message?: string;
    code?: string;
    ip?: string;
  }>({ status: "idle" });

  useEffect(() => {
    let isMounted = true;

    const fetchPin = async () => {
      try {
        const response = await fetch("/api/miniweb/pin");

        if (response.ok) {
          const data = await response.json();
          if (!isMounted) return;

          if (data?.pin) {
            setMiniWebPin(data.pin);
            setPinMessage(null);
          } else {
            setMiniWebPin(null);
            setPinMessage("PIN no disponible en este momento");
          }
        } else if (response.status === 403) {
          if (!isMounted) return;
          setMiniWebPin(null);
          setPinMessage("El PIN se muestra directamente en la pantalla del dispositivo");
        } else {
          if (!isMounted) return;
          setMiniWebPin(null);
          setPinMessage("No se pudo obtener el PIN. Verifica la conexión.");
        }
      } catch (error) {
        if (!isMounted) return;
        setMiniWebPin(null);
        setPinMessage("No se pudo obtener el PIN. Verifica la conexión.");
      }
    };

    fetchPin();
    const interval = window.setInterval(fetchPin, 10000);

    return () => {
      isMounted = false;
      window.clearInterval(interval);
    };
  }, []);

  const handleOpenMiniWeb = () => {
    window.location.href = "/config";
  };

  const handleReturnToApp = () => {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }

    window.location.href = "/";
  };

  const handleVerifyWifi = async () => {
    setVerifyState({ status: "checking" });
    const timeoutMs = 30_000;
    const started = Date.now();
    let lastCode: string | undefined;

    while (Date.now() - started < timeoutMs) {
      try {
        const response = await fetch("/api/miniweb/status", { cache: "no-store" });
        if (response.ok) {
          const status = await response.json();
          if (
            status?.ap_active === false &&
            typeof status?.connectivity === "string" &&
            status.connectivity.toLowerCase() === "full"
          ) {
            const ssid = typeof status.ssid === "string" && status.ssid ? status.ssid : "tu red WiFi";
            const ip =
              (typeof status.ip === "string" && status.ip) ||
              (typeof status.ip_address === "string" && status.ip_address) ||
              undefined;
            setVerifyState({
              status: "success",
              message: `Conectado a ${ssid}. Cambia tu Wi-Fi al hogar para seguir usando la báscula.`,
              ip,
            });
            return;
          }
          lastCode = undefined;
        } else {
          const body = (await response.json().catch(() => null)) as
            | { detail?: unknown; code?: unknown }
            | null;
          const detail =
            body && typeof body.detail === "object" && body.detail !== null
              ? (body.detail as { code?: unknown })
              : undefined;
          const detailCode =
            (detail && typeof detail.code === "string" && detail.code) ||
            (typeof body?.code === "string" ? body.code : undefined);
          if (detailCode) {
            lastCode = detailCode;
          }
        }
      } catch (error) {
        // Ignorar errores de red momentáneos
      }

      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 1_500);
      });
    }

    setVerifyState({
      status: "error",
      code: lastCode,
      message: lastCode
        ? `No se pudo confirmar la conexión (${lastCode}).`
        : "No se pudo confirmar la conexión Wi-Fi.",
    });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      <Card className="w-full max-w-2xl border-primary/30 p-8 glow-cyan">
        <div className="mb-8 text-center">
          <div className="mb-4 flex justify-center">
            <div className="rounded-full bg-primary/20 p-6">
              <Wifi className="h-20 w-20 text-primary" />
            </div>
          </div>
          <h1 className="mb-4 text-4xl font-bold">Modo Punto de Acceso</h1>
          <p className="text-xl text-muted-foreground">
            Conéctate a <strong>{apSSID}</strong> y abre {configURL}
          </p>
        </div>

        <div className="mb-8 space-y-6">
          {/* AP Info */}
          <div className="rounded-lg border border-border bg-muted/30 p-6">
            <h2 className="mb-4 text-xl font-bold">Red WiFi para configuración</h2>
            <div className="space-y-3">
              <div>
                <p className="text-sm text-muted-foreground">Nombre de Red (SSID):</p>
                <p className="text-2xl font-bold text-primary">{apSSID}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Contraseña:</p>
                <p className="text-2xl font-bold">{apPassword}</p>
              </div>
              <div className="flex items-start gap-3">
                <div className="mt-1 rounded-full bg-primary/10 p-2">
                  <KeyRound className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">PIN de la mini-web:</p>
                  <p
                    className={`text-2xl font-bold ${
                      miniWebPin ? "text-primary" : pinMessage ? "text-destructive" : ""
                    }`}
                  >
                    {miniWebPin ?? (pinMessage ? "PIN no disponible" : "Cargando...")}
                  </p>
                  {pinMessage && !miniWebPin && (
                    <p className="text-sm text-destructive">{pinMessage}</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Instructions */}
          <div className="space-y-4">
            <h2 className="text-xl font-bold">Pasos para configurar WiFi:</h2>
            <ol className="space-y-3">
              <li className="flex gap-3">
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/20 font-bold text-primary">
                  1
                </span>
                <p>
                  Conecta tu móvil, tablet u ordenador a la Wi-Fi <strong>{apSSID}</strong>
                </p>
              </li>
              <li className="flex gap-3">
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/20 font-bold text-primary">
                  2
                </span>
                <p>Usa la contraseña: <strong>{apPassword}</strong></p>
              </li>
              <li className="flex gap-3">
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/20 font-bold text-primary">
                  3
                </span>
                <p>
                  Abre un navegador y escribe: <strong>{configURL}</strong>
                </p>
              </li>
              <li className="flex gap-3">
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/20 font-bold text-primary">
                  4
                </span>
                <p>
                  Introduce el PIN <strong>{miniWebPin ?? "mostrado en esta pantalla"}</strong> y
                  configura tu red WiFi desde la mini-web de configuración
                </p>
              </li>
            </ol>
          </div>

          {/* QR Code Section */}
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-6 text-center">
            <QrCode className="mx-auto mb-3 h-32 w-32 text-primary" />
            <p className="text-sm text-muted-foreground">
              Escanea para abrir la mini-web de configuración
            </p>
            <p className="mt-2 text-xs font-mono text-muted-foreground">
              {configURL}
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-left">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-1 h-5 w-5 text-warning" />
              <div className="space-y-1 text-sm">
                <p className="font-semibold text-warning-foreground">Recuerda:</p>
                <p className="text-warning-foreground/80">
                  {appURL} abre la app principal (esta pantalla). Para configurar la red usa siempre {configURL}.
                </p>
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Button onClick={handleOpenMiniWeb} variant="glow" size="xl" className="w-full text-xl">
              <ExternalLink className="mr-2 h-6 w-6" />
              Abrir Mini-Web de Configuración
            </Button>
            <Button onClick={handleReturnToApp} variant="outline" size="xl" className="w-full text-xl">
              <Home className="mr-2 h-6 w-6" />
              Salir / Volver a la app
            </Button>
          </div>

          <Button
            onClick={handleVerifyWifi}
            variant="glow"
            size="xl"
            className="w-full text-xl"
            disabled={verifyState.status === "checking"}
          >
            {verifyState.status === "checking" ? (
              <Loader2 className="mr-2 h-6 w-6 animate-spin" />
            ) : (
              <Settings className="mr-2 h-6 w-6" />
            )}
            {verifyState.status === "checking" ? "Verificando…" : "Verificar Conexión WiFi"}
          </Button>

          {verifyState.status === "success" && (
            <div className="flex items-start gap-3 rounded-lg border border-emerald-400/40 bg-emerald-500/10 p-4 text-left">
              <CheckCircle2 className="mt-1 h-5 w-5 text-emerald-400" />
              <div className="space-y-1">
                <p className="font-semibold text-emerald-200">Conexión confirmada</p>
                <p className="text-sm text-emerald-100/80">{verifyState.message}</p>
                {verifyState.ip && (
                  <p className="text-xs font-mono text-emerald-100/60">IP asignada: {verifyState.ip}</p>
                )}
              </div>
            </div>
          )}

          {verifyState.status === "error" && (
            <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-left">
              <AlertCircle className="mt-1 h-5 w-5 text-destructive" />
              <div className="space-y-1">
                <p className="font-semibold text-destructive">Sin confirmación</p>
                <p className="text-sm text-destructive/90">{verifyState.message}</p>
                {verifyState.code && (
                  <p className="text-xs uppercase tracking-wide text-destructive/80">Código: {verifyState.code}</p>
                )}
              </div>
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          El sistema volverá a intentar conectarse automáticamente cada 30 segundos
        </p>
      </Card>
    </div>
  );
};
