import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Polyfill matchMedia for testing environments that use JSDOM
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// Mock SpeechRecognition so voice fallback logic can run in tests
class MockSpeechRecognition {
  lang = 'es-ES';
  interimResults = false;
  continuous = false;
  onresult: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onend: (() => void) | null = null;

  start() {
    return;
  }

  stop() {
    return;
  }
}

Object.defineProperty(MockSpeechRecognition.prototype, 'start', {
  value: vi.fn(function (this: MockSpeechRecognition) {
    (globalThis as any).__latestSpeechRecognition = this;
  }),
});

Object.defineProperty(MockSpeechRecognition.prototype, 'stop', {
  value: vi.fn(function () {
    return;
  }),
});

if (typeof window !== 'undefined') {
  (window as any).SpeechRecognition = MockSpeechRecognition as any;
  (window as any).webkitSpeechRecognition = MockSpeechRecognition as any;
}

// Provide navigator APIs used by the component
if (typeof navigator !== 'undefined') {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [
          {
            stop: vi.fn(),
          },
        ],
      })),
    },
    configurable: true,
  });

  Object.defineProperty(navigator, 'vibrate', {
    value: vi.fn(),
    configurable: true,
  });

  Object.defineProperty(navigator, 'onLine', {
    value: true,
    configurable: true,
  });
}

// Canvas/video helpers used during AI capture
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: vi.fn(() => ({
    drawImage: vi.fn(),
  })),
  configurable: true,
});

Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
  value: vi.fn(() => 'data:image/jpeg;base64,mock'),
  configurable: true,
});

Object.defineProperty(HTMLVideoElement.prototype, 'play', {
  value: vi.fn(async () => undefined),
  configurable: true,
});

Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
  value: 640,
  configurable: true,
});

Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
  value: 480,
  configurable: true,
});

if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  class ResizeObserver {
    callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe() {
      return;
    }

    unobserve() {
      return;
    }

    disconnect() {
      return;
    }
  }

  (window as any).ResizeObserver = ResizeObserver;
  (globalThis as any).ResizeObserver = ResizeObserver;
}
