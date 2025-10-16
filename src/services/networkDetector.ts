// Network Detection Service for AP Fallback

import { logger } from './logger';

export interface NetworkStatus {
  isOnline: boolean;
  isWifiConnected: boolean;
  ethernetConnected: boolean;
  apActive: boolean;
  connectivity: 'full' | 'limited' | 'portal' | 'none' | 'unknown';
  savedWifiProfiles: boolean;
  showAPScreen: boolean;
  offlineModeEnabled: boolean;
  effectiveMode: 'ap' | 'kiosk' | 'offline' | 'unknown';
  hasInternet: boolean;
  ssid?: string;
  ip?: string;
}

class NetworkDetector {
  private checkInterval: NodeJS.Timeout | null = null;
  private listeners: ((status: NetworkStatus) => void)[] = [];
  private currentStatus: NetworkStatus = {
    isOnline: navigator.onLine,
    isWifiConnected: false,
    ethernetConnected: false,
    apActive: false,
    connectivity: 'unknown',
    savedWifiProfiles: false,
    showAPScreen: false,
    offlineModeEnabled: false,
    effectiveMode: 'unknown',
    hasInternet: false,
  };
  private eventSource: EventSource | null = null;

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

  private setupEventStream() {
    if (this.eventSource || typeof window === 'undefined') {
      return;
    }

    try {
      const source = new EventSource('/api/net/events');
      source.addEventListener('status', () => {
        void this.checkNetworkStatus();
      });
      source.addEventListener('wifi_connected', () => {
        void this.checkNetworkStatus();
      });
      source.addEventListener('wifi_failed', () => {
        void this.checkNetworkStatus();
      });
      source.onerror = (event) => {
        logger.debug('NetworkDetector SSE reported an error', { event });
        source.close();
        this.eventSource = null;
        setTimeout(() => this.setupEventStream(), 5000);
      };
      this.eventSource = source;
    } catch (error) {
      logger.warn('Unable to open network status stream', { error });
    }
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
    let ethernetConnected = this.currentStatus.ethernetConnected;
    let offlineModeEnabled = this.currentStatus.offlineModeEnabled;
    let effectiveMode = this.currentStatus.effectiveMode;
    let hasInternet = this.currentStatus.hasInternet;

    if (isOnline) {
      try {
        // Try to ping the backend
        const response = await fetch('/api/miniweb/status', {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        });

        if (response.ok) {
          const data = await response.json();
          ssid = typeof data.ssid === 'string' && data.ssid ? data.ssid : undefined;
          if (typeof data.ip === 'string' && data.ip) {
            ip = data.ip;
          } else if (typeof data.ip_address === 'string' && data.ip_address) {
            ip = data.ip_address;
          }

          const connectivityValue = typeof data.connectivity === 'string' ? data.connectivity.toLowerCase() : 'unknown';
          if (connectivityValue === 'full' || connectivityValue === 'limited' || connectivityValue === 'portal' || connectivityValue === 'none') {
            connectivity = connectivityValue;
          }

          apActive = data.ap_active === true;
          savedWifiProfiles = data.saved_wifi_profiles === true;
          const connectedField = typeof data.connected === 'boolean' ? data.connected : undefined;
          isWifiConnected = connectedField ?? connectivity === 'full';

          if (data.wifi && typeof data.wifi === 'object') {
            const wifiData = data.wifi as Record<string, unknown>;
            if (typeof wifiData.connected === 'boolean') {
              isWifiConnected = wifiData.connected;
            }
            if (!ip && typeof wifiData.ip === 'string' && wifiData.ip.trim()) {
              ip = wifiData.ip.trim();
            }
          }

          offlineModeEnabled = data.offline_mode === true;
          ethernetConnected = data.ethernet_connected === true;
          const effectiveModeRaw =
            typeof data.effective_mode === 'string' ? data.effective_mode.trim().toLowerCase() : '';
          if (effectiveModeRaw === 'ap' || effectiveModeRaw === 'kiosk' || effectiveModeRaw === 'offline') {
            effectiveMode = effectiveModeRaw;
          } else {
            effectiveMode = 'unknown';
          }
          hasInternet = data.internet === true || connectivity === 'full';
          showAPScreen = effectiveMode === 'ap';

          logger.info('Network status fetched', {
            connectivity,
            apActive,
            savedWifiProfiles,
            isWifiConnected,
            ssid,
            ip,
            ethernetConnected,
            offlineModeEnabled,
            effectiveMode,
          });
        }
      } catch (error) {
        logger.warn('Cannot reach backend, assuming disconnected', { error });
      }
    } else {
      showAPScreen = apActive;
      hasInternet = false;
    }

    const status: NetworkStatus = {
      isOnline,
      isWifiConnected,
      ethernetConnected,
      apActive,
      connectivity,
      savedWifiProfiles,
      showAPScreen,
      offlineModeEnabled,
      effectiveMode,
      hasInternet,
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

    this.setupEventStream();

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
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
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
