import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Check for service worker update failures
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    const payload = event?.data ?? {};

    if (payload.type === "UPDATE_FAILED") {
      console.error("Service Worker update failed:", payload.error);
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("recovery_mode", "true");
        localStorage.setItem(
          "update_error",
          JSON.stringify({
            error: payload.error,
            timestamp: new Date().toISOString(),
          })
        );
      }
      // Reload to trigger recovery mode
      if (typeof window !== "undefined") {
        window.location.reload();
      }
    } else if (payload.type === "UPDATE_SUCCESS") {
      console.log("Service Worker updated successfully:", payload.version);
      // Clear any recovery flags
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem("recovery_mode");
        localStorage.removeItem("update_error");
      }
    }
  });

  if (typeof caches !== "undefined") {
    // Check if there's a pending recovery flag from service worker cache
    caches
      .open("recovery-cache")
      .then((cache) =>
        cache.match("/recovery-flag").then((response) => {
          if (!response) {
            return;
          }

          return response
            .json()
            .then((data) => {
              if (data?.failed && typeof localStorage !== "undefined") {
                localStorage.setItem("recovery_mode", "true");
                if (typeof window !== "undefined") {
                  window.location.reload();
                }
              }
            })
            .catch((error) => {
              console.error("Failed to parse recovery flag", error);
            });
        })
      )
      .catch((error) => {
        console.error("Failed to check recovery cache", error);
      });
  }
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
