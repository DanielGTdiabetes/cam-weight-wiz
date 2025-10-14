from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Deque, Dict, Iterable, Optional, Sequence, Tuple

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from backend.app.services.settings_service import get_settings_service
from backend.core.events import GlucoseUpdateEvent, coach_event_bus

logger = logging.getLogger("bascula.diabetes")

router = APIRouter(prefix="/api/diabetes", tags=["diabetes"])

Trend = Optional[str]


@dataclass(slots=True)
class GlucoseStatus:
    enabled: bool
    nightscout_connected: bool
    mgdl: Optional[int]
    trend: Trend
    updated_at: Optional[datetime]

    def as_dict(self) -> Dict[str, object]:
        return {
            "enabled": self.enabled,
            "nightscout_connected": self.nightscout_connected,
            "mgdl": self.mgdl,
            "trend": self.trend,
            "updated_at": _isoformat(self.updated_at),
        }


def _isoformat(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_entry(raw: Dict[str, object]) -> Optional[Tuple[datetime, float]]:
    value = raw.get("sgv")
    if value is None:
        return None
    try:
        mgdl = float(value)
    except (TypeError, ValueError):
        return None

    dt: Optional[datetime] = None
    if "date" in raw:
        try:
            timestamp_ms = float(raw["date"]) / 1000.0
            dt = datetime.fromtimestamp(timestamp_ms, tz=timezone.utc)
        except (TypeError, ValueError, OSError):
            dt = None
    if dt is None:
        raw_ts = raw.get("dateString")
        if isinstance(raw_ts, str):
            candidate = raw_ts.strip()
            if candidate.endswith("Z"):
                candidate = candidate[:-1] + "+00:00"
            try:
                dt = datetime.fromisoformat(candidate)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                else:
                    dt = dt.astimezone(timezone.utc)
            except ValueError:
                dt = None

    if dt is None:
        return None
    return dt, mgdl


class GlucoseMonitor:
    """Poll Nightscout and expose a cached status with SSE updates."""

    def __init__(self) -> None:
        self._settings_service = get_settings_service()
        self._status_lock = asyncio.Lock()
        self._refresh_lock = asyncio.Lock()
        self._status: Optional[GlucoseStatus] = None
        self._last_refresh: Optional[datetime] = None
        self._history: Deque[Tuple[datetime, float]] = deque(maxlen=3)
        self._task: Optional[asyncio.Task[None]] = None
        self._stop_event: Optional[asyncio.Event] = None
        self._subscribers: set[asyncio.Queue[Dict[str, object]]] = set()
        self._sub_lock = asyncio.Lock()
        self._last_event_payload: Optional[Tuple[Optional[int], Optional[str]]] = None
        self._last_event_time: float = 0.0
        self._badge_visible = False

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(self._run(), name="glucose-monitor")

    async def stop(self) -> None:
        if self._stop_event is None:
            return
        self._stop_event.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        self._stop_event = None

    async def subscribe(self) -> asyncio.Queue[Dict[str, object]]:
        await self.start()
        queue: asyncio.Queue[Dict[str, object]] = asyncio.Queue(maxsize=8)
        async with self._sub_lock:
            self._subscribers.add(queue)
        return queue

    async def unsubscribe(self, queue: asyncio.Queue[Dict[str, object]]) -> None:
        async with self._sub_lock:
            self._subscribers.discard(queue)

    async def get_snapshot(self, *, force_refresh: bool = False) -> GlucoseStatus:
        await self.start()
        status = await self._refresh(force=force_refresh)
        async with self._status_lock:
            return replace(status if status is not None else self._status or self._empty_status())

    async def _run(self) -> None:
        assert self._stop_event is not None
        while not self._stop_event.is_set():
            try:
                status = await self._refresh()
            except Exception:  # pragma: no cover - defensive
                logger.exception("GLUCOSE monitor tick failed")
                status = None
            interval = 30.0
            if status is not None and status.enabled:
                interval = 15.0
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=interval)
            except asyncio.TimeoutError:
                continue

    async def _refresh(self, *, force: bool = False) -> Optional[GlucoseStatus]:
        now = datetime.now(timezone.utc)
        async with self._refresh_lock:
            if not force and self._last_refresh is not None and self._status is not None:
                if (now - self._last_refresh) < timedelta(seconds=5):
                    return self._status
            try:
                settings = await asyncio.to_thread(self._settings_service.load)
            except Exception:
                logger.exception("GLUCOSE failed to load settings")
                new_status = self._empty_status()
                self._last_refresh = now
                await self._apply_status(new_status)
                return new_status

            diabetes = settings.diabetes
            ns_url = (diabetes.nightscout_url or "").strip()
            ns_token = (diabetes.nightscout_token or "").strip()
            enabled = bool(diabetes.enabled and ns_url)
            if not enabled:
                new_status = GlucoseStatus(
                    enabled=False,
                    nightscout_connected=False,
                    mgdl=None,
                    trend=None,
                    updated_at=None,
                )
                self._history.clear()
                self._last_refresh = now
                await self._apply_status(new_status)
                return new_status

            try:
                entries = await self._fetch_entries(ns_url, ns_token)
            except Exception:
                logger.warning("GLUCOSE Nightscout fetch failed", exc_info=True)
                new_status = GlucoseStatus(
                    enabled=True,
                    nightscout_connected=False,
                    mgdl=None,
                    trend=None,
                    updated_at=None,
                )
                self._last_refresh = now
                await self._apply_status(new_status)
                return new_status

            if not entries:
                new_status = GlucoseStatus(
                    enabled=True,
                    nightscout_connected=False,
                    mgdl=None,
                    trend=None,
                    updated_at=None,
                )
                self._last_refresh = now
                await self._apply_status(new_status)
                return new_status

            entries = deque(sorted(entries, key=lambda item: item[0]), maxlen=3)
            latest_dt, latest_value = entries[-1]
            if (now - latest_dt) > timedelta(minutes=10):
                new_status = GlucoseStatus(
                    enabled=True,
                    nightscout_connected=False,
                    mgdl=None,
                    trend=None,
                    updated_at=latest_dt,
                )
                self._last_refresh = now
                await self._apply_status(new_status)
                return new_status

            mgdl = int(round(latest_value))
            trend = self._compute_trend(entries)
            self._history = entries
            new_status = GlucoseStatus(
                enabled=True,
                nightscout_connected=True,
                mgdl=mgdl,
                trend=trend,
                updated_at=latest_dt,
            )
            self._last_refresh = now
            await self._apply_status(new_status)
            return new_status

    async def _apply_status(self, status: GlucoseStatus) -> None:
        async with self._status_lock:
            previous = self._status
            self._status = status
        await self._handle_state_change(previous, status)

    async def _handle_state_change(
        self,
        previous: Optional[GlucoseStatus],
        current: GlucoseStatus,
    ) -> None:
        visible = current.enabled and current.nightscout_connected
        if not visible and self._badge_visible:
            if not current.enabled:
                logger.info("GLUCOSE[badge] hidden (disabled)")
            else:
                logger.info("GLUCOSE[badge] hidden (disconnected)")
        self._badge_visible = visible

        if previous and previous.enabled and not current.enabled:
            await self._broadcast_event(None, None, datetime.now(timezone.utc))
            self._last_event_payload = (None, None)
            self._last_event_time = time.monotonic()

        if current.enabled and current.nightscout_connected and current.mgdl is not None:
            await self._maybe_emit_update(previous, current)
        elif previous and previous.nightscout_connected and not current.nightscout_connected:
            await self._broadcast_event(None, None, datetime.now(timezone.utc))
            self._last_event_payload = (None, None)
            self._last_event_time = time.monotonic()

    async def _maybe_emit_update(
        self,
        previous: Optional[GlucoseStatus],
        current: GlucoseStatus,
    ) -> None:
        if current.mgdl is None:
            return
        last_mgdl: Optional[int]
        last_trend: Optional[str]
        if previous and previous.nightscout_connected and previous.mgdl is not None:
            last_mgdl = previous.mgdl
            last_trend = previous.trend
        elif self._last_event_payload is not None:
            last_mgdl, last_trend = self._last_event_payload
        else:
            last_mgdl = None
            last_trend = None

        should_emit = last_mgdl is None
        if not should_emit and last_mgdl is not None:
            if abs(current.mgdl - last_mgdl) > 2:
                should_emit = True
        if not should_emit and current.trend != last_trend:
            should_emit = True
        if not should_emit and previous and previous.updated_at != current.updated_at:
            should_emit = True

        now_monotonic = time.monotonic()
        if should_emit and (now_monotonic - self._last_event_time) < 3.0:
            should_emit = False

        if not should_emit:
            return

        logger.info(
            "GLUCOSE[update] %s mg/dL (%s)",
            current.mgdl,
            current.trend or "flat",
        )
        await self._broadcast_event(
            current.mgdl,
            current.trend or "flat",
            current.updated_at or datetime.now(timezone.utc),
        )
        coach_event_bus.publish(
            GlucoseUpdateEvent(
                mgdl=float(current.mgdl),
                trend=current.trend or "flat",
            )
        )
        self._last_event_payload = (current.mgdl, current.trend or "flat")
        self._last_event_time = now_monotonic

    async def _broadcast_event(
        self,
        mgdl: Optional[int],
        trend: Optional[str],
        timestamp: datetime,
    ) -> None:
        payload = {
            "type": "glucose_update",
            "mgdl": mgdl,
            "trend": trend,
            "ts": _isoformat(timestamp),
        }
        async with self._sub_lock:
            subscribers = list(self._subscribers)
        for queue in subscribers:
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait(payload)
                except asyncio.QueueFull:
                    continue

    async def _fetch_entries(
        self,
        base_url: str,
        token: str,
    ) -> Sequence[Tuple[datetime, float]]:
        url = f"{base_url.rstrip('/')}/api/v1/entries.json"
        headers: Dict[str, str] = {}
        if token:
            headers["API-SECRET"] = token
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(url, params={"count": 3}, headers=headers)
            response.raise_for_status()
            data = response.json()
        entries: list[Tuple[datetime, float]] = []
        if isinstance(data, Iterable):
            for raw in data:
                if isinstance(raw, dict):
                    parsed = _parse_entry(raw)
                    if parsed is not None:
                        entries.append(parsed)
        return entries

    def _compute_trend(
        self, entries: Sequence[Tuple[datetime, float]]
    ) -> Optional[str]:
        if len(entries) < 2:
            return None
        start_dt, start_value = entries[0]
        end_dt, end_value = entries[-1]
        minutes = (end_dt - start_dt).total_seconds() / 60.0
        if minutes <= 0:
            minutes = 1.0
        slope = (end_value - start_value) / minutes
        if slope >= 3.0:
            return "up"
        if slope >= 1.0:
            return "up_slow"
        if slope <= -3.0:
            return "down"
        if slope <= -1.0:
            return "down_slow"
        return "flat"

    def _empty_status(self) -> GlucoseStatus:
        return GlucoseStatus(
            enabled=False,
            nightscout_connected=False,
            mgdl=None,
            trend=None,
            updated_at=None,
        )


glucose_monitor = GlucoseMonitor()


@router.on_event("startup")
async def _startup() -> None:
    await glucose_monitor.start()


@router.on_event("shutdown")
async def _shutdown() -> None:
    await glucose_monitor.stop()


@router.get("/status")
async def diabetes_status() -> JSONResponse:
    status = await glucose_monitor.get_snapshot()
    return JSONResponse(status.as_dict())


@router.get("/events")
async def diabetes_events(request: Request) -> StreamingResponse:
    queue = await glucose_monitor.subscribe()

    async def event_stream():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=10.0)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                data = json.dumps(payload, ensure_ascii=False)
                yield "event: glucose_update\n"
                yield f"data: {data}\n\n"
        finally:
            await glucose_monitor.unsubscribe(queue)

    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)


__all__ = ["router", "glucose_monitor", "GlucoseStatus"]
