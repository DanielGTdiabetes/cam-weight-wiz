import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildFoodItem,
  createScannerSnapshot,
  scaleNutritionByFactor,
  toFoodItem,
  type BarcodeScannerSnapshot,
} from "@/features/food-scanner/foodItem";
import type { FoodAnalysis } from "@/services/api";

const baseAnalysis: FoodAnalysis = {
  name: "Manzana",
  confidence: 0.82,
  avg_color: { r: 120, g: 85, b: 60 },
  nutrition: {
    carbs: 12.3456,
    proteins: 0.6789,
    fats: 0.1234,
    glycemic_index: 44.2,
  },
};

describe("food scanner contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.123456789);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("creates a snapshot with all macro nutrients", () => {
    const snapshot = createScannerSnapshot(baseAnalysis, 150);

    expect(snapshot).toEqual<BarcodeScannerSnapshot>({
      name: "Manzana",
      weight: 150,
      carbs: 12.35,
      proteins: 0.68,
      fats: 0.12,
      glycemicIndex: 44,
      kcal: 53.21,
      confidence: 0.82,
      avgColor: { r: 120, g: 85, b: 60 },
      timestamp: new Date("2024-01-01T00:00:00.000Z"),
    });
  });

  it("converts a snapshot into a FoodItem ready for appendFood", () => {
    const snapshot: BarcodeScannerSnapshot = {
      name: "Yogur natural",
      weight: 80,
      carbs: 10.1,
      proteins: 5.25,
      fats: 3.4,
      glycemicIndex: 30,
      confidence: 0.91,
      avgColor: { r: 200, g: 210, b: 220 },
      timestamp: new Date("2024-01-01T00:00:00.000Z"),
      photo: "data:image/png;base64,photo",
    };

    const item = toFoodItem(snapshot, "barcode");

    expect(item).toEqual({
      id: "1704067200000-4fzzzxjylrx",
      name: "Yogur natural",
      weight: 80,
      carbs: 10.1,
      proteins: 5.25,
      fats: 3.4,
      glycemicIndex: 30,
      confidence: 0.91,
      source: "barcode",
      capturedAt: 1704067200000,
      avgColor: { r: 200, g: 210, b: 220 },
      photo: "data:image/png;base64,photo",
    });
  });

  it("builds a FoodItem from analysis while preserving rounded macros", () => {
    const item = buildFoodItem(baseAnalysis, 200, "camera");

    expect(item.weight).toBe(200);
    expect(item.carbs).toBe(12.35);
    expect(item.proteins).toBe(0.68);
    expect(item.fats).toBe(0.12);
    expect(item.glycemicIndex).toBe(44);
    expect(item.kcal).toBe(53.21);
    expect(item.source).toBe("camera");
  });

  it("scales barcode nutrition before creating the snapshot", () => {
    const normalized = scaleNutritionByFactor(baseAnalysis, 2);
    const snapshot = createScannerSnapshot(normalized, 200);

    expect(snapshot.carbs).toBe(24.69);
    expect(snapshot.proteins).toBe(1.36);
    expect(snapshot.fats).toBe(0.25);
    expect(snapshot.glycemicIndex).toBe(44);
    expect(snapshot.kcal).toBe(106.45);
  });
});
