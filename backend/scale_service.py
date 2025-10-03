"""HX711 scale service with pigpio/RPi.GPIO backends and moving average filter."""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Deque, Dict, Optional

try:  # pragma: no cover - optional dependency
    import lgpio  # type: ignore
except ImportError:  # pragma: no cover - handled dynamically
    lgpio = None  # type: ignore

LOG_DIR = Path("/var/log/bascula")
STATE_PATH = Path(os.getenv("BASCULA_SCALE_STATE", "/var/lib/bascula/scale.json"))
DEFAULT_CALIBRATION = 1.0
DEFAULT_TARE = 0.0


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
        tare_offset: float = DEFAULT_TARE,
        sample_rate_hz: float = 20.0,
        filter_window: int = 10,
        persist_path: Path = STATE_PATH,
    ) -> None:
        self._dt_pin = int(dt_pin)
        self._sck_pin = int(sck_pin)
        self._sample_rate_hz = float(max(10.0, min(sample_rate_hz, 80.0)))
        self._filter_window = max(1, min(int(filter_window), 200))
        self._persist_path = persist_path

        self._driver: Optional[object] = None
        self._driver_name: Optional[str] = None
        self._driver_retry_at: Dict[str, float] = {"lgpio": 0.0, "pigpio": 0.0, "RPi.GPIO": 0.0}
        self._driver_errors: Dict[str, str] = {}
        self._last_driver_error: Optional[str] = None

        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._lock = threading.RLock()

        self._raw_samples: Deque[float] = deque(maxlen=self._filter_window)
        self._raw_sum = 0.0
        self._last_raw: Optional[float] = None
        self._last_avg: Optional[float] = None
        self._last_grams: Optional[float] = None
        self._last_instant_grams: Optional[float] = None
        self._last_timestamp: Optional[float] = None

        self._status_ok = False
        self._status_reason = "Service not started"

        self._calibration_factor = float(calibration_factor) if calibration_factor else DEFAULT_CALIBRATION
        self._tare_offset = float(tare_offset) if tare_offset else DEFAULT_TARE

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
            data = json.loads(self._persist_path.read_text())
            self._calibration_factor = float(data.get("calibration_factor", self._calibration_factor))
            self._tare_offset = float(data.get("tare_offset", self._tare_offset))
        except Exception as exc:
            LOGGER.error("Failed to load scale state: %s", exc)

    def _persist_state(self) -> None:
        payload = {
            "calibration_factor": self._calibration_factor,
            "tare_offset": self._tare_offset,
        }
        try:
            self._persist_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
        except Exception as exc:
            LOGGER.error("Failed to persist scale state: %s", exc)

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
                "HX711 service starting (DT=%s, SCK=%s, rate=%.2f Hz, filter=%d)",
                self._dt_pin,
                self._sck_pin,
                self._sample_rate_hz,
                self._filter_window,
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
                time.sleep(2.0)
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

        now = time.time()
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
                self._driver_retry_at[kind] = now + 60.0
                reasons.append(message)
                continue
            except Exception as exc:
                message = f"{kind} init failed: {exc}"
                LOGGER.error(message)
                self._driver_errors[kind] = message
                self._driver_retry_at[kind] = now + 15.0
                reasons.append(message)
                continue

            self._driver = driver
            self._driver_name = kind
            self._driver_errors.pop(kind, None)
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
        with self._lock:
            self._last_raw = raw
            self._last_timestamp = time.time()
            if len(self._raw_samples) == self._raw_samples.maxlen:
                removed = self._raw_samples.popleft()
                self._raw_sum -= removed
            self._raw_samples.append(raw)
            self._raw_sum += raw
            avg = self._raw_sum / len(self._raw_samples)
            self._last_avg = avg

            net = avg - self._tare_offset
            grams = None
            if self._calibration_factor:
                grams = net / self._calibration_factor
            self._last_grams = grams
            instant = None
            if self._calibration_factor:
                instant = (raw - self._tare_offset) / self._calibration_factor
            self._last_instant_grams = instant

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
                "tare_offset": self._tare_offset,
                "pins": {"dt": self._dt_pin, "sck": self._sck_pin},
                "driver": self._driver_name,
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
            if self._calibration_factor == 0:
                return {"ok": False, "reason": "calibration_factor_zero"}
            ts_iso = datetime.fromtimestamp(self._last_timestamp, tz=timezone.utc).isoformat()
            return {
                "ok": True,
                "grams": self._last_grams,
                "raw": self._last_raw,
                "avg": self._last_avg,
                "instant": self._last_instant_grams,
                "ts": ts_iso,
            }

    def read_raw(self) -> Optional[float]:
        with self._lock:
            return self._last_raw

    def read_grams(self, *, instant: bool = False) -> Optional[float]:
        with self._lock:
            if instant:
                return self._last_instant_grams
            return self._last_grams

    def tare(self) -> dict:
        with self._lock:
            if self._last_avg is None:
                return {"ok": False, "reason": "no_data"}
            self._tare_offset = self._last_avg
            self._raw_samples.clear()
            self._raw_sum = 0.0
            self._last_avg = None
            self._last_grams = None
            self._last_instant_grams = None
            self._last_raw = None
            self._last_timestamp = None
            self._persist_state()
            LOGGER.info("Tare set to %.3f", self._tare_offset)
            return {"ok": True, "tare_offset": self._tare_offset}

    def calibrate(self, known_grams: float) -> dict:
        if known_grams <= 0:
            return {"ok": False, "reason": "known_grams_invalid"}
        with self._lock:
            reference = self._last_avg if self._last_avg is not None else self._last_raw
            if reference is None:
                return {"ok": False, "reason": "no_data"}
            net = reference - self._tare_offset
            if abs(net) < 1e-6:
                return {"ok": False, "reason": "net_zero"}
            self._calibration_factor = net / known_grams
            self._persist_state()
            LOGGER.info(
                "Calibration updated: known=%.3f g -> factor=%.6f", known_grams, self._calibration_factor
            )
            return {
                "ok": True,
                "calibration_factor": self._calibration_factor,
                "tare_offset": self._tare_offset,
            }

    def read_raw_value(self) -> dict:
        with self._lock:
            if self._last_raw is None or self._last_timestamp is None:
                return {"ok": False, "reason": "no_data"}
            ts_iso = datetime.fromtimestamp(self._last_timestamp, tz=timezone.utc).isoformat()
            return {"ok": True, "raw": self._last_raw, "avg": self._last_avg, "ts": ts_iso}

    @property
    def sample_rate_hz(self) -> float:
        return self._sample_rate_hz

    @property
    def calibration_factor(self) -> float:
        return self._calibration_factor

    @property
    def tare_offset(self) -> float:
        return self._tare_offset
