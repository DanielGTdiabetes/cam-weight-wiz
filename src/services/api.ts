// API Service for FastAPI Backend Integration
import { apiWrapper, ApiError } from './apiWrapper';
import { storage } from './storage';
import { logger } from './logger';

export const setApiBaseUrl = (baseUrl: string) => {
  apiWrapper.updateBaseUrl(baseUrl);
};

export interface WeightData {
  weight: number;
  stable: boolean;
  unit: "g" | "ml";
}

export interface FoodAnalysis {
  name: string;
  confidence?: number;
  avg_color?: {
    r: number;
    g: number;
    b: number;
  };
  nutrition: {
    carbs: number;
    proteins: number;
    fats: number;
    glycemic_index: number;
  };
}

export interface RecipeIngredient {
  name: string;
  quantity: number | null;
  unit: string;
  needs_scale?: boolean;
}

export interface RecipeStep {
  index: number;
  instruction: string;
  needsScale: boolean;
  expectedWeight?: number;
  tip?: string;
  timer?: number;
}

export interface GeneratedRecipe {
  id: string;
  title: string;
  servings: number;
  ingredients: RecipeIngredient[];
  steps: RecipeStep[];
  estimatedTime?: number | null;
}

export interface NextRecipeStepResponse {
  step?: RecipeStep;
  isLast: boolean;
  assistantMessage?: string;
}
export interface GlucoseData {
  glucose: number;
  trend: "up" | "down" | "stable";
  timestamp: string;
}

class ApiService {
  constructor() {
    // Update API base URL from settings
    const settings = storage.getSettings();
    setApiBaseUrl(settings.apiUrl);
  }

  // Scale endpoints
  async scaleTare(): Promise<void> {
    await apiWrapper.post('/api/scale/tare');
  }

  async scaleZero(): Promise<void> {
    await apiWrapper.post('/api/scale/zero');
  }

  async setCalibrationFactor(factor: number): Promise<void> {
    await apiWrapper.post('/api/scale/calibrate', { factor });
  }

  // Food scanner endpoints
  async analyzeFood(imageBlob: Blob, weight: number): Promise<FoodAnalysis> {
    // FormData needs special handling, use native fetch
    const settings = storage.getSettings();
    const formData = new FormData();
    formData.append("image", imageBlob);
    formData.append("weight", weight.toString());

    const response = await fetch(`${settings.apiUrl}/api/scanner/analyze`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) throw new ApiError("Failed to analyze food");
    return response.json();
  }

  async scanBarcode(barcode: string): Promise<FoodAnalysis> {
    return apiWrapper.get<FoodAnalysis>(`/api/scanner/barcode/${barcode}`);
  }

  // Timer endpoints
  async startTimer(seconds: number): Promise<void> {
    await apiWrapper.post('/api/timer/start', { seconds });
  }

  async stopTimer(): Promise<void> {
    await apiWrapper.post('/api/timer/stop');
  }

  async getTimerStatus(): Promise<{ running: boolean; remaining: number }> {
    return apiWrapper.get<{ running: boolean; remaining: number }>('/api/timer/status');
  }

  // Nightscout endpoints
  async getGlucose(): Promise<GlucoseData> {
    // Check if Nightscout is configured
    const settings = storage.getSettings();
    if (!settings.nightscoutUrl) {
      throw new ApiError('Nightscout no configurado', 0, 'NOT_CONFIGURED');
    }
    return apiWrapper.get<GlucoseData>('/api/nightscout/glucose');
  }

  async exportBolus(
    carbs: number,
    insulin: number,
    timestamp: string
  ): Promise<void> {
    await apiWrapper.post('/api/nightscout/bolus', { carbs, insulin, timestamp });
  }

  // Voice/TTS endpoints
  async speak(text: string, voice?: string): Promise<void> {
    await apiWrapper.post('/api/voice/speak', { text, voice });
  }

  // Recipe endpoints
  async getRecipe(prompt: string, servings?: number): Promise<GeneratedRecipe> {
    return apiWrapper.post<GeneratedRecipe>('/api/recipes/generate', { prompt, servings });
  }

  async nextRecipeStep(
    recipeId: string,
    currentStep: number,
    userResponse?: string
  ): Promise<NextRecipeStepResponse> {
    return apiWrapper.post<NextRecipeStepResponse>('/api/recipes/next', {
      recipeId,
      currentStep,
      userResponse,
    });
  }

  // Settings endpoints
  async getSettings(): Promise<Record<string, any>> {
    return apiWrapper.get<Record<string, any>>('/api/settings');
  }

  async updateSettings(settings: Record<string, any>): Promise<void> {
    await apiWrapper.put('/api/settings', settings);
  }

  // OTA Updates
  async checkUpdates(): Promise<{ available: boolean; version?: string }> {
    return apiWrapper.get<{ available: boolean; version?: string }>('/api/updates/check');
  }

  async installUpdate(): Promise<void> {
    await apiWrapper.post('/api/updates/install');
  }
}

export const api = new ApiService();
