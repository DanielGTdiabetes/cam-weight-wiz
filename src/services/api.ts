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

export interface OtaJobState {
  status: "idle" | "running" | "success" | "error";
  started_at: number;
  finished_at: number;
  current: string;
  target: string;
  message: string;
  progress: number;
}

export interface WakeIntent {
  kind:
    | "timer"
    | "weight_status"
    | "tare"
    | "recipe_start"
    | "calibrate"
    | "smalltalk";
  seconds?: number;
  name?: string;
}

export interface WakeStatus {
  enabled: boolean;
  running: boolean;
  last_wake_ts?: string | null;
  wake_count?: number;
  intent_count?: number;
  errors?: string[];
  backend?: string | null;
}

export interface WakeEvent {
  type: "wake" | "intent";
  ts: number;
  text?: string;
  intent?: WakeIntent;
  simulated?: boolean;
}

export type MiniwebStatus = {
  ok: boolean;
  mode: "ap" | "kiosk";
  wifi: {
    connected: boolean;
    ssid?: string | null;
    ip?: string | null;
  };
  ap_active?: boolean;
  connectivity?: string;
  ssid?: string | null;
  ip?: string | null;
  ip_address?: string | null;
} & Record<string, unknown>;

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

  async getScaleWeight(): Promise<{ value: number | null; ts: string | null }> {
    return apiWrapper.get<{ value: number | null; ts: string | null }>('/api/scale/weight');
  }

  async setCalibrationFactor(factor: number): Promise<void> {
    await apiWrapper.post('/api/scale/calibrate', { factor });
  }

  async applyCalibration(
    referenceGrams: number
  ): Promise<{ ok: boolean; message?: string; calibration_factor?: number }> {
    return apiWrapper.post<{ ok: boolean; message?: string; calibration_factor?: number }>(
      '/api/scale/calibrate/apply',
      { reference_grams: referenceGrams }
    );
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
  async speak(text: string, voice?: string): Promise<void> {
    const payload = voice ? { text, voice } : { text };

    try {
      await apiWrapper.post('/api/voice/speak', payload);
    } catch {
      const params = new URLSearchParams({ text });
      if (voice) {
        params.set('voice', voice);
      }

      await apiWrapper.post(`/api/voice/tts/say?${params.toString()}`);
    }
  }

  async getWakeStatus(): Promise<WakeStatus> {
    return apiWrapper.get<WakeStatus>('/api/voice/wake/status');
  }

  async enableWake(): Promise<void> {
    await apiWrapper.post('/api/voice/wake/enable');
  }

  async disableWake(): Promise<void> {
    await apiWrapper.post('/api/voice/wake/disable');
  }

  async simulateWake(text: string): Promise<WakeEvent> {
    return apiWrapper.post<WakeEvent>('/api/voice/wake/simulate', { text });
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
  async getOtaStatus(): Promise<{ current: string; latest: string; hasUpdate: boolean }> {
    const response = await apiWrapper.get<{
      available?: boolean;
      version?: string;
      error?: string;
    }>('/api/updates/check');

    if (response.error) {
      throw new ApiError(response.error, 0, 'OTA_CHECK_ERROR');
    }

    let otaState: OtaJobState | null = null;
    try {
      otaState = await this.getOtaJobStatus();
    } catch (error) {
      logger.warn('No se pudo obtener el estado OTA actual', { error });
    }

    const normalizeVersion = (value?: string) => {
      if (!value) {
        return '';
      }

      const trimmed = value.trim();
      if (!trimmed || trimmed.toLowerCase() === 'unknown') {
        return '';
      }

      return trimmed;
    };

    const currentVersion = normalizeVersion(otaState?.current);
    const targetVersion = normalizeVersion(otaState?.target);
    const latestVersionFromResponse = normalizeVersion(response.version);

    const latestVersion = latestVersionFromResponse || targetVersion || currentVersion;
    const hasUpdate = Boolean(response.available && latestVersionFromResponse && latestVersionFromResponse !== currentVersion);

    return {
      current: currentVersion,
      latest: latestVersion,
      hasUpdate,
    };
  }

  async getOtaJobStatus(): Promise<OtaJobState> {
    return apiWrapper.get<OtaJobState>('/api/ota/status');
  }

  async applyOtaUpdate(target?: string): Promise<{ ok: boolean; job: string }> {
    const body = target ? { target } : {};
    return apiWrapper.post<{ ok: boolean; job: string }>('/api/ota/apply', body);
  }

  async getOtaLogs(lines = 400): Promise<string> {
    const fallbackOrigin = typeof window !== 'undefined' ? window.location.origin : '';
    const baseCandidate = apiWrapper.getBaseUrl() || storage.getSettings().apiUrl || fallbackOrigin;
    const baseUrl = baseCandidate.replace(/\/+$/, '');
    const url = `${baseUrl}/api/ota/logs?lines=${Math.max(1, lines)}`;

    try {
      const response = await fetch(url, { method: 'GET', cache: 'no-store' });
      if (!response.ok) {
        throw new ApiError(`HTTP ${response.status}`, response.status);
      }
      const text = await response.text();
      logger.debug('OTA logs descargados', { lines });
      return text;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      logger.warn('No se pudieron descargar los logs OTA', { error });
      throw new ApiError('No se pudieron obtener los logs OTA', 0, 'NETWORK_ERROR');
    }
  }

  // Network endpoints
  async getNetworkStatus(): Promise<{ ip: string; ssid?: string }> {
    return apiWrapper.get<{ ip: string; ssid?: string }>('/api/network/status');
  }

  async miniwebStatus(): Promise<MiniwebStatus> {
    return apiWrapper.get<MiniwebStatus>('/api/miniweb/status');
  }
}

export const api = new ApiService();
