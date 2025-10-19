"""Push-to-talk endpoints backed by ALSA ``arecord`` sessions."""
from __future__ import annotations

import logging
import os
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException

from backend.voice import VoiceTranscriptionError, transcribe_wav_file

logger = logging.getLogger("bascula.voice.ptt")

router = APIRouter()

_RUN_DIR = Path("/run/bascula/ptt")
_ACTIVE_PROC: Optional[subprocess.Popen[bytes]] = None
_ACTIVE_WAV: Optional[Path] = None
_ACTIVE_STARTED_AT: Optional[float] = None
_LOCK = threading.Lock()


def _mic_device() -> str:
    raw = os.getenv("BASCULA_MIC_DEVICE")
    if raw and raw.strip():
        return raw.strip()
    return "dsnoop:CARD=Device,DEV=0"


def _sample_rate() -> int:
    raw = os.getenv("BASCULA_SAMPLE_RATE", "16000")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return 16000
    return value if value > 0 else 16000


def _ensure_run_dir() -> Path:
    try:
        _RUN_DIR.mkdir(parents=True, exist_ok=True)
        _RUN_DIR.chmod(0o775)
    except PermissionError:
        logger.warning("VOICE[PTT] unable to adjust permissions for %s", _RUN_DIR)
    except OSError as exc:
        raise HTTPException(status_code=500, detail="ptt-storage-unavailable") from exc
    return _RUN_DIR


@router.post("/start")
def start_recording() -> dict[str, object]:
    global _ACTIVE_PROC, _ACTIVE_WAV, _ACTIVE_STARTED_AT
    with _LOCK:
        if _ACTIVE_PROC is not None:
            raise HTTPException(status_code=409, detail="ptt_already_active")

        run_dir = _ensure_run_dir()
        wav_path = run_dir / "active.wav"
        try:
            wav_path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            logger.warning("VOICE[PTT] unable to remove previous WAV at %s", wav_path)

        device = _mic_device()
        rate = _sample_rate()
        cmd = [
            "arecord",
            "-D",
            device,
            "-f",
            "S16_LE",
            "-r",
            str(rate),
            "-c",
            "1",
            "-t",
            "wav",
            str(wav_path),
        ]
        logger.info("VOICE[PTT] starting arecord device=%s rate=%d path=%s", device, rate, wav_path)
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=503, detail="arecord_missing") from exc
        except OSError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

        time.sleep(0.15)
        if proc.poll() is not None:
            stderr = proc.stderr.read().decode(errors="ignore") if proc.stderr else ""
            logger.error("VOICE[PTT] arecord failed to start: %s", stderr.strip())
            proc.wait()
            if proc.stderr is not None:
                proc.stderr.close()
            raise HTTPException(status_code=503, detail="ALSA open failed")

        _ACTIVE_PROC = proc
        _ACTIVE_WAV = wav_path
        _ACTIVE_STARTED_AT = time.monotonic()

    return {"ok": True}


@router.post("/stop")
def stop_recording() -> dict[str, object]:
    global _ACTIVE_PROC, _ACTIVE_WAV, _ACTIVE_STARTED_AT

    with _LOCK:
        if _ACTIVE_PROC is None or _ACTIVE_WAV is None:
            raise HTTPException(status_code=409, detail="ptt_not_active")
        proc = _ACTIVE_PROC
        wav_path = _ACTIVE_WAV
        started_at = _ACTIVE_STARTED_AT
        _ACTIVE_PROC = None
        _ACTIVE_WAV = None
        _ACTIVE_STARTED_AT = None

    logger.info("VOICE[PTT] stopping arecord (pid=%s)", getattr(proc, "pid", "?"))

    try:
        try:
            proc.send_signal(signal.SIGINT)
        except Exception:
            proc.terminate()
        try:
            proc.wait(timeout=3.0)
        except subprocess.TimeoutExpired:
            logger.warning("VOICE[PTT] arecord did not exit on SIGINT, terminating")
            proc.terminate()
            try:
                proc.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                logger.error("VOICE[PTT] force killing arecord")
                proc.kill()
                proc.wait(timeout=1.0)
    finally:
        if proc.stderr is not None:
            try:
                proc.stderr.close()
            except Exception:
                pass

    time.sleep(0.2)

    size_bytes = 0
    if wav_path.exists():
        try:
            size_bytes = wav_path.stat().st_size
        except OSError:
            size_bytes = 0
    else:
        logger.error("VOICE[PTT] recording file missing: %s", wav_path)
        raise HTTPException(status_code=503, detail="recording_unavailable")

    rate = _sample_rate()
    duration_guess = max(0.0, size_bytes / float(rate * 2)) if rate > 0 else 0.0
    if started_at is not None:
        elapsed = time.monotonic() - started_at
    else:
        elapsed = None
    logger.info(
        "VOICE[PTT] captured wav size=%d bytes duration≈%.2fs (elapsed=%.2fs)",
        size_bytes,
        duration_guess,
        elapsed if elapsed is not None else -1.0,
    )

    if size_bytes <= 44:
        try:
            wav_path.unlink()
        except OSError:
            pass
        raise HTTPException(status_code=503, detail="recording_empty")

    try:
        transcript = transcribe_wav_file(wav_path)
    except VoiceTranscriptionError as exc:
        if exc.reason == "whisper_not_installed":
            raise HTTPException(status_code=503, detail=exc.reason) from exc
        raise HTTPException(status_code=500, detail=exc.reason) from exc
    finally:
        try:
            wav_path.unlink()
        except OSError:
            logger.warning("VOICE[PTT] unable to remove temporary WAV %s", wav_path)

    return {"ok": True, "text": transcript}
