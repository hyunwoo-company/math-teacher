"""대상별 `ExportDoc` 조립 (시험지 / 변형 / 오답노트).

**마크다운 평문화(`to_plain_text`)와 섹션 분리(`markdown_sections`)를 여기서
끝낸다.** 렌더러(`docx.py` / `hwpx.py`)는 이미 사람이 읽을 수 있는 문자열만
받는다. 이렇게 해야 형식이 늘어도 변환 규칙이 한 곳에 남는다.

**수식만은 평문화하지 않고 LaTeX 원문을 함께 넘긴다**(`to_plain_segments`).
분수·근호의 2차원 조판은 형식마다 다른 문법이라 렌더러가 직접 해야 한다.
수식 밖 텍스트는 예전과 한 글자도 다르지 않다.

이 모듈은 DB 를 모른다. 호출자(`service.py`)가 읽어온 값을 항목 dataclass 로
넘기면 문서 구성 규칙만 적용한다(설계 문서 3-5항).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal

import markdown_sections
from export.model import Block, ExportDoc, Heading, Image, MathRun, Run, Text, TextRun
from to_plain_text import PlainSegment, to_plain_segments, to_plain_text

# 문항 본문을 무엇으로 낼지(설계 §3-4).
#   image = 지금까지와 같은 크롭 이미지. **기본값이고 결과물이 바뀌지 않는다.**
#   text  = 판독본(`transcript`) 텍스트. 판독본이 없는 문항은 조용히 이미지로 낸다.
BodyMode = Literal["image", "text"]

# 판독본 출처 값. `storage.TRANSCRIPT_AI` / `TRANSCRIPT_MANUAL` 과 같은 문자열이다.
# 이 모듈은 DB 를 모르므로(모듈 docstring) 상수를 import 하지 않고 계약으로만
# 받는다. 두 곳이 어긋나지 않는지는 `tests/test_transcript_export.py` 가 못박는다.
_SOURCE_AI: Final[str] = "ai"
_SOURCE_MANUAL: Final[str] = "manual"

# 텍스트로 나간 문서 첫 페이지의 고지(설계 §3-4). 복원이 완벽하다고 약속하지
# 않는다 — 배포 전 대조를 요구하는 것이 이 한 줄의 목적이다.
NOTICE_RESTORED: Final[str] = (
    "이 문서의 문항은 원본 PDF 에서 복원한 것입니다. 배포 전 원본과 대조하십시오."
)
# AI 판독본이 섞였을 때 덧붙이는 문구. 디코딩본과 신뢰도가 다르므로 밝힌다.
NOTICE_AI_SUFFIX: Final[str] = "일부 문항은 AI 판독본입니다."
# 넣은 항목이 **전부** 사용자가 직접 확인·수정한 것(`manual`)일 때의 문구.
# 사람이 이미 원본과 대조한 상태라 "배포 전 대조" 를 다시 요구하지 않는다.
NOTICE_MANUAL: Final[str] = (
    "이 문서의 문항은 원본 PDF 에서 복원한 뒤 직접 확인·수정한 것입니다."
)

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

# 내보내기에서 통째로 버리는 섹션.
# - `문제 확인`: 모델이 문제를 어떻게 읽었는지는 학생에게 불필요하다.
# - `검산`: 프롬프트가 출력을 금지하지만(설계 3-3) 모델이 어길 때를 위한 안전망.
_SKIPPED_SECTIONS: Final[frozenset[str]] = frozenset(
    {markdown_sections.PROBLEM_CHECK_TITLE, markdown_sections.VERIFY_TITLE}
)

# 변형 응답의 문제 본문 섹션 제목. 문항 제목이 이미 있어 소제목을 붙이지 않는다.
_PROBLEM_TITLE: Final[str] = "문제"
# 섹션이 없는 풀이에 붙이는 소제목.
_SOLUTION_TITLE: Final[str] = "풀이"
# 오답노트 메모 줄의 접두어.
_MEMO_PREFIX: Final[str] = "메모: "


@dataclass(frozen=True)
class ExamItem:
    """시험지 내보내기 항목 1건.

    Attributes:
        no: 문항 번호.
        image: 크롭 PNG 경로. 크롭이 없고 판독본만 있는 문항은 None 이다
            (`body="image"` 에서는 호출자가 그런 항목을 아예 넘기지 않는다).
        solution: 저장된 풀이 원문(마크다운). 없으면 None.
        transcript: 복원한 문항 전문(LaTeX 포함). `body="text"` 일 때만 쓰인다.
        transcript_source: 판독본 출처(`pua` / `ai` / `manual`). 고지 문구를
            정하는 데만 쓴다.
    """

    no: int
    image: Path | None = None
    solution: str | None = None
    transcript: str | None = None
    transcript_source: str | None = None


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
        transcript: 담을 때 복사한 판독본 **스냅샷**(크롭 스냅샷과 같은 규칙).
            원본 시험지가 지워져도 남는다. `body="text"` 일 때만 쓰인다.
        transcript_source: 판독본 스냅샷의 출처(`pua` / `ai` / `manual`).
    """

    source_name: str
    problem_no: int
    image: Path | None = None
    memo: str | None = None
    solution: str | None = None
    transcript: str | None = None
    transcript_source: str | None = None


def _heading_text(title: str) -> str:
    """섹션 제목을 평문으로. 평문화 결과가 비면 원문을 쓴다."""
    return to_plain_text(title) or title


def _to_lines(segments: Sequence[PlainSegment]) -> list[list[Run]]:
    """평문 조각들을 줄 단위 런 목록으로 나눈다.

    렌더러가 줄마다 문단을 만들기 때문에 줄 나누기를 여기서 끝낸다. 수식은
    `_convert_math` 가 공백을 접어 한 줄로 만들므로 줄을 넘지 않는다.

    Args:
        segments: `to_plain_segments` 결과.

    Returns:
        줄마다의 런 목록. 빈 줄은 빈 목록이 된다(빈 문단이 나간다).
    """
    lines: list[list[Run]] = [[]]
    for segment in segments:
        if segment.is_math:
            lines[-1].append(MathRun(latex=segment.latex, plain=segment.text))
            continue
        for index, part in enumerate(segment.text.split("\n")):
            if index:
                lines.append([])
            if part:
                lines[-1].append(TextRun(part))
    return lines


def _body(raw: str) -> Text | None:
    """본문 원문을 본문 블록으로 만든다.

    Args:
        raw: 마크다운 + LaTeX 원문.

    Returns:
        본문 블록. 평문화 결과가 비면 None(블록을 만들지 않는다).
    """
    segments = to_plain_segments(raw)
    plain = "".join(segment.text for segment in segments)
    if not plain:
        return None
    if not any(segment.is_math for segment in segments):
        # 수식이 없으면 예전과 똑같은 블록을 만든다.
        return Text(plain)
    return Text(plain, _to_lines(segments))


def _prefixed(prefix: str, body: Text | None) -> Text:
    """본문 블록 첫 줄 앞에 접두어를 붙인다(수식 런은 그대로 남긴다).

    Args:
        prefix: 붙일 접두어(예: `메모: `).
        body: 본문 블록. None 이면 접두어만 남는다.

    Returns:
        접두어가 붙은 본문 블록.
    """
    if body is None:
        return Text(prefix)
    if body.lines is None:
        return Text(f"{prefix}{body.text}")
    first, *rest = body.lines
    return Text(f"{prefix}{body.text}", [[TextRun(prefix), *first], *rest])


def _solution_blocks(solution: str) -> list[Block]:
    """풀이 원문을 섹션별 소제목 + 본문 블록으로 만든다.

    `_SKIPPED_SECTIONS`(`## 문제 확인` / `## 검산`)는 넣지 않는다. 섹션이 하나도
    없는 응답이면 전체를 `풀이` 로 묶는다.

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
        body = _body(sections[markdown_sections.FALLBACK_TITLE])
        return [Heading(_SOLUTION_TITLE, 3), body] if body else []

    blocks: list[Block] = []
    for title, raw in sections.items():
        if title in _SKIPPED_SECTIONS:
            continue
        body = _body(raw)
        if body is None:
            continue
        blocks.append(Heading(_heading_text(title), 3))
        blocks.append(body)
    return blocks


def _transcript_blocks(transcript: str) -> list[Block]:
    """판독본 전문을 본문 블록으로 만든다.

    새 변환 경로를 만들지 않는다 — 풀이·변형과 똑같이 `_body`(`to_plain_segments`)를
    타므로 수식 구간은 렌더러의 수식 개체 조판(`omml.py` / `hwpeq.py`)으로 간다.

    Args:
        transcript: 복원한 문항 전문(마크다운 + LaTeX).

    Returns:
        본문 블록 목록. 평문화 결과가 비면 빈 목록(호출자가 이미지로 폴백한다).
    """
    body = _body(transcript)
    return [] if body is None else [body]


def _notice(sources: Sequence[str | None]) -> str | None:
    """텍스트로 나간 항목들의 출처를 보고 첫 페이지 고지 문구를 정한다.

    출처마다 신뢰도가 다르므로 문구도 달라야 한다(설계 §3-4). AI 판독본이 하나라도
    섞이면 그 사실을 밝히고, 전부 사용자가 확인한 것이면 경고 강도를 낮춘다.

    Args:
        sources: 실제로 **텍스트로 렌더한** 항목들의 `transcript_source`.
            이미지로 폴백한 항목은 포함하지 않는다.

    Returns:
        고지 한 줄. 텍스트로 나간 항목이 없으면 None(고지를 넣지 않는다).
    """
    if not sources:
        return None
    kinds = {source or "" for source in sources}
    if kinds == {_SOURCE_MANUAL}:
        return NOTICE_MANUAL
    if _SOURCE_AI in kinds:
        return f"{NOTICE_RESTORED} {NOTICE_AI_SUFFIX}"
    return NOTICE_RESTORED


def _footer(source: str | None) -> str | None:
    """출처를 문서 꼬리말 값으로 정규화한다.

    Args:
        source: 호출자가 준 출처. None 이거나 공백뿐이면 넣지 않는다.

    Returns:
        앞뒤 공백을 턴 출처. 넣을 것이 없으면 None.
    """
    return (source or "").strip() or None


def build_exam_doc(
    *,
    title: str,
    items: Sequence[ExamItem],
    include_full: bool,
    source: str | None = None,
    body: BodyMode = "image",
) -> ExportDoc:
    """시험지 문서를 조립한다.

    구성은 문항마다 `N번`(제목) + 문항 본문이고, `include_full` 이면 그 뒤에
    저장된 풀이를 섹션별로 붙인다.

    문항 본문은 `body` 가 정한다. `image`(기본)면 예전과 똑같이 크롭 이미지만
    넣는다 — 항목에 판독본이 실려 있어도 보지 않는다. `text` 면 판독본을
    텍스트로 조판하고, **판독본이 없거나 평문화 결과가 빈 문항은 조용히
    이미지로 폴백**한다(혼합 문서가 정상 동작이다).

    Args:
        title: 문서 제목(시험지 이름).
        items: 번호 순으로 정렬된 문항 목록.
        include_full: True 면 풀이까지 넣는다.
        source: 문서 끝에 넣을 출처. None/빈 문자열이면 넣지 않는다.
        body: `image`(기본) 또는 `text`.

    Returns:
        조립된 문서. `body="text"` 로 텍스트가 하나라도 들어갔으면 `notice` 가 찬다.
    """
    blocks: list[Block] = []
    used_sources: list[str | None] = []
    for item in items:
        blocks.append(Heading(f"{item.no}번", 2))
        text_blocks = (
            _transcript_blocks(item.transcript)
            if body == "text" and item.transcript
            else []
        )
        if text_blocks:
            blocks.extend(text_blocks)
            used_sources.append(item.transcript_source)
        elif item.image is not None:
            blocks.append(Image(item.image))
        if include_full and item.solution:
            blocks.extend(_solution_blocks(item.solution))
    return ExportDoc(
        title=title,
        blocks=blocks,
        footer=_footer(source),
        notice=_notice(used_sources),
    )


def build_variants_doc(
    *,
    title: str,
    items: Sequence[VariantItem],
    include_full: bool,
    source: str | None = None,
) -> ExportDoc:
    """변형 문서를 조립한다.

    원본 크롭은 넣지 않는다 — 변형 문제만 깔끔하게 배포할 수 있어야 한다.
    한 문항에 여러 mode 가 저장돼 있으면 모두 넣는다(호출자가 정렬해 넘긴다).

    Args:
        title: 문서 제목(예: `<시험지명> 변형 문제`).
        items: (번호, mode) 순으로 정렬된 변형 목록.
        include_full: True 면 `## 정답` / `## 풀이` 까지 넣는다.
        source: 문서 끝에 넣을 출처. None/빈 문자열이면 넣지 않는다.

    Returns:
        조립된 문서.
    """
    blocks: list[Block] = []
    for item in items:
        label = VARIANT_MODE_LABEL.get(item.mode, item.mode)
        blocks.append(Heading(f"{item.no}번 · {label}", 2))
        for section_title, raw in markdown_sections.split_sections(item.text).items():
            if section_title in _SKIPPED_SECTIONS:
                continue
            body = _body(raw)
            if body is None:
                continue
            if section_title == _PROBLEM_TITLE:
                blocks.append(body)
                continue
            if not include_full:
                continue
            blocks.append(Heading(_heading_text(section_title), 3))
            blocks.append(body)
    return ExportDoc(title=title, blocks=blocks, footer=_footer(source))


def build_note_doc(
    *,
    title: str,
    items: Sequence[NoteItem],
    include_full: bool,
    source: str | None = None,
    body: BodyMode = "image",
) -> ExportDoc:
    """오답노트 문서를 조립한다.

    원본이 삭제된 항목도 스냅샷(크롭·판독본)으로 넣는다(풀이만 빠진다).
    본문 선택 규칙은 `build_exam_doc` 과 같다 — `body="text"` 면 판독본
    스냅샷을 텍스트로, 없으면 크롭 스냅샷으로 낸다.

    Args:
        title: 문서 제목(노트 이름).
        items: 담은 순서의 항목 목록.
        include_full: True 면 원본 문항의 저장된 풀이까지 넣는다.
        source: 문서 끝에 넣을 출처. None/빈 문자열이면 넣지 않는다.
        body: `image`(기본) 또는 `text`.

    Returns:
        조립된 문서. `body="text"` 로 텍스트가 하나라도 들어갔으면 `notice` 가 찬다.
    """
    blocks: list[Block] = []
    used_sources: list[str | None] = []
    for item in items:
        blocks.append(Heading(f"{item.source_name} {item.problem_no}번", 2))
        text_blocks = (
            _transcript_blocks(item.transcript)
            if body == "text" and item.transcript
            else []
        )
        if text_blocks:
            blocks.extend(text_blocks)
            used_sources.append(item.transcript_source)
        elif item.image is not None:
            blocks.append(Image(item.image))
        if item.memo:
            blocks.append(_prefixed(_MEMO_PREFIX, _body(item.memo)))
        if include_full and item.solution:
            blocks.extend(_solution_blocks(item.solution))
    return ExportDoc(
        title=title,
        blocks=blocks,
        footer=_footer(source),
        notice=_notice(used_sources),
    )


__all__ = [
    "NOTICE_AI_SUFFIX",
    "NOTICE_MANUAL",
    "NOTICE_RESTORED",
    "VARIANT_MODE_LABEL",
    "VARIANT_MODE_ORDER",
    "BodyMode",
    "ExamItem",
    "NoteItem",
    "VariantItem",
    "build_exam_doc",
    "build_note_doc",
    "build_variants_doc",
]
