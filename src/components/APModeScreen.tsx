import { Wifi, QrCode, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export const APModeScreen = () => {
  const apSSID = "Bascula-AP";
  const apPassword = "bascula2025";
  const miniWebURL = "http://192.168.4.1:8080";

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
            No se detectó ninguna red WiFi conocida
          </p>
        </div>

        <div className="mb-8 space-y-6">
          {/* AP Info */}
          <div className="rounded-lg border border-border bg-muted/30 p-6">
            <h2 className="mb-4 text-xl font-bold">Red WiFi Activa:</h2>
            <div className="space-y-3">
              <div>
                <p className="text-sm text-muted-foreground">Nombre de Red (SSID):</p>
                <p className="text-2xl font-bold text-primary">{apSSID}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Contraseña:</p>
                <p className="text-2xl font-bold">{apPassword}</p>
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
                <p>Conecta tu móvil o tablet a la red <strong>{apSSID}</strong></p>
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
                <p>Abre un navegador y accede a: <strong>{miniWebURL}</strong></p>
              </li>
              <li className="flex gap-3">
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/20 font-bold text-primary">
                  4
                </span>
                <p>Configura tu red WiFi desde la mini-web</p>
              </li>
            </ol>
          </div>

          {/* QR Code Section */}
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-6 text-center">
            <QrCode className="mx-auto mb-3 h-32 w-32 text-primary" />
            <p className="text-sm text-muted-foreground">
              Escanea para acceder a la mini-web
            </p>
            <p className="mt-2 text-xs font-mono text-muted-foreground">
              {miniWebURL}
            </p>
          </div>
        </div>

        <Button
          onClick={() => window.location.reload()}
          variant="glow"
          size="xl"
          className="w-full text-xl"
        >
          <Settings className="mr-2 h-6 w-6" />
          Verificar Conexión WiFi
        </Button>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          El sistema volverá a intentar conectarse automáticamente cada 30 segundos
        </p>
      </Card>
    </div>
  );
};
