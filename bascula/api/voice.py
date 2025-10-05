"""Voice and speech endpoints for Bascula backend."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response

router = APIRouter(prefix="/api/voice", tags=["voice"])

LOG = logging.getLogger("voice")

PIPER_DIRS = [Path("/opt/piper/models"), Path("/opt/bascula/voices")]
PIPER_BIN = Path(shutil.which("piper") or "/opt/piper/bin/piper")
ESPEAK_BIN = shutil.which("espeak-ng") or shutil.which("espeak")
APLAY_BIN = shutil.which("aplay")
VOICE_DATA_DIR = Path("/opt/bascula/data/voice")
WHISPER_ROOT = Path("/opt/whisper.cpp")


def _log_info(message: str) -> None:
    LOG.info("[voice] %s", message)


def _log_warn(message: str) -> None:
    LOG.warning("[voice] %s", message)


def _discover_piper_voices() -> List[Dict[str, object]]:
    voices: Dict[str, Dict[str, object]] = {}
    for directory in PIPER_DIRS:
        if not directory.exists():
            continue
        for model_path in directory.glob("*.onnx"):
            voice_id = model_path.stem
            if voice_id in voices:
                continue
            config_path = model_path.with_suffix(".onnx.json")
            voices[voice_id] = {
                "id": voice_id,
                "name": voice_id.replace("_", " "),
                "engine": "piper",
                "model": model_path,
                "config": config_path if config_path.exists() else None,
            }
    return sorted(voices.values(), key=lambda item: str(item["id"]))


def _list_espeak_voices() -> List[Dict[str, object]]:
    default_voice = "es"
    return [
        {
            "id": f"espeak:{default_voice}",
            "name": "espeak-ng (es)",
            "engine": "espeak",
            "voice": default_voice,
        }
    ]


def _resolve_whisper_paths() -> Optional[Tuple[Path, Path]]:
    if not WHISPER_ROOT.exists():
        return None

    candidates = [
        WHISPER_ROOT / "main",
        WHISPER_ROOT / "bin" / "main",
    ]
    alt_binary = shutil.which("whisper_cpp")
    if alt_binary:
        candidates.append(Path(alt_binary))

    binary = next((path for path in candidates if path and path.exists()), None)
    if binary is None:
        return None

    try:
        model = next(WHISPER_ROOT.glob("ggml-*.bin"))
    except StopIteration:
        return None

    return Path(binary), model


def _piper_available() -> bool:
    return PIPER_BIN.exists()


def _select_piper_voice(voice_id: Optional[str]) -> Dict[str, object]:
    voices = _discover_piper_voices()
    if not voices:
        raise RuntimeError("piper_voice_not_found")
    if voice_id:
        for entry in voices:
            if entry["id"] == voice_id:
                return entry
        raise HTTPException(status_code=404, detail="voice_not_found")
    return voices[0]


def _synthesize_with_piper(text: str, voice_id: Optional[str]) -> Tuple[bytes, Dict[str, object]]:
    if not _piper_available():
        raise RuntimeError("piper_not_available")

    voice_entry = _select_piper_voice(voice_id)

    model_path: Path = voice_entry["model"]  # type: ignore[assignment]
    config_path: Optional[Path] = voice_entry.get("config")  # type: ignore[assignment]

    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_out:
        tmp_output = Path(tmp_out.name)

    cmd = [
        str(PIPER_BIN),
        "--model",
        str(model_path),
        "--output_file",
        str(tmp_output),
        "--text",
        text,
    ]
    if config_path:
        cmd.extend(["--config", str(config_path)])

    env = os.environ.copy()
    env.setdefault("PIPER_NO_CACHE", "1")

    result = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if result.returncode != 0:
        tmp_output.unlink(missing_ok=True)
        _log_warn(f"piper failed: {result.stderr.strip()}")
        raise HTTPException(status_code=503, detail="piper_failed")

    audio_bytes = tmp_output.read_bytes()
    tmp_output.unlink(missing_ok=True)
    _log_info(f"Generated speech with Piper voice {voice_entry['id']}")
    return audio_bytes, {"engine": "piper", "voice": voice_entry["id"]}


def _synthesize_with_espeak(text: str, voice_id: Optional[str]) -> Tuple[bytes, Dict[str, object]]:
    if not ESPEAK_BIN:
        raise HTTPException(status_code=503, detail="espeak_not_available")

    voice_name = "es"
    if voice_id:
        voice_name = voice_id.split(":", 1)[-1] if ":" in voice_id else voice_id

    cmd = [ESPEAK_BIN, "-v", voice_name, "--stdout", text]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0 or not result.stdout:
        _log_warn(f"espeak failed: {result.stderr.decode(errors='ignore').strip() if result.stderr else 'no output'}")
        raise HTTPException(status_code=503, detail="espeak_failed")

    _log_info(f"Generated speech with espeak voice {voice_name}")
    return result.stdout, {"engine": "espeak", "voice": voice_name}


def _synthesize_audio(text: str, voice: Optional[str]) -> Tuple[bytes, Dict[str, object]]:
    text = text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text_required")

    if _piper_available() and _discover_piper_voices():
        try:
            return _synthesize_with_piper(text, voice)
        except HTTPException:
            raise
        except Exception as exc:  # pragma: no cover
            _log_warn(f"Falling back to espeak after Piper error: {exc}")

    return _synthesize_with_espeak(text, voice)


async def _async_synthesize(text: str, voice: Optional[str]) -> Tuple[bytes, Dict[str, object]]:
    return await asyncio.to_thread(_synthesize_audio, text, voice)


def _play_audio_locally(audio: bytes) -> None:
    if not APLAY_BIN:
        _log_warn("aplay not available; skipping local playback")
        return
    try:
        proc = subprocess.Popen([APLAY_BIN, "-q"], stdin=subprocess.PIPE)
        proc.communicate(audio)
    except Exception as exc:  # pragma: no cover
        _log_warn(f"Failed to play audio locally: {exc}")


def _safe_suffix(filename: Optional[str]) -> str:
    if not filename:
        return ".bin"
    suffix = Path(filename).suffix
    return suffix if suffix else ".bin"


async def _store_upload(file: UploadFile) -> Path:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty_file")

    VOICE_DATA_DIR.mkdir(parents=True, exist_ok=True)
    suffix = _safe_suffix(file.filename)
    timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    destination = VOICE_DATA_DIR / f"clip-{timestamp}{suffix}"
    destination.write_bytes(data)
    _log_info(f"Stored voice clip at {destination}")
    return destination


async def _write_temp_audio(file: UploadFile) -> Path:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty_file")

    suffix = _safe_suffix(file.filename)
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp_in:
        tmp_in.write(data)
        tmp_path = Path(tmp_in.name)

    return tmp_path


@router.get("/tts/voices")
async def list_voices():
    piper_voices = _discover_piper_voices() if _piper_available() else []
    engine = "piper" if piper_voices else "espeak"

    if engine == "piper":
        voices = [
            {"id": entry["id"], "name": entry["name"], "engine": "piper"}
            for entry in piper_voices
        ]
    else:
        voices = _list_espeak_voices()

    default_voice = voices[0]["id"] if voices else None
    return {"ok": True, "engine": engine, "voices": voices, "default_voice": default_voice}


@router.post("/tts/synthesize")
async def synthesize(text: str, voice: Optional[str] = None):
    audio, _ = await _async_synthesize(text, voice)
    headers = {"Content-Disposition": 'inline; filename="speech.wav"'}
    return Response(content=audio, media_type="audio/wav", headers=headers)


@router.post("/tts/say")
async def say(text: str, voice: Optional[str] = None, play_local: bool = True):
    audio, _ = await _async_synthesize(text, voice)
    if play_local:
        _play_audio_locally(audio)
    headers = {"Content-Disposition": 'inline; filename="speech.wav"'}
    return Response(content=audio, media_type="audio/wav", headers=headers)


@router.post("/upload")
async def upload(file: UploadFile = File(...)):
    path = await _store_upload(file)
    return {"ok": True, "path": str(path)}


def _normalize_audio(input_path: Path) -> Optional[Path]:
    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        _log_warn("ffmpeg not available; cannot normalize audio")
        return None

    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_out:
        normalized = Path(tmp_out.name)

    cmd = [
        ffmpeg_bin,
        "-y",
        "-i",
        str(input_path),
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "wav",
        str(normalized),
    ]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        _log_warn(f"ffmpeg normalization failed: {result.stderr.decode(errors='ignore').strip() if result.stderr else 'unknown error'}")
        normalized.unlink(missing_ok=True)
        return None

    return normalized


def _run_whisper(audio_path: Path) -> Optional[str]:
    paths = _resolve_whisper_paths()
    if not paths:
        return None

    binary, model = paths
    tmp_dir = Path(tempfile.mkdtemp(prefix="whisper_"))
    output_base = tmp_dir / "transcript"

    cmd = [
        str(binary),
        "-m",
        str(model),
        "-f",
        str(audio_path),
        "-otxt",
        "-of",
        str(output_base),
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(WHISPER_ROOT))
    if result.returncode != 0:
        _log_warn(f"whisper.cpp failed: {result.stderr.strip() if result.stderr else 'no stderr'}")
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return "__ERROR__"

    transcript_file = output_base.with_suffix(".txt")
    if not transcript_file.exists():
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return ""

    transcript = transcript_file.read_text(encoding="utf-8").strip()
    shutil.rmtree(tmp_dir, ignore_errors=True)
    return transcript


@router.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    source_path = await _write_temp_audio(file)

    normalized = _normalize_audio(source_path)
    if normalized is None:
        source_path.unlink(missing_ok=True)
        return {"ok": False, "transcript": None, "reason": "normalization_failed"}

    whisper_result = _run_whisper(normalized)
    source_path.unlink(missing_ok=True)
    normalized.unlink(missing_ok=True)

    if whisper_result is None:
        return {"ok": True, "transcript": None, "reason": "whisper_not_installed"}

    if whisper_result == "__ERROR__":
        return {"ok": False, "transcript": None, "reason": "whisper_failed"}

    return {"ok": True, "transcript": whisper_result or None}
