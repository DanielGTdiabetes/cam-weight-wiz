"""HX711 scale service with pigpio/RPi.GPIO backends and moving average filter."""
from __future__ import annotations

import json
import logging
import math
import os
import statistics
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Deque, Dict, List, Optional, Sequence, Tuple

try:  # pragma: no cover - optional dependency
    import lgpio  # type: ignore
except ImportError:  # pragma: no cover - handled dynamically
    lgpio = None  # type: ignore

LOG_DIR = Path("/var/log/bascula")
STATE_PATH = Path(os.getenv("BASCULA_SCALE_STATE", "/var/lib/bascula/scale.json"))
DEFAULT_CALIBRATION = 1.0
DEFAULT_CALIBRATION_OFFSET = 0.0
DEFAULT_CALIBRATION_SCALE = 1.0
DEFAULT_TARE = 0.0
DEFAULT_MEDIAN_WINDOW = 5
DEFAULT_EMA_ALPHA = 0.2
DEFAULT_HYSTERESIS_GRAMS = 2.0
DEFAULT_DEBOUNCE_MS = 100
DEFAULT_VARIANCE_WINDOW = 10
DEFAULT_VARIANCE_THRESHOLD = 1.0
DEFAULT_RECONNECT_MAX_BACKOFF = 30.0
DEFAULT_WATCHDOG_TIMEOUT = 5.0
DEFAULT_REFRACTORY_SEC = 0.3
EMA_EPSILON = 1e-6


def _setup_logger() -> logging.Logger:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("bascula.scale")
    if not logger.handlers:
        logger.setLevel(logging.INFO)
        handler = logging.FileHandler(LOG_DIR / "app.log")
        formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
        handler.setFormatter(formatter)
        logger.addHandler(handler)
    return logger


LOGGER = _setup_logger()


class HX711Error(Exception):
    """Base exception for HX711 errors."""


class HX711ReadTimeout(HX711Error):
    """Raised when waiting for HX711 data ready times out."""


class _LGPIODriver:
    """Low level HX711 reader backed by lgpio."""

    def __init__(self, dt_pin: int, sck_pin: int) -> None:
        if lgpio is None:  # pragma: no cover - hardware specific
            raise ImportError("lgpio module not available")

        self._lgpio = lgpio
        try:
            self._lgpio.exceptions = True  # type: ignore[attr-defined]
        except Exception:  # pragma: no cover - best effort
            pass

        self._chip = self._lgpio.gpiochip_open(0)
        self._dt_pin = dt_pin
        self._sck_pin = sck_pin

        try:
            pull_up_flag = getattr(self._lgpio, "SET_PULL_UP", None)
            if pull_up_flag is not None:
                try:
                    self._lgpio.gpio_claim_input(self._chip, self._dt_pin, pull_up_flag)
                except Exception:
                    self._lgpio.gpio_claim_input(self._chip, self._dt_pin)
            else:
                self._lgpio.gpio_claim_input(self._chip, self._dt_pin)

            self._lgpio.gpio_claim_output(self._chip, self._sck_pin, 0)
        except Exception:
            self.cleanup()
            raise

    def wait_ready(self, timeout: float = 0.5) -> None:
        start = time.perf_counter()
        while time.perf_counter() - start < timeout:
            if self._lgpio.gpio_read(self._chip, self._dt_pin) == 0:
                return
            time.sleep(0.0002)
        raise HX711ReadTimeout("HX711 ready timeout")

    def read_raw(self) -> float:
        self.wait_ready()
        value = 0
        for _ in range(24):
            self._lgpio.gpio_write(self._chip, self._sck_pin, 1)
            value = (value << 1) | self._lgpio.gpio_read(self._chip, self._dt_pin)
            self._lgpio.gpio_write(self._chip, self._sck_pin, 0)
        self._lgpio.gpio_write(self._chip, self._sck_pin, 1)
        self._lgpio.gpio_write(self._chip, self._sck_pin, 0)

        if value & 0x800000:
            value -= 1 << 24
        return float(value)

    def cleanup(self) -> None:
        if getattr(self, "_chip", None) is None:
            return
        try:
            self._lgpio.gpio_write(self._chip, self._sck_pin, 0)
        except Exception:  # pragma: no cover - best effort
            pass
        try:
            self._lgpio.gpio_free(self._chip, self._dt_pin)
        except Exception:  # pragma: no cover - best effort
            pass
        try:
            self._lgpio.gpio_free(self._chip, self._sck_pin)
        except Exception:  # pragma: no cover - best effort
            pass
        try:
            self._lgpio.gpiochip_close(self._chip)
        except Exception:  # pragma: no cover - best effort
            pass
        self._chip = None


class _PigpioDriver:
    """Low level HX711 reader backed by pigpio."""

    def __init__(self, dt_pin: int, sck_pin: int) -> None:
        try:
            import pigpio  # type: ignore
        except ImportError as exc:  # pragma: no cover - hardware specific
            raise ImportError("pigpio module not available") from exc

        self._pigpio = pigpio
        self._pi = pigpio.pi()
        if not self._pi.connected:
            self._pi.stop()
            raise RuntimeError("pigpiod daemon not reachable")

        self._dt_pin = dt_pin
        self._sck_pin = sck_pin
        self._pi.set_mode(self._dt_pin, pigpio.INPUT)
        self._pi.set_pull_up_down(self._dt_pin, pigpio.PUD_UP)
        self._pi.set_mode(self._sck_pin, pigpio.OUTPUT)
        self._pi.write(self._sck_pin, 0)

    def wait_ready(self, timeout: float = 0.5) -> None:
        start = time.perf_counter()
        while time.perf_counter() - start < timeout:
            if self._pi.read(self._dt_pin) == 0:  # type: ignore[union-attr]
                return
            time.sleep(0.0002)
        raise HX711ReadTimeout("HX711 ready timeout")

    def read_raw(self) -> float:
        self.wait_ready()
        value = 0
        for _ in range(24):
            self._pi.write(self._sck_pin, 1)  # type: ignore[union-attr]
            value = (value << 1) | self._pi.read(self._dt_pin)  # type: ignore[union-attr]
            self._pi.write(self._sck_pin, 0)  # type: ignore[union-attr]
        self._pi.write(self._sck_pin, 1)  # type: ignore[union-attr]
        self._pi.write(self._sck_pin, 0)  # type: ignore[union-attr]

        if value & 0x800000:
            value -= 1 << 24
        return float(value)

    def cleanup(self) -> None:
        try:
            self._pi.write(self._sck_pin, 0)
        except Exception:  # pragma: no cover - best effort
            pass
        try:
            self._pi.stop()
        except Exception:  # pragma: no cover - best effort
            pass


class _RPiGPIODriver:
    """Low level HX711 reader backed by RPi.GPIO."""

    def __init__(self, dt_pin: int, sck_pin: int) -> None:
        try:
            import RPi.GPIO as GPIO  # type: ignore
        except ImportError as exc:  # pragma: no cover - hardware specific
            raise ImportError("RPi.GPIO module not available") from exc

        self._GPIO = GPIO
        self._GPIO.setwarnings(False)
        self._GPIO.setmode(GPIO.BCM)

        self._dt_pin = dt_pin
        self._sck_pin = sck_pin

        self._GPIO.setup(self._dt_pin, GPIO.IN, pull_up_down=GPIO.PUD_UP)
        self._GPIO.setup(self._sck_pin, GPIO.OUT)
        self._GPIO.output(self._sck_pin, False)

    def wait_ready(self, timeout: float = 0.5) -> None:
        start = time.perf_counter()
        while time.perf_counter() - start < timeout:
            if self._GPIO.input(self._dt_pin) == 0:  # type: ignore[union-attr]
                return
            time.sleep(0.0005)
        raise HX711ReadTimeout("HX711 ready timeout")

    def read_raw(self) -> float:
        self.wait_ready()
        value = 0
        for _ in range(24):
            self._GPIO.output(self._sck_pin, True)  # type: ignore[union-attr]
            value = (value << 1) | self._GPIO.input(self._dt_pin)  # type: ignore[union-attr]
            self._GPIO.output(self._sck_pin, False)  # type: ignore[union-attr]
        self._GPIO.output(self._sck_pin, True)  # type: ignore[union-attr]
        self._GPIO.output(self._sck_pin, False)  # type: ignore[union-attr]

        if value & 0x800000:
            value -= 1 << 24
        return float(value)

    def cleanup(self) -> None:
        try:
            self._GPIO.output(self._sck_pin, False)
        except Exception:  # pragma: no cover - best effort
            pass
        try:
            self._GPIO.cleanup((self._dt_pin, self._sck_pin))
        except Exception:  # pragma: no cover - best effort
            pass


class HX711Service:
    """Background service that reads HX711 data and exposes filtered readings."""

    def __init__(
        self,
        dt_pin: int,
        sck_pin: int,
        *,
        calibration_factor: float = DEFAULT_CALIBRATION,
        calibration_offset: float = DEFAULT_CALIBRATION_OFFSET,
        calibration_scale: float = DEFAULT_CALIBRATION_SCALE,
        calibration_points: Optional[Sequence[Tuple[float, float]]] = None,
        tare_offset: float = DEFAULT_TARE,
        sample_rate_hz: float = 20.0,
        filter_window: int = 10,
        median_window: int = DEFAULT_MEDIAN_WINDOW,
        ema_alpha: float = DEFAULT_EMA_ALPHA,
        hysteresis_grams: float = DEFAULT_HYSTERESIS_GRAMS,
        debounce_ms: int = DEFAULT_DEBOUNCE_MS,
        variance_window: int = DEFAULT_VARIANCE_WINDOW,
        variance_threshold: float = DEFAULT_VARIANCE_THRESHOLD,
        reconnect_max_backoff: float = DEFAULT_RECONNECT_MAX_BACKOFF,
        watchdog_timeout: float = DEFAULT_WATCHDOG_TIMEOUT,
        refractory_sec: float = DEFAULT_REFRACTORY_SEC,
        persist_path: Path = STATE_PATH,
    ) -> None:
        self._dt_pin = int(dt_pin)
        self._sck_pin = int(sck_pin)
        self._sample_rate_hz = float(max(10.0, min(sample_rate_hz, 80.0)))
        self._filter_window = max(1, min(int(filter_window), 200))
        self._median_window = max(1, min(int(median_window), 251))
        self._variance_window = max(1, min(int(variance_window), 500))
        self._ema_alpha = float(ema_alpha)
        if not (EMA_EPSILON < self._ema_alpha <= 1.0):
            self._ema_alpha = DEFAULT_EMA_ALPHA
        self._ema_one_minus_alpha = 1.0 - self._ema_alpha
        self._hysteresis_grams = max(0.0, float(hysteresis_grams))
        self._debounce_seconds = max(0.0, float(debounce_ms) / 1000.0)
        self._refractory_seconds = max(0.0, float(refractory_sec))
        self._variance_threshold = max(0.0, float(variance_threshold))
        self._reconnect_max_backoff = max(1.0, float(reconnect_max_backoff))
        self._watchdog_timeout = max(0.0, float(watchdog_timeout))
        self._persist_path = persist_path

        self._driver: Optional[object] = None
        self._driver_name: Optional[str] = None
        self._driver_retry_at: Dict[str, float] = {"lgpio": 0.0, "pigpio": 0.0, "RPi.GPIO": 0.0}
        self._driver_backoff: Dict[str, float] = {"lgpio": 1.0, "pigpio": 1.0, "RPi.GPIO": 1.0}
        self._driver_errors: Dict[str, str] = {}
        self._last_driver_error: Optional[str] = None

        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._lock = threading.RLock()

        self._median_samples: Deque[float] = deque(maxlen=self._median_window)
        self._var_win: Deque[float] = deque(maxlen=self._variance_window)
        self._ema_value: Optional[float] = None
        self._last_raw: Optional[float] = None
        self._last_filtered_raw: Optional[float] = None
        self._last_avg: Optional[float] = None  # Backwards compatibility alias for filtered raw
        self._last_grams: Optional[float] = None
        self._last_instant_grams: Optional[float] = None
        self._candidate_grams: Optional[float] = None
        self._last_timestamp: Optional[float] = None
        self._last_publish_ts: Optional[float] = None
        self._last_change_ts: Optional[float] = None
        self._current_variance: Optional[float] = None
        self._is_stable = False
        self._last_sample_monotonic: Optional[float] = None

        self._status_ok = False
        self._status_reason = "Service not started"

        self._calibration_offset = float(calibration_offset) if calibration_offset is not None else DEFAULT_CALIBRATION_OFFSET
        self._calibration_scale = float(calibration_scale) if calibration_scale else DEFAULT_CALIBRATION_SCALE
        if abs(self._calibration_scale) < EMA_EPSILON:
            self._calibration_scale = DEFAULT_CALIBRATION_SCALE
        self._calibration_points: List[Tuple[float, float]] = []
        if calibration_points:
            self._calibration_points = [(float(raw), float(grams)) for raw, grams in calibration_points]
        self._calibration_factor = float(calibration_factor) if calibration_factor else DEFAULT_CALIBRATION
        self._calibration_from_config = (
            bool(calibration_points)
            or abs(self._calibration_offset) > EMA_EPSILON
            or abs(self._calibration_scale - DEFAULT_CALIBRATION_SCALE) > EMA_EPSILON
            or abs(self._calibration_factor - DEFAULT_CALIBRATION) > EMA_EPSILON
        )
        self._tare_offset = float(tare_offset) if tare_offset else DEFAULT_TARE

        self._sync_calibration_factor()

        self._load_persisted_state()

    # ------------------------------------------------------------------
    # Persistence helpers
    def _load_persisted_state(self) -> None:
        try:
            self._persist_path.parent.mkdir(parents=True, exist_ok=True)
        except Exception as exc:  # pragma: no cover - best effort directory creation
            LOGGER.error("Cannot create scale state directory: %s", exc)
        if not self._persist_path.exists():
            return
        try:
            raw_text = self._persist_path.read_text()
        except Exception as exc:
            LOGGER.error("Failed to read scale state: %s", exc)
            return

        try:
            data = json.loads(raw_text)
        except Exception as exc:
            LOGGER.error("Failed to load scale state: %s", exc)
            return

        tare_value = data.get("tare_offset")
        if tare_value is not None:
            try:
                self._tare_offset = float(tare_value)
            except (TypeError, ValueError):
                LOGGER.warning("Invalid tare_offset in persisted state: %s", tare_value)

        if not self._calibration_from_config:
            offset_value = data.get("calibration_offset")
            scale_value = data.get("calibration_scale")
            factor_value = data.get("calibration_factor")
            points_value = data.get("calibration_points")

            if offset_value is not None:
                try:
                    self._calibration_offset = float(offset_value)
                except (TypeError, ValueError):
                    LOGGER.warning("Invalid calibration_offset in persisted state: %s", offset_value)
            if scale_value is not None:
                try:
                    candidate_scale = float(scale_value)
                    if abs(candidate_scale) >= EMA_EPSILON:
                        self._calibration_scale = candidate_scale
                except (TypeError, ValueError):
                    LOGGER.warning("Invalid calibration_scale in persisted state: %s", scale_value)
            if factor_value is not None:
                try:
                    self._calibration_factor = float(factor_value)
                except (TypeError, ValueError):
                    LOGGER.warning("Invalid calibration_factor in persisted state: %s", factor_value)
            if isinstance(points_value, list):
                cleaned: List[Tuple[float, float]] = []
                for point in points_value:
                    if isinstance(point, dict):
                        raw = point.get("raw")
                        grams = point.get("grams")
                    elif isinstance(point, (list, tuple)) and len(point) >= 2:
                        raw, grams = point[:2]
                    else:
                        continue
                    try:
                        cleaned.append((float(raw), float(grams)))
                    except (TypeError, ValueError):
                        continue
                if cleaned:
                    self._calibration_points = cleaned

        self._sync_calibration_factor()

    def _persist_state(self) -> None:
        points_payload = [
            {"raw": raw, "grams": grams} for raw, grams in self._calibration_points
        ]
        payload = {
            "calibration_factor": self._calibration_factor,
            "calibration_offset": self._calibration_offset,
            "calibration_scale": self._calibration_scale,
            "calibration_points": points_payload,
            "tare_offset": self._tare_offset,
        }
        try:
            self._persist_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
        except Exception as exc:
            LOGGER.error("Failed to persist scale state: %s", exc)

    def _sync_calibration_factor(self) -> None:
        if abs(self._calibration_scale) >= EMA_EPSILON:
            self._calibration_factor = 1.0 / self._calibration_scale
        elif abs(self._calibration_factor) >= EMA_EPSILON:
            self._calibration_scale = 1.0 / self._calibration_factor
        else:
            self._calibration_scale = DEFAULT_CALIBRATION_SCALE
            self._calibration_factor = DEFAULT_CALIBRATION

    def _convert_raw_to_grams(self, raw_value: Optional[float]) -> Optional[float]:
        if raw_value is None:
            return None
        if abs(self._calibration_scale) < EMA_EPSILON:
            return None
        adjusted = raw_value - self._calibration_offset
        net = adjusted - self._tare_offset
        return net * self._calibration_scale

    def _ensure_var_window_capacity(self) -> None:
        if self._var_win.maxlen != self._variance_window:
            self._var_win = deque(self._var_win, maxlen=self._variance_window)

    def _evaluate_stability(self) -> Tuple[bool, Optional[float]]:
        samples = list(self._var_win)
        if self._variance_window <= 0 or len(samples) < self._variance_window:
            return False, None
        variance = statistics.pvariance(samples)
        return variance <= self._variance_threshold, variance

    def _reset_after_calibration(self) -> None:
        self._median_samples.clear()
        self._var_win = deque(maxlen=self._variance_window)
        self._ema_value = None
        self._last_filtered_raw = None
        self._last_avg = None
        self._last_grams = None
        self._last_instant_grams = None
        self._candidate_grams = None
        self._last_raw = None
        self._last_timestamp = None
        self._last_publish_ts = None
        self._last_change_ts = None
        self._current_variance = None
        self._is_stable = False
        self._last_sample_monotonic = None

    # ------------------------------------------------------------------
    # Lifecycle management
    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._thread = threading.Thread(target=self._run_loop, name="hx711-service", daemon=True)
            self._thread.start()
            self._status_ok = False
            self._status_reason = "Initializing"
            LOGGER.info(
                "HX711 service starting (DT=%s, SCK=%s, rate=%.2f Hz, median=%d, ema=%.2f, variance_window=%d)",
                self._dt_pin,
                self._sck_pin,
                self._sample_rate_hz,
                self._median_window,
                self._ema_alpha,
                self._variance_window,
            )

    def stop(self) -> None:
        with self._lock:
            if not self._thread:
                return
            self._stop_event.set()
            thread = self._thread
            self._thread = None
        thread.join(timeout=2)
        self._disconnect()
        LOGGER.info("HX711 service stopped")

    def _disconnect(self) -> None:
        if self._driver is not None:
            try:
                cleanup = getattr(self._driver, "cleanup")
                cleanup()
            except Exception:  # pragma: no cover - best effort cleanup
                pass
        self._driver = None
        self._driver_name = None

    # ------------------------------------------------------------------
    # Internal loop
    def _run_loop(self) -> None:
        interval = 1.0 / self._sample_rate_hz
        while not self._stop_event.is_set():
            if not self._ensure_driver():
                time.sleep(min(interval, 0.5))
                continue
            monotonic_now = time.monotonic()
            if (
                self._watchdog_timeout > 0.0
                and self._driver is not None
                and self._last_sample_monotonic is not None
                and monotonic_now - self._last_sample_monotonic > self._watchdog_timeout
            ):
                LOGGER.warning(
                    "HX711 watchdog triggered after %.2fs without samples; resetting driver",
                    monotonic_now - self._last_sample_monotonic,
                )
                self._disconnect()
                self._set_status(False, "watchdog_reset")
                time.sleep(min(interval, 0.5))
                continue
            try:
                raw = self._read_from_driver()
            except HX711ReadTimeout:
                self._last_driver_error = "hx711_timeout"
                self._set_status(False, "hx711_timeout")
                time.sleep(interval)
                continue
            except Exception as exc:  # pragma: no cover - unexpected errors
                LOGGER.error("Unexpected HX711 error: %s", exc)
                self._last_driver_error = str(exc)
                self._disconnect()
                self._set_status(False, f"driver_error: {exc}")
                time.sleep(interval)
                continue

            self._record_sample(raw)
            self._set_status(True, None)
            self._last_driver_error = None
            time.sleep(interval)

    def _create_driver(self, kind: str):
        if kind == "lgpio":
            return _LGPIODriver(self._dt_pin, self._sck_pin)
        if kind == "pigpio":
            return _PigpioDriver(self._dt_pin, self._sck_pin)
        if kind == "RPi.GPIO":
            return _RPiGPIODriver(self._dt_pin, self._sck_pin)
        raise ValueError(f"Unknown driver: {kind}")

    def _ensure_driver(self) -> bool:
        if self._driver is not None:
            return True

        now = time.monotonic()
        reasons = []
        for kind in ("lgpio", "pigpio", "RPi.GPIO"):
            retry_at = self._driver_retry_at.get(kind, 0.0)
            if now < retry_at:
                if kind in self._driver_errors:
                    reasons.append(self._driver_errors[kind])
                continue
            try:
                driver = self._create_driver(kind)
            except ImportError as exc:
                message = f"{kind} unavailable: {exc}"
                LOGGER.error(message)
                self._driver_errors[kind] = message
                backoff = min(self._driver_backoff.get(kind, 1.0) * 2.0, self._reconnect_max_backoff)
                self._driver_backoff[kind] = backoff
                self._driver_retry_at[kind] = now + backoff
                reasons.append(message)
                continue
            except Exception as exc:
                message = f"{kind} init failed: {exc}"
                LOGGER.error(message)
                self._driver_errors[kind] = message
                backoff = min(self._driver_backoff.get(kind, 1.0) * 2.0, self._reconnect_max_backoff)
                self._driver_backoff[kind] = backoff
                self._driver_retry_at[kind] = now + backoff
                reasons.append(message)
                continue

            self._driver = driver
            self._driver_name = kind
            self._driver_errors.pop(kind, None)
            self._driver_backoff[kind] = 1.0
            self._driver_retry_at[kind] = now
            LOGGER.info("HX711 driver initialized using %s", kind)
            self._last_driver_error = None
            return True

        if reasons:
            self._last_driver_error = "; ".join(reasons)
            self._set_status(False, self._last_driver_error)
        else:
            self._set_status(False, "driver_unavailable")
        return False

    def _read_from_driver(self) -> float:
        if self._driver is None:
            raise HX711Error("driver_not_initialized")
        read_raw = getattr(self._driver, "read_raw", None)
        if read_raw is None:
            raise HX711Error("driver_missing_read_raw")
        return float(read_raw())

    def _record_sample(self, raw: float) -> None:
        monotonic_now = time.monotonic()
        wall_now = time.time()
        with self._lock:
            self._last_raw = raw
            self._last_timestamp = wall_now
            self._last_sample_monotonic = monotonic_now

            # Filtering pipeline: median smoothing followed by EMA low-pass
            self._median_samples.append(raw)
            if len(self._median_samples) <= 1:
                median_value = raw
            else:
                median_value = statistics.median(self._median_samples)

            if self._ema_value is None:
                ema_value = median_value
            else:
                ema_value = (self._ema_alpha * median_value) + (self._ema_one_minus_alpha * self._ema_value)
            self._ema_value = ema_value
            self._last_filtered_raw = ema_value
            self._last_avg = ema_value

            instant_grams = self._convert_raw_to_grams(raw)
            filtered_grams = self._convert_raw_to_grams(ema_value)
            self._last_instant_grams = instant_grams
            self._candidate_grams = filtered_grams

            self._ensure_var_window_capacity()
            if filtered_grams is None:
                self._current_variance = None
                self._is_stable = False
                self._last_change_ts = None
                return

            self._var_win.append(filtered_grams)
            stable, variance_value = self._evaluate_stability()
            self._current_variance = variance_value
            self._is_stable = stable

            current = filtered_grams

            if self._last_grams is None:
                self._last_grams = current
                self._last_publish_ts = wall_now
                self._last_change_ts = wall_now
                return

            delta = abs(current - self._last_grams)
            if delta < self._hysteresis_grams:
                self._last_change_ts = None
                return

            if self._last_change_ts is None:
                self._last_change_ts = wall_now

            if (wall_now - self._last_change_ts) < self._debounce_seconds:
                return

            if self._last_publish_ts is not None and (wall_now - self._last_publish_ts) < self._refractory_seconds:
                return

            self._last_grams = current
            self._last_publish_ts = wall_now
            self._last_change_ts = wall_now

    def _set_status(self, ok: bool, reason: Optional[str]) -> None:
        with self._lock:
            self._status_ok = ok
            self._status_reason = reason or ""

    # ------------------------------------------------------------------
    # Public API
    def get_status(self) -> dict:
        with self._lock:
            status = {
                "ok": self._status_ok,
                "backend": "gpio",
                "sampling_hz": self._sample_rate_hz,
                "calibration_factor": self._calibration_factor,
                "calibration_scale": self._calibration_scale,
                "calibration_offset": self._calibration_offset,
                "calibration_points": [{"raw": raw, "grams": grams} for raw, grams in self._calibration_points],
                "tare_offset": self._tare_offset,
                "pins": {"dt": self._dt_pin, "sck": self._sck_pin},
                "driver": self._driver_name,
                "variance_window": self._variance_window,
                "variance_threshold": self._variance_threshold,
                "variance": self._current_variance,
                "stable": self._is_stable,
                "hysteresis_grams": self._hysteresis_grams,
                "debounce_ms": int(self._debounce_seconds * 1000),
                "refractory_sec": self._refractory_seconds,
            }
            if not self._status_ok:
                status["reason"] = self._status_reason or "not_ready"
            if self._last_driver_error:
                status["driver_error"] = self._last_driver_error
            return status

    def get_reading(self) -> dict:
        with self._lock:
            if not self._status_ok:
                return {"ok": False, "reason": self._status_reason or "not_ready"}
            if self._last_raw is None or self._last_timestamp is None:
                return {"ok": False, "reason": "no_data"}
            if abs(self._calibration_scale) < EMA_EPSILON:
                return {"ok": False, "reason": "calibration_scale_zero"}
            ts_iso = datetime.fromtimestamp(self._last_timestamp, tz=timezone.utc).isoformat()
            self._ensure_var_window_capacity()
            stable, variance = self._evaluate_stability()
            self._current_variance = variance
            self._is_stable = stable
            grams_value = self._last_grams if self._last_grams is not None else self._candidate_grams
            return {
                "ok": True,
                "grams": grams_value,
                "raw": self._last_raw,
                "filtered_raw": self._last_filtered_raw,
                "avg": self._last_avg,
                "instant": self._last_instant_grams,
                "candidate": self._candidate_grams,
                "stable": self._is_stable,
                "variance": self._current_variance,
                "ts": ts_iso,
            }

    def read_raw(self) -> Optional[float]:
        with self._lock:
            return self._last_raw

    def read_grams(self, *, instant: bool = False) -> Optional[float]:
        with self._lock:
            if instant:
                return self._last_instant_grams
            if self._last_grams is not None:
                return self._last_grams
            return self._candidate_grams

    def tare(self) -> dict:
        with self._lock:
            if self._last_filtered_raw is None:
                return {"ok": False, "reason": "no_data"}
            self._tare_offset = self._last_filtered_raw - self._calibration_offset
            self._median_samples.clear()
            self._var_win = deque(maxlen=self._variance_window)
            self._ema_value = None
            self._last_filtered_raw = None
            self._last_avg = None
            self._last_grams = None
            self._last_instant_grams = None
            self._last_raw = None
            self._last_timestamp = None
            self._last_publish_ts = None
            self._last_change_ts = None
            self._candidate_grams = None
            self._current_variance = None
            self._is_stable = False
            self._last_sample_monotonic = None
            self._persist_state()
            LOGGER.info("Tare set (raw offset %.6f)", self._tare_offset)
            return {"ok": True, "tare_offset": self._tare_offset}

    def calibrate(self, known_grams: float) -> dict:
        if known_grams <= 0:
            return {"ok": False, "reason": "known_grams_invalid"}
        with self._lock:
            reference_raw = self._last_filtered_raw if self._last_filtered_raw is not None else self._last_raw
            if reference_raw is None:
                return {"ok": False, "reason": "no_data"}
            adjusted = reference_raw - self._calibration_offset
            net_raw = adjusted - self._tare_offset
            if abs(net_raw) < EMA_EPSILON:
                return {"ok": False, "reason": "net_zero"}
            scale = known_grams / net_raw
            if abs(scale) < EMA_EPSILON:
                return {"ok": False, "reason": "scale_zero"}
            self._calibration_scale = scale
            self._sync_calibration_factor()
            self._calibration_points = [(reference_raw, known_grams)]
            self._calibration_from_config = False
            self._reset_after_calibration()
            self._persist_state()
            LOGGER.info(
                "Calibration updated (single-point): known=%.3f g -> scale=%.6f, offset=%.6f",
                known_grams,
                self._calibration_scale,
                self._calibration_offset,
            )
            return {
                "ok": True,
                "calibration_factor": self._calibration_factor,
                "calibration_scale": self._calibration_scale,
                "calibration_offset": self._calibration_offset,
                "tare_offset": self._tare_offset,
                "points": [{"raw": reference_raw, "grams": known_grams}],
            }

    def calibrate_from_points(self, points: Sequence[Tuple[float, float]]) -> dict:
        cleaned: List[Tuple[float, float]] = []
        for raw, grams in points:
            if raw is None or grams is None:
                continue
            if not (math.isfinite(raw) and math.isfinite(grams)):
                continue
            cleaned.append((float(raw), float(grams)))

        if len(cleaned) < 2:
            return {"ok": False, "reason": "not_enough_points"}

        sum_x = sum(raw for raw, _ in cleaned)
        sum_y = sum(grams for _, grams in cleaned)
        sum_x2 = sum(raw * raw for raw, _ in cleaned)
        sum_xy = sum(raw * grams for raw, grams in cleaned)
        n = len(cleaned)
        denominator = n * sum_x2 - (sum_x * sum_x)
        if abs(denominator) < EMA_EPSILON:
            return {"ok": False, "reason": "points_collinear"}

        slope = (n * sum_xy - sum_x * sum_y) / denominator
        if abs(slope) < EMA_EPSILON:
            return {"ok": False, "reason": "scale_zero"}
        intercept = (sum_y - slope * sum_x) / n
        offset = -intercept / slope

        residuals = [grams - (slope * raw + intercept) for raw, grams in cleaned]
        mse = sum(residual * residual for residual in residuals) / n
        rmse = math.sqrt(mse)

        with self._lock:
            self._calibration_scale = slope
            self._calibration_offset = offset
            self._sync_calibration_factor()
            self._calibration_points = cleaned
            self._calibration_from_config = False
            self._reset_after_calibration()
            self._persist_state()
            LOGGER.info(
                "Calibration updated from %d points: scale=%.6f, offset=%.6f, rmse=%.6f",
                n,
                self._calibration_scale,
                self._calibration_offset,
                rmse,
            )

            return {
                "ok": True,
                "calibration_factor": self._calibration_factor,
                "calibration_scale": self._calibration_scale,
                "calibration_offset": self._calibration_offset,
                "tare_offset": self._tare_offset,
                "points": [{"raw": raw, "grams": grams} for raw, grams in cleaned],
                "rmse": rmse,
            }

    def calibrate_two_point(
        self,
        raw1: float,
        grams1: float,
        raw2: float,
        grams2: float,
        extra_points: Optional[Sequence[Tuple[float, float]]] = None,
    ) -> dict:
        base_points: List[Tuple[float, float]] = [(float(raw1), float(grams1)), (float(raw2), float(grams2))]
        if extra_points:
            for raw, grams in extra_points:
                base_points.append((float(raw), float(grams)))
        return self.calibrate_from_points(base_points)

    def read_raw_value(self) -> dict:
        with self._lock:
            if self._last_raw is None or self._last_timestamp is None:
                return {"ok": False, "reason": "no_data"}
            ts_iso = datetime.fromtimestamp(self._last_timestamp, tz=timezone.utc).isoformat()
            return {
                "ok": True,
                "raw": self._last_raw,
                "filtered_raw": self._last_filtered_raw,
                "avg": self._last_avg,
                "ts": ts_iso,
            }

    @property
    def sample_rate_hz(self) -> float:
        return self._sample_rate_hz

    @property
    def calibration_factor(self) -> float:
        return self._calibration_factor

    @property
    def tare_offset(self) -> float:
        return self._tare_offset
