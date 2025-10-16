// Offline Queue Service for sync when connection is restored

import { logger } from './logger';

interface QueuedRequest {
  id: string;
  url: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
  timestamp: number;
  retries: number;
}

class OfflineQueue {
  private queue: QueuedRequest[] = [];
  private isProcessing = false;
  private maxRetries = 3;
  private storageKey = 'offline_queue';

  constructor() {
    this.loadQueue();
    this.setupOnlineListener();
  }

  private loadQueue() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        this.queue = JSON.parse(stored);
        logger.info('Loaded offline queue', { count: this.queue.length });
      }
    } catch (error) {
      logger.error('Failed to load offline queue', { error });
    }
  }

  private saveQueue() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.queue));
    } catch (error) {
      logger.error('Failed to save offline queue', { error });
    }
  }

  private setupOnlineListener() {
    window.addEventListener('online', () => {
      logger.info('Connection restored, processing offline queue');
      this.processQueue();
    });
  }

  enqueue(
    url: string,
    method: string,
    body?: unknown,
    headers?: Record<string, string>
  ): string {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const request: QueuedRequest = {
      id,
      url,
      method,
      body,
      headers,
      timestamp: Date.now(),
      retries: 0,
    };

    this.queue.push(request);
    this.saveQueue();
    
    logger.info('Request queued for offline sync', { id, url, method });

    // Try to process if online
    if (navigator.onLine) {
      this.processQueue();
    }

    return id;
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0 || !navigator.onLine) {
      return;
    }

    this.isProcessing = true;
    logger.info('Processing offline queue', { count: this.queue.length });

    const failedRequests: QueuedRequest[] = [];

    for (const request of this.queue) {
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
        });

        if (response.ok) {
          logger.info('Successfully synced queued request', { id: request.id });
        } else {
          throw new Error(`HTTP ${response.status}`);
        }
      } catch (error) {
        request.retries++;
        logger.warn('Failed to sync request', {
          id: request.id,
          retries: request.retries,
          error,
        });

        if (request.retries < this.maxRetries) {
          failedRequests.push(request);
        } else {
          logger.error('Request exceeded max retries, discarding', {
            id: request.id,
          });
        }
      }
    }

    this.queue = failedRequests;
    this.saveQueue();
    this.isProcessing = false;

    logger.info('Offline queue processed', {
      remaining: this.queue.length,
    });
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  clearQueue() {
    this.queue = [];
    this.saveQueue();
    logger.info('Offline queue cleared');
  }
}

export const offlineQueue = new OfflineQueue();
