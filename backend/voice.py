"""Voice APIs for TTS, audio uploads, and transcription."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional, Tuple

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from backend.audio_utils import is_playback_available, play_audio_file, play_pcm_audio

VOICE_ROUTER_PREFIX = "/api/voice"
router = APIRouter(prefix=VOICE_ROUTER_PREFIX, tags=["voice"])

VOICE_OUTPUT_DIR = Path("/opt/bascula/data/voice")
WHISPER_DIR = Path("/opt/whisper.cpp")
SUPPORTED_UPLOAD_EXTENSIONS = {".webm", ".ogg", ".wav", ".mp3"}

logger = logging.getLogger(__name__)

_PLAYBACK_LOCK = asyncio.Lock()


def _iter_env_dirs() -> Iterable[Path]:
    raw_single = os.getenv("BASCULA_VOICES_DIR") or os.getenv("BASCULA_VOICE_DIR")
    if raw_single:
        candidate = Path(raw_single).expanduser()
        yield candidate

    raw_list = (
        os.getenv("BASCULA_VOICE_DIRS")
        or os.getenv("BASCULA_VOICES_DIRS")
        or os.getenv("PIPER_VOICE_DIRS")
    )
    if raw_list:
        separators = [":", ";"]
        tokens = [raw_list]
        for sep in separators:
            next_tokens: list[str] = []
            for token in tokens:
                next_tokens.extend(token.split(sep))
            tokens = next_tokens
        for token in tokens:
            trimmed = token.strip()
            if trimmed:
                yield Path(trimmed).expanduser()


def _discover_piper() -> list[dict]:
    home = Path.home()
    bases = [
        Path("/opt/bascula/voices"),
        Path("/opt/bascula/voices/piper"),
        Path("/opt/bascula/current/voices"),
        Path("/opt/bascula/current/voices/piper"),
        Path("/opt/piper/models"),
        Path("/usr/local/share/piper/models"),
        Path("/usr/share/piper/models"),
        home / "voices",
        home / "voices/piper",
        home / ".local/share/piper",
        home / ".local/share/piper/models",
    ]
    bases.extend(_iter_env_dirs())
    out: list[dict] = []
    seen: set[Path] = set()
    for base in bases:
        if base.is_dir():
            try:
                models = sorted(base.glob("*.onnx"))
            except PermissionError as exc:
                logger.warning("Sin permisos para leer voces Piper en %s: %s", base, exc)
                continue
            for model_path in models:
                try:
                    resolved = model_path.resolve()
                except (FileNotFoundError, OSError):
                    resolved = model_path
                if resolved in seen:
                    continue
                if not resolved.exists():
                    continue
                seen.add(resolved)
                json_path = model_path.with_suffix(model_path.suffix + ".json")
                out.append(
                    {
                        "id": model_path.stem,
                        "name": model_path.name,
                        "path": str(model_path),
                        "json": str(json_path) if json_path.exists() else None,
                    }
                )
    if not out:
        logger.warning(
            "No se encontraron modelos Piper. Revisa que las voces estén bajo /opt/bascula/voices/piper "
            "o exporta BASCULA_VOICES_DIRS."
        )
    return out


def _is_espeak_available() -> bool:
    return shutil.which("espeak-ng") is not None


def _is_aplay_available() -> bool:
    return is_playback_available()


@router.get("/tts/voices")
def list_voices() -> dict[str, object]:
    models = _discover_piper()
    response_models = [
        {
            "id": model["id"],
            "name": model.get("name") or Path(model["path"]).name,
            "path": model["path"],
            "json": model["json"],
        }
        for model in models
    ]
    return {"piper_models": response_models, "espeak_available": _is_espeak_available()}


def _piper_to_wav(text: str, model_path: str, json_path: Optional[str]) -> bytes:
    cmd = ["piper", "--model", model_path, "--output_raw"]
    if json_path:
        cmd.extend(["--config", json_path])
    try:
        proc = subprocess.run(
            cmd,
            input=text.encode("utf-8"),
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("piper_not_found") from exc
    except subprocess.CalledProcessError as exc:  # pragma: no cover - depends on runtime
        raise RuntimeError(f"piper_failed: {exc.stderr.decode(errors='ignore').strip()}") from exc

    pcm_audio = proc.stdout

    sample_rate = 22050
    if json_path:
        try:
            with open(json_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                rate = data.get("sample_rate")
                if isinstance(rate, (int, float)):
                    sample_rate = int(rate)
                else:
                    audio_cfg = data.get("audio")
                    if isinstance(audio_cfg, dict):
                        audio_rate = audio_cfg.get("sample_rate")
                        if isinstance(audio_rate, (int, float)):
                            sample_rate = int(audio_rate)
        except Exception:  # pragma: no cover - best effort if config unreadable
            pass

    ffmpeg_cmd = [
        "ffmpeg",
        "-f",
        "s16le",
        "-ar",
        str(sample_rate),
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-f",
        "wav",
        "pipe:1",
    ]
    try:
        ffmpeg_proc = subprocess.run(
            ffmpeg_cmd,
            input=pcm_audio,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("ffmpeg_not_found") from exc
    except subprocess.CalledProcessError as exc:  # pragma: no cover - depends on runtime
        raise RuntimeError(f"ffmpeg_failed: {exc.stderr.decode(errors='ignore').strip()}") from exc

    return ffmpeg_proc.stdout


def _synthesize_with_espeak(text: str, output_path: Path) -> None:
    cmd = ["espeak-ng", "-w", str(output_path), text]
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError as exc:
        raise RuntimeError("espeak_not_found") from exc
    except subprocess.CalledProcessError as exc:  # pragma: no cover - depends on runtime
        raise RuntimeError(f"espeak_failed: {exc.stderr.decode(errors='ignore').strip()}") from exc


async def _play_audio_locally(path: Path) -> None:
    if not _is_aplay_available():
        return
    loop = asyncio.get_running_loop()
    async with _PLAYBACK_LOCK:
        await loop.run_in_executor(None, play_audio_file, path)


def _synthesize_to_file(text: str, voice: Optional[str]) -> Tuple[Path, str]:
    models = _discover_piper()
    tmp_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp_path = Path(tmp_file.name)
    tmp_file.close()

    model_entry: Optional[dict] = None
    if voice:
        for candidate_model in models:
            candidate_path = Path(candidate_model["path"])
            if (
                voice == candidate_model["id"]
                or voice == candidate_model["path"]
                or voice == candidate_path.name
            ):
                model_entry = candidate_model
                break
        else:
            voice_path = Path(voice)
            if voice_path.is_file():
                json_candidate = voice_path.with_suffix(voice_path.suffix + ".json")
                model_entry = {
                    "id": voice_path.stem,
                    "path": str(voice_path),
                    "json": str(json_candidate) if json_candidate.exists() else None,
                }
    if model_entry is None and models:
        model_entry = models[0]

    selected_backend: Optional[str] = None
    last_error: Optional[Exception] = None

    try:
        if model_entry:
            try:
                wav_bytes = _piper_to_wav(text, model_entry["path"], model_entry.get("json"))
                tmp_path.write_bytes(wav_bytes)
                selected_backend = "piper"
            except RuntimeError as exc:
                last_error = exc
                logger.warning("Piper synthesis failed (%s); falling back to espeak if available", exc)

        if selected_backend is None:
            if not _is_espeak_available():
                if last_error is not None:
                    logger.error("No espeak-ng available after Piper failure: %s", last_error)
                raise HTTPException(status_code=503, detail="no_tts_backend_available")
            try:
                _synthesize_with_espeak(text, tmp_path)
                selected_backend = "espeak"
            except RuntimeError as exc:
                last_error = exc
                logger.error("espeak-ng synthesis failed: %s", exc)
                raise HTTPException(status_code=503, detail="no_tts_backend_available") from exc
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise

    if selected_backend is None:
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=503, detail="no_tts_backend_available")

    return tmp_path, selected_backend


@router.post("/tts/synthesize", response_class=FileResponse)
async def synthesize_tts(
    request: Request,
    text: str = "",
    voice: Optional[str] = None,
    play_local: bool = False,
):
    payload_text = text
    payload_voice = voice
    payload_play_local = play_local

    # Optional JSON body compatibility
    if request.headers.get("content-type", "").lower().startswith("application/json"):
        try:
            body = await request.json()
        except json.JSONDecodeError:
            body = {}
        if isinstance(body, dict):
            payload_text = body.get("text", payload_text)
            payload_voice = body.get("voice", payload_voice)
            if "play_local" in body:
                payload_play_local = bool(body["play_local"])

    text = (payload_text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text_required")

    audio_path, backend_used = _synthesize_to_file(text, payload_voice)

    if payload_play_local:
        try:
            await _play_audio_locally(audio_path)
        except Exception:
            # Best-effort playback; ignore errors to still return audio
            pass

    background = BackgroundTask(lambda: audio_path.unlink(missing_ok=True))
    filename = f"tts_{backend_used}.wav"
    response = FileResponse(
        audio_path,
        media_type="audio/wav",
        filename=filename,
        background=background,
    )
    response.headers["X-TTS-Backend"] = backend_used
    return response


@router.post("/tts/say")
async def say(text: str, voice: Optional[str] = None):
    text = (text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text_required")

    audio_path, backend_used = _synthesize_to_file(text, voice)
    try:
        await _play_audio_locally(audio_path)
    finally:
        audio_path.unlink(missing_ok=True)

    return {"ok": True, "backend": backend_used}


@router.post("/upload")
async def upload_audio(file: UploadFile = File(...)):
    filename = file.filename or "clip"
    ext = Path(filename).suffix.lower()
    if ext not in SUPPORTED_UPLOAD_EXTENSIONS:
        ext = ".webm"

    VOICE_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
    dest_path = VOICE_OUTPUT_DIR / f"clip_{timestamp}{ext}"

    with dest_path.open("wb") as buffer:
        while True:
            chunk = await file.read(8192)
            if not chunk:
                break
            buffer.write(chunk)

    return {"ok": True, "path": str(dest_path)}


def _find_whisper_binary() -> Optional[Path]:
    if not WHISPER_DIR.exists():
        return None

    candidate_names = ["main", "whisper", "whisper-cli", "whisper.cpp"]
    for name in candidate_names:
        for candidate in (WHISPER_DIR / name, WHISPER_DIR / "build" / name):
            if candidate.exists() and candidate.is_file() and os_access_executable(candidate):
                return candidate

    # Fallback to searching for executables recursively
    for candidate in WHISPER_DIR.rglob("*"):
        if candidate.is_file() and os_access_executable(candidate) and candidate.name in candidate_names:
            return candidate

    return None


def os_access_executable(path: Path) -> bool:
    return path.exists() and os.access(path, os.X_OK)


def _find_whisper_model() -> Optional[Path]:
    if not WHISPER_DIR.exists():
        return None
    for candidate in WHISPER_DIR.rglob("*.bin"):
        if candidate.is_file():
            return candidate
    return None


@router.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    whisper_binary = _find_whisper_binary()
    model_path = _find_whisper_model()
    if whisper_binary is None or model_path is None:
        return {"ok": True, "transcript": None, "reason": "whisper_not_installed"}

    if shutil.which("ffmpeg") is None:
        return {"ok": True, "transcript": None, "reason": "ffmpeg_missing"}

    with tempfile.TemporaryDirectory() as tmpdir:
        original_path = Path(tmpdir) / (file.filename or "input")
        with original_path.open("wb") as buffer:
            while True:
                chunk = await file.read(8192)
                if not chunk:
                    break
                buffer.write(chunk)

        wav_path = Path(tmpdir) / "normalized.wav"
        ffmpeg_cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(original_path),
            "-ar",
            "16000",
            "-ac",
            "1",
            str(wav_path),
        ]
        try:
            subprocess.run(ffmpeg_cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except subprocess.CalledProcessError as exc:
            raise HTTPException(status_code=500, detail="ffmpeg_failed") from exc

        output_prefix = Path(tmpdir) / "transcript"
        whisper_cmd = [
            str(whisper_binary),
            "-m",
            str(model_path),
            "-f",
            str(wav_path),
            "-otxt",
            "-of",
            str(output_prefix),
        ]

        try:
            subprocess.run(whisper_cmd, check=True, cwd=WHISPER_DIR, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except subprocess.CalledProcessError as exc:
            raise HTTPException(status_code=500, detail="whisper_failed") from exc

        transcript_file = output_prefix.with_suffix(".txt")
        transcript_text = transcript_file.read_text(encoding="utf-8").strip() if transcript_file.exists() else ""

    return {"ok": True, "transcript": transcript_text or None, "engine": "whisper.cpp"}
