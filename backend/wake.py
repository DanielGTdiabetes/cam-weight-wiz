"""Wake-word listener with Vosk for the miniweb backend."""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import unicodedata
import wave
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncGenerator, Deque, Dict, Iterable, List, Optional, Tuple

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

try:  # Optional dependency handled gracefully
    import sounddevice as sd  # type: ignore
except Exception:  # pragma: no cover - optional at runtime
    sd = None  # type: ignore

try:  # Vosk may be unavailable during development
    from vosk import KaldiRecognizer, Model  # type: ignore
except Exception:  # pragma: no cover - optional at runtime
    KaldiRecognizer = None  # type: ignore
    Model = None  # type: ignore

try:
    import requests
except Exception:  # pragma: no cover - optional at runtime
    requests = None  # type: ignore

from rapidfuzz import fuzz

LOG_WAKE = logging.getLogger("bascula.wake")

SAMPLE_RATE = 16_000
FRAME_SAMPLES = 320  # 20 ms at 16 kHz
FRAME_BYTES = FRAME_SAMPLES * 2
FRAME_DURATION = FRAME_SAMPLES / SAMPLE_RATE
BUFFER_SECONDS = 8.0
PRE_WAKE_SECONDS = 1.0
POST_WAKE_SECONDS = 4.0
COOLDOWN_SECONDS = 2.0
WAKE_WORD = "basculin"
FUZZY_THRESHOLD = 85

BUFFER_FRAMES = int(BUFFER_SECONDS / FRAME_DURATION)
PRE_WAKE_FRAMES = int(PRE_WAKE_SECONDS / FRAME_DURATION)
POST_WAKE_FRAMES = int(POST_WAKE_SECONDS / FRAME_DURATION)

MODEL_CANDIDATES = [
    Path("/opt/vosk/es-small/model"),
    Path("/opt/vosk/es-small"),
]

NUMBER_WORDS: Dict[str, float] = {
    "cero": 0,
    "uno": 1,
    "una": 1,
    "un": 1,
    "dos": 2,
    "tres": 3,
    "cuatro": 4,
    "cinco": 5,
    "seis": 6,
    "siete": 7,
    "ocho": 8,
    "nueve": 9,
    "diez": 10,
    "once": 11,
    "doce": 12,
    "trece": 13,
    "catorce": 14,
    "quince": 15,
    "veinte": 20,
    "treinta": 30,
    "cuarenta": 40,
    "cincuenta": 50,
    "sesenta": 60,
    "medio": 0.5,
    "media": 0.5,
}

_STOP_WORDS = {"y", "con", "de", "la", "el"}


class WakeSimulatePayload(BaseModel):
    text: str


class WakeListener:
    """Threaded wake listener using Vosk for offline recognition."""

    def __init__(self, initial_enabled: bool = True) -> None:
        self.enabled = initial_enabled
        self.running = False
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._model: Optional[Model] = None
        self._recognizer: Optional[KaldiRecognizer] = None
        self._recent_audio: Deque[bytes] = deque(maxlen=BUFFER_FRAMES)
        self._errors: Deque[str] = deque(maxlen=10)
        self._last_wake_ts: Optional[float] = None
        self._wake_count = 0
        self._intent_count = 0
        self._cooldown_until = 0.0
        self._subscribers: List[Tuple[asyncio.AbstractEventLoop, asyncio.Queue[Dict[str, Any]]]] = []
        self._subscribers_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._audio_lock = threading.Lock()
        self._active_audio_source: Optional[_BaseAudioSource] = None
        self._current_source_name: Optional[str] = None
        self._remote_transcribe_unavailable = False
        self._transcribe_url: Optional[str] = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def start(self) -> None:
        with self._state_lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._run,
                name="wake-listener",
                daemon=True,
            )
            self._thread.start()
            LOG_WAKE.info("[wake] listener thread started (enabled=%s)", self.enabled)

    def stop(self) -> None:
        self._stop_event.set()
        with self._audio_lock:
            source = self._active_audio_source
            self._active_audio_source = None
        if source is not None:
            try:
                source.close()
            except Exception:  # pragma: no cover - best effort cleanup
                pass
        thread = None
        with self._state_lock:
            thread = self._thread
            self._thread = None
        if thread is not None:
            thread.join(timeout=2.0)
        LOG_WAKE.info("[wake] listener thread stopped")

    def set_enabled(self, value: bool) -> None:
        LOG_WAKE.info("[wake] set_enabled=%s", value)
        with self._state_lock:
            self.enabled = bool(value)
            if not self.enabled:
                self.running = False
        if not value:
            with self._audio_lock:
                source = self._active_audio_source
                self._active_audio_source = None
            if source is not None:
                try:
                    source.close()
                except Exception:  # pragma: no cover - best effort
                    pass

    def get_status(self) -> Dict[str, Any]:
        with self._state_lock:
            last_ts = self._last_wake_ts
            status = {
                "enabled": self.enabled,
                "running": self.running and self.enabled,
                "last_wake_ts": datetime.fromtimestamp(last_ts, tz=timezone.utc).isoformat()
                if last_ts
                else None,
                "wake_count": self._wake_count,
                "intent_count": self._intent_count,
                "errors": list(self._errors),
                "backend": self._current_source_name,
            }
        return status

    def subscribe(self, loop: asyncio.AbstractEventLoop) -> asyncio.Queue[Dict[str, Any]]:
        queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()
        with self._subscribers_lock:
            self._subscribers.append((loop, queue))
        return queue

    def unsubscribe(self, queue: asyncio.Queue[Dict[str, Any]]) -> None:
        with self._subscribers_lock:
            self._subscribers = [
                (loop, q) for (loop, q) in self._subscribers if q is not queue
            ]

    def simulate(self, text: str) -> Dict[str, Any]:
        intent = _parse_intent(text)
        event = {
            "type": "intent",
            "ts": time.time(),
            "text": text,
            "intent": intent,
            "simulated": True,
        }
        with self._state_lock:
            self._intent_count += 1
        self._broadcast(event)
        return event

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _run(self) -> None:
        audio_source: Optional[_BaseAudioSource] = None
        while not self._stop_event.is_set():
            if not self.enabled:
                if self.running:
                    self.running = False
                if audio_source is not None:
                    self._close_audio_source(audio_source)
                    audio_source = None
                time.sleep(0.25)
                continue

            if Model is None or KaldiRecognizer is None:
                self._record_error("Vosk no disponible (instala vosk==0.3.45)")
                time.sleep(5.0)
                continue

            if self._model is None:
                self._model = self._load_model()
                if self._model is None:
                    time.sleep(10.0)
                    continue

            if self._recognizer is None:
                try:
                    self._recognizer = KaldiRecognizer(self._model, SAMPLE_RATE)
                except Exception as exc:  # pragma: no cover - runtime failure
                    self._record_error(f"Error inicializando reconocedor: {exc}")
                    self._recognizer = None
                    time.sleep(5.0)
                    continue

            if audio_source is None:
                audio_source = self._open_audio_source()
                if audio_source is None:
                    time.sleep(5.0)
                    continue

            try:
                chunk = audio_source.read_chunk()
            except Exception as exc:  # pragma: no cover - runtime failure
                self._record_error(f"Fallo leyendo audio: {exc}")
                self._close_audio_source(audio_source)
                audio_source = None
                self.running = False
                continue

            if not chunk:
                self._record_error("Entrada de audio vacía; reiniciando capturadora")
                self._close_audio_source(audio_source)
                audio_source = None
                self.running = False
                continue

            self.running = True
            self._recent_audio.append(chunk)
            self._process_audio_chunk(chunk, audio_source)

        if audio_source is not None:
            self._close_audio_source(audio_source)

    def _close_audio_source(self, source: _BaseAudioSource) -> None:
        with self._audio_lock:
            if self._active_audio_source is source:
                self._active_audio_source = None
                self._current_source_name = None
        try:
            source.close()
        except Exception:  # pragma: no cover - best effort cleanup
            pass

    def _load_model(self) -> Optional[Model]:
        for candidate in MODEL_CANDIDATES:
            if candidate.is_dir():
                try:
                    LOG_WAKE.info("[wake] Cargando modelo Vosk: %s", candidate)
                    return Model(str(candidate))
                except Exception as exc:  # pragma: no cover - runtime failure
                    self._record_error(f"No se pudo cargar modelo Vosk: {exc}")
        self._record_error("Modelo Vosk ES no encontrado en /opt/vosk/es-small")
        return None

    def _open_audio_source(self) -> Optional[_BaseAudioSource]:
        if shutil.which("arecord"):
            try:
                source = _ARecordSource()
                with self._audio_lock:
                    self._active_audio_source = source
                self._current_source_name = "arecord"
                LOG_WAKE.info("[wake] Capturando audio con arecord")
                return source
            except Exception as exc:
                self._record_error(f"arecord no disponible: {exc}")
        else:
            LOG_WAKE.warning("[wake] arecord not found, falling back to sounddevice")

        if sd is not None:
            try:
                source = _SoundDeviceSource()
                with self._audio_lock:
                    self._active_audio_source = source
                self._current_source_name = "sounddevice"
                LOG_WAKE.info("[wake] Capturando audio con sounddevice")
                return source
            except Exception as exc:
                self._record_error(f"sounddevice no disponible: {exc}")
        else:
            self._record_error("sounddevice no instalado; no hay captura de audio")
        return None

    def _process_audio_chunk(self, chunk: bytes, audio_source: _BaseAudioSource) -> None:
        if self._recognizer is None:
            return

        try:
            accepted = self._recognizer.AcceptWaveform(chunk)
            partial_json = self._recognizer.PartialResult()
        except Exception as exc:  # pragma: no cover - runtime failure
            self._record_error(f"Recognizer error: {exc}")
            self._recognizer = None
            return

        text_candidate = ""
        if accepted:
            try:
                result_json = self._recognizer.Result()
                result_data = json.loads(result_json) if result_json else {}
            except json.JSONDecodeError:
                result_data = {}
            text_candidate = result_data.get("text", "")
            self._recognizer.Reset()
        else:
            if partial_json:
                try:
                    partial_data = json.loads(partial_json)
                except json.JSONDecodeError:
                    partial_data = {}
                text_candidate = partial_data.get("partial", "")

        if text_candidate:
            self._handle_recognized_text(text_candidate, audio_source)

    def _handle_recognized_text(self, text: str, audio_source: _BaseAudioSource) -> None:
        normalized = _normalize_text(text)
        if not normalized:
            return

        now = time.monotonic()
        if now < self._cooldown_until:
            return

        score = fuzz.partial_ratio(WAKE_WORD, normalized)
        if score >= FUZZY_THRESHOLD:
            self._cooldown_until = now + COOLDOWN_SECONDS
            LOG_WAKE.info("[wake] Wake-word detectada (score=%s, texto=%s)", score, text)
            self._on_wake_detected(audio_source)

    def _on_wake_detected(self, audio_source: _BaseAudioSource) -> None:
        wake_ts = time.time()
        with self._state_lock:
            self._last_wake_ts = wake_ts
            self._wake_count += 1
        self._broadcast({"type": "wake", "ts": wake_ts})

        pre_audio = list(self._recent_audio)[-PRE_WAKE_FRAMES:] if PRE_WAKE_FRAMES else []
        captured: List[bytes] = pre_audio.copy()

        for _ in range(POST_WAKE_FRAMES):
            if self._stop_event.is_set() or not self.enabled:
                break
            try:
                chunk = audio_source.read_chunk()
            except Exception as exc:  # pragma: no cover - runtime failure
                self._record_error(f"Fallo grabando audio posterior: {exc}")
                break
            if not chunk:
                break
            captured.append(chunk)
            self._recent_audio.append(chunk)

        if self._recognizer is not None:
            self._recognizer.Reset()

        raw_audio = b"".join(captured)
        if not raw_audio:
            LOG_WAKE.warning("[wake] No se capturó audio tras el wake-word")
            return

        wav_audio = _pcm_to_wav(raw_audio)
        transcript = self._transcribe_audio(raw_audio, wav_audio)
        intent = _parse_intent(transcript)
        with self._state_lock:
            self._intent_count += 1
        event = {
            "type": "intent",
            "ts": time.time(),
            "text": transcript,
            "intent": intent,
        }
        self._broadcast(event)

    def _transcribe_audio(self, pcm_audio: bytes, wav_audio: bytes) -> str:
        transcript: Optional[str] = None
        if not self._remote_transcribe_unavailable:
            transcript = self._try_remote_transcription(wav_audio)
        if transcript:
            return transcript.strip()
        return self._transcribe_local(pcm_audio)

    def _try_remote_transcription(self, wav_audio: bytes) -> Optional[str]:
        if requests is None:
            return None
        base_url = os.getenv("BASCULA_API_URL", "http://127.0.0.1:8080")
        if self._transcribe_url is None:
            self._transcribe_url = f"{base_url.rstrip('/')}/api/voice/transcribe"
        try:
            response = requests.post(
                self._transcribe_url,
                files={"file": ("wake.wav", wav_audio, "audio/wav")},
                timeout=10,
            )
        except Exception as exc:  # pragma: no cover - runtime failure
            LOG_WAKE.warning("[wake] transcripción remota falló: %s", exc)
            return None

        if response.status_code == 404:
            LOG_WAKE.info("[wake] Endpoint /api/voice/transcribe no disponible")
            self._remote_transcribe_unavailable = True
            return None
        if not response.ok:
            LOG_WAKE.warning("[wake] transcripción remota error HTTP %s", response.status_code)
            return None
        try:
            data = response.json()
        except Exception:  # pragma: no cover - runtime failure
            return None
        transcript = data.get("transcript")
        if transcript:
            LOG_WAKE.info("[wake] Transcripción remota completada")
            return str(transcript)
        return None

    def _transcribe_local(self, pcm_audio: bytes) -> str:
        if Model is None or KaldiRecognizer is None or self._model is None:
            return ""
        try:
            recognizer = KaldiRecognizer(self._model, SAMPLE_RATE)
            recognizer.AcceptWaveform(pcm_audio)
            result_json = recognizer.Result()
            result = json.loads(result_json) if result_json else {}
            transcript = result.get("text", "")
            LOG_WAKE.info("[wake] Transcripción local Vosk: %s", transcript)
            return transcript
        except Exception as exc:  # pragma: no cover - runtime failure
            self._record_error(f"Fallo transcribiendo localmente: {exc}")
            return ""

    def _broadcast(self, event: Dict[str, Any]) -> None:
        with self._subscribers_lock:
            subscribers = list(self._subscribers)
        for loop, queue in subscribers:
            try:
                loop.call_soon_threadsafe(queue.put_nowait, event)
            except RuntimeError:
                # Event loop closed; unsubscribe lazily
                self.unsubscribe(queue)

    def _record_error(self, message: str) -> None:
        LOG_WAKE.warning("[wake] %s", message)
        with self._state_lock:
            self._errors.append(message)


class _BaseAudioSource:
    def read_chunk(self) -> bytes:
        raise NotImplementedError

    def close(self) -> None:
        raise NotImplementedError


class _ARecordSource(_BaseAudioSource):
    def __init__(self) -> None:
        cmd = [
            "arecord",
            "-q",
            "-t",
            "raw",
            "-f",
            "S16_LE",
            "-r",
            str(SAMPLE_RATE),
            "-c",
            "1",
            "-",
        ]
        self._proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        if self._proc.stdout is None:  # pragma: no cover - defensive
            raise RuntimeError("arecord stdout no disponible")

    def read_chunk(self) -> bytes:
        assert self._proc.stdout is not None
        data = self._proc.stdout.read(FRAME_BYTES)
        if not data:
            raise RuntimeError("arecord sin datos")
        return data

    def close(self) -> None:
        if self._proc.poll() is None:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=1.0)
            except Exception:  # pragma: no cover - best effort
                self._proc.kill()


class _SoundDeviceSource(_BaseAudioSource):
    def __init__(self) -> None:
        if sd is None:  # pragma: no cover - defensive
            raise RuntimeError("sounddevice no disponible")
        self._stream = sd.RawInputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=FRAME_SAMPLES,
        )
        self._stream.start()

    def read_chunk(self) -> bytes:
        data, overflowed = self._stream.read(FRAME_SAMPLES)
        if overflowed:
            LOG_WAKE.warning("[wake] overflow de audio en sounddevice")
        return bytes(data)

    def close(self) -> None:
        try:
            self._stream.stop()
        finally:
            self._stream.close()


def _strip_accents(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value)
    return "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")


def _normalize_text(text: str) -> str:
    text = _strip_accents(text.lower())
    text = text.replace("'", " ")
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _parse_number_tokens(tokens: Iterable[str]) -> Optional[float]:
    cleaned: List[str] = []
    for token in tokens:
        token = token.strip()
        if not token or token in _STOP_WORDS:
            continue
        cleaned.append(token)
    if not cleaned:
        return None

    joined = " ".join(cleaned).replace(",", ".")
    try:
        return float(joined)
    except ValueError:
        pass

    total = 0.0
    for token in cleaned:
        if token.isdigit():
            total += float(token)
        elif token in NUMBER_WORDS:
            total += NUMBER_WORDS[token]
        else:
            return None
    return total


def _extract_timer_seconds(normalized: str) -> Optional[int]:
    match = re.search(
        r"(?:pon|configura|inicia)\s+(?:un\s+)?temporizador\s+de\s+([a-z0-9\s.,]+)",
        normalized,
    )
    if not match:
        return None

    remainder = match.group(1).strip()
    tokens = remainder.split()
    unit: Optional[str] = None
    value_tokens: List[str] = []
    for token in tokens:
        if token in {"minuto", "minutos"}:
            unit = "minutes"
            break
        if token in {"segundo", "segundos"}:
            unit = "seconds"
            break
        value_tokens.append(token)

    number_value = _parse_number_tokens(value_tokens)
    if number_value is None:
        return None

    if unit == "seconds":
        seconds = number_value
    else:
        # Default to minutes if unit not specified
        seconds = number_value * 60
    return int(max(1, round(seconds)))


def _parse_intent(text: str) -> Dict[str, Any]:
    normalized = _normalize_text(text)
    if not normalized:
        return {"kind": "smalltalk"}

    if "temporizador" in normalized or "timer" in normalized:
        seconds = _extract_timer_seconds(normalized)
        if seconds:
            return {"kind": "timer", "seconds": int(seconds)}

    if "cuanto pesa" in normalized or "peso actual" in normalized or "peso ahora" in normalized:
        return {"kind": "weight_status"}

    if "pon a cero" in normalized or "pone a cero" in normalized or "tara" in normalized:
        return {"kind": "tare"}

    if "inicia receta" in normalized or "abre receta" in normalized:
        name_match = re.search(r"receta\s+(.*)$", text, re.IGNORECASE)
        recipe_name = name_match.group(1).strip() if name_match else ""
        return {"kind": "recipe_start", "name": recipe_name}

    if "calibra" in normalized or "inicia calibracion" in normalized or "calibrar" in normalized:
        return {"kind": "calibrate"}

    return {"kind": "smalltalk"}


def _pcm_to_wav(pcm_audio: bytes) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(pcm_audio)
    return buffer.getvalue()


router = APIRouter(prefix="/api/voice/wake", tags=["voice"])

_wake_listener: Optional[WakeListener] = None
_wake_lock = threading.Lock()


def _env_enabled() -> bool:
    value = os.getenv("BASCULA_WAKEWORD", "1").strip().lower()
    return value not in {"0", "false", "no", "off"}


def init_wake_if_enabled(app: FastAPI) -> None:
    global _wake_listener
    with _wake_lock:
        if _wake_listener is None:
            listener = WakeListener(initial_enabled=_env_enabled())
            listener.start()
            _wake_listener = listener
            LOG_WAKE.info("[wake] WakeListener inicializado (enabled=%s)", listener.enabled)

    @app.on_event("shutdown")
    async def _shutdown_wake() -> None:  # pragma: no cover - executed at runtime
        listener = _wake_listener
        if listener is not None:
            listener.stop()


def _get_listener() -> WakeListener:
    if _wake_listener is None:
        raise HTTPException(status_code=503, detail="wake_listener_not_initialized")
    return _wake_listener


@router.get("/status")
async def wake_status() -> Dict[str, Any]:
    listener = _get_listener()
    return listener.get_status()


@router.post("/enable")
async def wake_enable() -> Dict[str, Any]:
    listener = _get_listener()
    listener.set_enabled(True)
    return {"ok": True}


@router.post("/disable")
async def wake_disable() -> Dict[str, Any]:
    listener = _get_listener()
    listener.set_enabled(False)
    return {"ok": True}


@router.get("/events")
async def wake_events(request: Request) -> StreamingResponse:
    listener = _get_listener()
    loop = asyncio.get_running_loop()
    queue = listener.subscribe(loop)

    async def event_stream() -> AsyncGenerator[str, None]:
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=10.0)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                payload = json.dumps(event, ensure_ascii=False)
                event_type = event.get("type", "message")
                yield f"event: {event_type}\n"
                yield f"data: {payload}\n\n"
        finally:
            listener.unsubscribe(queue)

    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)


@router.post("/simulate")
async def wake_simulate(payload: WakeSimulatePayload) -> Dict[str, Any]:
    listener = _get_listener()
    return listener.simulate(payload.text)

