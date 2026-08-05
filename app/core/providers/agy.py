"""agy(Antigravity CLI) 프로바이더.

`agy -p "<prompt>" --model <id> --output-format json --dangerously-skip-permissions`
를 **비동기 자식 프로세스**로 실행한다(셸을 거치지 않고 인자 배열로 넘겨 주입을 막는다).

실측 근거
---------
- 출력(성공): ``{"conversation_id", "status": "SUCCESS", "response", "duration_seconds",
  "usage": {"input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens",
  "total_tokens"}}``. 실패 시 ``status != "SUCCESS"`` + ``error`` 필드.
- `agy --help` 로 확인: `--system-prompt` 류 플래그가 **없다**. 그래서 시스템 프롬프트를
  프롬프트 본문 앞에 통합한다. `--effort` 는 `low|medium|high` 만 받는다.
- `gemini-3-flash` 는 `--effort` 를 거부하므로 flash 에는 붙이지 않는다.
- 이미지: 프롬프트에 크롭 PNG **파일 경로**를 넣으면 agy 가 read_file 로 읽는다.
  `--dangerously-skip-permissions` 필수. 경로는 서버가 만든 `data/` 하위만 허용한다.
- 비용: 쿼터 기반이라 달러 비용이 없다 → `cost` 는 항상 `None`. usage 토큰은 그대로 전달.
- 응답에 "Follow-up Question / 꼬리 질문" 같은 잡음을 자동으로 덧붙이므로
  후처리로 제거한다.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import shutil
import uuid
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import ClassVar, Final

import config
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

# 화이트리스트. 값의 `effort` 는 그 모델이 `--effort` 를 받는지 여부다.
# 여기 없는 모델 요청은 거부한다(400 은 ai_service.resolve_model 에서 낸다).
AGY_MODELS: Final[dict[str, dict[str, bool]]] = {
    "gemini-3-flash": {"effort": False},
    "gemini-3.1-pro-low": {"effort": True},
    "gemini-3.1-pro-high": {"effort": True},
    "claude-sonnet-4-6": {"effort": True},
}

DEFAULT_MODEL: Final[str] = "gemini-3-flash"

MODEL_LABELS: Final[dict[str, str]] = {
    "gemini-3-flash": "Gemini 3 Flash (기본, 빠름)",
    "gemini-3.1-pro-low": "Gemini 3.1 Pro (Low, 정밀)",
    "gemini-3.1-pro-high": "Gemini 3.1 Pro (High, 최고 정밀)",
    "claude-sonnet-4-6": "Claude Sonnet 4.6",
}

# base.Effort 는 low|medium|high|xhigh|max 지만 agy --effort 는 low|medium|high 만 받는다.
_AGY_EFFORT: Final[dict[str, str]] = {
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "high",
    "max": "high",
}

# 꼬리말 경계 패턴. agy 가 실제 풀이 뒤에 덧붙이는 잡음을 잘라내는 기준이다.
# 이 목록을 단위테스트로 잠근다(FOLLOWUP_MARKERS 참조 테스트).
FOLLOWUP_MARKERS: Final[tuple[str, ...]] = (
    "Follow-up Question",
    "Follow-up Questions",
    "꼬리 질문",
    "상세한 풀이 과정도 함께 제공해드릴까요",
)

# 실측 속도(flash ~18s, pro ~45s)에 여유를 둔 타임아웃.
_FLASH_TIMEOUT_SECONDS: Final[float] = 90.0
_PRO_TIMEOUT_SECONDS: Final[float] = 180.0

_AGY_NAMES: Final[tuple[str, ...]] = ("agy.exe", "agy")
_TEMP_IMAGE_DIRNAME: Final[str] = "agy_tmp"

# agy 는 코딩 에이전트라, 긴 지시문을 받으면 "구현 계획서(plan)"를 대신 내놓는다(실측).
# 계획/코드가 아니라 완성된 최종 풀이를 곧바로 쓰도록 프롬프트 맨 앞에 강제한다.
_AGY_PREAMBLE: Final[str] = (
    "당신은 코딩 에이전트가 아니라 수학 문제의 완성된 풀이를 최종 답변으로 직접 "
    "작성하는 교사입니다. 구현 계획서(Implementation Plan)나 코드, 작업 단계 나열을 "
    "만들지 말고, 아래 지침의 출력 형식에 맞춘 실제 풀이 본문만 바로 출력하세요. "
    "이미지가 첨부되면 read_file 로 읽어 판독한 뒤 곧장 풀이를 작성합니다."
)


def find_agy() -> Path | None:
    r"""Agy 실행파일을 찾는다.

    PATH 를 먼저 보고, 없으면 알려진 설치 위치를 본다.
    - Windows: `%USERPROFILE%\AppData\Local\agy\bin`
    - Linux(컨테이너/서버): `~/.local/bin` (hostPath 로 마운트되는 위치)
    """
    found = shutil.which("agy")
    if found and Path(found).is_file():
        return Path(found)
    home = Path.home()
    candidates = [
        home / "AppData" / "Local" / "agy" / "bin",
        home / ".local" / "bin",
    ]
    for directory in candidates:
        for name in _AGY_NAMES:
            candidate = directory / name
            if candidate.is_file():
                return candidate
    return None


def is_available() -> bool:
    """Agy 실행파일이 있으면 True."""
    return find_agy() is not None


def agy_models() -> list[dict[str, object]]:
    """`GET /api/env` 의 `providers.agy.models` 항목."""
    return [
        {
            "id": model_id,
            "label": MODEL_LABELS[model_id],
            "default": model_id == DEFAULT_MODEL,
        }
        for model_id in AGY_MODELS
    ]


def availability() -> dict[str, object]:
    """`GET /api/env` 의 `providers.agy` 필드.

    `reason` 은 `ok`(사용 가능) 또는 `agy_missing`(실행파일 없음).
    """
    available = is_available()
    return {
        "available": available,
        "reason": "ok" if available else "agy_missing",
        "models": agy_models(),
    }


def _timeout_for(model: str) -> float:
    """모델별 타임아웃(초). effort 지원 모델(pro/claude)은 더 길게 잡는다."""
    if AGY_MODELS.get(model, {}).get("effort"):
        return _PRO_TIMEOUT_SECONDS
    return _FLASH_TIMEOUT_SECONDS


def build_agy_args(
    *, agy_path: Path, model: str, effort: Effort, prompt: str
) -> list[str]:
    """Agy 실행 인자 배열을 만든다.

    flash 는 `--effort` 를 거부하므로 붙이지 않는다. 지원 모델에만 조건부로 붙인다.

    Raises:
        ProviderError: 화이트리스트에 없는 모델일 때.
    """
    spec = AGY_MODELS.get(model)
    if spec is None:
        raise ProviderError(
            "unknown_model",
            f"agy 에서 지원하지 않는 모델입니다: {model}",
            f"사용 가능: {', '.join(AGY_MODELS)}",
        )
    args = [
        str(agy_path),
        "-p",
        prompt,
        "--model",
        model,
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
    ]
    if spec["effort"]:
        args += ["--effort", _AGY_EFFORT.get(effort, "medium")]
    return args


def _is_separator(line: str) -> bool:
    """빈 줄이거나 마크다운 수평선(---, ___, ***)이면 True."""
    stripped = line.strip()
    if not stripped:
        return True
    return len(stripped) >= 3 and set(stripped) <= {"-", "_", "*"}


def strip_followups(text: str) -> str:
    """Agy 가 붙인 꼬리말(Follow-up 질문 등)을 제거한다.

    실제 풀이는 보존하고, 가장 먼저 나타나는 꼬리말 경계부터 끝까지 잘라낸다.
    경계 직전의 수평선/빈 줄도 함께 정리한다.
    """
    lines = text.splitlines()
    lowered_markers = [marker.lower() for marker in FOLLOWUP_MARKERS]
    cut: int | None = None
    for index, line in enumerate(lines):
        low = line.lower()
        if any(marker in low for marker in lowered_markers):
            cut = index
            break
    if cut is None:
        return text.strip()
    kept = lines[:cut]
    while kept and _is_separator(kept[-1]):
        kept.pop()
    return "\n".join(kept).strip()


def parse_agy_output(stdout: str) -> dict[str, object]:
    """Agy 의 JSON 출력을 파싱한다.

    앞뒤 로그가 섞여 있으면 첫 `{` ~ 마지막 `}` 구간을 다시 시도한다.

    Raises:
        ProviderError: 비어 있거나 JSON 으로 읽을 수 없을 때.
    """
    text = stdout.strip()
    if not text:
        raise ProviderError(
            "agy_empty",
            "agy 가 빈 응답을 반환했습니다. 잠시 후 다시 시도하세요.",
        )
    try:
        loaded = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end < start:
            raise ProviderError(
                "agy_bad_output",
                "agy 출력을 해석할 수 없습니다.",
                text[:500],
            ) from None
        try:
            loaded = json.loads(text[start : end + 1])
        except json.JSONDecodeError as exc:
            raise ProviderError(
                "agy_bad_output",
                "agy 출력을 JSON 으로 파싱하지 못했습니다.",
                f"{exc}",
            ) from exc
    if not isinstance(loaded, dict):
        raise ProviderError(
            "agy_bad_output",
            "agy 출력이 예상한 JSON 객체 형태가 아닙니다.",
            text[:500],
        )
    return loaded


def _validated_image_path(path: Path) -> Path:
    """서버가 만든 `data/` 하위 경로만 허용한다(경로 주입 방지).

    Raises:
        ProviderError: 데이터 디렉터리 밖의 경로일 때.
    """
    resolved = path.resolve()
    root = config.data_dir().resolve()
    if not resolved.is_relative_to(root):
        raise ProviderError(
            "path_forbidden",
            "허용되지 않은 이미지 경로입니다.",
            "서버가 생성한 크롭 이미지(data/ 하위)만 사용할 수 있습니다.",
        )
    return resolved


class AgyProvider(Provider):
    """agy CLI 로 호출하는 프로바이더(쿼터 기반, 달러 비용 없음)."""

    name: ClassVar[str] = "agy"
    # 크롭 PNG 파일 경로를 프롬프트에 넣으면 agy 가 read_file 로 읽는다(실측).
    supports_images: ClassVar[bool] = True

    def __init__(self) -> None:
        """Agy 실행파일을 찾는다. 없으면 실패한다."""
        agy_path = find_agy()
        if agy_path is None:
            raise ProviderError(
                "agy_unavailable",
                "Antigravity CLI(agy) 를 찾을 수 없습니다.",
                "agy 를 설치하고 PATH 에 등록했는지 확인하세요.",
            )
        self._agy_path: Final[Path] = agy_path

    def _write_temp_image(self, b64: str) -> Path:
        """크롭 base64 를 `data/agy_tmp/` 에 PNG 로 써서 agy 가 읽을 경로를 만든다.

        서버가 경로를 직접 생성하므로 외부 경로가 agy 에 넘어가지 않는다.
        """
        raw = base64.b64decode(b64)
        tmp_dir = config.data_dir() / _TEMP_IMAGE_DIRNAME
        tmp_dir.mkdir(parents=True, exist_ok=True)
        path = tmp_dir / f"{uuid.uuid4().hex}.png"
        path.write_bytes(raw)
        return _validated_image_path(path)

    def _build_prompt(
        self, system: str, turns: Sequence[Turn]
    ) -> tuple[str, list[Path]]:
        """시스템 프롬프트 + 이전 대화 + 마지막 턴 + 이미지 경로를 하나로 접는다."""
        history, last_parts = flatten_history(turns)
        temp_images: list[Path] = []
        text_chunks: list[str] = []
        for part in last_parts:
            if isinstance(part, ImagePart):
                temp_images.append(self._write_temp_image(part.b64))
            elif isinstance(part, TextPart):
                text_chunks.append(part.text)

        body = "\n\n".join(chunk for chunk in text_chunks if chunk.strip())
        if history:
            body = f"# 이전 대화\n{history}\n\n# 지금 질문\n{body}"

        sections = [_AGY_PREAMBLE, system]
        if temp_images:
            listing = "\n".join(f"- {path}" for path in temp_images)
            sections.append(
                "# 첨부 이미지\n"
                "다음 경로의 PNG 파일을 read_file 도구로 열어 문항을 정확히 판독하세요:\n"
                + listing
            )
        sections.append(body)
        prompt = "\n\n".join(section for section in sections if section.strip())
        return prompt, temp_images

    async def _run(self, args: list[str], timeout: float) -> str:
        """Agy 를 자식 프로세스로 실행하고 stdout(문자열)을 돌려준다.

        Raises:
            ProviderError: 실행 불가/타임아웃/오류 종료일 때.
        """
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(config.data_dir()),
            )
        except (FileNotFoundError, OSError) as exc:
            raise ProviderError(
                "agy_unavailable",
                "agy 실행파일을 실행할 수 없습니다.",
                f"{exc}",
            ) from exc

        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout)
        except TimeoutError as exc:
            proc.kill()
            with contextlib.suppress(ProcessLookupError):
                await proc.wait()
            raise ProviderError(
                "timeout",
                f"agy 응답이 {int(timeout)}초 안에 오지 않았습니다.",
                "모델을 flash 로 바꾸거나 잠시 후 다시 시도하세요.",
            ) from exc

        stdout = stdout_b.decode("utf-8", errors="replace")
        if proc.returncode != 0 and not stdout.strip():
            detail = stderr_b.decode("utf-8", errors="replace").strip()
            raise ProviderError(
                "agy_failed",
                f"agy 가 오류로 종료했습니다 (종료 코드 {proc.returncode}).",
                detail[:500] or None,
            )
        return stdout

    async def stream(
        self,
        *,
        system: str,
        turns: Sequence[Turn],
        model: str,
        effort: Effort,
        max_tokens: int,
    ) -> AsyncIterator[ProviderEvent]:
        """Agy 를 1회 호출해 응답을 받아 delta 1건 + done 을 흘린다.

        `--output-format json` 은 스트리밍이 아니므로 델타는 전체 텍스트 1건으로 낸다
        (계약상 done 만도 허용되지만 다른 프로바이더와 형태를 맞춘다). `max_tokens` 는
        agy 가 관리하므로 무시한다.
        """
        del max_tokens

        prompt, temp_images = self._build_prompt(system, turns)
        try:
            args = build_agy_args(
                agy_path=self._agy_path, model=model, effort=effort, prompt=prompt
            )
            stdout = await self._run(args, timeout=_timeout_for(model))
        finally:
            for path in temp_images:
                path.unlink(missing_ok=True)

        data = parse_agy_output(stdout)
        agy_status = data.get("status")
        if agy_status != "SUCCESS":
            error = data.get("error") or "알 수 없는 오류"
            raise ProviderError(
                "agy_failed",
                f"agy 호출이 실패했습니다: {error}",
                f"status={agy_status}",
            )

        response = strip_followups(str(data.get("response") or ""))
        if not response:
            raise ProviderError(
                "empty_response",
                "모델이 빈 응답을 반환했습니다. 다시 시도하세요.",
                None,
            )

        raw_usage = data.get("usage")
        usage = dict(raw_usage) if isinstance(raw_usage, dict) else None

        yield DeltaEvent(type="delta", text=response)
        yield DoneEvent(
            type="done",
            text=response,
            usage=usage,  # agy 가 준 토큰 값을 그대로 전달(달러 환산하지 않는다)
            cost=None,  # 쿼터 기반이라 달러 비용이 없다
            truncated=False,
            stop_reason=str(agy_status),
        )
