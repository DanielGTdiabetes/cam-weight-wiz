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
import { ScannerView } from "./pages/ScannerView";

const queryClient = new QueryClient();

const App = () => (
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
          <Route path="/scanner" element={<ScannerView />} />
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

export default App;
