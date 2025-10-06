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
  sec: string | null;
  in_use: boolean;
  secured: boolean;
}

interface ScanNetworksResponse {
  networks?: Array<{
    ssid: string;
    signal?: number;
    sec?: string;
    in_use?: boolean;
    secured?: boolean;
  }>;
}

interface ApiErrorResponse {
  code?: string;
  message?: string;
  detail?: string | { code?: string; message?: string };
}

export const MiniWebConfig = () => {
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [selectedSSID, setSelectedSSID] = useState("");
  const [password, setPassword] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [ui, setUi] = useState({ connecting: false });
  const [connectionStatus, setConnectionStatus] = useState<{
    type: 'idle' | 'error' | 'success' | 'info';
    message: string;
    panelUrl?: string;
  }>({ type: 'idle', message: '' });
  const [pinInput, setPinInput] = useState("");
  const [devicePin, setDevicePin] = useState<string | null>(null);
  const [pinMessage, setPinMessage] = useState<string | null>(null);
  const [isPinValid, setIsPinValid] = useState(false);
  const [isRecoveryMode, setIsRecoveryMode] = useState(false);
  const { toast } = useToast();

  const selectedNetwork = networks.find((network) => network.ssid === selectedSSID);

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

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();

    const fetchStatus = async () => {
      try {
        const response = await fetch('/api/miniweb/status', {
          cache: 'no-store',
          signal: controller.signal,
        });

        if (!isMounted) {
          return;
        }

        if (response.ok) {
          const data = (await response.json()) as {
            ap_active?: boolean;
            connectivity?: string;
          };
          const connectivity = typeof data?.connectivity === 'string' ? data.connectivity.toLowerCase() : undefined;
          const inRecovery = Boolean(data?.ap_active) || (connectivity ? connectivity !== 'full' : false);
          setIsRecoveryMode(inRecovery);
        } else {
          setIsRecoveryMode(false);
        }
      } catch (error) {
        if (!isMounted) {
          return;
        }
        setIsRecoveryMode(false);
        logger.debug('Failed to fetch AP status for miniweb', { error });
      }
    };

    void fetchStatus();

    return () => {
      isMounted = false;
      controller.abort();
    };
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
    setConnectionStatus({ type: 'idle', message: '' });
    setIsScanning(true);
    try {
      const response = await fetch('/api/miniweb/scan-networks');
      if (response.ok) {
        const data = (await response.json()) as ScanNetworksResponse;
        if (Array.isArray(data.networks)) {
          const mapped = data.networks.map((net) => ({
            ssid: net.ssid,
            signal: typeof net.signal === 'number' ? net.signal : 0,
            sec: typeof net.sec === 'string' ? net.sec : null,
            in_use: Boolean(net.in_use),
            secured:
              typeof net.secured === 'boolean'
                ? net.secured
                : Boolean(net.sec && net.sec.toUpperCase() !== 'NONE'),
          }));

          mapped.sort((a, b) => b.signal - a.signal);
          setNetworks(mapped);

          if (!selectedSSID) {
            const active = mapped.find((net) => net.in_use);
            if (active) {
              setSelectedSSID(active.ssid);
            }
          }
        } else {
          setNetworks([]);
        }
      } else {
        const errorBody = (await response.json().catch(() => null)) as ApiErrorResponse | null;
        const errorDetail =
          typeof errorBody?.detail === 'object' && errorBody.detail
            ? errorBody.detail
            : undefined;
        const errorCode = errorBody?.code ?? errorDetail?.code;

        if (response.status === 403 && errorCode === 'NMCLI_NOT_AUTHORIZED') {
          toast({
            title: 'Permisos insuficientes',
            description: 'Permisos de Wi-Fi insuficientes. Reinicia el dispositivo o finaliza la instalación para aplicar permisos.',
            variant: 'destructive',
          });
        } else if (response.status === 503 && errorCode === 'NMCLI_NOT_AVAILABLE') {
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
        title: 'Selecciona una red',
        variant: 'destructive',
      });
      return;
    }

    const connectWifi = async () => {
      try {
        setConnectionStatus({ type: 'idle', message: '' });

        const isSecured = Boolean(selectedNetwork?.secured);
        const payload = {
          ssid: selectedNetwork?.ssid ?? selectedSSID,
          password: isSecured ? password ?? '' : '',
          secured: isSecured,
          sec: selectedNetwork?.sec ?? null,
        };

        if (payload.secured && !payload.password) {
          setConnectionStatus({ type: 'error', message: 'Falta contraseña' });
          return;
        }

        setUi((prev) => ({ ...prev, connecting: true }));

        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 15_000);

        const res = await fetch('/api/miniweb/connect-wifi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        }).finally(() => {
          window.clearTimeout(timeoutId);
        });

        if (!res.ok) {
          const err = (await res.json().catch(() => null)) as
            | { detail?: unknown; message?: unknown }
            | null;
          const detail =
            typeof err?.detail === 'string'
              ? err.detail
              : typeof err?.detail === 'object' && err.detail !== null
                ? (() => {
                    const message = (err.detail as { message?: unknown }).message;
                    return typeof message === 'string' ? message : undefined;
                  })()
                : undefined;
          const message =
            (typeof err?.message === 'string' ? err.message : undefined) || detail || 'Error al conectar';
          setConnectionStatus({ type: 'error', message });
          setUi((prev) => ({ ...prev, connecting: false }));
          return;
        }

        setConnectionStatus({ type: 'info', message: 'Conectando… verificando el estado de la red.' });

        const started = Date.now();
        const timeoutMs = 30_000;
        const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

        while (Date.now() - started < timeoutMs) {
          try {
            const statusResponse = await fetch('/api/miniweb/status', { cache: 'no-store' });
            if (!statusResponse.ok) {
              await delay(2_000);
              continue;
            }
            const status = await statusResponse.json();
            if (
              status?.ap_active === false &&
              typeof status?.connectivity === "string" &&
              status.connectivity.toLowerCase() === "full"
            ) {
              const targetIp = status.ip || status.ip_address || window.location.hostname;
              const panelUrl = `http://${targetIp}:8080/`;
              setConnectionStatus({
                type: 'success',
                message: `Conectado a ${payload.ssid}`,
                panelUrl,
              });
              setUi((prev) => ({ ...prev, connecting: false }));
              return;
            }
          } catch (statusError) {
            logger.error('Failed to fetch status during connect', { error: statusError });
          }

          await delay(2_000);
        }

        setConnectionStatus({
          type: 'error',
          message: 'No se pudo confirmar la conexión. Revisa la contraseña o acércate al router',
        });
      } catch (error) {
        logger.error('Failed to connect WiFi', { error });
        const isNetworkChangeError =
          (error instanceof DOMException && error.name === 'AbortError') ||
          (error instanceof TypeError && error.message.includes('Failed to fetch'));
        const message = isNetworkChangeError
          ? 'Conectando… Si pierdes esta página es normal: cambia tu Wi-Fi al punto de acceso/red seleccionada y vuelve a abrir la app.'
          : 'Error al conectar';
        setConnectionStatus({ type: isNetworkChangeError ? 'info' : 'error', message });
      } finally {
        setUi((prev) => ({ ...prev, connecting: false }));
      }
    };

    void connectWifi();
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
            <h1 className="text-3xl font-bold mb-2">Báscula — Configuración de Red y Servicios</h1>
            <p className="text-muted-foreground">
              Introduce el PIN para acceder a la mini-web de ajustes.
            </p>
          </div>

          {isRecoveryMode && (
            <div className="mb-6 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-left">
              <AlertCircle className="mt-1 h-5 w-5 text-warning" />
              <p className="text-sm text-warning-foreground">
                Estás en modo recuperación (AP). Primero conecta la báscula a una Wi-Fi para continuar.
              </p>
            </div>
          )}

          <div className="space-y-6">
            <div className="space-y-2">
              <Label className="text-lg">PIN de Acceso</Label>
              <Input
                  type="password"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && checkPin(pinInput)}
                  placeholder="Ingresa el PIN de 4 dígitos"
                  className="text-2xl text-center h-16 tracking-wider allow-select"
                  maxLength={4}
                  autoComplete="off"
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
            <h1 className="text-3xl font-bold mb-2">Báscula — Configuración de Red y Servicios</h1>
            <p className="text-muted-foreground">
              Gestiona la Wi-Fi y los servicios conectados desde la mini-web oficial.
            </p>
          </div>

          {isRecoveryMode && (
            <div className="mb-6 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-left">
              <AlertCircle className="mt-1 h-5 w-5 text-warning" />
              <p className="text-sm text-warning-foreground">
                Estás en modo recuperación (AP). Primero conecta la báscula a una Wi-Fi para continuar.
              </p>
            </div>
          )}

          <div className="space-y-6">
            {/* Scan Button */}
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold">Redes Disponibles</h2>
              <Button
                onClick={loadNetworks}
                variant="outline"
                size="lg"
                disabled={isScanning || ui.connecting}
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
                    onClick={() => {
                      setSelectedSSID(network.ssid);
                      setConnectionStatus({ type: 'idle', message: '' });
                      if (!network.secured) {
                        setPassword('');
                      }
                    }}
                    className={`w-full p-4 rounded-lg border-2 text-left transition-smooth hover:bg-accent ${
                      selectedSSID === network.ssid
                        ? 'border-primary bg-primary/10'
                        : 'border-border'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Wifi className={`h-5 w-5 ${network.in_use ? 'text-primary' : ''}`} />
                  <div>
                    <p className="font-semibold">{network.ssid}</p>
                    <p className="text-sm text-muted-foreground">
                      Señal: {network.signal}%
                    </p>
                    <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wide">
                      {network.sec && network.sec.toUpperCase() !== 'NONE' ? network.sec : 'Abierta'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {network.in_use && (
                    <span className="text-xs font-semibold uppercase text-primary border border-primary/40 rounded-full px-2 py-0.5">
                      En uso
                    </span>
                  )}
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
            {selectedNetwork && (
              <div className="space-y-2 animate-fade-in">
                <Label className="text-lg">
                  {selectedNetwork.secured ? 'Contraseña WiFi' : 'Red abierta'}
                </Label>
                {selectedNetwork.secured ? (
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setConnectionStatus({ type: 'idle', message: '' });
                    }}
                    placeholder="Ingresa la contraseña"
                    className="text-lg h-14 allow-select"
                    onKeyPress={(e) => e.key === 'Enter' && handleConnect()}
                    autoComplete="off"
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Red abierta (sin contraseña).
                  </p>
                )}
              </div>
            )}

            {/* Connect Button */}
            <Button
              onClick={handleConnect}
              variant="glow"
              size="xl"
              className="w-full text-xl mx-auto"
              disabled={!selectedSSID || ui.connecting}
            >
              {ui.connecting ? (
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

            {connectionStatus.message && (
              <div
                className={`text-sm text-center rounded-md border px-3 py-2 ${
                  connectionStatus.type === 'error'
                    ? 'text-destructive border-destructive/50'
                    : connectionStatus.type === 'success'
                      ? 'text-emerald-600 border-emerald-500/40'
                      : 'text-muted-foreground border-border'
                }`}
                role="status"
                aria-live="polite"
              >
                <p>{connectionStatus.message}</p>
                {connectionStatus.type === 'success' && connectionStatus.panelUrl && (
                  <div className="mt-3 flex justify-center">
                    <Button asChild variant="outline" size="sm">
                      <a href={connectionStatus.panelUrl} target="_blank" rel="noopener noreferrer">
                        Abrir panel
                      </a>
                    </Button>
                  </div>
                )}
              </div>
            )}

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
