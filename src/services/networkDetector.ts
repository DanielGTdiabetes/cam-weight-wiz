// Network Detection Service for AP Fallback

import { logger } from './logger';

export interface NetworkStatus {
  isOnline: boolean;
  isWifiConnected: boolean;
  shouldActivateAP: boolean;
  ssid?: string;
  ip?: string;
}

class NetworkDetector {
  private checkInterval: NodeJS.Timeout | null = null;
  private listeners: ((status: NetworkStatus) => void)[] = [];
  private currentStatus: NetworkStatus = {
    isOnline: navigator.onLine,
    isWifiConnected: false,
    shouldActivateAP: false,
  };

  constructor() {
    this.setupListeners();
  }

  private setupListeners() {
    // Browser online/offline events
    window.addEventListener('online', () => {
      logger.info('Browser detected online');
      this.checkNetworkStatus();
    });

    window.addEventListener('offline', () => {
      logger.warn('Browser detected offline');
      this.checkNetworkStatus();
    });
  }

  private async checkNetworkStatus(): Promise<NetworkStatus> {
    const isOnline = navigator.onLine;

    // Check if we can reach the backend
    let isWifiConnected = false;
    let ssid: string | undefined;
    let ip: string | undefined;
    let shouldActivateAP = !isWifiConnected;

    if (isOnline) {
      try {
        // Try to ping the backend
        const response = await fetch('/api/miniweb/status', {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        });

        if (response.ok) {
          const data = await response.json();
          isWifiConnected = data.connected || false;
          ssid = data.ssid;
          ip = data.ip;
          logger.info('Network status fetched', { isWifiConnected, ssid, ip });

          if (typeof data.should_activate_ap === 'boolean') {
            shouldActivateAP = data.should_activate_ap;
          } else {
            shouldActivateAP = !isWifiConnected;
          }
        }
      } catch (error) {
        logger.warn('Cannot reach backend, assuming disconnected', { error });
      }
    } else {
      shouldActivateAP = !isWifiConnected;
    }

    const status: NetworkStatus = {
      isOnline,
      isWifiConnected,
      shouldActivateAP,
      ssid,
      ip,
    };

    // Notify listeners if status changed
    if (JSON.stringify(status) !== JSON.stringify(this.currentStatus)) {
      this.currentStatus = status;
      this.notifyListeners(status);
      
      if (shouldActivateAP) {
        logger.warn('No WiFi connection detected, AP mode should be activated');
        this.requestAPMode();
      } else {
        logger.info('WiFi connected, AP mode should be deactivated');
        this.requestStationMode();
      }
    }

    return status;
  }

  private async requestAPMode() {
    try {
      await fetch('/api/network/enable-ap', {
        method: 'POST',
      });
      logger.info('AP mode activation requested');
    } catch (error) {
      logger.error('Failed to request AP mode', { error });
    }
  }

  private async requestStationMode() {
    try {
      await fetch('/api/network/disable-ap', {
        method: 'POST',
      });
      logger.info('Station mode requested (AP disabled)');
    } catch (error) {
      logger.error('Failed to disable AP mode', { error });
    }
  }

  private notifyListeners(status: NetworkStatus) {
    this.listeners.forEach((listener) => listener(status));
  }

  // Public API
  startMonitoring(intervalMs: number = 30000) {
    if (this.checkInterval) {
      this.stopMonitoring();
    }

    logger.info('Starting network monitoring', { intervalMs });
    
    // Check immediately
    this.checkNetworkStatus();

    // Then check periodically
    this.checkInterval = setInterval(() => {
      this.checkNetworkStatus();
    }, intervalMs);
  }

  stopMonitoring() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('Network monitoring stopped');
    }
  }

  subscribe(listener: (status: NetworkStatus) => void) {
    this.listeners.push(listener);
    // Immediately notify with current status
    listener(this.currentStatus);
  }

  unsubscribe(listener: (status: NetworkStatus) => void) {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  getCurrentStatus(): NetworkStatus {
    return { ...this.currentStatus };
  }
}

export const networkDetector = new NetworkDetector();
