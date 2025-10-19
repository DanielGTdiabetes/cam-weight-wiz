import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

class MockEventSource {
  url: string;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener() {}

  removeEventListener() {}

  close() {}
}

(globalThis as typeof globalThis & { EventSource: typeof MockEventSource }).EventSource =
  MockEventSource as unknown as typeof EventSource;

vi.mock('@/components/MainMenu', () => ({ MainMenu: () => <div data-testid="main-menu" /> }));
vi.mock('@/pages/ScaleView', () => ({ ScaleView: () => <div data-testid="scale-view" /> }));
vi.mock('@/pages/FoodScannerView', () => ({ FoodScannerView: () => <div data-testid="scanner-view" /> }));
vi.mock('@/pages/TimerFullView', () => ({ TimerFullView: () => <div data-testid="timer-view" /> }));
vi.mock('@/pages/RecipesView', () => ({ RecipesView: () => <div data-testid="recipes-view" /> }));
vi.mock('@/pages/SettingsView', () => ({ SettingsView: () => <div data-testid="settings-view" /> }));
vi.mock('@/components/TopBar', () => ({ TopBar: () => <div data-testid="top-bar" /> }));
vi.mock('@/components/NotificationBar', () => ({
  NotificationBar: ({ message }: { message: string }) => (
    <div data-testid="notification">{message}</div>
  ),
}));
vi.mock('@/components/TimerDialog', () => ({ TimerDialog: () => null }));
vi.mock('@/components/Mode1515Dialog', () => ({ Mode1515Dialog: () => null }));
vi.mock('@/components/RecoveryMode', () => ({ RecoveryMode: () => <div>Recovery</div> }));
vi.mock('@/components/APModeScreen', () => ({ APModeScreen: () => <div>AP Mode</div> }));
vi.mock('@/components/BasculinMascot', () => ({ BasculinMascot: () => <div data-testid="mascot" /> }));
vi.mock('@/hooks/useGlucoseMonitor', () => ({ useGlucoseMonitor: () => null }));
vi.mock('@/services/api', () => ({
  api: {
    startTimer: vi.fn(() => Promise.resolve()),
    getScaleWeight: vi.fn(() => Promise.resolve({ value: 0 })),
    scaleTare: vi.fn(() => Promise.resolve()),
    getWakeStatus: vi.fn(() => Promise.resolve({ enabled: false, running: false })),
  },
}));
vi.mock('@/services/apiWrapper', () => ({
  apiWrapper: {
    getBaseUrl: vi.fn(() => 'http://localhost'),
  },
}));
vi.mock('@/services/storage', () => ({
  storage: {
    getSettings: vi.fn(() => ({ wakeWordEnabled: false, apiUrl: 'http://localhost' })),
    setSettings: vi.fn(),
  },
}));
vi.mock('@/lib/format', () => ({ formatWeight: (value: number) => value.toString() }));
vi.mock('@/hooks/useScaleDecimals', () => ({ useScaleDecimals: () => 1 }));

const baseStatus = {
  isOnline: true,
  isWifiConnected: true,
  ethernetConnected: false,
  apActive: false,
  connectivity: 'full' as const,
  savedWifiProfiles: true,
  showAPScreen: false,
  offlineModeEnabled: false,
  effectiveMode: 'kiosk' as const,
  hasInternet: true,
  ssid: 'TestWifi',
  ip: '192.168.1.10',
};

const listeners: ((status: typeof baseStatus) => void)[] = [];
let currentStatus = { ...baseStatus };

const emitStatus = () => {
  for (const listener of listeners) {
    listener({ ...currentStatus });
  }
};

vi.mock('@/services/networkDetector', () => ({
  networkDetector: {
    subscribe: vi.fn((listener: (status: typeof baseStatus) => void) => {
      listeners.push(listener);
      listener({ ...currentStatus });
    }),
    unsubscribe: vi.fn((listener: (status: typeof baseStatus) => void) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    }),
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    getCurrentStatus: vi.fn(() => ({ ...currentStatus })),
    __setStatus: (status: Partial<typeof baseStatus>) => {
      currentStatus = { ...currentStatus, ...status };
      emitStatus();
    },
    __reset: () => {
      currentStatus = { ...baseStatus };
    },
  },
}));

import Index from '@/pages/Index';
import App from '@/App';
import { networkDetector } from '@/services/networkDetector';

const mockedDetector = networkDetector as unknown as {
  __setStatus: (status: Partial<typeof baseStatus>) => void;
  __reset: () => void;
};

describe('Offline mode experience', () => {
  beforeEach(() => {
    listeners.length = 0;
    mockedDetector.__reset();
  });

  it('shows an Offline badge on the main view when effective mode is offline', async () => {
    render(
      <MemoryRouter>
        <Index />
      </MemoryRouter>,
    );

    await act(async () => {
      mockedDetector.__setStatus({ effectiveMode: 'offline', offlineModeEnabled: true, hasInternet: false });
    });

    expect(await screen.findByText('Offline')).toBeInTheDocument();
  });

  it('renders the offline page when navigating to /offline', () => {
    window.history.pushState({}, '', '/offline');

    render(<App />);

    expect(screen.getByText('Modo offline activado')).toBeInTheDocument();

    window.history.pushState({}, '', '/');
  });
});
