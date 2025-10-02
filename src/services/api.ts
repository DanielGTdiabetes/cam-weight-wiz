// API Service for FastAPI Backend Integration
import { apiWrapper, ApiError } from './apiWrapper';
import { storage } from './storage';
import { logger } from './logger';

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
  constructor() {
    // Update API base URL from settings
    const settings = storage.getSettings();
    apiWrapper.updateBaseUrl(settings.apiUrl);
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
  async getRecipe(prompt: string): Promise<{ steps: string[] }> {
    return apiWrapper.post<{ steps: string[] }>('/api/recipes/generate', { prompt });
  }

  async nextRecipeStep(
    currentStep: number,
    userResponse?: string
  ): Promise<{ step: string; needsScale: boolean }> {
    return apiWrapper.post<{ step: string; needsScale: boolean }>(
      '/api/recipes/next',
      { currentStep, userResponse }
    );
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
