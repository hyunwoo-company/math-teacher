"""판독본이 그림을 가리키는지 판정한다 (`needs_figure`).

판독본(`problems.transcript`)은 **글자와 수식만** 복원한다. 좌표평면·그래프·도형·
표 같은 그림은 복원 대상이 아니다. 그래서 판독본을 텍스트로만 쓰면 그림을 참조하는
문항은 정보가 빠진 채로 나간다 — 내보내기는 크롭을 함께 실어야 하고(`export/build.py`),
풀이는 텍스트가 아니라 크롭 이미지로 풀어야 한다(`ai_service.solve_events`).

판정을 **텍스트 표현으로만** 하는 이유: 스키마를 늘리지 않고 **이미 저장된 판독본에도**
그대로 동작해야 하기 때문이다(재판독 없이).

내보내기와 풀이 두 곳이 같은 기준으로 판단해야 하므로 여기 한 곳에 둔다.
"""

from __future__ import annotations

import re
from typing import Final

# 판독본이 그림을 가리키는 표현. 공백 변형(`그림 과 같이`)에 관대하게 잡는다.
_FIGURE_REF_RE: Final[re.Pattern[str]] = re.compile(
    r"(?:다음|아래|위)\s*(?:[와과]\s*같은\s*)?그림"
    r"|그림\s*(?:[과와]\s*같이|에서|의)"
    r"|(?:그래프|도형)\s*(?:[와과]\s*같이|에서)"
)


def needs_figure(transcript: str) -> bool:
    """판독본이 그림을 가리키고 있는지 판정한다.

    판독본은 글자·수식만 복원하고 그림은 복원하지 못하므로, 이런 표현이 있으면
    크롭을 함께 실어야 한다.

    Args:
        transcript: 복원한 문항 전문.

    Returns:
        도형 참조 표현이 있으면 True.
    """
    return _FIGURE_REF_RE.search(transcript) is not None
