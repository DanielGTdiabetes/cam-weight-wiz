/**
 * Input Validation Utilities
 */

export interface ValidationResult {
  isValid: boolean;
  error?: string;
}

// URL validation
export const validateUrl = (url: string): ValidationResult => {
  if (!url || url.trim() === '') {
    return { isValid: true }; // Empty is valid (optional field)
  }

  try {
    const urlObj = new URL(url);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(urlObj.protocol)) {
      return { isValid: false, error: 'URL debe usar http, https, ws o wss' };
    }
    if (url.length > 500) {
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
export const validateApiKey = (key: string): ValidationResult => {
  if (!key || key.trim() === '') {
    return { isValid: true }; // Empty is valid (optional)
  }

  const trimmed = key.trim();

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
