// API Service for FastAPI Backend Integration

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

export interface WeightData {
  weight: number;
  stable: boolean;
  unit: "g" | "ml";
}

export interface FoodAnalysis {
  name: string;
  confidence: number;
  nutrition: {
    carbs: number;
    proteins: number;
    fats: number;
    glycemic_index: number;
  };
}

export interface GlucoseData {
  glucose: number;
  trend: "up" | "down" | "stable";
  timestamp: string;
}

class ApiService {
  // Scale endpoints
  async scaleTare(): Promise<void> {
    const response = await fetch(`${API_URL}/api/scale/tare`, {
      method: "POST",
    });
    if (!response.ok) throw new Error("Failed to tare scale");
  }

  async scaleZero(): Promise<void> {
    const response = await fetch(`${API_URL}/api/scale/zero`, {
      method: "POST",
    });
    if (!response.ok) throw new Error("Failed to zero scale");
  }

  async setCalibrationFactor(factor: number): Promise<void> {
    const response = await fetch(`${API_URL}/api/scale/calibrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ factor }),
    });
    if (!response.ok) throw new Error("Failed to set calibration");
  }

  // Food scanner endpoints
  async analyzeFood(imageBlob: Blob, weight: number): Promise<FoodAnalysis> {
    const formData = new FormData();
    formData.append("image", imageBlob);
    formData.append("weight", weight.toString());

    const response = await fetch(`${API_URL}/api/scanner/analyze`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) throw new Error("Failed to analyze food");
    return response.json();
  }

  async scanBarcode(barcode: string): Promise<FoodAnalysis> {
    const response = await fetch(`${API_URL}/api/scanner/barcode/${barcode}`);
    if (!response.ok) throw new Error("Failed to scan barcode");
    return response.json();
  }

  // Timer endpoints
  async startTimer(seconds: number): Promise<void> {
    const response = await fetch(`${API_URL}/api/timer/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seconds }),
    });
    if (!response.ok) throw new Error("Failed to start timer");
  }

  async stopTimer(): Promise<void> {
    const response = await fetch(`${API_URL}/api/timer/stop`, {
      method: "POST",
    });
    if (!response.ok) throw new Error("Failed to stop timer");
  }

  async getTimerStatus(): Promise<{ running: boolean; remaining: number }> {
    const response = await fetch(`${API_URL}/api/timer/status`);
    if (!response.ok) throw new Error("Failed to get timer status");
    return response.json();
  }

  // Nightscout endpoints
  async getGlucose(): Promise<GlucoseData> {
    const response = await fetch(`${API_URL}/api/nightscout/glucose`);
    if (!response.ok) throw new Error("Failed to get glucose data");
    return response.json();
  }

  async exportBolus(
    carbs: number,
    insulin: number,
    timestamp: string
  ): Promise<void> {
    const response = await fetch(`${API_URL}/api/nightscout/bolus`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ carbs, insulin, timestamp }),
    });
    if (!response.ok) throw new Error("Failed to export to Nightscout");
  }

  // Voice/TTS endpoints
  async speak(text: string, voice?: string): Promise<void> {
    const response = await fetch(`${API_URL}/api/voice/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });
    if (!response.ok) throw new Error("Failed to speak");
  }

  // Recipe endpoints
  async getRecipe(prompt: string): Promise<{ steps: string[] }> {
    const response = await fetch(`${API_URL}/api/recipes/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!response.ok) throw new Error("Failed to get recipe");
    return response.json();
  }

  async nextRecipeStep(
    currentStep: number,
    userResponse?: string
  ): Promise<{ step: string; needsScale: boolean }> {
    const response = await fetch(`${API_URL}/api/recipes/next`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentStep, userResponse }),
    });
    if (!response.ok) throw new Error("Failed to get next step");
    return response.json();
  }

  // Settings endpoints
  async getSettings(): Promise<Record<string, any>> {
    const response = await fetch(`${API_URL}/api/settings`);
    if (!response.ok) throw new Error("Failed to get settings");
    return response.json();
  }

  async updateSettings(settings: Record<string, any>): Promise<void> {
    const response = await fetch(`${API_URL}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    if (!response.ok) throw new Error("Failed to update settings");
  }

  // OTA Updates
  async checkUpdates(): Promise<{ available: boolean; version?: string }> {
    const response = await fetch(`${API_URL}/api/updates/check`);
    if (!response.ok) throw new Error("Failed to check updates");
    return response.json();
  }

  async installUpdate(): Promise<void> {
    const response = await fetch(`${API_URL}/api/updates/install`, {
      method: "POST",
    });
    if (!response.ok) throw new Error("Failed to install update");
  }
}

export const api = new ApiService();
