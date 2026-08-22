"""내보내기 공통 문서 모델 (형식에 독립적인 최소 표현).

`.docx` 와 `.hwpx` 렌더러가 같은 `ExportDoc` 을 받는다. 형식이 늘어도 문서 구성
규칙(`build.py`)은 한 벌만 유지된다.

**마크다운 평문화는 `build.py` 에서 끝낸다.** `Text.text` 에는 이미 사람이 읽을
수 있는 유니코드 평문만 들어온다(마크다운 잔재 없음).

**수식은 예외다.** 분수의 가로선이나 근호가 덮는 선은 1차원 문자열로 표현할 수
없고, 2차원 조판은 형식마다 완전히 다른 문법(워드 OMML vs 한글 EqEdit)을 쓴다.
그래서 수식만은 LaTeX 원문(`MathRun.latex`)이 렌더러까지 살아서 간다. 조판에
실패한 렌더러는 `MathRun.plain`(기존 유니코드 평문)으로 폴백한다.

**조판 지시는 의미 단위로만 담는다.** `two_column`(2단 조판인가)과
`item_spans`(문항의 시작·끝)까지가 이 모듈의 몫이고, 그것을 무슨 속성으로
쓰는지(`w:keepNext` / `hh:breakSetting`)는 렌더러가 정한다.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final


@dataclass(frozen=True)
class Heading:
    """제목 블록.

    Attributes:
        text: 제목 문자열(평문).
        level: 제목 수준. 2 = 문항, 3 = 문항 안 소제목(풀이/정답).
    """

    text: str
    level: int = 2


@dataclass(frozen=True)
class Image:
    """이미지 블록(크롭 PNG 경로). 파일이 실제로 있어야 한다."""

    path: Path


@dataclass(frozen=True)
class TextRun:
    """수식이 아닌 글자 조각. **이미 평문화된** 문자열이다."""

    text: str


@dataclass(frozen=True)
class MathRun:
    """수식 조각.

    Attributes:
        latex: 구분자를 벗긴 LaTeX 원문. 렌더러가 형식별 수식 개체로 조판한다.
        plain: 조판에 실패했을 때 쓸 유니코드 평문(`to_plain_text` 결과와 같다).
    """

    latex: str
    plain: str


Run = TextRun | MathRun


@dataclass(frozen=True)
class Text:
    r"""본문 블록.

    Attributes:
        text: 블록 전체의 평문. 줄바꿈(`\\n`)이 그대로 들어 있다.
        lines: 줄마다의 런 목록. 수식이 하나도 없는 블록은 None 이고, 그때
            렌더러는 `text` 만 보고 예전과 똑같이 렌더한다(수식 없는 문서의
            결과물이 바뀌지 않도록 하는 장치다).
    """

    text: str
    lines: Sequence[Sequence[Run]] | None = None


@dataclass(frozen=True)
class PageBreak:
    """페이지 나눔 블록.

    필드가 없다 — 이 블록은 "여기서 지면을 끊어라" 라는 지시뿐이다. 문서 구성
    규칙(`build.py`)이 문항부와 해설부를 갈라야 해서 생겼다(시험지 미주 구성).

    두 렌더러 모두 형식 고유 기능으로 낸다. docx 는 `w:br w:type="page"`
    (`Document.add_page_break`), hwpx 는 빈 문단의 `hp:p/@pageBreak` 속성이다.
    """


Block = Heading | Image | PageBreak | Text


@dataclass(frozen=True)
class ExportDoc:
    """내보낼 문서 하나.

    Attributes:
        title: 문서 상단 제목.
        blocks: 본문 블록들(순서대로 렌더한다).
        footer: 문서 맨 끝에 넣을 출처 한 줄. None 이면 아무것도 넣지 않는다
            (기본값이라 기존 호출부는 지금과 같은 문서를 얻는다).
        notice: **첫 페이지 제목 바로 아래**에 넣을 고지 한 줄. 판독본 텍스트로
            내보낸 문서에만 들어간다(설계 §3-4). `footer` 와 서식은 같지만 위치가
            정반대라 같은 필드로 쓸 수 없다 — 고지는 읽기 전에 보여야 한다.
            None 이면 아무것도 넣지 않는다(기본값 = 기존 문서와 동일).
        two_column: 시험지처럼 **좌우 2단**으로 조판할지. 시험지·변형이 True 고
            오답노트는 False 다(복습용이라 문항을 크게 본다). 단 수를 세는 값이
            아니라 "2단 조판인가" 라는 문서의 성격이므로 bool 이다 — 치수(단
            간격·단 폭)는 `layout.py` 가 정한다. 기본값 False = 1단이라 이 필드를
            모르는 호출부는 예전과 같은 문서를 얻는다.
    """

    title: str
    blocks: Sequence[Block]
    footer: str | None = None
    notice: str | None = None
    two_column: bool = False


#: 문항을 여는 제목 수준. `Heading.level` 의 계약(2 = 문항)이 그대로 경계다.
_ITEM_HEADING_LEVEL: Final[int] = 2


def item_spans(blocks: Sequence[Block]) -> dict[int, int]:
    """블록 목록에서 **문항 하나가 차지하는 구간**을 찾는다.

    렌더러가 "쪼개지지 마라"(단·페이지 넘김 방지)와 문항 간 간격을 걸려면 어디서
    문항이 시작하고 끝나는지 알아야 한다. `blocks` 는 평평한 목록이지만 경계는
    이미 들어 있다 — `Heading.level == 2` 가 **문항**이라는 것이 이 모델의 계약
    (`Heading` docstring)이다. 그래서 마커 블록이나 새 필드를 만들지 않고 그
    계약을 읽는다. 조립 결과(`build.py`)가 한 글자도 바뀌지 않는 것이 이 선택의
    이유다 — 이미 배포한 문서와 대조가 깨지지 않는다.

    구간은 문항 제목에서 시작해 다음 경계 **직전**까지다. 경계는 다음 문항 제목,
    상위 제목(해설부 표제 같은 1수준), 그리고 페이지 나눔이다. 문항 안 소제목
    (3수준 `풀이`/`정답`)은 경계가 아니므로 한 덩이에 남는다.

    Args:
        blocks: 문서 블록 목록.

    Returns:
        `{문항 시작 인덱스: 끝 인덱스(배타)}`. 문항 제목이 없으면 빈 dict.
    """
    starts = [
        index
        for index, block in enumerate(blocks)
        if isinstance(block, Heading) and block.level == _ITEM_HEADING_LEVEL
    ]
    spans: dict[int, int] = {}
    for start in starts:
        stop = start + 1
        while stop < len(blocks):
            block = blocks[stop]
            if isinstance(block, PageBreak):
                break
            if isinstance(block, Heading) and block.level <= _ITEM_HEADING_LEVEL:
                break
            stop += 1
        spans[start] = stop
    return spans


__all__ = [
    "Block",
    "ExportDoc",
    "Heading",
    "Image",
    "MathRun",
    "PageBreak",
    "Run",
    "Text",
    "TextRun",
    "item_spans",
]
