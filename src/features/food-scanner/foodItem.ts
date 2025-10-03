import type { FoodAnalysis } from "@/services/api";

export type FoodSource = "camera" | "barcode";

export interface FoodColor {
  r: number;
  g: number;
  b: number;
}

export interface FoodItem {
  id: string;
  name: string;
  weight: number;
  carbs: number;
  proteins: number;
  fats: number;
  glycemicIndex: number;
  confidence?: number;
  source: FoodSource;
  capturedAt: number;
  avgColor?: FoodColor;
}

export interface BarcodeScannerSnapshot {
  name: string;
  weight: number;
  carbs: number;
  proteins: number;
  fats: number;
  glycemicIndex: number;
  confidence?: number;
  avgColor?: FoodColor;
}

export interface BarcodeScannerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appendFood: (food: BarcodeScannerSnapshot) => void;
}

export const roundMacro = (value: number): number => Number(value.toFixed(2));

const mapColor = (analysis: FoodAnalysis): FoodColor | undefined =>
  analysis.avg_color
    ? {
        r: analysis.avg_color.r,
        g: analysis.avg_color.g,
        b: analysis.avg_color.b,
      }
    : undefined;

const ensureNutrition = (analysis: FoodAnalysis) =>
  analysis.nutrition ?? { carbs: 0, proteins: 0, fats: 0, glycemic_index: 0 };

export const createScannerSnapshot = (
  analysis: FoodAnalysis,
  weight: number
): BarcodeScannerSnapshot => {
  const nutrition = ensureNutrition(analysis);

  return {
    name: analysis.name || "Alimento sin nombre",
    weight,
    carbs: roundMacro((nutrition.carbs ?? 0)),
    proteins: roundMacro((nutrition.proteins ?? 0)),
    fats: roundMacro((nutrition.fats ?? 0)),
    glycemicIndex: Math.round(nutrition.glycemic_index ?? 0),
    confidence: analysis.confidence,
    avgColor: mapColor(analysis),
  };
};

export const toFoodItem = (
  snapshot: BarcodeScannerSnapshot,
  source: FoodSource
): FoodItem => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  name: snapshot.name,
  weight: snapshot.weight,
  carbs: snapshot.carbs,
  proteins: snapshot.proteins,
  fats: snapshot.fats,
  glycemicIndex: snapshot.glycemicIndex,
  confidence: snapshot.confidence,
  source,
  capturedAt: Date.now(),
  avgColor: snapshot.avgColor,
});

export const buildFoodItem = (
  analysis: FoodAnalysis,
  weight: number,
  source: FoodSource
): FoodItem => toFoodItem(createScannerSnapshot(analysis, weight), source);

export const scaleNutritionByFactor = (
  analysis: FoodAnalysis,
  factor: number
): FoodAnalysis => {
  const nutrition = ensureNutrition(analysis);

  return {
    ...analysis,
    nutrition: {
      carbs: roundMacro((nutrition.carbs ?? 0) * factor),
      proteins: roundMacro((nutrition.proteins ?? 0) * factor),
      fats: roundMacro((nutrition.fats ?? 0) * factor),
      glycemic_index: nutrition.glycemic_index ?? 0,
    },
  };
};
