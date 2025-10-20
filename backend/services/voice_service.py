from __future__ import annotations

import asyncio
import logging
import queue
import threading
import time
from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
from typing import Callable, Dict, Literal, Optional, Tuple

from backend.audio.capture import (
    AudioCaptureError,
    AudioCaptureSession,
    AudioCaptureTimeout,
    start_capture,
)
from backend.models.settings import AppSettings, load_settings
from backend.wake import WakeListener  # type: ignore[attr-defined]

logger = logging.getLogger("bascula.voice.service")


SettingsProvider = Callable[[], AppSettings]


@dataclass
class PttResult:
    ok: bool
    reason: Optional[str] = None
    transcript: Optional[str] = None


class VoiceService:
    """Centralised voice orchestrator for push-to-talk and contextual speech."""

    listen_enabled: bool
    mode: Literal["general", "recetas"]

    def __init__(self, settings_provider: Optional[SettingsProvider] = None) -> None:
        self.listen_enabled = False
        self.mode = "general"
        self._settings_provider = settings_provider or (lambda: load_settings({}))
        self._state_lock = threading.Lock()
        self._capture_stop = threading.Event()
        self._capture_thread: Optional[threading.Thread] = None
        self._active_capture: Optional[AudioCaptureSession] = None
        self._captured_chunks: list[bytes] = []
        self._last_transcript: Optional[str] = None
        self._capture_error: Optional[str] = None
        self._wake_helper = WakeListener(initial_enabled=False)
        self._speech_lock = threading.Lock()
        self._speech_subscribers: Dict[int, queue.Queue[Dict[str, object]]] = {}
        self._next_speech_token = 1

    # ------------------------------------------------------------------
    # Push-to-talk lifecycle
    # ------------------------------------------------------------------
    def start_listen_ptt(self) -> PttResult:
        """Begin push-to-talk capture if the service is in recipes mode."""
        with self._state_lock:
            if self.mode != "recetas":
                return PttResult(ok=False, reason="mode-disabled")
            if self.listen_enabled:
                return PttResult(ok=False, reason="busy")

            logger.info("VOICE[PTT] start requested (mode=%s)", self.mode)
            self._captured_chunks = []
            self._capture_error = None
            self._capture_stop.clear()
            capture, reason = self._obtain_audio_capture()
            if capture is None:
                logger.warning("VOICE[PTT] unable to open microphone: %s", reason or "unknown")
                return PttResult(ok=False, reason=reason or "unavailable")

            self.listen_enabled = True
            self._active_capture = capture
            self._capture_thread = threading.Thread(
                target=self._capture_loop,
                args=(capture,),
                name="voice-ptt",
                daemon=True,
            )
            self._capture_thread.start()

        return PttResult(ok=True)

    def stop_listen_ptt(self) -> PttResult:
        """Finalize push-to-talk capture and return the transcript."""
        with self._state_lock:
            if not self.listen_enabled:
                return PttResult(ok=False, reason="not-listening")
            logger.info("VOICE[PTT] stop requested")
            self.listen_enabled = False
            self._capture_stop.set()
            thread = self._capture_thread
            capture = self._active_capture
            self._capture_thread = None
            self._active_capture = None

        if thread is not None:
            thread.join(timeout=1.5)
        if capture is not None:
            try:
                capture.close()
            except Exception:  # pragma: no cover - defensive
                logger.exception("VOICE[PTT] failed closing capture session")

        pcm_audio = b"".join(self._captured_chunks)
        self._captured_chunks = []

        if self._capture_error:
            logger.warning("VOICE[PTT] capture aborted: %s", self._capture_error)
            return PttResult(ok=False, reason=self._capture_error)

        if not pcm_audio:
            logger.info("VOICE[PTT] no audio captured")
            self._last_transcript = ""
            return PttResult(ok=True, transcript="")

        transcript = self._transcribe_pcm(pcm_audio)
        self._last_transcript = transcript
        return PttResult(ok=True, transcript=transcript or "")

    def _obtain_audio_capture(self) -> Tuple[Optional[AudioCaptureSession], Optional[str]]:
        """Start a fresh ``arecord`` session for push-to-talk capture."""

        try:
            capture = start_capture(timeout=65.0)
        except AudioCaptureError as exc:
            return None, exc.reason or "audio-unavailable"

        helper = self._wake_helper
        try:
            helper._configured_sample_rate = capture.sample_rate  # type: ignore[attr-defined]
            helper._set_sample_rate(capture.sample_rate)  # type: ignore[attr-defined]
            helper._recent_audio.clear()  # type: ignore[attr-defined]
        except Exception:  # pragma: no cover - defensive sync
            logger.debug("VOICE[PTT] unable to sync wake helper sample rate", exc_info=True)

        logger.info("VOICE[PTT] microphone ready (%s@%dHz)", capture.device, capture.sample_rate)
        return capture, None

    def _capture_loop(self, capture: AudioCaptureSession) -> None:
        helper = self._wake_helper
        max_duration = 60.0
        started_at = time.monotonic()
        while not self._capture_stop.is_set():
            if (time.monotonic() - started_at) > max_duration:
                self._capture_error = "timeout"
                logger.warning("VOICE[PTT] capture timeout reached (%.1fs)", max_duration)
                break
            try:
                chunk = capture.read_chunk()
            except AudioCaptureTimeout:
                self._capture_error = "timeout"
                logger.warning("VOICE[PTT] capture timeout reached (arecord)")
                break
            except AudioCaptureError as exc:
                self._capture_error = exc.reason or "capture-error"
                logger.warning("VOICE[PTT] capture aborted: %s", exc)
                break

            if not chunk:
                continue
            self._captured_chunks.append(chunk)
            helper._recent_audio.append(chunk)  # type: ignore[attr-defined]

        helper._recent_audio.clear()  # type: ignore[attr-defined]

    def _transcribe_pcm(self, pcm_audio: bytes) -> str:
        helper = self._wake_helper
        try:
            if helper._model is None:  # type: ignore[attr-defined]
                helper._model = helper._load_model()  # type: ignore[attr-defined]
        except Exception:
            logger.exception("VOICE[PTT] unable to load Vosk model")
            helper._model = None  # type: ignore[attr-defined]

        if helper._model is None:  # type: ignore[attr-defined]
            return ""

        try:
            helper._sample_rate  # touch attribute to ensure prepared
            transcript = helper._transcribe_local(pcm_audio)  # type: ignore[attr-defined]
        except Exception:
            logger.exception("VOICE[PTT] transcription failed")
            transcript = ""
        return transcript.strip()

    # ------------------------------------------------------------------
    # Speech output
    # ------------------------------------------------------------------
    async def say(self, text: str, *, voice: Optional[str] = None) -> bool:
        """Speak text if speech is enabled; always broadcasts the caption."""
        normalized = (text or "").strip()
        if not normalized:
            return False

        settings = self._settings_provider()
        speech_setting_enabled = bool(settings.voice.speech_enabled)
        with self._state_lock:
            listening = self.listen_enabled

        should_play_audio = speech_setting_enabled and not listening
        self._broadcast_speech(normalized, spoken=should_play_audio, voice=voice)

        if not speech_setting_enabled:
            logger.info("VOICE muted, skipping playback: %s", normalized)
            return False

        if listening:
            logger.info("VOICE[PTT] capture active, suppressing playback: %s", normalized)
            return False

        try:
            voice_module = import_module("backend.voice")
            synthesize = getattr(voice_module, "_synthesize_to_file")
            playback = getattr(voice_module, "_play_audio_locally")
            raw_timeout = getattr(voice_module, "_PLAY_TIMEOUT_S", 10.0)
            try:
                playback_timeout = float(raw_timeout)
            except (TypeError, ValueError):  # pragma: no cover - defensive fallback
                playback_timeout = 10.0
        except Exception as exc:  # pragma: no cover - unexpected import failure
            logger.exception("VOICE unable to import playback helpers: %s", exc)
            return False

        try:
            audio_path: Path
            backend_used: str
            audio_path, backend_used = synthesize(normalized, voice)
        except Exception as exc:
            logger.exception("VOICE synthesis failed: %s", exc)
            return False

        try:
            await playback(audio_path, timeout_s=playback_timeout)
            logger.info("VOICE played with backend=%s (%s)", backend_used, audio_path)
        except Exception:
            logger.exception("VOICE playback failed")
            return False
        finally:
            try:
                audio_path.unlink(missing_ok=True)
            except Exception:  # pragma: no cover - non critical
                pass

        return True

    def subscribe_speech(self) -> Tuple[int, queue.Queue[Dict[str, object]]]:
        subscriber_queue: queue.Queue[Dict[str, object]] = queue.Queue(maxsize=32)
        with self._speech_lock:
            token = self._next_speech_token
            self._next_speech_token += 1
            self._speech_subscribers[token] = subscriber_queue
        return token, subscriber_queue

    def unsubscribe_speech(self, token: int) -> None:
        with self._speech_lock:
            self._speech_subscribers.pop(token, None)

    def _broadcast_speech(self, text: str, *, spoken: bool, voice: Optional[str]) -> None:
        payload = {
            "text": text,
            "spoken": spoken,
            "voice": voice,
            "mode": self.mode,
            "ts": time.time(),
        }
        logger.debug("VOICE broadcast speech payload: %s", payload)
        with self._speech_lock:
            subscribers = list(self._speech_subscribers.values())
        for q in subscribers:
            try:
                q.put_nowait(payload)
            except queue.Full:
                continue

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def reload_settings(self, settings_provider: SettingsProvider) -> None:
        self._settings_provider = settings_provider

    def get_last_transcript(self) -> Optional[str]:
        return self._last_transcript


# Shared singleton ----------------------------------------------------
voice_service = VoiceService()


__all__ = ["voice_service", "VoiceService", "PttResult"]
