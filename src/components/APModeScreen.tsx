import { useCallback, useEffect, useRef, useState } from "react";
import { Wifi, KeyRound, Loader2, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/services/api";
import { apiWrapper } from "@/services/apiWrapper";
import { logger } from "@/services/logger";

type ApInfo = {
  ssid: string;
  ip: string;
  httpPort: number;
  configPath?: string;
};

const DEFAULT_AP_INFO: ApInfo = {
  ssid: "Bascula-AP",
  ip: "192.168.4.1",
  httpPort: 8080,
  configPath: "/config",
};

export const APModeScreen = () => {
  const apPassword = "Bascula1234";
  const [apInfo, setApInfo] = useState<ApInfo | null>(null);
  const [apInfoLoading, setApInfoLoading] = useState(true);
  const [miniWebPin, setMiniWebPin] = useState<string | null>(null);
  const [pinMessage, setPinMessage] = useState<string | null>(null);
  const [toastState, setToastState] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [startingOffline, setStartingOffline] = useState(false);
  const redirectRef = useRef(false);

  const resolveAppBaseUrl = useCallback(() => {
    if (typeof window === "undefined" || !window.location?.origin) {
      return "/";
    }

    return `${window.location.origin.replace(/\/+$/, "")}/`;
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchApInfo = async () => {
      setApInfoLoading(true);
      try {
        const response = await fetch("/api/ap/info", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Failed to load AP info: ${response.status}`);
        }
        const payload = (await response.json()) as Record<string, unknown>;
        if (cancelled) return;

        const ssid =
          typeof payload.ssid === "string" && payload.ssid.trim()
            ? payload.ssid.trim()
            : DEFAULT_AP_INFO.ssid;

        let httpPortCandidate: number | undefined;
        if (typeof payload.httpPort === "number") {
          httpPortCandidate = payload.httpPort;
        } else if (typeof payload.httpPort === "string") {
          const parsed = Number.parseInt(payload.httpPort, 10);
          if (Number.isFinite(parsed)) {
            httpPortCandidate = parsed;
          }
        }

        const httpPort =
          typeof httpPortCandidate === "number" && Number.isFinite(httpPortCandidate) && httpPortCandidate > 0
            ? httpPortCandidate
            : DEFAULT_AP_INFO.httpPort;

        const ip =
          typeof payload.ip === "string" && payload.ip.trim()
            ? payload.ip.trim()
            : DEFAULT_AP_INFO.ip;

        const configPathCandidate =
          typeof payload.configPath === "string" && payload.configPath.trim()
            ? payload.configPath.trim()
            : DEFAULT_AP_INFO.configPath;

        setApInfo({
          ssid,
          ip,
          httpPort,
          configPath: configPathCandidate,
        });
      } catch (error) {
        if (cancelled) return;
        setApInfo({ ...DEFAULT_AP_INFO });
      } finally {
        if (!cancelled) {
          setApInfoLoading(false);
        }
      }
    };

    fetchApInfo();

    return () => {
      cancelled = true;
    };
  }, []);

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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const baseCandidate = apiWrapper.getBaseUrl();
    const fallback = window.location.origin;
    let eventSource: EventSource | null = null;
    let redirectTimer: number | undefined;

    try {
      const origin = (baseCandidate && baseCandidate.trim()) || fallback || "";
      if (!origin) {
        return;
      }
      const url = new URL("/api/net/events", origin).toString();
      eventSource = new EventSource(url);
    } catch (error) {
      logger.debug("No se pudo iniciar el stream SSE de red", { error });
      return;
    }

    const issueRedirect = () => {
      if (redirectRef.current) {
        return;
      }
      redirectRef.current = true;
      const target = resolveAppBaseUrl();
      redirectTimer = window.setTimeout(() => {
        try {
          window.location.replace(target);
        } catch (err) {
          logger.warn("No se pudo redirigir tras wifi_connected", { error: err });
        }
      }, 1_500);
    };

    const handleConnected = (event: MessageEvent) => {
      let message = "Conectado. Reiniciando…";
      try {
        const raw = event.data;
        if (typeof raw === "string" && raw.trim()) {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const eventSsid = typeof parsed.ssid === "string" ? parsed.ssid : undefined;
          if (eventSsid) {
            message = `Conectado a ${eventSsid}. Reiniciando…`;
          }
        }
      } catch (error) {
        logger.debug("No se pudo parsear evento wifi_connected", { error });
      }
      setToastState({ type: "success", msg: message });
      issueRedirect();
    };

    const handleFailed = (event: MessageEvent) => {
      let message = "No se pudo conectar";
      try {
        const raw = event.data;
        if (typeof raw === "string" && raw.trim()) {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const detail = typeof parsed.message === "string" ? parsed.message : undefined;
          const code = typeof parsed.code === "string" ? parsed.code : undefined;
          if (detail) {
            message = detail;
          } else if (code) {
            message = `No se pudo conectar (${code})`;
          }
        }
      } catch (error) {
        logger.debug("No se pudo parsear evento wifi_failed", { error });
      }
      setToastState({ type: "error", msg: message });
    };

    const connectedListener = (event: Event) => {
      handleConnected(event as MessageEvent);
    };
    const failedListener = (event: Event) => {
      handleFailed(event as MessageEvent);
    };

    eventSource.addEventListener("wifi_connected", connectedListener);
    eventSource.addEventListener("wifi_failed", failedListener);
    eventSource.onerror = (event) => {
      logger.debug("SSE de red reportó un error", { event });
    };

    return () => {
      if (redirectTimer !== undefined) {
        window.clearTimeout(redirectTimer);
      }
      eventSource?.removeEventListener("wifi_connected", connectedListener);
      eventSource?.removeEventListener("wifi_failed", failedListener);
      eventSource?.close();
    };
  }, [redirectRef, resolveAppBaseUrl]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let cancelled = false;

    const checkStatus = async () => {
      const handleOnlineRedirect = () => {
        if (redirectRef.current) {
          return;
        }
        redirectRef.current = true;
        try {
          window.location.replace(resolveAppBaseUrl());
        } catch (error) {
          logger.warn("No se pudo redirigir tras detectar modo kiosk", { error });
        }
      };

      try {
        const status = await api.miniwebStatus();
        const rawMode =
          typeof status?.effective_mode === "string"
            ? status.effective_mode.trim().toLowerCase()
            : typeof status?.mode === "string"
              ? status.mode.trim().toLowerCase()
              : null;
        if (!cancelled && !redirectRef.current) {
          if (rawMode === "kiosk") {
            handleOnlineRedirect();
            return;
          }
          if (rawMode === "offline") {
            redirectRef.current = true;
            const base = resolveAppBaseUrl().replace(/\/+$/, "");
            const target = `${base}/offline`;
            window.location.replace(target);
            return;
          }
        }
      } catch (error) {
        logger.debug("Fallo al consultar miniweb status durante polling", { error });
      }
    };

    const interval = window.setInterval(() => {
      void checkStatus();
    }, 4_000);

    void checkStatus();

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [redirectRef, resolveAppBaseUrl]);

  const effectiveApInfo = apInfo ?? DEFAULT_AP_INFO;
  const configPathRaw =
    typeof effectiveApInfo.configPath === "string" && effectiveApInfo.configPath.trim()
      ? effectiveApInfo.configPath.trim()
      : DEFAULT_AP_INFO.configPath ?? "/config";
  const normalizedConfigPath = configPathRaw.startsWith("/")
    ? configPathRaw
    : `/${configPathRaw}`;
  const baseUrl = `http://${effectiveApInfo.ip}:${effectiveApInfo.httpPort}`;
  const configUrl = `${baseUrl}${normalizedConfigPath}`;
  const displaySsid = apInfoLoading ? "Cargando…" : effectiveApInfo.ssid;
  const defaultBaseUrl = `http://${DEFAULT_AP_INFO.ip}:${DEFAULT_AP_INFO.httpPort}`;
  const displayConfigUrl = apInfoLoading ? `${defaultBaseUrl}${normalizedConfigPath}` : configUrl;

  const parseResponseMessage = async (response: Response): Promise<string> => {
    try {
      const data = (await response.json()) as {
        detail?: unknown;
        message?: unknown;
      };
      if (typeof data?.detail === "string" && data.detail.trim()) {
        return data.detail.trim();
      }
      if (typeof data?.message === "string" && data.message.trim()) {
        return data.message.trim();
      }
    } catch (error) {
      logger.debug("No se pudo interpretar la respuesta del backend", { error });
    }
    return `Error ${response.status}`;
  };

  const handleStartOffline = async () => {
    if (startingOffline) {
      return;
    }
    setStartingOffline(true);
    setToastState(null);
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ui: { offline_mode: true } }),
      });
      if (!response.ok) {
        const message = await parseResponseMessage(response);
        throw new Error(message);
      }

      setToastState({
        type: "success",
        msg: "Modo offline activado. Abriendo la app sin conexión…",
      });

      redirectRef.current = true;
      const base = resolveAppBaseUrl().replace(/\/+$/, "");
      window.location.replace(`${base}/offline`);
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "No se pudo activar el modo offline.";
      logger.error("No se pudo activar el modo offline desde la pantalla AP", { error });
      setToastState({ type: "error", msg: message });
    } finally {
      setStartingOffline(false);
    }
  };

  const handleOpenConfig = () => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.location.assign("/config");
    } catch (error) {
      logger.warn("No se pudo abrir /config desde la pantalla AP", { error });
    }
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
          <h1 className="mb-4 text-4xl font-bold">Conéctate a «{displaySsid}»</h1>
          <div className="space-y-2 text-muted-foreground">
            <p className="text-lg">
              Usa tu móvil, tablet o PC para conectarte a la red Wi-Fi creada por la báscula.
            </p>
            <p className="text-lg">
              También puedes configurar desde <span className="font-mono text-primary">http://IP/config</span> si tienes cable Ethernet conectado.
            </p>
          </div>
        </div>

        {toastState && (
          <div
            className={`mb-8 rounded-lg border p-4 text-left text-sm ${
              toastState.type === "success"
                ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-50"
                : "border-destructive/40 bg-destructive/10 text-destructive"
            }`}
          >
            <p className="font-semibold">
              {toastState.type === "success" ? "Conexión exitosa" : "Error de conexión"}
            </p>
            <p className="mt-1 text-muted-foreground/80 dark:text-foreground/70">{toastState.msg}</p>
          </div>
        )}

        <div className="space-y-8">
          <div className="rounded-lg border border-border bg-muted/30 p-6">
            <h2 className="mb-4 text-xl font-bold">Datos del punto de acceso</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-sm text-muted-foreground">Nombre de la red (SSID)</p>
                <p className="text-2xl font-bold text-primary">{displaySsid}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Contraseña</p>
                <p className="text-2xl font-bold">{apPassword}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">IP local de la báscula</p>
                <p className="text-lg font-mono">{effectiveApInfo.ip}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Miniweb de ajustes</p>
                <a
                  href={displayConfigUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-mono text-primary underline-offset-4 hover:underline"
                >
                  {displayConfigUrl}
                </a>
              </div>
            </div>
            <div className="mt-4 flex items-start gap-3">
              <div className="mt-1 rounded-full bg-primary/10 p-2">
                <KeyRound className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">PIN de acceso</p>
                <p
                  className={`text-2xl font-bold ${
                    miniWebPin ? "text-primary" : pinMessage ? "text-destructive" : ""
                  }`}
                >
                  {miniWebPin ?? (pinMessage ? "PIN no disponible" : "Cargando...")}
                </p>
                {pinMessage && !miniWebPin && <p className="text-sm text-destructive">{pinMessage}</p>}
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Button
              onClick={handleOpenConfig}
              variant="glow"
              size="xl"
              className="w-full text-lg"
            >
              <Wifi className="mr-2 h-6 w-6" />
              Configurar Wi-Fi
            </Button>

            <Button
              onClick={handleStartOffline}
              disabled={startingOffline}
              variant="secondary"
              size="xl"
              className="w-full text-lg"
            >
              {startingOffline ? (
                <>
                  <Loader2 className="mr-2 h-6 w-6 animate-spin" />
                  Activando...
                </>
              ) : (
                <>
                  <WifiOff className="mr-2 h-6 w-6" />
                  Modo Offline
                </>
              )}
            </Button>
          </div>

          <div className="space-y-4 rounded-lg border border-border/60 bg-muted/20 p-6">
            <h2 className="text-xl font-bold">Pasos para configurar</h2>
            <ol className="space-y-3">
              <li className="flex gap-3">
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/20 font-bold text-primary">
                  1
                </span>
                <p>
                  Conéctate a <strong>{displaySsid}</strong> desde tu dispositivo.
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
                  Abre <strong>{displayConfigUrl}</strong>
                </p>
              </li>
              <li className="flex gap-3">
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/20 font-bold text-primary">
                  4
                </span>
                <p>
                  Introduce el PIN mostrado arriba y guarda tu red doméstica. La báscula volverá al modo normal automáticamente.
                </p>
              </li>
            </ol>
            <p className="text-sm text-muted-foreground">
              También puedes abrir la misma dirección desde otro dispositivo conectado a Bascula-AP para completar la
              configuración.
            </p>
          </div>

          <div className="rounded-lg border border-primary/40 bg-primary/5 p-4">
            <div className="flex items-start gap-3">
              <WifiOff className="mt-1 h-5 w-5 text-primary" />
              <div className="space-y-1 text-sm">
                <p className="font-semibold text-primary">¿Sin conexión a Internet?</p>
                <p className="text-muted-foreground">
                  Activa el modo offline para usar la báscula sin red. Cuando tengas Internet, el sistema volverá automáticamente al modo normal.
                </p>
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
};
