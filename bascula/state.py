"""Shared application state for the local Tkinter UI."""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable, List, Optional


@dataclass(frozen=True)
class WeightState:
    """Represents the current weight shown in the UI."""

    weight: float = 0.0
    unit: str = "g"
    stable: bool = False
    updated_at: float = field(default_factory=time.time)


@dataclass(frozen=True)
class TimerState:
    """Represents the status of the shared kitchen timer."""

    remaining_seconds: int = 0
    active: bool = False
    started_at: Optional[float] = None
    completed_at: Optional[float] = None


class AppState:
    """Thread-safe state container shared across UI screens/widgets."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._weight_state = WeightState()
        self._timer_state = TimerState()
        self._weight_listeners: List[Callable[[WeightState], None]] = []
        self._timer_listeners: List[Callable[[TimerState], None]] = []
        self._tare_listeners: List[Callable[[float], None]] = []
        self._last_tare_at: Optional[float] = None

    # ------------------------------------------------------------------
    # Weight management
    # ------------------------------------------------------------------
    def subscribe_weight(self, callback: Callable[[WeightState], None]) -> Callable[[], None]:
        """Register a callback notified whenever the weight changes."""

        with self._lock:
            self._weight_listeners.append(callback)
            snapshot = self._weight_state

        callback(snapshot)

        def unsubscribe() -> None:
            with self._lock:
                if callback in self._weight_listeners:
                    self._weight_listeners.remove(callback)

        return unsubscribe

    def set_weight(self, weight: float, *, unit: Optional[str] = None, stable: bool = False) -> None:
        """Update the displayed weight and notify subscribers."""

        with self._lock:
            self._weight_state = WeightState(
                weight=weight,
                unit=unit or self._weight_state.unit,
                stable=stable,
            )
            snapshot = self._weight_state

        self._notify_weight(snapshot)

    def _notify_weight(self, snapshot: WeightState) -> None:
        for listener in list(self._weight_listeners):
            try:
                listener(snapshot)
            except Exception:
                # Subscribers should never break the state flow.
                continue

    # ------------------------------------------------------------------
    # Tare events
    # ------------------------------------------------------------------
    def subscribe_tare(self, callback: Callable[[float], None]) -> Callable[[], None]:
        """Register a callback invoked whenever tare is applied."""

        with self._lock:
            self._tare_listeners.append(callback)
            last_tare = self._last_tare_at

        if last_tare is not None:
            callback(last_tare)

        def unsubscribe() -> None:
            with self._lock:
                if callback in self._tare_listeners:
                    self._tare_listeners.remove(callback)

        return unsubscribe

    def record_tare_event(self) -> None:
        """Store and broadcast the timestamp of the last tare."""

        with self._lock:
            self._last_tare_at = time.time()
            timestamp = self._last_tare_at

        for listener in list(self._tare_listeners):
            try:
                listener(timestamp)
            except Exception:
                continue

    # ------------------------------------------------------------------
    # Timer management
    # ------------------------------------------------------------------
    def subscribe_timer(self, callback: Callable[[TimerState], None]) -> Callable[[], None]:
        """Register a callback notified whenever the timer state changes."""

        with self._lock:
            self._timer_listeners.append(callback)
            snapshot = self._timer_state

        callback(snapshot)

        def unsubscribe() -> None:
            with self._lock:
                if callback in self._timer_listeners:
                    self._timer_listeners.remove(callback)

        return unsubscribe

    def start_timer(self, duration_seconds: int) -> None:
        """Start the countdown timer with the provided duration."""

        duration = max(0, int(duration_seconds))
        now = time.time()
        with self._lock:
            self._timer_state = TimerState(
                remaining_seconds=duration,
                active=duration > 0,
                started_at=now if duration > 0 else None,
                completed_at=None,
            )
            snapshot = self._timer_state

        self._notify_timer(snapshot)

    def stop_timer(self) -> None:
        """Stop and reset the timer without marking it as completed."""

        with self._lock:
            if (
                not self._timer_state.active
                and self._timer_state.remaining_seconds == 0
                and self._timer_state.completed_at is None
            ):
                return
            self._timer_state = TimerState()
            snapshot = self._timer_state

        self._notify_timer(snapshot)

    def decrement_timer(self) -> int:
        """Decrease the remaining seconds and notify listeners."""

        with self._lock:
            state = self._timer_state
            if not state.active:
                return state.remaining_seconds

            remaining = max(0, state.remaining_seconds - 1)
            if remaining == 0:
                self._timer_state = TimerState(
                    remaining_seconds=0,
                    active=False,
                    started_at=state.started_at,
                    completed_at=time.time(),
                )
            else:
                self._timer_state = TimerState(
                    remaining_seconds=remaining,
                    active=True,
                    started_at=state.started_at,
                    completed_at=None,
                )
            snapshot = self._timer_state

        self._notify_timer(snapshot)
        return remaining

    def _notify_timer(self, snapshot: TimerState) -> None:
        for listener in list(self._timer_listeners):
            try:
                listener(snapshot)
            except Exception:
                continue
