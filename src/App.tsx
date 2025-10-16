import { useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Index from "./pages/Index";
import OfflineMode from "./pages/OfflineMode";
import NotFound from "./pages/NotFound";
import { MiniWebConfig } from "./pages/MiniWebConfig";
import { APModeScreen } from "@/components/APModeScreen";
import { FoodScannerView } from "./pages/FoodScannerView";
import { useSettingsSync } from "@/hooks/useSettingsSync";
import { api } from "@/services/api";
import { storage } from "@/services/storage";
import { buildAppSettingsUpdateFromBackend } from "@/lib/backendSettings";
import { logger } from "@/services/logger";

const queryClient = new QueryClient();

const App = () => {
  useSettingsSync();

  useEffect(() => {
    let cancelled = false;

    const loadBackendSettings = async () => {
      try {
        const payload = await api.fetchBackendSettings();
        if (cancelled) {
          return;
        }
        const updates = buildAppSettingsUpdateFromBackend(
          payload as Record<string, unknown>,
        );
        if (Object.keys(updates).length > 0) {
          storage.saveSettings(updates);
        }
      } catch (error) {
        logger.debug("[App] Unable to preload backend settings", { error });
      }
    };

    void loadBackendSettings();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter
          future={{
            v7_startTransition: true,
            v7_relativeSplatPath: true,
          }}
        >
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/scanner" element={<FoodScannerView />} />
            <Route path="/ap" element={<APModeScreen />} />
            <Route path="/config" element={<MiniWebConfig />} />
            <Route path="/offline" element={<OfflineMode />} />
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
