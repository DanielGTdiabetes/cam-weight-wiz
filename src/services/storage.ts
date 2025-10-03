/**
 * Local Storage Service with Versioning
 * Maneja la persistencia de configuraciones y datos locales
 */

const STORAGE_VERSION = 2;
const VERSION_KEY = 'storage_version';

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

// Migration functions for each version
const migrations: Record<number, (data: any) => any> = {
  1: (data) => {
    // v0 -> v1: Initial version
    return data;
  },
  2: (data) => {
    // v1 -> v2: Ensure all new fields exist
    if (data.settings) {
      data.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    }
    return data;
  },
};

function migrateStorage() {
  try {
    const currentVersion = parseInt(localStorage.getItem(VERSION_KEY) || '0');
    
    if (currentVersion === STORAGE_VERSION) {
      return; // Already up to date
    }

    console.log(`🔄 Migrating storage from v${currentVersion} to v${STORAGE_VERSION}`);

    let data = {
      settings: JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'),
      history: JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'),
    };

    // Apply migrations sequentially
    for (let version = currentVersion + 1; version <= STORAGE_VERSION; version++) {
      if (migrations[version]) {
        data = migrations[version](data);
        console.log(`✅ Applied migration to v${version}`);
      }
    }

    // Save migrated data
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data.settings));
    localStorage.setItem(HISTORY_KEY, JSON.stringify(data.history));
    localStorage.setItem(VERSION_KEY, STORAGE_VERSION.toString());

    console.log(`✅ Migration complete to v${STORAGE_VERSION}`);
  } catch (error) {
    console.error('❌ Storage migration failed:', error);
  }
}

class StorageService {
  constructor() {
    // Run migrations on initialization
    migrateStorage();
  }

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

  // Scanner history management
  getScannerHistory(): any[] {
    try {
      const stored = localStorage.getItem('scanner_history');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (error) {
      console.error('Error loading scanner history:', error);
    }
    return [];
  }

  saveScannerHistory(history: any[]): void {
    try {
      localStorage.setItem('scanner_history', JSON.stringify(history));
    } catch (error) {
      console.error('Error saving scanner history:', error);
    }
  }

  addScannerRecord(record: any): void {
    try {
      const history = this.getScannerHistory();
      const timestamp =
        record.timestamp instanceof Date
          ? record.timestamp.toISOString()
          : record.timestamp ?? new Date().toISOString();
      history.unshift({ ...record, timestamp });
      const trimmed = history.slice(0, MAX_HISTORY_ITEMS);
      this.saveScannerHistory(trimmed);
    } catch (error) {
      console.error('Error adding scanner record:', error);
    }
  }

  // Offline queue management
  getScannerQueue(): any[] {
    try {
      const stored = localStorage.getItem('scanner_history_queue');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (error) {
      console.error('Error loading scanner queue:', error);
    }
    return [];
  }

  enqueueScannerAction(action: any): void {
    try {
      const queue = this.getScannerQueue();
      const timestamp =
        action.timestamp instanceof Date
          ? action.timestamp.toISOString()
          : action.timestamp;
      queue.push({ ...action, timestamp, queuedAt: Date.now() });
      localStorage.setItem('scanner_history_queue', JSON.stringify(queue));
    } catch (error) {
      console.error('Error enqueuing scanner action:', error);
    }
  }

  dequeueScannerAction(): any | null {
    try {
      const queue = this.getScannerQueue();
      if (queue.length === 0) return null;
      const action = queue.shift();
      localStorage.setItem('scanner_history_queue', JSON.stringify(queue));
      return action;
    } catch (error) {
      console.error('Error dequeuing scanner action:', error);
      return null;
    }
  }

  clearScannerQueue(): void {
    try {
      localStorage.removeItem('scanner_history_queue');
    } catch (error) {
      console.error('Error clearing scanner queue:', error);
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
