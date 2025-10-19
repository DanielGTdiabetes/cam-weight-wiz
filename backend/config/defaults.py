"""Default flags for wake/listen behaviour."""

# Wake-word listener should stay disabled unless explicitly requested via env vars.
WAKE_ENABLED = False

# Offline Vosk transcription is disabled by default; enable via env when needed.
VOSK_ENABLED = False

# Push-to-talk listening remains disabled until UI explicitly toggles it.
LISTEN_ENABLED = False

__all__ = ["WAKE_ENABLED", "VOSK_ENABLED", "LISTEN_ENABLED"]
