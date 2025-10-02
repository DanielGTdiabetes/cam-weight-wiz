import { useState } from "react";
import { Camera, Plus, Trash2, Check, X, Barcode, Syringe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { BolusCalculator } from "@/components/BolusCalculator";
import { useScaleWebSocket } from "@/hooks/useScaleWebSocket";
import { storage } from "@/services/storage";
import { logger } from "@/services/logger";
import { api } from "@/services/api";

interface FoodItem {
  id: string;
  name: string;
  weight: number;
  carbs: number;
  proteins: number;
  fats: number;
  glycemicIndex: number;
}

export const FoodScannerView = () => {
  const { weight: scaleWeight } = useScaleWebSocket();
  const [isScanning, setIsScanning] = useState(false);
  const [foods, setFoods] = useState<FoodItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showBolusCalculator, setShowBolusCalculator] = useState(false);
  const [currentGlucose, setCurrentGlucose] = useState<number | undefined>();
  const { toast } = useToast();
  
  // Check if diabetes mode is active
  const settings = storage.getSettings();
  const isDiabetesMode = settings.diabetesMode;

  const totals = foods.reduce(
    (acc, food) => ({
      weight: acc.weight + food.weight,
      carbs: acc.carbs + food.carbs,
      proteins: acc.proteins + food.proteins,
      fats: acc.fats + food.fats,
    }),
    { weight: 0, carbs: 0, proteins: 0, fats: 0 }
  );

  const handleScan = async () => {
    if (scaleWeight === 0) {
      toast({
        title: "Coloca el alimento",
        description: "La báscula no detecta peso",
        variant: "destructive",
      });
      return;
    }

    setIsScanning(true);
    
    try {
      // TODO: Connect to backend camera + AI for real food recognition
      // For now, simulate AI analysis
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Simulated AI response
      const foodNames = [
        "Manzana Roja", "Plátano", "Pan Blanco", "Arroz Blanco",
        "Pasta", "Pollo", "Salmón", "Brócoli", "Tomate", "Lechuga"
      ];
      const randomFood = foodNames[Math.floor(Math.random() * foodNames.length)];
      
      const newFood: FoodItem = {
        id: Date.now().toString(),
        name: randomFood,
        weight: scaleWeight,
        // Simulated nutritional values based on weight
        carbs: Math.round((scaleWeight / 100) * 15),
        proteins: Math.round((scaleWeight / 100) * 3),
        fats: Math.round((scaleWeight / 100) * 0.5),
        glycemicIndex: Math.floor(Math.random() * 40) + 30,
      };
      
      setFoods([...foods, newFood]);
      
      logger.info("Food added to scanner", {
        name: newFood.name,
        weight: newFood.weight,
        carbs: newFood.carbs,
      });
      
      toast({
        title: "Alimento añadido",
        description: `${newFood.name} - ${newFood.weight}g`,
      });

      // Haptic feedback
      if (navigator.vibrate) {
        navigator.vibrate(30);
      }
    } catch (error) {
      logger.error("Failed to scan food", { error });
      toast({
        title: "Error al escanear",
        description: "Intenta de nuevo",
        variant: "destructive",
      });
    } finally {
      setIsScanning(false);
    }
  };

  const handleScanBarcode = () => {
    toast({
      title: "Escáner de código de barras",
      description: "Función en desarrollo",
    });
  };

  const handleDelete = (id: string) => {
    setFoods(foods.filter((f) => f.id !== id));
    setSelectedId(null);
    toast({ title: "Alimento eliminado" });
  };

  const handleFinish = async () => {
    logger.info("Food analysis completed", {
      totalWeight: totals.weight,
      totalCarbs: totals.carbs,
      totalProteins: totals.proteins,
      totalFats: totals.fats,
      itemCount: foods.length,
    });

    toast({
      title: "Análisis completado",
      description: `Total: ${totals.carbs.toFixed(1)}g HC, ${totals.proteins.toFixed(1)}g Proteínas, ${totals.fats.toFixed(1)}g Grasas`,
      duration: 5000,
    });

    // Show bolus calculator if diabetes mode is active and there are carbs
    if (isDiabetesMode && totals.carbs > 0) {
      // Try to get current glucose from API
      try {
        const glucoseData = await api.getGlucose();
        setCurrentGlucose(glucoseData.glucose);
      } catch {
        // If can't get glucose, continue without it
        logger.debug("Could not fetch current glucose for bolus calculator");
      }
      
      setShowBolusCalculator(true);
    }

    // Haptic feedback
    if (navigator.vibrate) {
      navigator.vibrate([50, 100, 50]);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      {/* Camera Preview */}
      <Card className="relative aspect-video overflow-hidden bg-muted">
        <div className="flex h-full items-center justify-center">
          {isScanning ? (
            <div className="text-center">
              <Camera className="mx-auto mb-4 h-16 w-16 animate-pulse text-primary" />
              <p className="text-xl font-medium">Analizando con IA...</p>
            </div>
          ) : (
            <div className="text-center text-muted-foreground">
              <Camera className="mx-auto mb-4 h-16 w-16" />
              <p className="text-lg">Posiciona el alimento</p>
              <p className="text-5xl font-bold text-primary">{scaleWeight.toFixed(0)}g</p>
            </div>
          )}
        </div>
      </Card>

      {/* Action Buttons */}
      <div className="grid grid-cols-2 gap-3">
        <Button
          onClick={handleScan}
          disabled={isScanning || scaleWeight === 0}
          size="xl"
          variant="glow"
          className="h-20 text-xl"
        >
          <Plus className="mr-2 h-6 w-6" />
          {isScanning ? "Analizando..." : "Añadir Alimento"}
        </Button>
        <Button
          onClick={handleScanBarcode}
          size="xl"
          variant="secondary"
          className="h-20 text-xl"
        >
          <Barcode className="mr-2 h-6 w-6" />
          Código Barras
        </Button>
      </div>

      {/* Food List */}
      {foods.length > 0 && (
        <Card className="flex-1 overflow-hidden">
          <div className="flex h-full flex-col">
            <div className="border-b border-border p-4">
              <h3 className="text-xl font-bold">Alimentos Escaneados</h3>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {foods.map((food) => (
                <button
                  key={food.id}
                  onClick={() => setSelectedId(food.id === selectedId ? null : food.id)}
                  className={cn(
                    "mb-2 w-full rounded-lg border p-4 text-left transition-smooth",
                    selectedId === food.id
                      ? "border-primary bg-primary/10"
                      : "border-border hover:border-primary/50"
                  )}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-lg font-bold">{food.name}</span>
                    <span className="text-xl font-bold text-primary">{food.weight}g</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-sm">
                    <div>
                      <p className="text-muted-foreground">HC</p>
                      <p className="font-semibold">{food.carbs}g</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Prot</p>
                      <p className="font-semibold">{food.proteins}g</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Grasas</p>
                      <p className="font-semibold">{food.fats}g</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">IG</p>
                      <p className="font-semibold">{food.glycemicIndex}</p>
                    </div>
                  </div>
                  {selectedId === food.id && (
                    <Button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(food.id);
                      }}
                      variant="destructive"
                      size="sm"
                      className="mt-3 w-full"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Eliminar
                    </Button>
                  )}
                </button>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* Totals */}
      {foods.length > 0 && (
        <Card className="border-primary/50 bg-primary/5">
          <div className="p-4">
            <h3 className="mb-3 text-xl font-bold">Totales</h3>
            <div className="mb-4 grid grid-cols-4 gap-4 text-center">
              <div>
                <p className="text-sm text-muted-foreground">Peso</p>
                <p className="text-2xl font-bold text-primary">{totals.weight}g</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">HC</p>
                <p className="text-2xl font-bold text-warning">{totals.carbs.toFixed(1)}g</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Proteínas</p>
                <p className="text-2xl font-bold text-secondary">{totals.proteins.toFixed(1)}g</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Grasas</p>
                <p className="text-2xl font-bold text-success">{totals.fats.toFixed(1)}g</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Button
                onClick={() => {
                  setFoods([]);
                  setSelectedId(null);
                  toast({ title: "Lista limpiada" });
                }}
                variant="outline"
                size="xl"
                className="text-xl"
              >
                <X className="mr-2 h-6 w-6" />
                Limpiar
              </Button>
              <Button
                onClick={handleFinish}
                variant="success"
                size="xl"
                className="text-xl"
              >
                <Check className="mr-2 h-6 w-6" />
                Finalizar
              </Button>
            </div>
            {isDiabetesMode && totals.carbs > 0 && (
              <Button
                onClick={async () => {
                  try {
                    const glucoseData = await api.getGlucose();
                    setCurrentGlucose(glucoseData.glucose);
                  } catch {
                    // Continue without glucose
                  }
                  setShowBolusCalculator(true);
                }}
                variant="glow"
                size="xl"
                className="w-full text-xl mt-3"
              >
                <Syringe className="mr-2 h-6 w-6" />
                Calcular Bolo de Insulina
              </Button>
            )}
          </div>
        </Card>
      )}

      {/* Bolus Calculator Dialog */}
      {showBolusCalculator && (
        <BolusCalculator
          totalCarbs={totals.carbs}
          currentGlucose={currentGlucose}
          onClose={() => {
            setShowBolusCalculator(false);
            // Optionally clear the list after calculating bolus
            setFoods([]);
          }}
        />
      )}
    </div>
  );
};
