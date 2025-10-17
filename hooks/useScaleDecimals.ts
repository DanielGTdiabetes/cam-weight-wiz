import { useEffect, useState } from 'react';
import { storage, type AppSettings, SETTINGS_STORAGE_KEY } from '@/services/storage';

const readDecimals = (): 0 | 1 => {
  try {
    const settings = storage.getSettings();
    const value = settings.scale?.decimals;
    return value === 0 ? 0 : 1;
  } catch (error) {
    return 1;
  }
};

export const useScaleDecimals = (): 0 | 1 => {
  const [decimals, setDecimals] = useState<0 | 1>(() => readDecimals());

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleUpdate: EventListener = (event) => {
      const detail = (event as CustomEvent<{ settings?: AppSettings }>).detail;
      const next = detail?.settings?.scale?.decimals;

      if (next === 0 || next === 1) {
        setDecimals(next);
        return;
      }

      setDecimals(readDecimals());
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key && event.key !== SETTINGS_STORAGE_KEY) {
        return;
      }
      setDecimals(readDecimals());
    };

    window.addEventListener('app-settings-updated', handleUpdate);
    window.addEventListener('storage', handleStorage);

    return () => {
      window.removeEventListener('app-settings-updated', handleUpdate);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  return decimals;
};
