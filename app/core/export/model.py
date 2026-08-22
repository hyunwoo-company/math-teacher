"""내보내기 공통 문서 모델 (형식에 독립적인 최소 표현).

`.docx` 와 `.hwpx` 렌더러가 같은 `ExportDoc` 을 받는다. 형식이 늘어도 문서 구성
규칙(`build.py`)은 한 벌만 유지된다.

**마크다운 평문화는 `build.py` 에서 끝낸다.** `Text.text` 에는 이미 사람이 읽을
수 있는 유니코드 평문만 들어온다(마크다운 잔재 없음).

**수식은 예외다.** 분수의 가로선이나 근호가 덮는 선은 1차원 문자열로 표현할 수
없고, 2차원 조판은 형식마다 완전히 다른 문법(워드 OMML vs 한글 EqEdit)을 쓴다.
그래서 수식만은 LaTeX 원문(`MathRun.latex`)이 렌더러까지 살아서 간다. 조판에
실패한 렌더러는 `MathRun.plain`(기존 유니코드 평문)으로 폴백한다.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path


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
    """

    title: str
    blocks: Sequence[Block]
    footer: str | None = None
    notice: str | None = None


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
]
