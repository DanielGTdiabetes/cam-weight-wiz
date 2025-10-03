import { useState, useEffect } from "react";
import { Wifi, Lock, Save, RefreshCw, Check, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { logger } from "@/services/logger";

interface WifiNetwork {
  ssid: string;
  signal: number;
  secured: boolean;
}

export const MiniWebConfig = () => {
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [selectedSSID, setSelectedSSID] = useState("");
  const [password, setPassword] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [devicePin, setDevicePin] = useState<string | null>(null);
  const [pinMessage, setPinMessage] = useState<string | null>(null);
  const [isPinValid, setIsPinValid] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const fetchPin = async () => {
      try {
        const response = await fetch('/api/miniweb/pin');
        if (response.ok) {
          const data = await response.json();
          if (data?.pin) {
            setDevicePin(data.pin);
            setPinMessage(null);
          }
        } else if (response.status === 403) {
          setDevicePin(null);
          setPinMessage('El PIN se muestra en la pantalla del dispositivo');
        } else {
          setDevicePin(null);
          setPinMessage('No se pudo obtener el PIN. Verifica la conexión.');
        }
      } catch (error) {
        logger.error('Failed to fetch PIN', { error });
        setDevicePin(null);
        setPinMessage('No se pudo obtener el PIN. Verifica la conexión.');
      }
    };

    fetchPin();
  }, []);

  // Check PIN for security
  const checkPin = async (inputPin: string) => {
    try {
      const response = await fetch('/api/miniweb/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: inputPin }),
      });
      
      if (response.ok) {
        setIsPinValid(true);
        loadNetworks();
      } else if (response.status === 429) {
        toast({
          title: 'Demasiados intentos',
          description: 'Espera unos minutos antes de volver a intentar.',
          variant: 'destructive',
        });
      } else {
        toast({
          title: "PIN incorrecto",
          description: "Verifica el PIN en la pantalla del dispositivo",
          variant: "destructive",
        });
      }
    } catch (error) {
      logger.error('Failed to verify PIN', { error });
    }
  };

  const loadNetworks = async () => {
    setIsScanning(true);
    try {
      const response = await fetch('/api/miniweb/scan-networks');
      if (response.ok) {
        const data = await response.json();
        setNetworks(data.networks || []);
      } else {
        let errorBody: any = null;
        try {
          errorBody = await response.json();
        } catch (error) {
          logger.error('Failed to parse scan error', { error });
        }

        if (response.status === 403 && errorBody?.code === 'NMCLI_NOT_AUTHORIZED') {
          toast({
            title: 'Permisos insuficientes',
            description: 'Permisos de Wi-Fi insuficientes. Reinicia el dispositivo o finaliza la instalación para aplicar permisos.',
            variant: 'destructive',
          });
        } else if (response.status === 503 && errorBody?.code === 'NMCLI_NOT_AVAILABLE') {
          toast({
            title: 'nmcli no disponible',
            description: 'nmcli no disponible. Instala NetworkManager.',
            variant: 'destructive',
          });
        } else {
          toast({
            title: 'Error al escanear redes',
            description: 'No se pudo obtener la lista de redes Wi-Fi.',
            variant: 'destructive',
          });
        }
        setNetworks([]);
      }
    } catch (error) {
      logger.error('Failed to scan networks', { error });
      toast({
        title: 'Error al escanear redes',
        description: 'No se pudo obtener la lista de redes Wi-Fi.',
        variant: 'destructive',
      });
    } finally {
      setIsScanning(false);
    }
  };

  const handleConnect = async () => {
    if (!selectedSSID) {
      toast({
        title: "Selecciona una red",
        variant: "destructive",
      });
      return;
    }

    setIsConnecting(true);
    try {
      const response = await fetch('/api/miniweb/connect-wifi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ssid: selectedSSID,
          password,
        }),
      });

      if (response.ok) {
        toast({
          title: "¡Conectado!",
          description: "El dispositivo se reiniciará en modo normal",
        });

        // Wait 3 seconds then reload
        setTimeout(() => {
          window.location.href = '/';
        }, 3000);
      } else {
        const error = await response.json().catch(() => ({}));
        const detail = error?.detail || error?.message;
        toast({
          title: "Error al conectar",
          description: detail || "Verifica la contraseña",
          variant: "destructive",
        });
      }
    } catch (error) {
      logger.error('Failed to connect WiFi', { error });
      toast({
        title: "Error de conexión",
        variant: "destructive",
      });
    } finally {
      setIsConnecting(false);
    }
  };

  // PIN Entry Screen
  if (!isPinValid) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-background/80 p-4">
        <Card className="w-full max-w-md p-8 border-primary/30 glow-cyan">
          <div className="text-center mb-8">
            <div className="flex justify-center mb-4">
              <div className="rounded-full bg-primary/20 p-6">
                <Lock className="h-16 w-16 text-primary" />
              </div>
            </div>
            <h1 className="text-3xl font-bold mb-2">Asistente de configuración</h1>
            <p className="text-muted-foreground">
              Configuración WiFi - Modo AP
            </p>
          </div>

          <div className="space-y-6">
            <div className="space-y-2">
              <Label className="text-lg">PIN de Acceso</Label>
              <Input
                type="password"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && checkPin(pinInput)}
                placeholder="Ingresa el PIN de 4 dígitos"
                className="text-2xl text-center h-16 tracking-wider"
                maxLength={4}
              />
              {devicePin ? (
                <div className="text-center space-y-1">
                  <p className="text-xs uppercase tracking-widest text-muted-foreground">PIN actual</p>
                  <p className="text-4xl font-bold tracking-[0.6em]">{devicePin}</p>
                  <p className="text-xs text-muted-foreground">También visible en la pantalla del dispositivo.</p>
                </div>
              ) : pinMessage ? (
                <p className="text-sm text-muted-foreground text-center">{pinMessage}</p>
              ) : null}
            </div>

            <Button
              onClick={() => checkPin(pinInput)}
              variant="glow"
              size="xl"
              className="w-full text-xl"
              disabled={pinInput.length !== 4}
            >
              Acceder
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // WiFi Configuration Screen
  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-background/80 p-4">
      <div className="max-w-2xl mx-auto py-8">
        <Card className="p-8 border-primary/30">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold mb-2">Configuración WiFi</h1>
            <p className="text-muted-foreground">
              Selecciona una red y conéctate
            </p>
          </div>

          <div className="space-y-6">
            {/* Scan Button */}
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold">Redes Disponibles</h2>
              <Button
                onClick={loadNetworks}
                variant="outline"
                size="lg"
                disabled={isScanning}
              >
                <RefreshCw className={`mr-2 h-5 w-5 ${isScanning ? 'animate-spin' : ''}`} />
                {isScanning ? 'Escaneando...' : 'Escanear'}
              </Button>
            </div>

            {/* Networks List */}
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {networks.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Wifi className="h-16 w-16 mx-auto mb-4 opacity-50" />
                  <p>No se encontraron redes</p>
                  <p className="text-sm mt-2">Presiona "Escanear" para buscar</p>
                </div>
              ) : (
                networks.map((network) => (
                  <button
                    key={network.ssid}
                    onClick={() => setSelectedSSID(network.ssid)}
                    className={`w-full p-4 rounded-lg border-2 text-left transition-smooth hover:bg-accent ${
                      selectedSSID === network.ssid
                        ? 'border-primary bg-primary/10'
                        : 'border-border'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Wifi className="h-5 w-5" />
                        <div>
                          <p className="font-semibold">{network.ssid}</p>
                          <p className="text-sm text-muted-foreground">
                            Señal: {network.signal}%
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {network.secured && <Lock className="h-4 w-4" />}
                        {selectedSSID === network.ssid && (
                          <Check className="h-5 w-5 text-primary" />
                        )}
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>

            {/* Password Input */}
            {selectedSSID && (
              <div className="space-y-2 animate-fade-in">
                <Label className="text-lg">Contraseña WiFi</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Ingresa la contraseña"
                  className="text-lg h-14"
                  onKeyPress={(e) => e.key === 'Enter' && handleConnect()}
                />
              </div>
            )}

            {/* Connect Button */}
            <Button
              onClick={handleConnect}
              variant="glow"
              size="xl"
              className="w-full text-xl"
              disabled={!selectedSSID || isConnecting}
            >
              {isConnecting ? (
                <>
                  <RefreshCw className="mr-2 h-6 w-6 animate-spin" />
                  Conectando...
                </>
              ) : (
                <>
                  <Save className="mr-2 h-6 w-6" />
                  Conectar a {selectedSSID}
                </>
              )}
            </Button>

            {/* Info Alert */}
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 flex gap-3">
              <AlertCircle className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-semibold mb-1">Importante:</p>
                <p className="text-muted-foreground">
                  El dispositivo se reiniciará automáticamente tras conectarse.
                  Esta mini-web se desactivará al establecer la conexión.
                </p>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
};
