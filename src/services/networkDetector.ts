// Network Detection Service for AP Fallback

import { logger } from './logger';

export interface NetworkStatus {
  isOnline: boolean;
  isWifiConnected: boolean;
  apActive: boolean;
  connectivity: 'full' | 'limited' | 'portal' | 'none' | 'unknown';
  savedWifiProfiles: boolean;
  showAPScreen: boolean;
  ssid?: string;
  ip?: string;
}

class NetworkDetector {
  private checkInterval: NodeJS.Timeout | null = null;
  private listeners: ((status: NetworkStatus) => void)[] = [];
  private currentStatus: NetworkStatus = {
    isOnline: navigator.onLine,
    isWifiConnected: false,
    apActive: false,
    connectivity: 'unknown',
    savedWifiProfiles: false,
    showAPScreen: false,
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
    let isWifiConnected = this.currentStatus.isWifiConnected;
    let ssid: string | undefined = this.currentStatus.ssid;
    let ip: string | undefined = this.currentStatus.ip;
    let apActive = this.currentStatus.apActive;
    let connectivity: NetworkStatus['connectivity'] = this.currentStatus.connectivity;
    let savedWifiProfiles = this.currentStatus.savedWifiProfiles;
    let showAPScreen = this.currentStatus.showAPScreen;

    if (isOnline) {
      try {
        // Try to ping the backend
        const response = await fetch('/api/miniweb/status', {
          method: 'GET',
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
        });

        if (response.ok) {
          const data = await response.json();
          ssid = typeof data.ssid === 'string' ? data.ssid : undefined;
          ip = typeof data.ip === 'string' ? data.ip : undefined;

          const connectivityValue = typeof data.connectivity === 'string' ? data.connectivity.toLowerCase() : 'unknown';
          if (connectivityValue === 'full' || connectivityValue === 'limited' || connectivityValue === 'portal' || connectivityValue === 'none') {
            connectivity = connectivityValue;
          }

          apActive = data.ap_active === true;
          savedWifiProfiles = data.saved_wifi_profiles === true;
          const connectedField = typeof data.connected === 'boolean' ? data.connected : undefined;
          isWifiConnected = connectedField ?? connectivity === 'full';
          showAPScreen = apActive;

          logger.info('Network status fetched', {
            connectivity,
            apActive,
            savedWifiProfiles,
            isWifiConnected,
            ssid,
            ip,
          });
        }
      } catch (error) {
        logger.warn('Cannot reach backend, assuming disconnected', { error });
      }
    } else {
      showAPScreen = apActive;
    }

    const status: NetworkStatus = {
      isOnline,
      isWifiConnected,
      apActive,
      connectivity,
      savedWifiProfiles,
      showAPScreen,
      ssid,
      ip,
    };

    // Notify listeners if status changed
    if (JSON.stringify(status) !== JSON.stringify(this.currentStatus)) {
      this.currentStatus = status;
      this.notifyListeners(status);
      
      if (showAPScreen) {
        logger.warn('BasculaAP active; showing AP provisioning screen');
      } else {
        logger.info('AP provisioning screen not required');
      }
    }

    return status;
  }

  private notifyListeners(status: NetworkStatus) {
    this.listeners.forEach((listener) => listener(status));
  }

  // Public API
  startMonitoring(intervalMs: number = 3000) {
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
