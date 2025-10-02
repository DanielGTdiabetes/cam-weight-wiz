/**
 * Local Storage Service
 * Maneja la persistencia de configuraciones y datos locales
 */

export interface AppSettings {
  // Scale settings
  calibrationFactor: number;
  defaultUnit: 'g' | 'ml';
  
  // API settings
  chatGptKey: string;
  apiUrl: string;
  wsUrl: string;
  
  // Nightscout settings
  nightscoutUrl: string;
  nightscoutToken: string;
  
  // Diabetes settings
  diabetesMode: boolean;
  correctionFactor: number;
  carbRatio: number;
  targetGlucose: number;
  hypoAlarm: number;
  hyperAlarm: number;
  
  // UI settings
  isVoiceActive: boolean;
  theme: 'dark' | 'light';
}

export interface WeightRecord {
  id: string;
  weight: number;
  unit: 'g' | 'ml';
  stable: boolean;
  timestamp: number;
  note?: string;
}

const SETTINGS_KEY = 'bascula_settings';
const HISTORY_KEY = 'bascula_history';
const MAX_HISTORY_ITEMS = 100;

// Default settings
const DEFAULT_SETTINGS: AppSettings = {
  calibrationFactor: 1,
  defaultUnit: 'g',
  chatGptKey: '',
  apiUrl: 'http://localhost:8080',
  wsUrl: 'ws://localhost:8080',
  nightscoutUrl: '',
  nightscoutToken: '',
  diabetesMode: false,
  correctionFactor: 50,
  carbRatio: 10,
  targetGlucose: 100,
  hypoAlarm: 70,
  hyperAlarm: 180,
  isVoiceActive: false,
  theme: 'dark',
};

class StorageService {
  // Settings management
  getSettings(): AppSettings {
    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Merge with defaults to handle new settings
        return { ...DEFAULT_SETTINGS, ...parsed };
      }
    } catch (error) {
      console.error('Error loading settings:', error);
    }
    return DEFAULT_SETTINGS;
  }

  saveSettings(settings: Partial<AppSettings>): void {
    try {
      const current = this.getSettings();
      const updated = { ...current, ...settings };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
    } catch (error) {
      console.error('Error saving settings:', error);
    }
  }

  resetSettings(): void {
    try {
      localStorage.removeItem(SETTINGS_KEY);
    } catch (error) {
      console.error('Error resetting settings:', error);
    }
  }

  // Weight history management
  getWeightHistory(): WeightRecord[] {
    try {
      const stored = localStorage.getItem(HISTORY_KEY);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (error) {
      console.error('Error loading history:', error);
    }
    return [];
  }

  addWeightRecord(weight: number, unit: 'g' | 'ml', stable: boolean, note?: string): void {
    try {
      const history = this.getWeightHistory();
      const record: WeightRecord = {
        id: Date.now().toString(),
        weight,
        unit,
        stable,
        timestamp: Date.now(),
        note,
      };
      
      // Add to beginning and limit size
      history.unshift(record);
      const trimmed = history.slice(0, MAX_HISTORY_ITEMS);
      
      localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
    } catch (error) {
      console.error('Error saving weight record:', error);
    }
  }

  deleteWeightRecord(id: string): void {
    try {
      const history = this.getWeightHistory();
      const filtered = history.filter(record => record.id !== id);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(filtered));
    } catch (error) {
      console.error('Error deleting weight record:', error);
    }
  }

  clearWeightHistory(): void {
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch (error) {
      console.error('Error clearing history:', error);
    }
  }

  // Export/Import data
  exportData(): string {
    const data = {
      settings: this.getSettings(),
      history: this.getWeightHistory(),
      exportDate: new Date().toISOString(),
    };
    return JSON.stringify(data, null, 2);
  }

  importData(jsonString: string): boolean {
    try {
      const data = JSON.parse(jsonString);
      
      if (data.settings) {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(data.settings));
      }
      
      if (data.history) {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(data.history));
      }
      
      return true;
    } catch (error) {
      console.error('Error importing data:', error);
      return false;
    }
  }
}

export const storage = new StorageService();
