"""구독 모드 프로바이더 (claude_agent_sdk 경유, 데스크톱 전용).

Claude Code CLI 의 인증 프로필을 그대로 사용한다. **API 키를 넘기지 않는다.**
(오히려 부모 프로세스에 `ANTHROPIC_API_KEY` 가 남아 있으면 CLI 가 API 과금으로
붙을 수 있으므로, 자식 프로세스 환경에서 빈 값으로 덮어 구독 인증을 강제한다.)

호출 방법 확인 근거
------------------
`pip show -f claude-agent-sdk` 로 설치 위치를 찾아
`claude_agent_sdk/__init__.py`, `query.py`, `types.py`,
`_internal/transport/subprocess_cli.py` 를 직접 읽어 확인했다.
- `query(prompt=..., options=ClaudeAgentOptions(...))` -> `AsyncIterator[Message]`
- 이미지 입력은 `prompt` 를 `AsyncIterable[dict]`(stream-json 입력)으로 주고
  `{"type":"user","message":{"role":"user","content":[블록...]}}` 형태로 보낸다.
  실제 크롭 PNG 로 호출해 판독이 되는 것을 확인했다.
- 델타는 `include_partial_messages=True` 일 때 `StreamEvent.event` 의
  `content_block_delta / text_delta` 로 온다.
- 실측 토큰은 `ResultMessage.usage`. **비용(cost)은 구독이므로 항상 `None`.**
"""

from __future__ import annotations

import os
import shutil
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Any, ClassVar, Final

import config
import pricing
from providers.base import (
    DeltaEvent,
    DoneEvent,
    Effort,
    ImagePart,
    Provider,
    ProviderError,
    ProviderEvent,
    TextPart,
    Turn,
    flatten_history,
)

try:  # claude_agent_sdk 는 데스크톱 전용 의존성이다.
    from claude_agent_sdk import (
        AssistantMessage,
        ClaudeAgentOptions,
        ClaudeSDKError,
        CLINotFoundError,
        ResultMessage,
        StreamEvent,
        TextBlock,
        query,
    )
except ImportError as exc:  # pragma: no cover - 설치 여부에 따라 갈린다
    SDK_AVAILABLE = False
    SDK_IMPORT_ERROR: str | None = str(exc)
else:
    SDK_AVAILABLE = True
    SDK_IMPORT_ERROR = None

_CLI_NAMES: Final[tuple[str, ...]] = ("claude.exe", "claude")
_PROFILE_DIR_NAME: Final[str] = ".claude"


def find_cli() -> Path | None:
    r"""PATH 와 `%USERPROFILE%\.local\bin` 에서 claude 실행파일을 찾는다."""
    found = shutil.which("claude")
    if found:
        path = Path(found)
        if path.is_file():
            return path
    local_bin = Path.home() / ".local" / "bin"
    for name in _CLI_NAMES:
        candidate = local_bin / name
        if candidate.is_file():
            return candidate
    return None


def profile_dir() -> Path:
    """Claude Code 인증 프로필 디렉터리."""
    return Path.home() / _PROFILE_DIR_NAME


DISABLE_ENV: Final[str] = "MATH_TEACHER_DISABLE_SUBSCRIPTION"

# `availability()["reason"]` 값. 프론트가 안내 문구를 갈라 쓰기 위한 것이다.
#   ok            : 사용 가능
#   web_mode      : 웹 배포 — 서버가 사용자 PC 인증에 접근할 수 없다
#   disabled      : 환경변수로 강제 비활성화(테스트/의도적 API 전용 운용)
#   sdk_missing   : claude-agent-sdk 미설치
#   cli_missing   : Claude Code 가 설치되지 않았다
#   not_logged_in : Claude Code 는 있는데 로그인 프로필(~/.claude)이 없다
Reason = str


def unavailable_reason() -> Reason:
    """구독을 쓸 수 없는 이유. 쓸 수 있으면 `"ok"`.

    `MATH_TEACHER_DISABLE_SUBSCRIPTION=1` 로 강제 비활성화할 수 있다.
    Claude Code 를 지우지 않고도 "미설치 상태" UI 를 확인하기 위한 테스트 스위치이며,
    일부러 API 키 모드만 쓰고 싶을 때도 쓸 수 있다.
    """
    if os.environ.get(DISABLE_ENV, "").strip() not in ("", "0", "false", "False"):
        return "disabled"
    if config.deploy_mode() != "desktop":
        return "web_mode"
    if not SDK_AVAILABLE:
        return "sdk_missing"
    if find_cli() is None:
        return "cli_missing"
    if not profile_dir().is_dir():
        return "not_logged_in"
    return "ok"


def is_available() -> bool:
    """구독 모드를 쓸 수 있는지.

    ① claude 실행파일이 있고 ② `~/.claude` 프로필이 있고
    ③ SDK 가 설치돼 있고 ④ 배포 모드가 `desktop` 이어야 한다.
    (웹 배포는 서버가 사용자 PC 인증에 접근할 수 없으므로 항상 False.)
    실제 호출 성공 여부는 첫 호출에서 판정한다.
    """
    return unavailable_reason() == "ok"


def availability() -> dict[str, Any]:
    """`GET /api/env` 의 `subscription` 필드."""
    reason = unavailable_reason()
    cli = None if reason == "disabled" else find_cli()
    return {
        "available": reason == "ok",
        "cli_path": None if cli is None else str(cli),
        "reason": reason,
    }


def _prompt_message(turns: Sequence[Turn]) -> dict[str, Any]:
    """대화를 stream-json 입력용 user 메시지 1건으로 접는다."""
    history, last_parts = flatten_history(turns)
    content: list[dict[str, Any]] = []
    for part in last_parts:
        if isinstance(part, ImagePart):
            content.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": part.media_type,
                        "data": part.b64,
                    },
                }
            )
    texts = [part.text for part in last_parts if isinstance(part, TextPart)]
    body = "\n\n".join(texts)
    if history:
        body = f"# 이전 대화\n{history}\n\n# 지금 질문\n{body}"
    content.append({"type": "text", "text": body})
    return {
        "type": "user",
        "message": {"role": "user", "content": content},
        "parent_tool_use_id": None,
        "session_id": "math-teacher",
    }


class SubscriptionProvider(Provider):
    """Claude Code 구독 인증으로 호출하는 프로바이더."""

    name: ClassVar[str] = "subscription"
    # 실측 확인: 크롭 PNG(base64) 를 stream-json 입력으로 보내 판독됐다.
    supports_images: ClassVar[bool] = True

    def __init__(self) -> None:
        """SDK 와 CLI/프로필이 준비돼 있는지 확인한다."""
        if not SDK_AVAILABLE:
            raise ProviderError(
                "sdk_missing",
                "claude-agent-sdk 가 설치되어 있지 않아 구독 모드를 쓸 수 없습니다.",
                f"pip install claude-agent-sdk 를 실행하세요. (원문: {SDK_IMPORT_ERROR})",
            )
        if find_cli() is None or not profile_dir().is_dir():
            raise ProviderError(
                "subscription_unavailable",
                "Claude Code CLI 또는 로그인 프로필을 찾을 수 없습니다.",
                "claude 를 설치하고 로그인한 뒤 다시 시도하세요. "
                "웹 배포에서는 구독 모드를 쓸 수 없습니다.",
            )

    def _options(self, *, system: str, model: str, effort: Effort) -> ClaudeAgentOptions:
        cli = find_cli()
        # .cmd/.bat 래퍼는 SDK 가 거부하므로 실행파일일 때만 넘긴다(아니면 번들 CLI).
        cli_path = str(cli) if cli is not None and cli.suffix.lower() == ".exe" else None
        child_env = {
            # 구독 인증 강제: 부모 셸의 API 키가 새어 들어가 과금되는 것을 막는다.
            "ANTHROPIC_API_KEY": "",
            "CLAUDE_AGENT_SDK_CLIENT_APP": "math-teacher-core/0.1.0",
        }
        return ClaudeAgentOptions(
            system_prompt=system,
            model=model,
            tools=[],  # 도구 없이 순수 대화만
            allowed_tools=[],
            setting_sources=[],  # 사용자 settings/CLAUDE.md 를 끌어오지 않는다
            permission_mode="dontAsk",
            include_partial_messages=True,  # 델타 스트리밍
            thinking={"type": "adaptive"},  # budget_tokens 금지
            effort=effort,
            max_turns=1,
            cwd=str(config.data_dir()),
            cli_path=cli_path,
            env={key: value for key, value in child_env.items() if value is not None},
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
        """CLI 를 통해 델타를 흘린다. `max_tokens` 는 CLI 가 관리하므로 무시된다."""
        del max_tokens  # 구독 모드에서는 출력 상한을 지정할 수 없다

        message = _prompt_message(turns)

        async def prompt_stream() -> AsyncIterator[dict[str, Any]]:
            yield message

        deltas: list[str] = []
        assistant_texts: list[str] = []
        result: ResultMessage | None = None

        try:
            async for chunk in query(
                prompt=prompt_stream(),
                options=self._options(system=system, model=model, effort=effort),
            ):
                if isinstance(chunk, StreamEvent):
                    text = _delta_text(chunk.event)
                    if text:
                        deltas.append(text)
                        yield DeltaEvent(type="delta", text=text)
                elif isinstance(chunk, AssistantMessage):
                    joined = "".join(
                        block.text
                        for block in chunk.content
                        if isinstance(block, TextBlock)
                    )
                    if joined.strip():
                        assistant_texts.append(joined)
                elif isinstance(chunk, ResultMessage):
                    result = chunk
        except CLINotFoundError as exc:
            raise ProviderError(
                "subscription_unavailable",
                "Claude Code CLI 를 실행할 수 없습니다.",
                f"원문: {exc}",
            ) from exc
        except ClaudeSDKError as exc:
            raise ProviderError(
                "subscription_failed",
                "구독 모드 호출에 실패했습니다. Claude Code 로그인 상태를 확인하세요.",
                f"원문: {type(exc).__name__}: {exc}",
            ) from exc

        if result is not None and result.is_error:
            raise ProviderError(
                "subscription_failed",
                "구독 모드 호출이 오류로 끝났습니다.",
                f"subtype={result.subtype} errors={result.errors} "
                f"http={result.api_error_status}",
            )

        text = _final_text(result, assistant_texts, deltas)
        if not text:
            raise ProviderError(
                "empty_response",
                "모델이 빈 응답을 반환했습니다. 다시 시도하세요.",
                None if result is None else f"stop_reason={result.stop_reason}",
            )

        usage: dict[str, Any] | None = None
        stop_reason: str | None = None
        if result is not None:
            stop_reason = result.stop_reason
            if result.usage:
                # 실측 토큰만 보존한다. 못 얻으면 None (추정값을 만들지 않는다).
                usage = pricing.normalize_usage(result.usage)

        yield DoneEvent(
            type="done",
            text=text,
            usage=usage,
            cost=None,  # 구독 모드는 추가 과금이 없으므로 비용은 항상 null
            truncated=stop_reason == "max_tokens",
            stop_reason=stop_reason,
        )


def _delta_text(event: dict[str, Any]) -> str | None:
    """Raw 스트림 이벤트에서 본문 text_delta 만 뽑는다(thinking 은 제외)."""
    if event.get("type") != "content_block_delta":
        return None
    delta = event.get("delta")
    if not isinstance(delta, dict) or delta.get("type") != "text_delta":
        return None
    text = delta.get("text")
    return text if isinstance(text, str) and text else None


def _final_text(
    result: ResultMessage | None,
    assistant_texts: Sequence[str],
    deltas: Sequence[str],
) -> str:
    """최종 본문: ResultMessage.result → assistant 블록 → 델타 누적 순으로 채택."""
    if result is not None and isinstance(result.result, str) and result.result.strip():
        return result.result.strip()
    if assistant_texts:
        return assistant_texts[-1].strip()
    return "".join(deltas).strip()
