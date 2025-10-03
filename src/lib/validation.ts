/**
 * Input Validation Utilities
 */

export interface ValidationResult {
  isValid: boolean;
  error?: string;
}

// URL validation
interface ValidationOptions {
  allowEmpty?: boolean;
  emptyError?: string;
}

export const validateUrl = (url: string, options: ValidationOptions = {}): ValidationResult => {
  const trimmed = url.trim();

  if (trimmed === '') {
    if (options.allowEmpty) {
      return { isValid: true };
    }

    return { isValid: false, error: options.emptyError ?? 'URL requerida' };
  }

  try {
    const urlObj = new URL(trimmed);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(urlObj.protocol)) {
      return { isValid: false, error: 'URL debe usar http, https, ws o wss' };
    }
    if (trimmed.length > 500) {
      return { isValid: false, error: 'URL demasiado larga (máx 500 caracteres)' };
    }
    return { isValid: true };
  } catch {
    return { isValid: false, error: 'URL inválida' };
  }
};

// Number validation
export const validateNumber = (value: string, min?: number, max?: number, allowDecimal = true): ValidationResult => {
  if (!value || value.trim() === '') {
    return { isValid: false, error: 'Valor requerido' };
  }

  const num = parseFloat(value);
  
  if (isNaN(num)) {
    return { isValid: false, error: 'Debe ser un número válido' };
  }

  if (!allowDecimal && !Number.isInteger(num)) {
    return { isValid: false, error: 'Debe ser un número entero' };
  }

  if (min !== undefined && num < min) {
    return { isValid: false, error: `Valor mínimo: ${min}` };
  }

  if (max !== undefined && num > max) {
    return { isValid: false, error: `Valor máximo: ${max}` };
  }

  return { isValid: true };
};

// Text validation
export const validateText = (text: string, minLength?: number, maxLength?: number): ValidationResult => {
  const trimmed = text.trim();

  if (minLength !== undefined && trimmed.length < minLength) {
    return { isValid: false, error: `Mínimo ${minLength} caracteres` };
  }

  if (maxLength !== undefined && trimmed.length > maxLength) {
    return { isValid: false, error: `Máximo ${maxLength} caracteres` };
  }

  // Check for potentially dangerous characters
  const dangerousPattern = /<script|javascript:|onerror=|onclick=/i;
  if (dangerousPattern.test(trimmed)) {
    return { isValid: false, error: 'Contiene caracteres no permitidos' };
  }

  return { isValid: true };
};

// API Key validation (basic)
export const validateApiKey = (key: string, options: ValidationOptions = {}): ValidationResult => {
  const trimmed = key.trim();

  if (trimmed === '') {
    if (options.allowEmpty) {
      return { isValid: true };
    }

    return { isValid: false, error: options.emptyError ?? 'API key requerida' };
  }

  if (trimmed.length < 10) {
    return { isValid: false, error: 'API key demasiado corta' };
  }

  if (trimmed.length > 500) {
    return { isValid: false, error: 'API key demasiado larga' };
  }

  // Only allow alphanumeric, dashes, and underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return { isValid: false, error: 'API key contiene caracteres inválidos' };
  }

  return { isValid: true };
};

// Sanitize text for display
export const sanitizeText = (text: string): string => {
  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
};
