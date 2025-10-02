import { useState } from "react";
import { AlertCircle, RotateCcw, Download, Power } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/services/api";
import { useToast } from "@/hooks/use-toast";

export const RecoveryMode = () => {
  const [isUpdating, setIsUpdating] = useState(false);
  const { toast } = useToast();

  const handleUpdate = async () => {
    setIsUpdating(true);
    try {
      await api.installUpdate();
      toast({
        title: "Actualización iniciada",
        description: "El sistema se reiniciará en 30 segundos",
      });
      setTimeout(() => {
        window.location.reload();
      }, 30000);
    } catch (error) {
      toast({
        title: "Error",
        description: "No se pudo iniciar la actualización",
        variant: "destructive",
      });
      setIsUpdating(false);
    }
  };

  const handleRestart = () => {
    toast({
      title: "Reiniciando sistema",
      description: "Por favor espera...",
    });
    setTimeout(() => {
      window.location.reload();
    }, 3000);
  };

  const handleRetry = () => {
    // Clear recovery flags
    localStorage.removeItem("recovery_mode");
    localStorage.removeItem("last_error");
    localStorage.removeItem("update_error");
    
    // Try to clear service worker cache
    if ("caches" in window) {
      caches.open("recovery-cache").then((cache) => {
        cache.delete(new Request("/recovery-flag"));
      });
    }
    
    toast({
      title: "Reiniciando aplicación",
      description: "Intentando cargar normalmente...",
    });
    
    setTimeout(() => {
      window.location.reload();
    }, 1000);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      <Card className="w-full max-w-2xl border-warning/50 bg-warning/5 p-8">
        <div className="mb-8 text-center">
          <div className="mb-4 flex justify-center">
            <div className="rounded-full bg-warning/20 p-6">
              <AlertCircle className="h-20 w-20 text-warning" />
            </div>
          </div>
          <h1 className="mb-4 text-4xl font-bold">Modo Recovery</h1>
          <p className="text-xl text-muted-foreground">
            Se ha detectado un problema al iniciar la aplicación
          </p>
        </div>

        <div className="mb-8 space-y-4 rounded-lg border border-border p-6">
          <h2 className="text-xl font-bold">Posibles causas:</h2>
          <ul className="list-inside list-disc space-y-2 text-muted-foreground">
            <li>Actualización OTA incompleta o corrupta</li>
            <li>Error de configuración del sistema</li>
            <li>Problema de conexión con hardware</li>
            <li>Archivos del sistema dañados</li>
          </ul>
          
          {localStorage.getItem("last_error") && (
            <div className="mt-4 rounded-lg bg-destructive/10 p-4">
              <p className="text-sm font-mono text-destructive">
                {JSON.parse(localStorage.getItem("last_error") || "{}").message}
              </p>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <Button
            onClick={handleRetry}
            variant="glow"
            size="xl"
            className="w-full text-xl"
          >
            <RotateCcw className="mr-2 h-6 w-6" />
            Reintentar Cargar App
          </Button>

          <Button
            onClick={handleUpdate}
            disabled={isUpdating}
            variant="secondary"
            size="xl"
            className="w-full text-xl"
          >
            <Download className="mr-2 h-6 w-6" />
            {isUpdating ? "Actualizando..." : "Reinstalar Última Versión"}
          </Button>

          <Button
            onClick={handleRestart}
            variant="outline"
            size="xl"
            className="w-full text-xl"
          >
            <Power className="mr-2 h-6 w-6" />
            Reiniciar Sistema
          </Button>
        </div>

        <div className="mt-8 rounded-lg border-warning/50 bg-warning/5 p-4">
          <p className="text-center text-sm">
            <strong>¿Problemas persistentes?</strong>
            <br />
            Accede a la mini-web desde otro dispositivo para reconfigurar el sistema.
          </p>
        </div>
      </Card>
    </div>
  );
};
