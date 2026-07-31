"""SSE(text/event-stream) 직렬화 헬퍼."""

from __future__ import annotations

import json
from typing import Any, Final

SSE_MEDIA_TYPE: Final[str] = "text/event-stream"

SSE_HEADERS: Final[dict[str, str]] = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    # nginx 등 리버스 프록시의 버퍼링을 막아 델타가 즉시 나가게 한다.
    "X-Accel-Buffering": "no",
}


def event(name: str, data: dict[str, Any]) -> str:
    """`event:` / `data:` 한 쌍을 만든다. data 는 한 줄 JSON(한글 그대로)."""
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {name}\ndata: {payload}\n\n"
