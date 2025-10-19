"""Helpers to capture audio on demand via ALSA/arecord."""

from __future__ import annotations

import os
import subprocess
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator, Optional


MIC_DEVICE_ENV = "BASCULA_MIC_DEVICE"
SAMPLE_RATE_ENV = "BASCULA_SAMPLE_RATE"

DEFAULT_DEVICE = "bascula_mix_in"
DEFAULT_SAMPLE_RATE = 16_000
DEFAULT_TIMEOUT = 60.0
FRAME_DURATION = 0.02  # seconds

def _read_env_device() -> str:
    raw = os.getenv(MIC_DEVICE_ENV)
    if not raw:
        return DEFAULT_DEVICE
    candidate = raw.strip()
    return candidate or DEFAULT_DEVICE


def _read_env_sample_rate() -> int:
    raw = os.getenv(SAMPLE_RATE_ENV)
    if not raw:
        return DEFAULT_SAMPLE_RATE
    raw = raw.strip()
    if not raw:
        return DEFAULT_SAMPLE_RATE
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_SAMPLE_RATE
    return value if value > 0 else DEFAULT_SAMPLE_RATE


def _compute_frame_bytes(sample_rate: int, frame_duration: float = FRAME_DURATION) -> int:
    samples = int(sample_rate * frame_duration)
    if samples <= 0:
        samples = max(1, int(DEFAULT_SAMPLE_RATE * frame_duration))
    return samples * 2  # S16_LE ⇒ 2 bytes per sample


class AudioCaptureError(RuntimeError):
    """Base error for audio capture issues."""

    def __init__(self, reason: str, message: Optional[str] = None) -> None:
        super().__init__(message or reason)
        self.reason = reason


class AudioCaptureTimeout(AudioCaptureError):
    """Raised when the capture exceeds the allotted timeout."""


@dataclass
class AudioCaptureSession:
    """Context manager around an ``arecord`` subprocess."""

    device: str
    sample_rate: int
    frame_bytes: int
    _proc: subprocess.Popen[bytes]
    _deadline: Optional[float]
    _closed: bool = False

    @classmethod
    def start(
        cls,
        *,
        device: Optional[str] = None,
        sample_rate: Optional[int] = None,
        timeout: float = DEFAULT_TIMEOUT,
        frame_duration: float = FRAME_DURATION,
    ) -> "AudioCaptureSession":
        resolved_device = (device or _read_env_device()).strip() or DEFAULT_DEVICE
        resolved_rate = sample_rate or _read_env_sample_rate()
        if resolved_rate <= 0:
            resolved_rate = DEFAULT_SAMPLE_RATE

        frame_bytes = _compute_frame_bytes(resolved_rate, frame_duration)
        cmd = [
            "arecord",
            "-q",
            "-D",
            resolved_device,
            "-t",
            "raw",
            "-f",
            "S16_LE",
            "-r",
            str(resolved_rate),
            "-c",
            "1",
            "-",
        ]
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError as exc:  # pragma: no cover - runtime dependency
            raise AudioCaptureError("arecord-missing", "arecord no está disponible") from exc

        if proc.stdout is None:  # pragma: no cover - defensive
            proc.kill()
            raise AudioCaptureError("no-stdout", "arecord no expone stdout")

        stdout = proc.stdout
        probe_timeout = 2.0
        if timeout and timeout > 0:
            probe_timeout = min(timeout, 2.0)
        probe_deadline = time.monotonic() + probe_timeout if probe_timeout and probe_timeout > 0 else None
        if probe_deadline is not None:
            ready = False
            while time.monotonic() < probe_deadline:
                if proc.poll() is not None:
                    break
                try:
                    if stdout.peek(1):  # type: ignore[attr-defined]
                        ready = True
                        break
                except AttributeError:
                    ready = True
                    break
                except Exception:
                    time.sleep(0.05)
                    continue
                time.sleep(0.05)

            if proc.poll() is not None:
                err = proc.stderr.read().decode(errors="ignore") if proc.stderr else ""
                raise AudioCaptureError(
                    "process-exit",
                    f"arecord terminó antes de entregar audio: {err.strip()}",
                )

            if not ready:
                raise AudioCaptureTimeout("timeout", "arecord no entregó audio inicial a tiempo")

        session_deadline = time.monotonic() + timeout if timeout and timeout > 0 else None

        return cls(
            device=resolved_device,
            sample_rate=resolved_rate,
            frame_bytes=frame_bytes,
            _proc=proc,
            _deadline=session_deadline,
        )

    def __enter__(self) -> "AudioCaptureSession":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:  # pragma: no cover - trivial
        self.close()

    def read_chunk(self) -> bytes:
        if self._closed:
            raise AudioCaptureError("closed", "captura ya cerrada")

        if self._deadline is not None and time.monotonic() > self._deadline:
            raise AudioCaptureTimeout("timeout", "captura de audio agotó el tiempo")

        stdout = self._proc.stdout
        if stdout is None:  # pragma: no cover - defensive
            raise AudioCaptureError("no-stdout", "arecord sin stdout")

        try:
            chunk = stdout.read(self.frame_bytes)
        except Exception as exc:  # pragma: no cover - runtime failure
            raise AudioCaptureError("read-error", f"fallo leyendo audio: {exc}") from exc

        if not chunk:
            return self._raise_for_empty_chunk()

        return chunk

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True

        try:
            if self._proc.poll() is None:
                try:
                    self._proc.terminate()
                    self._proc.wait(timeout=1.0)
                except subprocess.TimeoutExpired:  # pragma: no cover - runtime
                    self._proc.kill()
        finally:
            stdout = self._proc.stdout
            if stdout is not None:
                try:
                    stdout.close()
                except Exception:  # pragma: no cover - best effort
                    pass
            stderr = self._proc.stderr
            if stderr is not None:
                try:
                    stderr.close()
                except Exception:  # pragma: no cover - best effort
                    pass

    def iter_pcm(self) -> Iterator[bytes]:
        """Yield chunks until timeout or closure."""

        while True:
            try:
                yield self.read_chunk()
            except AudioCaptureTimeout:
                raise
            except AudioCaptureError:
                raise

    def _raise_for_empty_chunk(self) -> bytes:
        code = self._proc.poll()
        stderr = self._consume_stderr()
        if code is None:
            raise AudioCaptureError("no-data", "arecord no entregó datos")
        details = stderr.strip() if stderr else ""
        message = f"arecord finalizó con código {code}"
        if details:
            message = f"{message}: {details}"
        raise AudioCaptureError("process-exit", message)

    def _consume_stderr(self) -> str:
        handle = self._proc.stderr
        if handle is None:
            return ""
        try:
            data = handle.read()
        except Exception:  # pragma: no cover - best effort
            return ""
        return data.decode(errors="ignore") if data else ""


def start_capture(
    *,
    device: Optional[str] = None,
    sample_rate: Optional[int] = None,
    timeout: float = DEFAULT_TIMEOUT,
    frame_duration: float = FRAME_DURATION,
) -> AudioCaptureSession:
    """Convenience wrapper returning a started :class:`AudioCaptureSession`."""

    return AudioCaptureSession.start(
        device=device,
        sample_rate=sample_rate,
        timeout=timeout,
        frame_duration=frame_duration,
    )


@contextmanager
def capture_context(
    *,
    device: Optional[str] = None,
    sample_rate: Optional[int] = None,
    timeout: float = DEFAULT_TIMEOUT,
    frame_duration: float = FRAME_DURATION,
):
    """Context manager to automatically close the capture session."""

    session = start_capture(
        device=device,
        sample_rate=sample_rate,
        timeout=timeout,
        frame_duration=frame_duration,
    )
    try:
        yield session
    finally:
        session.close()


__all__ = [
    "AudioCaptureError",
    "AudioCaptureSession",
    "AudioCaptureTimeout",
    "capture_context",
    "start_capture",
]
