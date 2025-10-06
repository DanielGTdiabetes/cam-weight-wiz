/**
 * Local Storage Service with Versioning
 * Maneja la persistencia de configuraciones y datos locales
 */

const STORAGE_VERSION = 3;
const VERSION_KEY = 'storage_version';

const parseJson = <T>(value: string | null): T | undefined => {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.error('Failed to parse JSON from storage:', error);
    return undefined;
  }
};

export type FeatureFlagKey =
  | 'navSafeExit'
  | 'voiceSelector'
  | 'timerAlarms'
  | 'calibrationV2'
  | 'networkModal'
  | 'miniEbStable'
  | 'otaCheck'
  | 'otaApply'
  | 'debugLogs';

export type FeatureFlags = Record<FeatureFlagKey, boolean>;

export interface UiSettings {
  flags: FeatureFlags;
}

export interface AppSettings {
  // Scale settings
  calibrationFactor: number;
  defaultUnit: 'g' | 'ml';
  decimals: number;
  
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
  voiceId?: string;
  wakeWordEnabled: boolean;
  theme: 'dark' | 'light';
  timerAlarmSoundEnabled: boolean;
  timerVoiceAnnouncementsEnabled: boolean;
  uiVolume: number;
  ui: UiSettings;
}

export type AppSettingsUpdate = Partial<Omit<AppSettings, 'ui'>> & {
  ui?: {
    flags?: Partial<FeatureFlags>;
  };
};

export interface WeightRecord {
  id: string;
  weight: number;
  unit: 'g' | 'ml';
  stable: boolean;
  timestamp: number;
  note?: string;
}

export type ScannerSource = 'barcode' | 'ai' | 'manual';

export interface ScannerHistoryEntry {
  name: string;
  weight: number;
  carbs: number;
  proteins: number;
  fats: number;
  glycemicIndex: number;
  carbsPer100g: number;
  proteinsPer100g: number;
  fatsPer100g: number;
  kcalPer100g: number;
  kcal?: number;
  confidence?: number;
  source: ScannerSource;
  portionWeight?: number;
  photo?: string;
  timestamp: string;
  id?: string;
  capturedAt?: string;
}

export type ScannerRecordInput = Omit<ScannerHistoryEntry, 'timestamp'> & {
  timestamp?: string | Date;
};

export interface ScannerQueueAction {
  type: 'exportBolus';
  carbs: number;
  insulin?: number;
  timestamp: string | Date;
}

interface QueuedScannerAction extends ScannerQueueAction {
  queuedAt: number;
}

interface StorageMigrationData {
  settings?: AppSettingsUpdate;
  history?: WeightRecord[];
}

const isScannerSource = (value: unknown): value is ScannerSource =>
  value === 'barcode' || value === 'ai' || value === 'manual';

const normaliseScannerSource = (value: unknown): ScannerSource => {
  if (isScannerSource(value)) {
    return value;
  }

  if (value === 'camera') {
    return 'ai';
  }

  return 'manual';
};

const isScannerHistoryEntry = (value: unknown): value is ScannerHistoryEntry => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === 'string' &&
    typeof entry.timestamp === 'string' &&
    typeof entry.carbs === 'number' &&
    typeof entry.weight === 'number' &&
    typeof entry.carbsPer100g === 'number' &&
    typeof entry.proteinsPer100g === 'number' &&
    typeof entry.fatsPer100g === 'number' &&
    typeof entry.kcalPer100g === 'number' &&
    isScannerSource(entry.source)
  );
};

const toScannerHistoryEntry = (value: unknown): ScannerHistoryEntry | null => {
  if (isScannerHistoryEntry(value)) {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const entry = value as Record<string, unknown>;

  const name = typeof entry.name === 'string' ? entry.name : undefined;
  const weight = typeof entry.weight === 'number' ? entry.weight : undefined;
  const carbs = typeof entry.carbs === 'number' ? entry.carbs : undefined;

  if (!name || typeof weight !== 'number' || typeof carbs !== 'number') {
    return null;
  }

  const proteins = typeof entry.proteins === 'number' ? entry.proteins : 0;
  const fats = typeof entry.fats === 'number' ? entry.fats : 0;
  const glycemicIndex = typeof entry.glycemicIndex === 'number' ? entry.glycemicIndex : 0;

  const referenceWeight = weight > 0
    ? weight
    : typeof entry.portionWeight === 'number' && entry.portionWeight > 0
      ? entry.portionWeight
      : 100;

  const carbsPer100g = typeof entry.carbsPer100g === 'number'
    ? entry.carbsPer100g
    : (carbs / referenceWeight) * 100;

  const proteinsPer100g = typeof entry.proteinsPer100g === 'number'
    ? entry.proteinsPer100g
    : (proteins / referenceWeight) * 100;

  const fatsPer100g = typeof entry.fatsPer100g === 'number'
    ? entry.fatsPer100g
    : (fats / referenceWeight) * 100;

  const kcalPer100g = typeof entry.kcalPer100g === 'number'
    ? entry.kcalPer100g
    : carbsPer100g * 4 + proteinsPer100g * 4 + fatsPer100g * 9;

  const timestampSource = (() => {
    if (typeof entry.timestamp === 'string') {
      return entry.timestamp;
    }

    if (typeof entry.timestamp === 'number') {
      return new Date(entry.timestamp).toISOString();
    }

    if (typeof entry.capturedAt === 'string') {
      return entry.capturedAt;
    }

    if (typeof entry.capturedAt === 'number') {
      return new Date(entry.capturedAt).toISOString();
    }

    return new Date().toISOString();
  })();

  const timestamp = timestampSource;

  const normalised: ScannerHistoryEntry = {
    name,
    weight,
    carbs,
    proteins,
    fats,
    glycemicIndex,
    carbsPer100g,
    proteinsPer100g,
    fatsPer100g,
    kcalPer100g,
    source: normaliseScannerSource(entry.source),
    timestamp,
  };

  if (typeof entry.id === 'string' && entry.id.length > 0) {
    normalised.id = entry.id;
  }

  if (typeof entry.capturedAt === 'string') {
    normalised.capturedAt = entry.capturedAt;
  } else if (typeof entry.capturedAt === 'number') {
    normalised.capturedAt = new Date(entry.capturedAt).toISOString();
  }

  if (typeof entry.kcal === 'number') {
    normalised.kcal = entry.kcal;
  }

  if (typeof entry.confidence === 'number') {
    normalised.confidence = entry.confidence;
  }

  if (typeof entry.portionWeight === 'number') {
    normalised.portionWeight = entry.portionWeight;
  }

  if (typeof entry.photo === 'string') {
    normalised.photo = entry.photo;
  }

  return normalised;
};

const isQueuedScannerAction = (value: unknown): value is QueuedScannerAction => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const action = value as Record<string, unknown>;
  return (
    action.type === 'exportBolus' &&
    typeof action.carbs === 'number' &&
    typeof action.timestamp === 'string' &&
    typeof action.queuedAt === 'number'
  );
};

const SETTINGS_KEY = 'bascula_settings';
const HISTORY_KEY = 'bascula_history';
const MAX_HISTORY_ITEMS = 100;

// Default settings
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  navSafeExit: false,
  voiceSelector: false,
  timerAlarms: false,
  calibrationV2: false,
  networkModal: false,
  miniEbStable: false,
  otaCheck: false,
  otaApply: false,
  debugLogs: false,
};

const DEFAULT_SETTINGS: AppSettings = {
  calibrationFactor: 1,
  defaultUnit: 'g',
  decimals: 1,
  chatGptKey: '',
  // Dispositivo: usar loopback 127.0.0.1 por defecto
  apiUrl: import.meta.env.VITE_API_URL || 'http://127.0.0.1:8080',
  wsUrl: import.meta.env.VITE_WS_URL || 'ws://127.0.0.1:8080',
  nightscoutUrl: '',
  nightscoutToken: '',
  diabetesMode: false,
  correctionFactor: 50,
  carbRatio: 10,
  targetGlucose: 100,
  hypoAlarm: 70,
  hyperAlarm: 180,
  isVoiceActive: false,
  voiceId: undefined,
  wakeWordEnabled: false,
  theme: 'dark',
  timerAlarmSoundEnabled: true,
  timerVoiceAnnouncementsEnabled: false,
  uiVolume: 1,
  ui: {
    flags: { ...DEFAULT_FEATURE_FLAGS },
  },
};

const cloneSettings = (settings: AppSettings): AppSettings => ({
  ...settings,
  ui: {
    ...settings.ui,
    flags: { ...settings.ui.flags },
  },
});

const dispatchSettingsUpdate = (settings: AppSettings) => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('app-settings-updated', { detail: { settings } }));
  }
};

const mergeSettings = (base: AppSettings, overrides?: AppSettingsUpdate): AppSettings => {
  const next = cloneSettings(base);

  if (!overrides) {
    return next;
  }

  const { ui: overridesUi, ...rest } = overrides;

  Object.assign(next, rest);

  next.ui = {
    ...next.ui,
    ...overridesUi,
    flags: {
      ...next.ui.flags,
      ...(overridesUi?.flags ?? {}),
    },
  };

  return next;
};

// Migration functions for each version
const migrations: Record<number, (data: StorageMigrationData) => StorageMigrationData> = {
  1: (data) => data,
  2: (data) => {
    data.settings = mergeSettings(DEFAULT_SETTINGS, data.settings);
    return data;
  },
  3: (data) => {
    data.settings = mergeSettings(DEFAULT_SETTINGS, data.settings);
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

    let data: StorageMigrationData = {
      settings: parseJson<Partial<AppSettings>>(localStorage.getItem(SETTINGS_KEY)) ?? {},
      history: parseJson<WeightRecord[]>(localStorage.getItem(HISTORY_KEY)) ?? [],
    };

    // Apply migrations sequentially
    for (let version = currentVersion + 1; version <= STORAGE_VERSION; version++) {
      if (migrations[version]) {
        data = migrations[version](data);
        console.log(`✅ Applied migration to v${version}`);
      }
    }

    // Save migrated data
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data.settings ?? {}));
    localStorage.setItem(HISTORY_KEY, JSON.stringify(Array.isArray(data.history) ? data.history : []));
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
      const parsed = JSON.parse(stored) as AppSettingsUpdate;
      // Merge with defaults to handle new settings
      return mergeSettings(DEFAULT_SETTINGS, parsed);
    }
  } catch (error) {
    console.error('Error loading settings:', error);
  }
    return cloneSettings(DEFAULT_SETTINGS);
  }

  saveSettings(settings: AppSettingsUpdate): void {
    try {
      const current = this.getSettings();
      const updated = mergeSettings(current, settings);
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
      dispatchSettingsUpdate(updated);
    } catch (error) {
      console.error('Error saving settings:', error);
    }
  }

  resetSettings(): void {
    try {
      localStorage.removeItem(SETTINGS_KEY);
      dispatchSettingsUpdate(cloneSettings(DEFAULT_SETTINGS));
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
  getScannerHistory(): ScannerHistoryEntry[] {
    try {
      const stored = parseJson<unknown[]>(localStorage.getItem('scanner_history'));
      if (Array.isArray(stored)) {
        return stored
          .map(toScannerHistoryEntry)
          .filter((entry): entry is ScannerHistoryEntry => entry !== null);
      }
    } catch (error) {
      console.error('Error loading scanner history:', error);
    }
    return [];
  }

  saveScannerHistory(history: ScannerHistoryEntry[]): void {
    try {
      localStorage.setItem('scanner_history', JSON.stringify(history));
    } catch (error) {
      console.error('Error saving scanner history:', error);
    }
  }

  addScannerRecord(record: ScannerRecordInput): void {
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
  getScannerQueue(): QueuedScannerAction[] {
    try {
      const stored = parseJson<unknown[]>(localStorage.getItem('scanner_history_queue'));
      if (Array.isArray(stored)) {
        return stored.filter(isQueuedScannerAction);
      }
    } catch (error) {
      console.error('Error loading scanner queue:', error);
    }
    return [];
  }

  enqueueScannerAction(action: ScannerQueueAction): void {
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

  dequeueScannerAction(): ScannerQueueAction | null {
    try {
      const queue = this.getScannerQueue();
      if (queue.length === 0) return null;
      const action = queue.shift();
      localStorage.setItem('scanner_history_queue', JSON.stringify(queue));
      if (!action) {
        return null;
      }

      return {
        type: action.type,
        carbs: action.carbs,
        insulin: action.insulin,
        timestamp: action.timestamp,
      };
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
      const parsed = JSON.parse(jsonString) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        return false;
      }

      const data = parsed as Partial<StorageMigrationData>;

      if (data.settings && typeof data.settings === 'object') {
        const merged = mergeSettings(DEFAULT_SETTINGS, data.settings as AppSettingsUpdate);
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
      }

      if (Array.isArray(data.history)) {
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
