"""대상별 `ExportDoc` 조립 (시험지 / 변형 / 오답노트).

**평문화(`to_plain_text`)와 섹션 분리(`markdown_sections`)를 여기서 끝낸다.**
렌더러(`docx.py` / `hwpx.py`)는 이미 사람이 읽을 수 있는 문자열만 받는다.
이렇게 해야 형식이 늘어도 변환 규칙이 한 곳에 남는다.

이 모듈은 DB 를 모른다. 호출자(`service.py`)가 읽어온 값을 항목 dataclass 로
넘기면 문서 구성 규칙만 적용한다(설계 문서 3-5항).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import markdown_sections
from export.model import Block, ExportDoc, Heading, Image, Text
from to_plain_text import to_plain_text

# 변형 종류의 표시 라벨. 프론트(`web/src/lib/variant.ts`)와 문구를 맞춘다.
VARIANT_MODE_LABEL: Final[dict[str, str]] = {
    "number": "숫자 변형",
    "condition": "조건 변형",
    "number_condition": "숫자·조건 변형",
}

# 변형 탭 렌더 순서(프론트 `VARIANT_MODES` 와 동일).
VARIANT_MODE_ORDER: Final[tuple[str, ...]] = (
    "number",
    "condition",
    "number_condition",
)

# 변형 응답의 문제 본문 섹션 제목. 문항 제목이 이미 있어 소제목을 붙이지 않는다.
_PROBLEM_TITLE: Final[str] = "문제"
# 섹션이 없는 풀이에 붙이는 소제목.
_SOLUTION_TITLE: Final[str] = "풀이"


@dataclass(frozen=True)
class ExamItem:
    """시험지 내보내기 항목 1건.

    Attributes:
        no: 문항 번호.
        image: 크롭 PNG 경로.
        solution: 저장된 풀이 원문(마크다운). 없으면 None.
    """

    no: int
    image: Path
    solution: str | None = None


@dataclass(frozen=True)
class VariantItem:
    """변형 내보내기 항목 1건.

    Attributes:
        no: 원본 문항 번호.
        mode: 변형 종류(`number` / `condition` / `number_condition`).
        text: 변형 응답 원문(`## 문제 / ## 정답 / ## 풀이` 마크다운).
    """

    no: int
    mode: str
    text: str


@dataclass(frozen=True)
class NoteItem:
    """오답노트 내보내기 항목 1건.

    Attributes:
        source_name: 출처 시험지 이름(스냅샷).
        problem_no: 출처 문항 번호.
        image: 크롭 스냅샷 PNG 경로. 스냅샷이 없으면 None.
        memo: 메모. 없으면 None.
        solution: 원본 문항의 저장된 풀이 원문. 원본이 지워졌거나 풀이가 없으면 None.
    """

    source_name: str
    problem_no: int
    image: Path | None = None
    memo: str | None = None
    solution: str | None = None


def _heading_text(title: str) -> str:
    """섹션 제목을 평문으로. 평문화 결과가 비면 원문을 쓴다."""
    return to_plain_text(title) or title


def _solution_blocks(solution: str) -> list[Block]:
    """풀이 원문을 섹션별 소제목 + 본문 블록으로 만든다.

    `## 문제 확인` 은 넣지 않는다(모델이 문제를 어떻게 읽었는지는 학생에게
    불필요하다). 섹션이 하나도 없는 응답이면 전체를 `풀이` 로 묶는다.

    Args:
        solution: 저장된 풀이 원문(마크다운).

    Returns:
        블록 목록. 넣을 내용이 없으면 빈 목록.
    """
    sections = markdown_sections.split_sections(solution)
    if not sections:
        return []
    if list(sections) == [markdown_sections.FALLBACK_TITLE]:
        # 섹션을 못 찾은 응답. 전체를 풀이 한 덩이로 본다.
        body = to_plain_text(sections[markdown_sections.FALLBACK_TITLE])
        return [Heading(_SOLUTION_TITLE, 3), Text(body)] if body else []

    blocks: list[Block] = []
    for title, raw in sections.items():
        if title == markdown_sections.PROBLEM_CHECK_TITLE:
            continue
        body = to_plain_text(raw)
        if not body:
            continue
        blocks.append(Heading(_heading_text(title), 3))
        blocks.append(Text(body))
    return blocks


def build_exam_doc(
    *, title: str, items: Sequence[ExamItem], include_full: bool
) -> ExportDoc:
    """시험지 문서를 조립한다.

    구성은 문항마다 `N번`(제목) + 크롭 이미지이고, `include_full` 이면 그 뒤에
    저장된 풀이를 섹션별로 붙인다.

    Args:
        title: 문서 제목(시험지 이름).
        items: 번호 순으로 정렬된 문항 목록.
        include_full: True 면 풀이까지 넣는다.

    Returns:
        조립된 문서.
    """
    blocks: list[Block] = []
    for item in items:
        blocks.append(Heading(f"{item.no}번", 2))
        blocks.append(Image(item.image))
        if include_full and item.solution:
            blocks.extend(_solution_blocks(item.solution))
    return ExportDoc(title=title, blocks=blocks)


def build_variants_doc(
    *, title: str, items: Sequence[VariantItem], include_full: bool
) -> ExportDoc:
    """변형 문서를 조립한다.

    원본 크롭은 넣지 않는다 — 변형 문제만 깔끔하게 배포할 수 있어야 한다.
    한 문항에 여러 mode 가 저장돼 있으면 모두 넣는다(호출자가 정렬해 넘긴다).

    Args:
        title: 문서 제목(예: `<시험지명> 변형 문제`).
        items: (번호, mode) 순으로 정렬된 변형 목록.
        include_full: True 면 `## 정답` / `## 풀이` 까지 넣는다.

    Returns:
        조립된 문서.
    """
    blocks: list[Block] = []
    for item in items:
        label = VARIANT_MODE_LABEL.get(item.mode, item.mode)
        blocks.append(Heading(f"{item.no}번 · {label}", 2))
        for section_title, raw in markdown_sections.split_sections(item.text).items():
            if section_title == markdown_sections.PROBLEM_CHECK_TITLE:
                continue
            body = to_plain_text(raw)
            if not body:
                continue
            if section_title == _PROBLEM_TITLE:
                blocks.append(Text(body))
                continue
            if not include_full:
                continue
            blocks.append(Heading(_heading_text(section_title), 3))
            blocks.append(Text(body))
    return ExportDoc(title=title, blocks=blocks)


def build_note_doc(
    *, title: str, items: Sequence[NoteItem], include_full: bool
) -> ExportDoc:
    """오답노트 문서를 조립한다.

    원본이 삭제된 항목도 스냅샷 크롭으로 넣는다(풀이만 빠진다).

    Args:
        title: 문서 제목(노트 이름).
        items: 담은 순서의 항목 목록.
        include_full: True 면 원본 문항의 저장된 풀이까지 넣는다.

    Returns:
        조립된 문서.
    """
    blocks: list[Block] = []
    for item in items:
        blocks.append(Heading(f"{item.source_name} {item.problem_no}번", 2))
        if item.image is not None:
            blocks.append(Image(item.image))
        if item.memo:
            blocks.append(Text(f"메모: {to_plain_text(item.memo)}"))
        if include_full and item.solution:
            blocks.extend(_solution_blocks(item.solution))
    return ExportDoc(title=title, blocks=blocks)


__all__ = [
    "VARIANT_MODE_LABEL",
    "VARIANT_MODE_ORDER",
    "ExamItem",
    "NoteItem",
    "VariantItem",
    "build_exam_doc",
    "build_note_doc",
    "build_variants_doc",
]
