from __future__ import annotations

import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from backend.services.voice_service import voice_service

logger = logging.getLogger("bascula.voice.routes")

router = APIRouter(prefix="/api/voice", tags=["voice"])


@router.post("/ptt/start")
async def api_voice_ptt_start() -> dict[str, object]:
    voice_service.mode = "recetas"
    result = voice_service.start_listen_ptt()
    if not result.ok:
        reason = result.reason or "unavailable"
        status_code = 423 if reason == "busy" else 400
        logger.warning("VOICE[PTT] start failed: %s", reason)
        voice_service.mode = "general"
        return JSONResponse(status_code=status_code, content={"ok": False, "reason": reason})
    return {"ok": True}


@router.post("/ptt/stop")
async def api_voice_ptt_stop() -> dict[str, object]:
    result = voice_service.stop_listen_ptt()
    voice_service.mode = "general"
    if not result.ok:
        reason = result.reason or "not-listening"
        logger.warning("VOICE[PTT] stop failed: %s", reason)
        return JSONResponse(status_code=400, content={"ok": False, "reason": reason})
    payload: dict[str, object] = {"ok": True}
    if result.transcript is not None:
        payload["transcript"] = result.transcript
    return payload
