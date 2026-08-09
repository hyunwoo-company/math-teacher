"""내보내기 공통 문서 모델 (형식에 독립적인 최소 표현).

`.docx` 와 `.hwpx` 렌더러가 같은 `ExportDoc` 을 받는다. 형식이 늘어도 문서 구성
규칙(`build.py`)은 한 벌만 유지된다.

**평문화는 `build.py` 에서 끝낸다.** `Text.text` 에는 이미 사람이 읽을 수 있는
유니코드 평문만 들어온다(LaTeX/마크다운 잔재 없음).
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
class Text:
    """본문 블록. **이미 평문화된** 문자열만 들어온다."""

    text: str


Block = Heading | Image | Text


@dataclass(frozen=True)
class ExportDoc:
    """내보낼 문서 하나.

    Attributes:
        title: 문서 상단 제목.
        blocks: 본문 블록들(순서대로 렌더한다).
    """

    title: str
    blocks: Sequence[Block]


__all__ = ["Block", "ExportDoc", "Heading", "Image", "Text"]
