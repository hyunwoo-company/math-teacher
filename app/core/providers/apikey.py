"""API 키 모드 프로바이더 (anthropic SDK).

호출 규칙 (ARCHITECTURE.md 4항 — 위반하면 400)
---------------------------------------------
* `temperature` / `top_p` / `top_k` 를 **넣지 않는다**.
* `thinking` 은 `{"type": "adaptive"}` 만. `budget_tokens` 금지.
* 사고 강도는 `output_config={"effort": ...}` 로 조절한다.
* system 프롬프트 블록에 `cache_control: {"type": "ephemeral"}` 를 건다.
* 스트리밍은 `client.messages.stream()` 을 쓴다.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from typing import Any, ClassVar, Final

import anthropic
from anthropic.types import (
    Base64ImageSourceParam,
    ImageBlockParam,
    MessageParam,
    TextBlockParam,
)
from anthropic.types.output_config_param import OutputConfigParam
from anthropic.types.thinking_config_adaptive_param import ThinkingConfigAdaptiveParam

import pricing
from providers.base import (
    DeltaEvent,
    DoneEvent,
    Effort,
    ImagePart,
    Part,
    Provider,
    ProviderError,
    ProviderEvent,
    Turn,
)

ContentBlock = TextBlockParam | ImageBlockParam

_TIMEOUT_SECONDS: Final[float] = 600.0


def _content_blocks(parts: Sequence[Part]) -> list[ContentBlock]:
    blocks: list[ContentBlock] = []
    for part in parts:
        if isinstance(part, ImagePart):
            blocks.append(
                ImageBlockParam(
                    type="image",
                    source=Base64ImageSourceParam(
                        type="base64",
                        media_type="image/png",
                        data=part.b64,
                    ),
                )
            )
        else:
            blocks.append(TextBlockParam(type="text", text=part.text))
    return blocks


def _usage_to_dict(usage: object) -> dict[str, Any] | None:
    """`response.usage` 를 dict 로 보존한다(실측, 추정 없음)."""
    if usage is None:
        return None
    dump = getattr(usage, "model_dump", None)
    if callable(dump):
        result = dump(mode="json")
        return result if isinstance(result, dict) else None
    if isinstance(usage, dict):
        return dict(usage)
    return None


class ApiKeyProvider(Provider):
    """Anthropic API 키로 직접 호출하는 프로바이더."""

    name: ClassVar[str] = "apikey"
    supports_images: ClassVar[bool] = True

    def __init__(self, api_key: str) -> None:
        """API 키로 비동기 클라이언트를 만든다."""
        if not api_key.strip():
            raise ProviderError(
                "no_api_key",
                "Anthropic API 키가 없습니다.",
                "설정에서 API 키를 저장하거나 요청 헤더 X-Api-Key 로 전달하세요.",
            )
        self._client = anthropic.AsyncAnthropic(
            api_key=api_key.strip(), timeout=_TIMEOUT_SECONDS
        )

    async def stream(
        self,
        *,
        system: str,
        turns: Sequence[Turn],
        model: str,
        effort: Effort,
        max_tokens: int,
    ) -> AsyncIterator[ProviderEvent]:
        """`messages.stream()` 으로 델타를 흘리고 마지막에 실측 usage/비용을 준다."""
        messages = [
            MessageParam(role=turn.role, content=_content_blocks(turn.parts))
            for turn in turns
        ]
        system_blocks = [
            TextBlockParam(
                type="text",
                text=system,
                cache_control={"type": "ephemeral"},  # 문항별 호출 → 캐시 히트 노림
            )
        ]

        collected: list[str] = []
        try:
            async with self._client.messages.stream(
                model=model,
                max_tokens=max_tokens,
                system=system_blocks,
                messages=messages,
                # temperature / top_p / top_k 는 의도적으로 넣지 않는다.
                thinking=ThinkingConfigAdaptiveParam(type="adaptive"),
                output_config=OutputConfigParam(effort=effort),
            ) as stream:
                async for chunk in stream.text_stream:
                    if chunk:
                        collected.append(chunk)
                        yield DeltaEvent(type="delta", text=chunk)
                final = await stream.get_final_message()
        except anthropic.AuthenticationError as exc:
            raise ProviderError(
                "auth_failed",
                "Anthropic 인증에 실패했습니다. API 키를 확인하세요.",
                f"원문: {exc}",
            ) from exc
        except anthropic.RateLimitError as exc:
            raise ProviderError(
                "rate_limited",
                "Anthropic API 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요.",
                f"원문: {exc}",
            ) from exc
        except anthropic.APIStatusError as exc:
            raise ProviderError(
                "api_error",
                f"Anthropic API 오류가 발생했습니다 (HTTP {exc.status_code}).",
                f"원문: {getattr(exc, 'message', None) or exc}",
            ) from exc
        except anthropic.APIError as exc:
            raise ProviderError(
                "api_error",
                "Anthropic API 호출에 실패했습니다.",
                f"원문: {exc}",
            ) from exc

        stop_reason = getattr(final, "stop_reason", None)
        usage = _usage_to_dict(getattr(final, "usage", None))
        try:
            cost = pricing.calc_cost(model, usage) if usage is not None else None
        except pricing.UnknownModelError:
            cost = None  # 단가를 모르면 추정하지 않고 비운다

        if stop_reason == "refusal":
            # content 를 읽기 전에 분기한다.
            raise ProviderError(
                "refusal",
                "모델이 응답을 거부했습니다. 문항 이미지나 텍스트를 확인하세요.",
                "stop_reason=refusal",
            )

        text = "".join(collected).strip()
        if not text:
            raise ProviderError(
                "empty_response",
                "모델이 빈 응답을 반환했습니다. 다시 시도하세요.",
                f"stop_reason={stop_reason}",
            )

        yield DoneEvent(
            type="done",
            text=text,
            usage=usage,
            cost=cost,
            truncated=stop_reason == "max_tokens",
            stop_reason=stop_reason,
        )
