"""Provider 추상화.

구독 모드(claude_agent_sdk)와 API 키 모드(anthropic SDK)를 같은 인터페이스로
쓴다. 두 메서드 모두 **델타 스트리밍** 이며, 이벤트는 dict 로 흘린다.

이벤트
------
`{"type": "delta", "text": "..."}`
    부분 텍스트. 도착 즉시 여러 번 나온다.
`{"type": "done", "text": ..., "usage": ..., "cost": ..., "truncated": ...,
  "stop_reason": ...}`
    마지막에 한 번. `usage`/`cost` 를 얻을 수 없으면 `None` 이다.
    **추정값을 만들어 넣지 않는다.**

실패는 `ProviderError` 로 던진다(부분 델타가 이미 나간 뒤일 수도 있다).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from typing import Any, ClassVar, Final, Literal, TypedDict

from prompts import CHAT_SYSTEM_PROMPT, SOLVE_SYSTEM_PROMPT, solve_user_text

Effort = Literal["low", "medium", "high", "xhigh", "max"]
Mode = Literal["text", "image"]
Role = Literal["user", "assistant"]

VALID_EFFORTS: Final[tuple[Effort, ...]] = ("low", "medium", "high", "xhigh", "max")
DEFAULT_EFFORT: Final[Effort] = "medium"


@dataclass(frozen=True)
class TextPart:
    """대화 블록: 텍스트."""

    text: str


@dataclass(frozen=True)
class ImagePart:
    """대화 블록: base64 PNG 이미지."""

    b64: str
    media_type: str = "image/png"


Part = TextPart | ImagePart


@dataclass(frozen=True)
class Turn:
    """대화 한 턴."""

    role: Role
    parts: tuple[Part, ...]


class DeltaEvent(TypedDict):
    """부분 텍스트 이벤트."""

    type: Literal["delta"]
    text: str


class DoneEvent(TypedDict):
    """완료 이벤트. `usage`/`cost` 는 못 얻으면 None."""

    type: Literal["done"]
    text: str
    usage: dict[str, Any] | None
    cost: dict[str, Any] | None
    truncated: bool
    stop_reason: str | None


ProviderEvent = DeltaEvent | DoneEvent


class ProviderError(RuntimeError):
    """프로바이더 호출 실패. `message` 는 한국어."""

    def __init__(self, error_code: str, message: str, hint: str | None = None) -> None:
        """`message` 는 사용자에게 보여줄 한국어 문장이다."""
        super().__init__(message)
        self.error_code = error_code
        self.message = message
        self.hint = hint


class Provider(ABC):
    """풀이/채팅 스트리밍 프로바이더."""

    name: ClassVar[str] = "base"
    supports_images: ClassVar[bool] = False

    @abstractmethod
    def stream(
        self,
        *,
        system: str,
        turns: Sequence[Turn],
        model: str,
        effort: Effort,
        max_tokens: int,
    ) -> AsyncIterator[ProviderEvent]:
        """System + 대화 턴으로 응답을 스트리밍한다(구현체는 async generator)."""

    def _ensure_image_support(self, parts: Sequence[Part]) -> None:
        """이미지 블록이 있는데 지원하지 않으면 조용히 넘기지 말고 실패시킨다."""
        if not any(isinstance(part, ImagePart) for part in parts):
            return
        if self.supports_images:
            return
        raise ProviderError(
            "unsupported",
            f"'{self.name}' 프로바이더는 이미지 입력을 지원하지 않습니다.",
            "API 키 모드로 전환하거나, 텍스트 모드로 추출된 시험지를 사용하세요.",
        )

    async def solve_problem(
        self,
        *,
        no: int,
        mode: Mode,
        text: str,
        image_b64: str | None,
        model: str,
        effort: Effort,
        max_tokens: int,
        system: str | None = None,
        instruction: str | None = None,
    ) -> AsyncIterator[ProviderEvent]:
        """문항 하나의 풀이를 스트리밍한다.

        Args:
            no: 문항 번호.
            mode: `image` 면 크롭 PNG 를, `text` 면 추출 텍스트를 보낸다.
            text: 문항 텍스트(text 모드 필수).
            image_b64: 크롭 PNG base64(image 모드 필수).
            model: 모델 ID.
            effort: 사고 강도.
            max_tokens: 출력 상한(구독 모드에서는 CLI 가 관리하므로 무시된다).
            system: system 프롬프트. 기본값은 풀이용 프롬프트.
            instruction: user 지시문. 기본값은 모드별 표준 지시문.

        Yields:
            `delta` 이벤트들, 마지막에 `done` 이벤트 하나.

        Raises:
            ProviderError: 입력이 모자라거나 호출이 실패했을 때.
        """
        parts: list[Part] = []
        if mode == "image":
            if not image_b64:
                raise ProviderError(
                    "crop_missing",
                    f"{no}번 문항의 크롭 이미지가 없어 풀이를 요청할 수 없습니다.",
                    "파일을 다시 업로드해 추출을 재실행하세요.",
                )
            parts.append(ImagePart(b64=image_b64))
        elif not text.strip():
            raise ProviderError(
                "text_missing",
                f"{no}번 문항의 텍스트가 비어 있어 풀이를 요청할 수 없습니다.",
                "이미지 모드로 추출된 시험지인지 확인하세요.",
            )
        parts.append(
            TextPart(text=instruction or solve_user_text(no, mode=mode, text=text))
        )
        self._ensure_image_support(parts)

        turns = (Turn(role="user", parts=tuple(parts)),)
        async for event in self.stream(
            system=system or SOLVE_SYSTEM_PROMPT,
            turns=turns,
            model=model,
            effort=effort,
            max_tokens=max_tokens,
        ):
            yield event

    async def chat(
        self,
        *,
        turns: Sequence[Turn],
        model: str,
        effort: Effort,
        max_tokens: int,
        system: str | None = None,
    ) -> AsyncIterator[ProviderEvent]:
        """대화 이력을 이어 응답을 스트리밍한다.

        Args:
            turns: 오래된 순서의 대화 턴. 마지막 턴이 새 사용자 메시지다.
            model: 모델 ID.
            effort: 사고 강도.
            max_tokens: 출력 상한(구독 모드에서는 무시된다).
            system: system 프롬프트. 기본값은 채팅용 프롬프트.

        Yields:
            `delta` 이벤트들, 마지막에 `done` 이벤트 하나.

        Raises:
            ProviderError: 입력이 비었거나 호출이 실패했을 때.
        """
        if not turns:
            raise ProviderError("empty_message", "보낼 메시지가 없습니다.")
        for turn in turns:
            self._ensure_image_support(turn.parts)

        async for event in self.stream(
            system=system or CHAT_SYSTEM_PROMPT,
            turns=turns,
            model=model,
            effort=effort,
            max_tokens=max_tokens,
        ):
            yield event


def flatten_history(turns: Sequence[Turn]) -> tuple[str, tuple[Part, ...]]:
    """대화 턴을 (이전 대화 텍스트, 마지막 턴 블록) 으로 접는다.

    구독 모드(CLI stream-json 입력)는 검증된 형태가 '사용자 메시지 1건' 이므로
    이전 대화를 텍스트로 접어 넣는다. 이전 턴의 이미지는 포함하지 않는다.
    """
    if not turns:
        return "", ()
    history: list[str] = []
    for turn in turns[:-1]:
        label = "학생" if turn.role == "user" else "선생님"
        chunks: list[str] = []
        for part in turn.parts:
            if isinstance(part, TextPart):
                chunks.append(part.text)
            else:
                chunks.append("(이미지 첨부)")
        history.append(f"[{label}] {' '.join(chunks).strip()}")
    return "\n\n".join(history), turns[-1].parts
