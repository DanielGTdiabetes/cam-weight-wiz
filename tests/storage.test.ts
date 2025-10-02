/**
 * Basic tests for storage service
 * Run with: npm test (if vitest is configured)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { storage } from '@/services/storage';

describe('StorageService', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
  });

  describe('Settings', () => {
    it('should return default settings when none are saved', () => {
      const settings = storage.getSettings();
      expect(settings.calibrationFactor).toBe(1);
      expect(settings.diabetesMode).toBe(false);
      expect(settings.theme).toBe('dark');
    });

    it('should save and retrieve settings', () => {
      storage.saveSettings({ calibrationFactor: 420.5 });
      const settings = storage.getSettings();
      expect(settings.calibrationFactor).toBe(420.5);
    });

    it('should merge partial settings', () => {
      storage.saveSettings({ diabetesMode: true });
      storage.saveSettings({ calibrationFactor: 100 });
      
      const settings = storage.getSettings();
      expect(settings.diabetesMode).toBe(true);
      expect(settings.calibrationFactor).toBe(100);
    });

    it('should reset settings to defaults', () => {
      storage.saveSettings({ calibrationFactor: 999 });
      storage.resetSettings();
      
      const settings = storage.getSettings();
      expect(settings.calibrationFactor).toBe(1);
    });
  });

  describe('Weight History', () => {
    it('should start with empty history', () => {
      const history = storage.getWeightHistory();
      expect(history).toEqual([]);
    });

    it('should add weight records', () => {
      storage.addWeightRecord(100, 'g', true);
      storage.addWeightRecord(200, 'g', false, 'Test note');
      
      const history = storage.getWeightHistory();
      expect(history).toHaveLength(2);
      expect(history[0].weight).toBe(200);
      expect(history[0].note).toBe('Test note');
      expect(history[1].weight).toBe(100);
    });

    it('should delete weight records', () => {
      storage.addWeightRecord(100, 'g', true);
      const history = storage.getWeightHistory();
      const recordId = history[0].id;
      
      storage.deleteWeightRecord(recordId);
      const updatedHistory = storage.getWeightHistory();
      expect(updatedHistory).toHaveLength(0);
    });

    it('should clear all history', () => {
      storage.addWeightRecord(100, 'g', true);
      storage.addWeightRecord(200, 'g', true);
      
      storage.clearWeightHistory();
      const history = storage.getWeightHistory();
      expect(history).toEqual([]);
    });

    it('should limit history to MAX_HISTORY_ITEMS', () => {
      // Add more than 100 items
      for (let i = 0; i < 105; i++) {
        storage.addWeightRecord(i, 'g', true);
      }
      
      const history = storage.getWeightHistory();
      expect(history).toHaveLength(100);
    });
  });

  describe('Export/Import', () => {
    it('should export data as JSON', () => {
      storage.saveSettings({ calibrationFactor: 420 });
      storage.addWeightRecord(100, 'g', true);
      
      const exported = storage.exportData();
      const data = JSON.parse(exported);
      
      expect(data.settings.calibrationFactor).toBe(420);
      expect(data.history).toHaveLength(1);
      expect(data.exportDate).toBeDefined();
    });

    it('should import data successfully', () => {
      const importData = {
        settings: { calibrationFactor: 999 },
        history: [
          { id: '1', weight: 100, unit: 'g', stable: true, timestamp: Date.now() }
        ]
      };
      
      const success = storage.importData(JSON.stringify(importData));
      expect(success).toBe(true);
      
      const settings = storage.getSettings();
      const history = storage.getWeightHistory();
      
      expect(settings.calibrationFactor).toBe(999);
      expect(history).toHaveLength(1);
    });

    it('should handle invalid import data', () => {
      const success = storage.importData('invalid json');
      expect(success).toBe(false);
    });
  });
});
