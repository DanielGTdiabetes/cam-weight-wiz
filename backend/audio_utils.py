"""Utilities for audio playback using ALSA/HiFiBerry."""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional

LOG_AUDIO = logging.getLogger("bascula.audio")

DEFAULT_AUDIO_DEVICE = os.getenv("BASCULA_AUDIO_DEVICE_DEFAULT", "bascula_out")
AUDIO_DEVICE_ENV = "BASCULA_AUDIO_DEVICE"
PLAYBACK_SAMPLE_RATE = int(os.getenv("BASCULA_PLAYBACK_RATE", "48000"))
PLAYBACK_CHANNELS = int(os.getenv("BASCULA_PLAYBACK_CHANNELS", "2"))
PLAYBACK_FORMAT = os.getenv("BASCULA_PLAYBACK_FORMAT", "S16_LE")


def _get_audio_device() -> str:
    device = os.getenv(AUDIO_DEVICE_ENV)
    if device:
        return device
    return DEFAULT_AUDIO_DEVICE


def is_playback_available() -> bool:
    return shutil.which("aplay") is not None


def _ensure_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def _run_ffmpeg(cmd: list[str], input_data: Optional[bytes] = None) -> bytes:
    try:
        result = subprocess.run(
            cmd,
            input=input_data,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode(errors="ignore") if exc.stderr else ""
        raise RuntimeError(stderr.strip() or str(exc)) from exc
    return result.stdout


def _play_pcm_bytes(pcm_audio: bytes) -> None:
    if not pcm_audio:
        return
    if not is_playback_available():
        raise RuntimeError("aplay no disponible")
    device = _get_audio_device()
    cmd = [
        "aplay",
        "-q",
        "-D",
        device,
        "-f",
        PLAYBACK_FORMAT,
        "-r",
        str(PLAYBACK_SAMPLE_RATE),
        "-c",
        str(PLAYBACK_CHANNELS),
        "-t",
        "raw",
        "-",
    ]
    LOG_AUDIO.info(
        "[audio] Audio out: %s @44.1kHz stereo (bytes=%d)",
        device,
        len(pcm_audio),
    )
    proc = subprocess.run(
        cmd,
        input=pcm_audio,
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    if proc.returncode not in (0, None):
        stderr = proc.stderr.decode(errors="ignore") if proc.stderr else ""
        LOG_AUDIO.warning(
            "[audio] aplay devolvió código %s: %s",
            proc.returncode,
            stderr.strip(),
        )


def play_audio_file(path: Path | str) -> None:
    file_path = Path(path)
    if not file_path.exists():
        raise FileNotFoundError(file_path)
    if not is_playback_available():
        raise RuntimeError("aplay no disponible")
    if not _ensure_ffmpeg():
        LOG_AUDIO.warning(
            "[audio] ffmpeg no disponible; reproduciendo archivo directamente"
        )
        subprocess.run(
            ["aplay", "-q", "-D", _get_audio_device(), str(file_path)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        return
    ffmpeg_cmd = [
        "ffmpeg",
        "-v",
        "error",
        "-i",
        str(file_path),
        "-f",
        "s16le",
        "-ar",
        str(PLAYBACK_SAMPLE_RATE),
        "-ac",
        str(PLAYBACK_CHANNELS),
        "pipe:1",
    ]
    pcm_audio = _run_ffmpeg(ffmpeg_cmd)
    _play_pcm_bytes(pcm_audio)


def play_pcm_audio(pcm_audio: bytes, *, sample_rate: int, channels: int) -> None:
    if not pcm_audio:
        return
    if not _ensure_ffmpeg():
        raise RuntimeError("ffmpeg no disponible")
    ffmpeg_cmd = [
        "ffmpeg",
        "-v",
        "error",
        "-f",
        "s16le",
        "-ar",
        str(sample_rate),
        "-ac",
        str(channels),
        "-i",
        "pipe:0",
        "-f",
        "s16le",
        "-ar",
        str(PLAYBACK_SAMPLE_RATE),
        "-ac",
        str(PLAYBACK_CHANNELS),
        "pipe:1",
    ]
    converted = _run_ffmpeg(ffmpeg_cmd, input_data=pcm_audio)
    _play_pcm_bytes(converted)
