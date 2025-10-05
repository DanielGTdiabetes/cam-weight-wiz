import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { ErrorBoundary } from "./components/ErrorBoundary";

declare global {
  interface WindowEventMap {
    "app:bootstrap-error": CustomEvent<{ message: string }>;
  }
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("No se encontró el elemento raíz para montar la aplicación");
}

const root = createRoot(rootElement);

type BootstrapState =
  | {
      status: "loading";
      attempt: number;
      totalAttempts: number;
      onRetry: () => void;
    }
  | {
      status: "error";
      attempt: number;
      totalAttempts: number;
      message: string;
      onRetry: () => void;
    };

const retryDelays = [0, 500, 1000, 2000];
const isDevelopment = import.meta.env.DEV;

const notifyBootstrapError = (message: string) => {
  const fallbackMessage =
    message ||
    "No se pudo contactar con el backend. La aplicación se iniciará en modo sin conexión.";

  window.dispatchEvent(
    new CustomEvent("app:bootstrap-error", {
      detail: { message: fallbackMessage },
    })
  );
};

const BootstrapFallback = (props: BootstrapState) => {
  const { status, attempt, totalAttempts, onRetry } = props;
  const attemptLabel = `Intento ${attempt} de ${totalAttempts}`;
  const errorMessage = status === "error" ? props.message : undefined;
  const description =
    status === "loading"
      ? "Conectando con el backend…"
      : errorMessage || "No se pudo contactar con el backend. Verifica la conexión y vuelve a intentarlo.";

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">Preparando la báscula…</h1>
          <p className="text-muted-foreground">{description}</p>
          <p className="text-sm text-muted-foreground/80">{attemptLabel}</p>
        </div>
        {status === "loading" ? (
          <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-primary/40 border-t-primary" />
        ) : (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-base font-semibold text-primary-foreground shadow-md transition hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Reintentar
          </button>
        )}
      </div>
    </div>
  );
};

const renderFallback = (state: BootstrapState) => {
  root.render(
    <BootstrapFallback {...state} />
  );
};

const renderApp = () => {
  root.render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
};

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const checkBackendReachable = async (): Promise<void> => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch("/api/miniweb/status", {
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Estado HTTP ${response.status}`);
    }

    const body = await response.json().catch(() => null);
    if (body === null || typeof body !== "object") {
      throw new Error("Respuesta inesperada del backend");
    }
  } finally {
    window.clearTimeout(timeout);
  }
};

async function bootstrap() {
  if (isDevelopment) {
    renderApp();
    return;
  }

  const totalAttempts = retryDelays.length;
  let lastError = "";

  for (let index = 0; index < totalAttempts; index += 1) {
    const attempt = index + 1;
    const delay = retryDelays[index];

    renderFallback({ status: "loading", attempt, totalAttempts, onRetry: bootstrap });

    if (delay > 0) {
      await wait(delay);
    }

    try {
      await checkBackendReachable();
      renderApp();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  notifyBootstrapError(lastError);
  renderApp();
}

void bootstrap();
