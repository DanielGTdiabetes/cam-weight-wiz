import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Trash2, Calendar } from "lucide-react";
import { useWeightHistory } from "@/hooks/useWeightHistory";
import { Skeleton } from "@/components/ui/skeleton";
import { formatWeight } from "@/lib/format";
import { useScaleDecimals } from "@/hooks/useScaleDecimals";

interface WeightHistoryDialogProps {
  open: boolean;
  onClose: () => void;
}

export const WeightHistoryDialog = ({ open, onClose }: WeightHistoryDialogProps) => {
  const { history, isLoading, deleteRecord, clearHistory } = useWeightHistory();
  const decimals = useScaleDecimals();

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) {
      return `Hoy ${date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
    } else if (date.toDateString() === yesterday.toDateString()) {
      return `Ayer ${date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
    } else {
      return date.toLocaleDateString('es-ES', { 
        day: '2-digit', 
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      });
    }
  };

  const handleClearAll = () => {
    if (confirm('¿Eliminar todo el historial? Esta acción no se puede deshacer.')) {
      clearHistory();
      // Haptic feedback
      if (navigator.vibrate) {
        navigator.vibrate([50, 100, 50]);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl h-[600px] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-2xl flex items-center gap-2">
            <Calendar className="h-6 w-6" />
            Historial de Pesadas
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : history.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-center">
            <div>
              <p className="text-lg text-muted-foreground mb-2">
                No hay pesadas registradas
              </p>
              <p className="text-sm text-muted-foreground">
                Usa el botón "Guardar" en la vista de báscula para registrar pesadas
              </p>
            </div>
          </div>
        ) : (
          <>
            <ScrollArea className="flex-1 pr-4">
              <div className="space-y-2">
                {history.map((record) => (
                  <div
                    key={record.id}
                    className="flex items-center justify-between p-4 rounded-lg border border-border bg-card hover:bg-accent/50 transition-smooth"
                  >
                    <div className="flex-1">
                      <div className="flex items-baseline gap-3 mb-1">
                        <span className="text-3xl font-bold text-primary" style={{ fontFeatureSettings: '"tnum"' }}>
                          {formatWeight(record.weight, decimals)}
                        </span>
                        <span className="text-lg text-muted-foreground">
                          {record.unit}
                        </span>
                        {record.stable && (
                          <span className="text-xs bg-success/20 text-success px-2 py-1 rounded">
                            Estable
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {formatDate(record.timestamp)}
                      </p>
                      {record.note && (
                        <p className="text-sm mt-1 text-foreground/80">
                          {record.note}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        deleteRecord(record.id);
                        if (navigator.vibrate) {
                          navigator.vibrate(30);
                        }
                      }}
                      className="text-destructive hover:text-destructive/80"
                    >
                      <Trash2 className="h-5 w-5" />
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>

            <div className="border-t border-border pt-4 flex gap-2">
              <Button
                variant="outline"
                size="lg"
                onClick={onClose}
                className="flex-1"
              >
                Cerrar
              </Button>
              <Button
                variant="destructive"
                size="lg"
                onClick={handleClearAll}
                className="flex-1"
              >
                <Trash2 className="mr-2 h-5 w-5" />
                Eliminar Todo
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
