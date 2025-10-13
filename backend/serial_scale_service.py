"""Serial-based scale service communicating with an ESP32 over UART."""
from __future__ import annotations

import logging
import os
import queue
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional

from backend.core.events import coach_event_bus, WeightStableEvent

try:  # pragma: no cover - external dependency
    import serial
    from serial import SerialException
except ImportError as exc:  # pragma: no cover - handled at runtime
    raise ImportError("pyserial (python3-serial) is required for SerialScaleService") from exc


_LOGGER: Optional[logging.Logger] = None


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


ZERO_ACK_TIMEOUT = _env_float("ZERO_ACK_TIMEOUT", 1.0)
ZERO_ACK_RETRIES = max(0, _env_int("ZERO_ACK_RETRIES", 1))
ZERO_ACK_SETTLE = _env_float("ZERO_ACK_SETTLE", 0.05)


def get_logger() -> logging.Logger:
    """Return a lazily configured logger for the serial scale service."""

    global _LOGGER
    if _LOGGER:
        return _LOGGER

    logger = logging.getLogger("bascula.serial")
    if not logger.handlers:
        logger.setLevel(logging.INFO)
        formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")

        try:
            log_dir = Path("/var/log/bascula")
            log_dir.mkdir(parents=True, exist_ok=True)
            file_handler = logging.FileHandler(log_dir / "app.log")
            file_handler.setFormatter(formatter)
            logger.addHandler(file_handler)
        except Exception:
            try:
                home_dir = Path.home() / ".bascula" / "logs"
                home_dir.mkdir(parents=True, exist_ok=True)
                file_handler = logging.FileHandler(home_dir / "app.log")
                file_handler.setFormatter(formatter)
                logger.addHandler(file_handler)
            except Exception:
                stream_handler = logging.StreamHandler(sys.stderr)
                stream_handler.setFormatter(formatter)
                logger.addHandler(stream_handler)

    _LOGGER = logger
    return logger


class SerialScaleService:
    """Service that reads weight data from an ESP32 via UART."""

    def __init__(
        self,
        device: str = "/dev/serial0",
        baud: int = 115200,
        *,
        reconnect_delay: float = 1.0,
        read_timeout: float = 0.1,
    ) -> None:
        self._log = get_logger()
        self._device = device
        self._baud = int(baud)
        self._reconnect_delay = max(0.2, reconnect_delay)
        self._read_timeout = max(0.05, read_timeout)
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._serial: Optional[serial.Serial] = None
        self._serial_lock = threading.Lock()
        self._buffer = bytearray()
        self._ack_queue: "queue.Queue[str]" = queue.Queue()
        self._last_grams: Optional[float] = None
        self._last_timestamp: Optional[float] = None
        self._last_stable: Optional[bool] = None
        self._connected = False
        self._status_reason: str = ""
        self._last_error_log: float = 0.0
        self._log.info("SerialScaleService init for device %s @ %d baud", self._device, self._baud)

    # ------------------------------------------------------------------
    # Lifecycle
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._reader_loop, name="SerialScaleService", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None
        self._close_serial()
        self._drain_ack_queue()

    # ------------------------------------------------------------------
    # Public API
    def get_status(self) -> Dict[str, object]:
        status: Dict[str, object] = {
            "ok": self._connected,
            "backend": "uart",
            "device": self._device,
            "baud": self._baud,
        }
        if not self._connected and self._status_reason:
            status["reason"] = self._status_reason
        if self._last_stable is not None:
            status["stable"] = self._last_stable
        if self._last_timestamp is not None:
            status["ts"] = datetime.fromtimestamp(self._last_timestamp, tz=timezone.utc).isoformat()
        if self._last_grams is not None:
            status["grams"] = self._last_grams
        return status

    def get_reading(self) -> Dict[str, object]:
        if not self._connected:
            return {"ok": False, "reason": "serial_disconnected"}
        if self._last_timestamp is None or self._last_grams is None:
            return {"ok": False, "reason": "no_data"}
        ts_iso = datetime.fromtimestamp(self._last_timestamp, tz=timezone.utc).isoformat()
        payload: Dict[str, object] = {"ok": True, "grams": self._last_grams, "ts": ts_iso}
        if self._last_stable is not None:
            payload["stable"] = self._last_stable
        return payload

    def tare(self) -> Dict[str, object]:
        if not self._connected:
            return {"ok": False, "reason": "serial_disconnected"}
        try:
            self._send_and_wait_ack(
                b"T\r\n",
                ack_tokens=(b"ACK:T", b"CK:T"),
                timeout=ZERO_ACK_TIMEOUT,
                retries=ZERO_ACK_RETRIES,
                settle=ZERO_ACK_SETTLE,
            )
        except TimeoutError:
            return {"ok": False, "reason": "ack_timeout"}
        except RuntimeError as exc:
            return {"ok": False, "reason": str(exc)}
        return {"ok": True}

    def calibrate(self, known_grams: float) -> Dict[str, object]:
        if not self._connected:
            return {"ok": False, "reason": "serial_disconnected"}
        try:
            ack = self._send_command(f"C:{known_grams}\n", expected_prefix="ACK:C")
        except TimeoutError:
            return {"ok": False, "reason": "ack_timeout"}
        except RuntimeError as exc:
            return {"ok": False, "reason": str(exc)}
        response: Dict[str, object] = {"ok": True}
        if ack and ":" in ack:
            parts = ack.split(":", 2)
            if len(parts) == 3:
                try:
                    response["calibration_factor"] = float(parts[2])
                except ValueError:
                    response["calibration_factor"] = parts[2]
        return response

    # ------------------------------------------------------------------
    # Internal helpers
    def _reader_loop(self) -> None:
        while not self._stop_event.is_set():
            if self._serial is None or not self._serial.is_open:
                self._attempt_connect()
                if self._serial is None:
                    self._wait(self._reconnect_delay)
                    continue

            try:
                to_read = max(1, self._serial.in_waiting) if self._serial.in_waiting else 1
                data = self._serial.read(to_read)
            except SerialException as exc:
                self._handle_serial_error(exc)
                continue
            except OSError as exc:  # pragma: no cover - hardware specific
                self._handle_serial_error(exc)
                continue

            if not data:
                self._wait(0.01)
                continue

            self._buffer.extend(data)
            while b"\n" in self._buffer:
                line, _, remainder = self._buffer.partition(b"\n")
                self._buffer = bytearray(remainder)
                self._process_line(line.strip())

    def _wait(self, seconds: float) -> None:
        self._stop_event.wait(seconds)

    def _attempt_connect(self) -> None:
        try:
            serial_conn = serial.Serial(
                self._device,
                self._baud,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=self._read_timeout,
            )
            serial_conn.reset_input_buffer()
            serial_conn.reset_output_buffer()
            self._serial = serial_conn
            self._buffer.clear()
            self._set_connected(True, "")
            self._log.info("Serial scale connected on %s @ %d baud", self._device, self._baud)
        except Exception as exc:  # pragma: no cover - hardware specific
            self._set_connected(False, str(exc))
            now = time.time()
            if now - self._last_error_log > 5.0:
                self._log.warning("Serial scale connection failed (%s): %s", self._device, exc)
                self._last_error_log = now
            self._close_serial()

    def _handle_serial_error(self, exc: Exception) -> None:
        self._set_connected(False, str(exc))
        now = time.time()
        if now - self._last_error_log > 5.0:
            self._log.warning("Serial scale communication error: %s", exc)
            self._last_error_log = now
        self._close_serial()
        self._wait(0.5)

    def _process_line(self, raw_line: bytes) -> None:
        if not raw_line:
            return
        try:
            line = raw_line.decode("utf-8", errors="replace").strip()
        except Exception:
            self._log.warning("Serial scale received undecodable line: %s", raw_line)
            return

        if not line:
            return

        upper_line = line.upper()

        if upper_line.startswith("ACK:") or upper_line.endswith("CK:T"):
            self._ack_queue.put(line)
            return

        if not line.startswith("G:"):
            self._log.warning("Serial scale received unexpected line: %s", line)
            return

        grams: Optional[float] = None
        stable: Optional[bool] = None
        parts = [segment.strip() for segment in line.split(",") if segment.strip()]
        for part in parts:
            if part.startswith("G:"):
                try:
                    grams = float(part.split(":", 1)[1])
                except (ValueError, IndexError):
                    grams = None
            elif part.startswith("S:"):
                try:
                    stable_value = part.split(":", 1)[1]
                    stable = stable_value.strip() in {"1", "true", "True"}
                except IndexError:
                    stable = None

        if grams is None:
            self._log.warning("Serial scale could not parse grams from line: %s", line)
            return

        self._last_grams = grams
        self._last_timestamp = time.time()
        self._last_stable = stable
        if stable:
            try:
                coach_event_bus.publish(WeightStableEvent(grams=grams))
            except Exception:  # pragma: no cover - defensive log
                self._log.debug("Failed to publish weight stable event", exc_info=True)

    def _send_and_wait_ack(
        self,
        payload: bytes,
        *,
        ack_tokens: tuple[bytes, ...],
        timeout: float,
        retries: int,
        settle: float = ZERO_ACK_SETTLE,
    ) -> str:
        if not payload:
            raise ValueError("payload must not be empty")
        tokens_upper = tuple(token.decode("utf-8", errors="ignore").upper() for token in ack_tokens if token)
        if not tokens_upper:
            raise ValueError("ack_tokens must contain at least one token")

        for attempt in range(retries + 1):
            with self._serial_lock:
                serial_conn = self._serial
                if serial_conn is None or not serial_conn.is_open:
                    raise RuntimeError("serial_disconnected")
                self._drain_ack_queue()
                try:
                    serial_conn.reset_input_buffer()
                    serial_conn.reset_output_buffer()
                except (SerialException, OSError) as exc:
                    self._handle_serial_error(exc)
                    raise RuntimeError("serial_flush_failed") from exc

                if settle > 0:
                    time.sleep(settle)

                try:
                    serial_conn.write(payload)
                    serial_conn.flush()
                except (SerialException, OSError) as exc:
                    self._handle_serial_error(exc)
                    raise RuntimeError("serial_write_failed") from exc

            deadline = time.monotonic() + max(timeout, 0.01)
            aggregated = ""
            while time.monotonic() < deadline:
                try:
                    ack_line = self._ack_queue.get(timeout=0.05)
                except queue.Empty:
                    if self._stop_event.is_set():
                        break
                    continue

                if not isinstance(ack_line, str):
                    ack_line = str(ack_line)

                aggregated += ack_line
                upper_line = ack_line.upper()
                if any(token in upper_line for token in tokens_upper):
                    return ack_line
                if any(token in aggregated.upper() for token in tokens_upper):
                    return aggregated

            self._log.debug(
                "Serial scale ACK not received on attempt %d/%d for payload %s",
                attempt + 1,
                retries + 1,
                payload,
            )

        raise TimeoutError("ack_timeout")

    def _send_command(self, command: str, *, expected_prefix: str, timeout: float = 1.0) -> str:
        if not command.endswith("\n"):
            command += "\n"

        payload = command.encode("utf-8")
        ack = self._send_and_wait_ack(
            payload,
            ack_tokens=(expected_prefix.encode("utf-8"),),
            timeout=timeout,
            retries=0,
            settle=ZERO_ACK_SETTLE,
        )
        return ack

    def _drain_ack_queue(self) -> None:
        try:
            while True:
                self._ack_queue.get_nowait()
        except queue.Empty:
            return

    def _set_connected(self, state: bool, reason: str) -> None:
        previous_state = self._connected
        self._connected = state
        self._status_reason = reason
        if not state:
            if previous_state:
                self._log.info("Serial scale disconnected: %s", reason or "unknown reason")
            had_reading = self._last_grams is not None or self._last_timestamp is not None
            self._last_grams = None
            self._last_timestamp = None
            self._last_stable = None
            if had_reading:
                self._log.info("Cleared last reading after disconnect to avoid stale data")

    def _close_serial(self) -> None:
        with self._serial_lock:
            if self._serial is not None:
                try:
                    self._serial.close()
                except Exception:  # pragma: no cover - best effort
                    pass
                self._serial = None


__all__ = ["SerialScaleService"]
