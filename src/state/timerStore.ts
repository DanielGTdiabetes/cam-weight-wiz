import { create } from "zustand";

interface TimerState {
  durationMs: number;
  startedAt: number | null;
  start: (durationMs: number) => void;
  stop: () => void;
  hydrate: (durationMs: number, startedAt: number | null) => void;
}

export const useTimerStore = create<TimerState>((set) => ({
  durationMs: 0,
  startedAt: null,
  start: (durationMs) => {
    const safeDuration = Math.max(0, durationMs);
    const startedAt = safeDuration > 0 ? Date.now() : null;
    set({ durationMs: safeDuration, startedAt });
  },
  stop: () => set((state) => ({ durationMs: state.durationMs, startedAt: null })),
  hydrate: (durationMs, startedAt) => {
    const safeDuration = Math.max(0, durationMs);
    set({ durationMs: safeDuration, startedAt: startedAt && safeDuration > 0 ? startedAt : null });
  },
}));

export const selectTimerConfig = (state: TimerState) => ({
  durationMs: state.durationMs,
  startedAt: state.startedAt,
});
