import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Check for service worker update failures
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data.type === "UPDATE_FAILED") {
      console.error("Service Worker update failed:", event.data.error);
      localStorage.setItem("recovery_mode", "true");
      localStorage.setItem(
        "update_error",
        JSON.stringify({
          error: event.data.error,
          timestamp: new Date().toISOString(),
        })
      );
      // Reload to trigger recovery mode
      window.location.reload();
    } else if (event.data.type === "UPDATE_SUCCESS") {
      console.log("Service Worker updated successfully:", event.data.version);
      // Clear any recovery flags
      localStorage.removeItem("recovery_mode");
      localStorage.removeItem("update_error");
    }
  });

  // Check if there's a pending recovery flag from service worker cache
  caches.open("recovery-cache").then((cache) => {
    cache.match("/recovery-flag").then((response) => {
      if (response) {
        response.json().then((data) => {
          if (data.failed) {
            localStorage.setItem("recovery_mode", "true");
            window.location.reload();
          }
        });
      }
    });
  });
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
