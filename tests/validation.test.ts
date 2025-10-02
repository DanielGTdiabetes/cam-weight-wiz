/**
 * Tests for validation utilities
 */

import { describe, it, expect } from 'vitest';
import { validateUrl, validateNumber, validateText, validateApiKey } from '@/lib/validation';

describe('Validation', () => {
  describe('validateUrl', () => {
    it('should accept valid URLs', () => {
      expect(validateUrl('http://example.com').isValid).toBe(true);
      expect(validateUrl('https://example.com').isValid).toBe(true);
      expect(validateUrl('https://api.example.com/endpoint').isValid).toBe(true);
    });

    it('should reject invalid URLs', () => {
      expect(validateUrl('not a url').isValid).toBe(false);
      expect(validateUrl('ftp://example.com').isValid).toBe(false);
      expect(validateUrl('').isValid).toBe(false);
    });
  });

  describe('validateNumber', () => {
    it('should accept valid numbers', () => {
      expect(validateNumber('100').isValid).toBe(true);
      expect(validateNumber('0').isValid).toBe(true);
      expect(validateNumber('99.5', 0, 100, true).isValid).toBe(true);
    });

    it('should reject invalid numbers', () => {
      expect(validateNumber('abc').isValid).toBe(false);
      expect(validateNumber('12.5', 0, 100, false).isValid).toBe(false); // No decimals
      expect(validateNumber('').isValid).toBe(false);
    });

    it('should enforce min/max bounds', () => {
      expect(validateNumber('5', 10, 100).isValid).toBe(false);
      expect(validateNumber('150', 10, 100).isValid).toBe(false);
      expect(validateNumber('50', 10, 100).isValid).toBe(true);
    });
  });

  describe('validateText', () => {
    it('should accept valid text', () => {
      expect(validateText('Hello').isValid).toBe(true);
      expect(validateText('Test 123').isValid).toBe(true);
    });

    it('should reject empty text when required', () => {
      expect(validateText('', 1).isValid).toBe(false);
      expect(validateText('   ', 1).isValid).toBe(false);
    });

    it('should enforce length limits', () => {
      expect(validateText('Hi', 5).isValid).toBe(false);
      expect(validateText('Hello World', undefined, 5).isValid).toBe(false);
      expect(validateText('Hello', 3, 10).isValid).toBe(true);
    });

    it('should detect XSS attempts', () => {
      expect(validateText('<script>alert("xss")</script>').isValid).toBe(false);
      expect(validateText('javascript:alert(1)').isValid).toBe(false);
    });
  });

  describe('validateApiKey', () => {
    it('should accept valid API keys', () => {
      expect(validateApiKey('sk-1234567890abcdef').isValid).toBe(true);
      expect(validateApiKey('AIzaSyABCDEF1234567890').isValid).toBe(true);
    });

    it('should reject invalid API keys', () => {
      expect(validateApiKey('').isValid).toBe(false);
      expect(validateApiKey('abc').isValid).toBe(false);
      expect(validateApiKey('too_short').isValid).toBe(false);
    });
  });
});
