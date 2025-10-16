from __future__ import annotations

import queue
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Dict, Iterable, Optional, Tuple, Union


@dataclass(frozen=True, slots=True)
class FoodScannedEvent:
    name: str
    nutrients: Dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class NutritionUpdatedEvent:
    total: Dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class GlucoseUpdateEvent:
    mgdl: float
    trend: Optional[str] = None


@dataclass(frozen=True, slots=True)
class WeightStableEvent:
    grams: float


@dataclass(frozen=True, slots=True)
class TareDoneEvent:
    pass


CoachEvent = Union[
    FoodScannedEvent,
    NutritionUpdatedEvent,
    GlucoseUpdateEvent,
    WeightStableEvent,
    TareDoneEvent,
]


def _event_name(event: CoachEvent) -> str:
    name = type(event).__name__
    if name.endswith("Event"):
        name = name[:-5]  # strip trailing "Event"
    # Normalize to kebab-case for SSE event names
    out = []
    for index, char in enumerate(name):
        if char.isupper() and index:
            out.append("-")
        out.append(char.lower())
    return "".join(out)


class CoachEventBus:
    """Simple pub/sub bus with rate limiting per event type."""

    def __init__(
        self,
        *,
        default_rate: float = 5.0,
        rate_overrides: Optional[Dict[str, float]] = None,
        queue_size: int = 32,
    ) -> None:
        self._lock = threading.Lock()
        self._subscribers: Dict[int, queue.Queue[CoachEvent]] = {}
        self._next_token = 1
        self._queue_size = max(1, queue_size)
        self._last_emit: Dict[str, float] = {}
        self._default_rate = max(0.0, float(default_rate))
        overrides = rate_overrides or {}
        self._rate_overrides = {
            key: max(0.0, float(value)) for key, value in overrides.items()
        }

    def subscribe(self) -> Tuple[int, queue.Queue[CoachEvent]]:
        subscriber_queue: queue.Queue[CoachEvent] = queue.Queue(self._queue_size)
        with self._lock:
            token = self._next_token
            self._next_token += 1
            self._subscribers[token] = subscriber_queue
        return token, subscriber_queue

    def unsubscribe(self, token: int) -> None:
        with self._lock:
            self._subscribers.pop(token, None)

    def publish(self, event: CoachEvent, *, force: bool = False) -> bool:
        event_type = _event_name(event)
        now = time.monotonic()
        with self._lock:
            if not force:
                rate_limit = self._rate_overrides.get(event_type, self._default_rate)
                if rate_limit > 0:
                    last = self._last_emit.get(event_type)
                    if last is not None and (now - last) < rate_limit:
                        return False
            self._last_emit[event_type] = now
            subscribers = list(self._subscribers.values())

        for subscriber_queue in subscribers:
            try:
                subscriber_queue.put_nowait(event)
            except queue.Full:
                # Drop if subscriber is slow; they can reconnect.
                continue

        return True

    @staticmethod
    def serialize(event: CoachEvent) -> Dict[str, object]:
        payload = asdict(event)
        payload["type"] = _event_name(event)
        payload["ts"] = time.time()
        return payload

    def broadcast_snapshot(self, events: Iterable[CoachEvent]) -> None:
        for event in events:
            self.publish(event, force=True)


coach_event_bus = CoachEventBus(
    rate_overrides={
        "weight-stable": 10.0,
        "tare-done": 5.0,
        "glucose-update": 3.0,
    }
)

__all__ = [
    "CoachEventBus",
    "coach_event_bus",
    "CoachEvent",
    "FoodScannedEvent",
    "NutritionUpdatedEvent",
    "GlucoseUpdateEvent",
    "WeightStableEvent",
    "TareDoneEvent",
]
