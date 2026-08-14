"""AI 응답의 `## 제목` 섹션을 나누는 파서.

풀이는 `## 문제 확인 / ## 핵심 개념 / ## 풀이 / ## 정답 / ## 오답 주의`,
변형은 `## 문제 / ## 정답 / ## 풀이` 형식이다(`prompts.py`). 내보내기가 섹션별로
제목을 붙이려면 이 분리가 필요하다.

`###` 이하 소제목은 섹션 경계로 보지 않는다 — 풀이 본문 안에서 쓰이므로 경계로
삼으면 본문이 잘게 쪼개진다.
"""

from __future__ import annotations

import re
from typing import Final

# 섹션을 하나도 못 찾았을 때 전체 텍스트에 붙이는 제목.
FALLBACK_TITLE: Final[str] = "문제"

# 풀이 응답의 첫 섹션. 모델이 문제를 어떻게 읽었는지는 학생에게 불필요하므로
# 내보내기에서 제외한다.
PROBLEM_CHECK_TITLE: Final[str] = "문제 확인"

# 모델이 지시를 어기고 검산을 섹션으로 낼 때가 있다. 내보내기에서 제외한다.
VERIFY_TITLE: Final[str] = "검산"

# `## 제목` 한 줄. 들여쓰기는 3칸까지 마크다운으로 인정한다(`#{1,6}` 아님에 주의).
_SECTION_RE: Final[re.Pattern[str]] = re.compile(
    r"^[ \t]{0,3}##[ \t]+(.+?)[ \t]*$", re.MULTILINE
)


def split_sections(text: str) -> dict[str, str]:
    """`## 제목` 기준으로 본문을 나눈다.

    제목은 앞뒤 공백을 제거한 원문 그대로 키가 된다(순서는 원문 등장 순서).
    첫 섹션 앞의 머리말은 버린다. 같은 제목이 여러 번 나오면 본문을 이어붙인다.

    형식이 어긋난 응답(섹션이 하나도 없음)에 대비해, 아무 섹션도 못 찾으면
    **전체 텍스트를 `문제`(`FALLBACK_TITLE`) 로 취급**한다. 내보내기가 빈 문서가
    되는 것보다 낫다.

    Args:
        text: 마크다운 원문.

    Returns:
        `{제목: 본문}`. 내용이 아무것도 없으면 빈 dict.
    """
    matches = list(_SECTION_RE.finditer(text))
    if not matches:
        body = text.strip()
        return {FALLBACK_TITLE: body} if body else {}

    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        title = match.group(1).strip()
        if not title:
            continue
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        body = text[match.end() : end].strip()
        if title in sections:
            sections[title] = f"{sections[title]}\n\n{body}".strip()
        else:
            sections[title] = body
    return sections


__all__ = [
    "FALLBACK_TITLE",
    "PROBLEM_CHECK_TITLE",
    "VERIFY_TITLE",
    "split_sections",
]
