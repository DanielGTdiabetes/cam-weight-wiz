// API Wrapper with Error Handling and Offline Queue

import { logger } from './logger';
import { offlineQueue } from './offlineQueue';
import { storage } from './storage';

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestConfig {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  skipQueue?: boolean;
  timeout?: number;
}

class ApiWrapper {
  private baseUrl: string;
  private defaultTimeout = 30000; // 30 seconds

  constructor() {
    const settings = storage.getSettings();
    this.baseUrl = settings.apiUrl;
  }

  updateBaseUrl(url: string) {
    this.baseUrl = url;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeout: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  async request<T>(
    endpoint: string,
    config: RequestConfig = {}
  ): Promise<T> {
    const {
      method = 'GET',
      body,
      headers = {},
      skipQueue = false,
      timeout = this.defaultTimeout,
    } = config;

    const url = `${this.baseUrl}${endpoint}`;
    const isWriteOperation = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method);

    // Check if offline and queue write operations
    if (!navigator.onLine && isWriteOperation && !skipQueue) {
      logger.warn('Offline: Queueing request', { url, method });
      offlineQueue.enqueue(url, method, body, headers);
      throw new ApiError(
        'Sin conexión. La operación se sincronizará cuando haya conexión.',
        0,
        'OFFLINE'
      );
    }

    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...headers,
    };

    try {
      logger.debug('API Request', { url, method });

      const response = await this.fetchWithTimeout(
        url,
        {
          method,
          headers: requestHeaders,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        timeout
      );

      // Handle HTTP errors
      if (!response.ok) {
        let errorMessage = `HTTP ${response.status}`;
        let errorCode = `HTTP_${response.status}`;

        try {
          const errorData = await response.json();
          errorMessage = errorData.message || errorMessage;
          errorCode = errorData.code || errorCode;
        } catch {
          // Could not parse error as JSON
        }

        logger.error('API Error', {
          url,
          status: response.status,
          message: errorMessage,
        });

        throw new ApiError(errorMessage, response.status, errorCode);
      }

      // Try to parse as JSON
      try {
        const data = await response.json();
        logger.debug('API Response', { url, status: response.status });
        return data;
      } catch {
        // Not JSON, return empty object
        return {} as T;
      }
    } catch (error) {
      // Network or timeout errors
      if (error instanceof ApiError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          logger.error('Request timeout', { url, timeout });
          throw new ApiError('Tiempo de espera agotado', 0, 'TIMEOUT');
        }

        logger.error('Network error', { url, error: error.message });
        throw new ApiError(
          'Error de conexión. Verifica tu red.',
          0,
          'NETWORK_ERROR'
        );
      }

      throw new ApiError('Error desconocido', 0, 'UNKNOWN');
    }
  }

  // Convenience methods
  get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint);
  }

  post<T>(endpoint: string, body?: unknown): Promise<T> {
    return this.request<T>(endpoint, { method: 'POST', body });
  }

  put<T>(endpoint: string, body?: unknown): Promise<T> {
    return this.request<T>(endpoint, { method: 'PUT', body });
  }

  delete<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'DELETE' });
  }
}

export const apiWrapper = new ApiWrapper();
