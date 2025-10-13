from __future__ import annotations

import asyncio
import logging
import queue
import threading
import time
from typing import Callable, Optional

from backend.core.events import (
    CoachEvent,
    FoodScannedEvent,
    GlucoseUpdateEvent,
    NutritionUpdatedEvent,
    TareDoneEvent,
    WeightStableEvent,
    coach_event_bus,
)
from backend.models.settings import AppSettings, load_settings
from backend.services.voice_service import voice_service

logger = logging.getLogger("bascula.voice.coach")

SettingsProvider = Callable[[], AppSettings]


class BasculinCoach:
    """Listen to contextual events and decide when Basculín should speak."""

    def __init__(self, settings_provider: Optional[SettingsProvider] = None) -> None:
        self._settings_provider = settings_provider or (lambda: load_settings({}))
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._subscription: Optional[tuple[int, queue.Queue[CoachEvent]]] = None
        self._last_spoken: dict[str, float] = {}
        self._last_weight_announcement: float = 0.0
        self._last_weight_value: Optional[float] = None
        self._last_low_alert: float = 0.0
        self._last_low_warn: float = 0.0
        self._last_high_alert: float = 0.0
        self._last_rule1515: float = 0.0

    # ------------------------------------------------------------------
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        token, event_queue = coach_event_bus.subscribe()
        self._subscription = (token, event_queue)
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, args=(event_queue,), name="basculin-coach", daemon=True)
        self._thread.start()
        logger.info("COACH service started")

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1.5)
        if self._subscription:
            token, _ = self._subscription
            coach_event_bus.unsubscribe(token)
        self._subscription = None
        self._thread = None
        logger.info("COACH service stopped")

    def reload_settings(self, provider: SettingsProvider) -> None:
        self._settings_provider = provider

    # ------------------------------------------------------------------
    def _run(self, event_queue: queue.Queue[CoachEvent]) -> None:
        while not self._stop.is_set():
            try:
                event = event_queue.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                self._handle_event(event)
            except Exception:  # pragma: no cover - defensive
                logger.exception("COACH failed processing event")

    def _handle_event(self, event: CoachEvent) -> None:
        if isinstance(event, FoodScannedEvent):
            self._handle_food_scanned(event)
        elif isinstance(event, NutritionUpdatedEvent):
            self._handle_nutrition_updated(event)
        elif isinstance(event, TareDoneEvent):
            self._handle_tare_done(event)
        elif isinstance(event, WeightStableEvent):
            self._handle_weight_stable(event)
        elif isinstance(event, GlucoseUpdateEvent):
            self._handle_glucose_update(event)

    # ------------------------------------------------------------------
    def _handle_food_scanned(self, event: FoodScannedEvent) -> None:
        name = event.name.strip() if event.name else ""
        if not name:
            return

        key = f"food:{name.lower()}"
        if not self._should_speak(key, cooldown=5.0):
            return

        message = f"He detectado {name}."
        self._speak(message)

    def _handle_nutrition_updated(self, event: NutritionUpdatedEvent) -> None:
        totals = event.total or {}
        kcal = totals.get("kcal") or totals.get("calories") or 0
        carbs = totals.get("carbs") or totals.get("carbohydrates") or 0
        protein = totals.get("protein") or totals.get("proteins") or 0
        fat = totals.get("fat") or totals.get("fats") or 0

        key = "nutrition:totals"
        if not self._should_speak(key, cooldown=8.0):
            return

        message = (
            f"Totales: {kcal:.0f} kilocalorías, {carbs:.1f} gramos de hidratos, "
            f"{protein:.1f} gramos de proteína, {fat:.1f} gramos de grasa."
        )
        self._speak(message)

    def _handle_tare_done(self, event: TareDoneEvent) -> None:  # noqa: D401
        if not self._should_speak("tare", cooldown=5.0):
            return
        self._speak("Tara puesta.")

    def _handle_weight_stable(self, event: WeightStableEvent) -> None:
        now = time.monotonic()
        grams = event.grams
        if (now - self._last_weight_announcement) < 10.0:
            return
        if self._last_weight_value is not None and abs(self._last_weight_value - grams) < 0.1:
            # Avoid repeating for the same weight
            return
        self._last_weight_value = grams
        self._last_weight_announcement = now
        self._speak("Peso estable.")

    def _handle_glucose_update(self, event: GlucoseUpdateEvent) -> None:
        settings = self._settings_provider()
        diabetes = settings.diabetes
        if not diabetes.enabled:
            return
        mgdl = event.mgdl
        now = time.monotonic()

        if mgdl <= diabetes.low_thresh:
            if (now - self._last_low_alert) > 60.0:
                self._last_low_alert = now
                self._speak(f"Glucosa baja: {mgdl:.0f}.")
            self._maybe_run_rule_1515(now)
            return

        if mgdl < diabetes.low_warn:
            if (now - self._last_low_warn) > 90.0:
                self._last_low_warn = now
                self._speak(f"Precaución, glucosa en {mgdl:.0f}.")
            return

        if mgdl >= diabetes.high_thresh and (now - self._last_high_alert) > 90.0:
            self._last_high_alert = now
            self._speak(f"Glucosa alta: {mgdl:.0f}.")

    # ------------------------------------------------------------------
    def _maybe_run_rule_1515(self, now: float) -> None:
        settings = self._settings_provider()
        diabetes = settings.diabetes
        if not diabetes.rule_15.enabled:
            return
        if (now - self._last_rule1515) < 300.0:
            return
        self._last_rule1515 = now
        self._speak("Toma quince gramos de hidratos rápidos.")
        self._speak("Espera quince minutos y vuelve a medir.")
        self._speak("Si sigue baja la glucosa, repite el proceso.")

    def _should_speak(self, key: str, *, cooldown: float) -> bool:
        now = time.monotonic()
        last = self._last_spoken.get(key)
        if last is not None and (now - last) < cooldown:
            return False
        self._last_spoken[key] = now
        return True

    def _speak(self, text: str) -> None:
        if not text:
            return
        logger.info("COACH[speak] %s", text)
        try:
            asyncio.run(voice_service.say(text))
        except RuntimeError:
            # Fallback if event loop already running in this thread
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(voice_service.say(text))
            finally:
                loop.close()
        except Exception:  # pragma: no cover - defensive
            logger.exception("COACH failed to speak text")


basculin_coach = BasculinCoach()

__all__ = ["basculin_coach", "BasculinCoach"]
