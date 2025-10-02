import { useState, useEffect, useCallback } from 'react';
import { storage, WeightRecord } from '@/services/storage';

export const useWeightHistory = () => {
  const [history, setHistory] = useState<WeightRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Load history on mount
  useEffect(() => {
    const loadHistory = () => {
      setIsLoading(true);
      const records = storage.getWeightHistory();
      setHistory(records);
      setIsLoading(false);
    };

    loadHistory();
  }, []);

  // Add new record
  const addRecord = useCallback((weight: number, unit: 'g' | 'ml', stable: boolean, note?: string) => {
    storage.addWeightRecord(weight, unit, stable, note);
    setHistory(storage.getWeightHistory());
  }, []);

  // Delete record
  const deleteRecord = useCallback((id: string) => {
    storage.deleteWeightRecord(id);
    setHistory(storage.getWeightHistory());
  }, []);

  // Clear all history
  const clearHistory = useCallback(() => {
    storage.clearWeightHistory();
    setHistory([]);
  }, []);

  return {
    history,
    isLoading,
    addRecord,
    deleteRecord,
    clearHistory,
  };
};
