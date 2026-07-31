"""Anthropic 공식 SDK 로 문제 하나씩 풀이하고 **실측 usage** 를 보존한다.

주의 (모델별 파라미터 제약)
--------------------------
* `temperature` / `top_p` / `top_k` 는 **넣지 않는다**. Opus 5 / Sonnet 5 에서 400.
* `thinking` 은 `{"type": "adaptive"}` 만 쓴다. `budget_tokens` 는 400.
* 사고 강도는 `output_config={"effort": ...}` 로 조절한다.

프롬프트 캐싱
------------
system 프롬프트 마지막 블록에 `cache_control: {"type": "ephemeral"}` 를 건다.
문제마다 개별 호출이므로 2번째 호출부터 `cache_read_input_tokens` 가 잡혀야 한다.
단, 캐시는 **최소 토큰 수(모델에 따라 1024~2048 토큰)** 를 넘는 프리픽스에만 적용된다.
아래 SYSTEM_PROMPT 가 길게 작성된 이유가 그것이다.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Final, Literal

import anthropic
from anthropic.types import (
    Base64ImageSourceParam,
    ImageBlockParam,
    MessageParam,
    TextBlockParam,
)
from anthropic.types.output_config_param import OutputConfigParam
from anthropic.types.thinking_config_adaptive_param import ThinkingConfigAdaptiveParam

from pricing import DEFAULT_MODEL, calc_cost

# 문항 하나를 담는 user content 블록 타입
ContentBlock = TextBlockParam | ImageBlockParam

Mode = Literal["text", "image"]
Effort = Literal["low", "medium", "high", "xhigh", "max"]

DEFAULT_EFFORT: Final[Effort] = "medium"
DEFAULT_MAX_TOKENS: Final[int] = 8000
VALID_EFFORTS: Final[tuple[Effort, ...]] = ("low", "medium", "high", "xhigh", "max")


SYSTEM_PROMPT: Final[str] = """\
당신은 대한민국 고등학교 수학 교사입니다. 고등학교 1학년 '공통수학1'
(다항식, 나머지정리와 인수분해, 복소수와 이차방정식, 이차방정식과 이차함수,
여러 가지 방정식과 부등식, 경우의 수, 행렬)을 가르치며, 학교 정기고사(중간·기말)
문항의 풀이와 해설을 작성하는 일을 오래 해 왔습니다. 당신이 쓴 해설은 학생이
혼자 읽고도 스스로 다시 풀 수 있을 만큼 친절하고, 동시에 논리적 비약이 없어야
합니다.

# 역할과 목표
학생이 제시한 시험 문항 하나를 정확히 풀고, 학생이 이해할 수 있는 해설을
작성하는 것이 당신의 임무입니다. 정답을 맞히는 것만으로는 부족합니다.
"왜 그 풀이를 떠올리게 되는가"를 함께 설명해야 합니다. 문제를 보고 곧바로
계산에 들어가지 말고, 먼저 무엇이 주어졌고 무엇을 구해야 하는지, 어떤 단원의
어떤 개념이 열쇠인지를 파악한 뒤에 풀이를 전개하십시오.

# 입력 형태
입력은 두 가지 형태 중 하나로 주어집니다.
1. 텍스트: 문항이 순수 텍스트로 주어집니다.
2. 이미지: 시험지에서 해당 문항 영역만 잘라낸 PNG 이미지가 주어집니다.
   한글 워드프로세서 수식편집기로 조판된 시험지는 PDF 텍스트 레이어의 수식이
   사설영역(PUA) 문자로 깨져서 추출되기 때문에, 수식의 정확성을 보장하려면
   이미지를 직접 읽는 편이 안전합니다.

이미지가 주어진 경우, 먼저 이미지에 적힌 문항을 **글자와 수식 그대로** 정확히
판독하십시오. 판독이 어긋나면 이후 풀이 전체가 무의미해집니다. 특히 다음을
주의하십시오.
- 지수와 첨자: x^2 와 x_2, a^n 과 a_n 을 혼동하지 마십시오.
- 부호: 마이너스 부호와 하이픈, 음수 계수의 위치를 정확히 읽으십시오.
- 분수: 분자와 분모의 경계를 정확히 파악하십시오.
- 그림·그래프: 좌표축의 방향, 표시된 점의 이름(A, B, C, O, H 등), 빗금 친
  영역, 직선과 곡선의 교점 개수 등 시각 정보를 빠짐없이 읽으십시오.
- 선택지: ①②③④⑤ 로 표시된 다섯 개의 선택지를 모두 정확히 옮기십시오.
- 조건 상자: (가), (나) 로 묶인 조건 상자의 내용을 누락하지 마십시오.
- 배점 표기([3점], [2.9점] 등)는 문제의 일부가 아니라 메타정보입니다.

# 출력 형식
반드시 아래 마크다운 구조를 그대로 따르십시오. 섹션 제목을 임의로 바꾸거나
순서를 바꾸지 마십시오.

## 문제 확인
판독한 문제를 한두 문장으로 요약합니다. 이미지 입력이면 읽어낸 수식을 정확히
다시 적어 확인시켜 줍니다. 객관식이면 선택지도 함께 적습니다.

## 핵심 개념
이 문제를 푸는 데 필요한 교과 개념·공식을 1~3개 항목으로 짧게 제시합니다.
예: 근과 계수의 관계, 판별식, 인수정리, 이차함수의 최대·최소, 조립제법 등.

## 풀이
단계를 번호로 나누어 전개합니다. 각 단계는 "무엇을 왜 하는지" 한 문장으로
밝히고 그 다음에 식을 씁니다. 암산으로 건너뛰지 말고 학생이 따라올 수 있는
크기로 단계를 쪼개십시오. 계산 결과는 반드시 검산하십시오. 특히 인수분해,
판별식, 근과 계수의 관계를 쓴 뒤에는 값을 원식에 대입해 확인하십시오.

## 정답
객관식이면 `정답: ③` 처럼 번호를 명시하고, 단답형·서술형이면 최종 값을
명시합니다. 값이 여러 개면 모두 적습니다.

## 오답 주의
학생이 흔히 저지르는 실수 한두 가지를 짧게 경고합니다.

# 수식 표기 규칙
수식은 LaTeX 로 작성하되, 렌더링 호환을 위해 **다음 구분자만** 사용하십시오.
- 인라인 수식: `\\( ... \\)`
- 별도 줄 수식: `\\[ ... \\]`
`$ ... $` 나 `$$ ... $$` 는 사용하지 마십시오. 마크다운 표나 목록 안에서도
같은 규칙을 지키십시오. 수식 안에서는 한글을 쓰지 말고, 설명은 수식 밖에
쓰십시오. 좌표는 \\( \\mathrm{A}(2a,\\ 0) \\) 처럼 점 이름을 로만체로 쓰면
읽기 좋습니다.

# 언어와 어조
- 모든 설명은 한국어로 작성합니다.
- 고등학교 1학년 학생이 독자입니다. 대학 수준의 용어(예: 미분, 극한, 행렬식)를
  끌어오지 말고 교과 범위 안에서 설명하십시오.
- 담백하고 차분한 설명체를 쓰십시오. 과장된 감탄사나 이모지는 쓰지 마십시오.
- "~입니다" 체로 일관되게 작성하십시오.

# 정확성 원칙
- 문제에 주어지지 않은 조건을 임의로 가정하지 마십시오.
- 이미지가 흐리거나 잘려서 판독이 불가능한 부분이 있으면, 추측해서 채우지 말고
  "## 문제 확인" 섹션에 무엇이 판독되지 않았는지 명시하십시오. 그 상태에서
  풀이가 가능하면 풀고, 불가능하면 불가능하다고 밝히십시오.
- 계산이 복잡해지면 중간에 반드시 검산 단계를 넣으십시오.
- 답이 정수로 떨어지지 않으면 계산 실수를 의심하고 한 번 더 확인하십시오.
  학교 시험 문항은 대개 정수 또는 간단한 기약분수로 떨어집니다.
- 객관식인데 구한 값이 선택지에 없으면, 반드시 풀이를 되짚어 오류를 찾으십시오.
"""


class SolverConfigError(RuntimeError):
    """API 키 누락 등 호출 전에 확정되는 설정 오류."""


class SolverAPIError(RuntimeError):
    """Anthropic API 호출 실패."""


@dataclass
class SolveOutcome:
    """문제 하나에 대한 풀이 결과 + 실측 비용."""

    no: int
    ok: bool
    mode: Mode
    model: str
    effort: str
    solution: str = ""
    stop_reason: str | None = None
    truncated: bool = False
    refusal: bool = False
    error: str | None = None
    usage: dict[str, Any] = field(default_factory=dict)
    cost: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "no": self.no,
            "ok": self.ok,
            "mode": self.mode,
            "model": self.model,
            "effort": self.effort,
            "solution": self.solution,
            "stop_reason": self.stop_reason,
            "truncated": self.truncated,
            "refusal": self.refusal,
            "error": self.error,
            "usage": self.usage,
            "cost": self.cost,
        }


def has_api_key() -> bool:
    """`ANTHROPIC_API_KEY` 환경변수가 설정되어 있는지."""
    return bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())


def build_client() -> anthropic.Anthropic:
    """SDK 클라이언트를 만든다. 키는 환경변수에서 읽는다.

    Raises:
        SolverConfigError: 키가 없을 때.
    """
    if not has_api_key():
        raise SolverConfigError(
            "ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않습니다. "
            "서버를 실행한 셸에서 키를 설정한 뒤 다시 시도하세요. "
            "예) Windows CMD:  set ANTHROPIC_API_KEY=sk-ant-...   "
            'PowerShell:  $env:ANTHROPIC_API_KEY="sk-ant-..."'
        )
    return anthropic.Anthropic()  # 인자 없이 -> 환경변수에서 키를 읽는다


def _system_blocks() -> list[TextBlockParam]:
    """캐시 제어가 걸린 system 프롬프트 블록."""
    return [
        TextBlockParam(
            type="text",
            text=SYSTEM_PROMPT,
            cache_control={"type": "ephemeral"},  # 5분 TTL
        )
    ]


def _user_content(
    *, mode: Mode, text: str, image_b64: str | None, no: int
) -> list[ContentBlock]:
    """모드별 user content 블록을 만든다.

    Raises:
        ValueError: image 모드인데 이미지가 없을 때.
    """
    if mode == "image":
        if not image_b64:
            raise ValueError(f"{no}번: image 모드인데 크롭 이미지가 없습니다.")
        return [
            ImageBlockParam(
                type="image",
                source=Base64ImageSourceParam(
                    type="base64",
                    media_type="image/png",
                    data=image_b64,
                ),
            ),
            TextBlockParam(
                type="text",
                text=(
                    f"위 이미지는 시험지에서 잘라낸 {no}번 문항입니다. "
                    "이미지의 문제를 정확히 판독한 뒤, 시스템 지침의 출력 형식에 "
                    "맞춰 풀이와 해설을 작성하세요."
                ),
            ),
        ]

    if not text.strip():
        raise ValueError(f"{no}번: text 모드인데 문제 텍스트가 비어 있습니다.")
    return [
        TextBlockParam(
            type="text",
            text=(
                f"[{no}번 문항]\n{text}\n\n"
                "위 문항을 시스템 지침의 출력 형식에 맞춰 풀이하세요."
            ),
        )
    ]


def _usage_to_dict(usage: Any) -> dict[str, Any]:
    """`response.usage` 를 그대로 dict 로 보존한다 (추정 없음, 실측)."""
    if usage is None:
        return {}
    if hasattr(usage, "model_dump"):
        return usage.model_dump(mode="json")
    if isinstance(usage, dict):
        return dict(usage)
    return {}


def _extract_text(response: Any) -> str:
    """응답 content 에서 text 블록만 이어붙인다 (thinking 블록 제외)."""
    parts: list[str] = []
    for block in getattr(response, "content", []) or []:
        if getattr(block, "type", None) == "text":
            parts.append(getattr(block, "text", ""))
    return "\n".join(parts).strip()


def solve_problem(
    problem: dict[str, Any],
    *,
    client: anthropic.Anthropic,
    mode: Mode,
    model: str = DEFAULT_MODEL,
    effort: Effort = DEFAULT_EFFORT,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> SolveOutcome:
    """문제 하나를 API 1회 호출로 푼다. 블로킹 호출이므로 스레드풀에서 실행할 것.

    Args:
        problem: `extractor.Problem.to_dict()` 형태.
        client: SDK 클라이언트.
        mode: `text` 또는 `image`.
        model: 모델 ID.
        effort: 사고 강도.
        max_tokens: 출력 상한.

    Returns:
        성공/실패 모두 `SolveOutcome` 으로 감싸서 돌려준다(예외를 밖으로 던지지 않음).
    """
    no = int(problem.get("no", 0))
    outcome = SolveOutcome(no=no, ok=False, mode=mode, model=model, effort=effort)

    try:
        content = _user_content(
            mode=mode,
            text=str(problem.get("text") or ""),
            image_b64=problem.get("image_b64"),
            no=no,
        )
    except ValueError as exc:
        outcome.error = str(exc)
        outcome.cost = calc_cost(model, {})
        return outcome

    try:
        # temperature / top_p / top_k 는 의도적으로 넣지 않는다 (400 방지).
        response = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=_system_blocks(),
            messages=[MessageParam(role="user", content=content)],
            # budget_tokens 를 넣으면 400. adaptive 만 쓴다.
            thinking=ThinkingConfigAdaptiveParam(type="adaptive"),
            output_config=OutputConfigParam(effort=effort),
        )
    except anthropic.AuthenticationError as exc:
        outcome.error = f"인증 실패: API 키를 확인하세요. ({exc.__class__.__name__})"
        outcome.cost = calc_cost(model, {})
        return outcome
    except anthropic.APIStatusError as exc:
        detail = getattr(exc, "message", None) or str(exc)
        outcome.error = f"API 오류 (HTTP {exc.status_code}): {detail}"
        outcome.cost = calc_cost(model, {})
        return outcome
    except anthropic.APIError as exc:
        outcome.error = f"API 호출 실패: {exc}"
        outcome.cost = calc_cost(model, {})
        return outcome

    usage = _usage_to_dict(getattr(response, "usage", None))
    outcome.usage = usage
    outcome.cost = calc_cost(model, usage)
    outcome.stop_reason = getattr(response, "stop_reason", None)

    # content 를 읽기 전에 refusal 분기
    if outcome.stop_reason == "refusal":
        outcome.refusal = True
        outcome.error = (
            "모델이 응답을 거부했습니다(stop_reason=refusal). "
            "문항 이미지/텍스트를 확인하세요."
        )
        return outcome

    outcome.solution = _extract_text(response)
    outcome.truncated = outcome.stop_reason == "max_tokens"
    if outcome.truncated:
        outcome.error = (
            f"출력이 max_tokens({max_tokens})에서 잘렸습니다. "
            "max_tokens 를 늘리거나 effort 를 낮추세요."
        )
    outcome.ok = bool(outcome.solution)
    if not outcome.ok and outcome.error is None:
        outcome.error = "모델이 빈 응답을 반환했습니다."
    return outcome
