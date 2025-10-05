// API Service for FastAPI Backend Integration
import { apiWrapper, ApiError } from './apiWrapper';
import { storage, type AppSettings } from './storage';
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

export interface VoiceInfo {
  id: string;
  name?: string;
  engine: string;
}

export interface VoiceListResponse {
  voices: VoiceInfo[];
  defaultVoice?: string;
  engine: string;
}

export interface VoiceTranscriptionResult {
  ok: boolean;
  transcript: string | null;
  reason?: string;
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

  async analyzeFoodPhoto(imageBase64: string): Promise<{
    name: string;
    carbsPer100g: number;
    proteinsPer100g?: number;
    fatsPer100g?: number;
    kcalPer100g?: number;
    glycemicIndex?: number;
    confidence: number;
  } | null> {
    try {
      const response = await apiWrapper.post<{
        name: string;
        carbsPer100g: number;
        proteinsPer100g?: number;
        fatsPer100g?: number;
        kcalPer100g?: number;
        glycemicIndex?: number;
        confidence: number;
      }>('/api/scanner/analyze-photo', {
        image: imageBase64,
      });

      if (response.confidence < 0.7) {
        return null;
      }

      return response;
    } catch (error) {
      logger.error('Photo analysis failed:', error);
      return null;
    }
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
  async getVoices(): Promise<VoiceListResponse> {
    const response = await apiWrapper.get<{
      ok?: boolean;
      engine?: string;
      voices?: VoiceInfo[];
      default_voice?: string;
    }>('/api/voice/tts/voices');

    const engine = response.engine ?? 'unknown';
    const voices = (response.voices ?? []).map((voice) => ({
      id: voice.id,
      name: voice.name ?? voice.id,
      engine: voice.engine ?? engine,
    }));

    return {
      voices,
      defaultVoice: response.default_voice ?? voices[0]?.id,
      engine,
    };
  }

  async synthesizeVoice(text: string, voice?: string): Promise<ArrayBuffer> {
    const settings = storage.getSettings();
    const params = new URLSearchParams({ text });
    if (voice) {
      params.append('voice', voice);
    }

    const response = await fetch(`${settings.apiUrl}/api/voice/tts/synthesize?${params.toString()}`, {
      method: 'POST',
    });

    if (!response.ok) {
      throw new ApiError('No se pudo sintetizar la voz', response.status);
    }

    return await response.arrayBuffer();
  }

  async say(text: string, voice?: string, playLocal = true): Promise<void> {
    const settings = storage.getSettings();
    const params = new URLSearchParams({
      text,
      play_local: playLocal ? 'true' : 'false',
    });
    if (voice) {
      params.append('voice', voice);
    }

    const response = await fetch(`${settings.apiUrl}/api/voice/tts/say?${params.toString()}`, {
      method: 'POST',
    });

    if (!response.ok) {
      throw new ApiError('No se pudo reproducir el audio', response.status);
    }

    // Leer el cuerpo para completar la solicitud aunque no lo usemos.
    await response.arrayBuffer();
  }

  async uploadVoiceClip(blob: Blob, filename: string): Promise<void> {
    const settings = storage.getSettings();
    const formData = new FormData();
    formData.append('file', blob, filename);

    const response = await fetch(`${settings.apiUrl}/api/voice/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new ApiError('No se pudo guardar el clip de voz', response.status);
    }
  }

  async transcribeVoice(blob: Blob): Promise<VoiceTranscriptionResult> {
    const settings = storage.getSettings();
    const formData = new FormData();
    formData.append('file', blob, 'recording.webm');

    const response = await fetch(`${settings.apiUrl}/api/voice/transcribe`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new ApiError('No se pudo transcribir el audio', response.status);
    }

    return await response.json();
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
  async getSettings(): Promise<AppSettings> {
    return apiWrapper.get<AppSettings>('/api/settings');
  }

  async updateSettings(settings: Partial<AppSettings>): Promise<void> {
    await apiWrapper.put('/api/settings', settings);
  }

  // OTA Updates
  async checkUpdates(): Promise<{ available: boolean; version?: string }> {
    return apiWrapper.get<{ available: boolean; version?: string }>('/api/updates/check');
  }

  async installUpdate(): Promise<void> {
    await apiWrapper.post('/api/updates/install');
  }

  // Network endpoints
  async getNetworkStatus(): Promise<{ ip: string; ssid?: string }> {
    return apiWrapper.get<{ ip: string; ssid?: string }>('/api/network/status');
  }
}

export const api = new ApiService();
