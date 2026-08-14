"""`ExportDoc` -> `.docx` 바이트 (python-docx, 순수 파이썬).

기존 `core/docx_export.py` 를 이식한 것이다(이미지 폭 계산 로직 동일).
원본 PDF 는 수식 폰트(PUA)가 깨져 문항은 텍스트 대신 크롭 이미지를 쓴다.

이 모듈은 **블로킹**(파일 IO / 이미지 인코딩)이다.
`async def` 라우트에서 부를 때는 `run_in_threadpool` 로 감싼다.
"""

from __future__ import annotations

import io
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Final

from docx import Document
from docx.document import Document as DocxDocument
from docx.enum.text import WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Length, Pt
from PIL import Image as PilImage

from export.model import ExportDoc, Heading, Image, Text

# 크롭 렌더 해상도(extractor.DEFAULT_DPI 와 동일). 픽셀→인치 환산 기준.
_CROP_RENDER_DPI: Final[int] = 150
# 이미지 폭 상한(A4 본문 폭에 맞춘 값). 세로 비율은 python-docx 가 유지한다.
_MAX_IMAGE_WIDTH_INCHES: Final[float] = 6.0

# 본문 폰트. python-docx 기본 템플릿은 테마 폰트(Calibri)를 쓰는데, Calibri 에는
# 위·아래첨자(ᵐ ⁿ ⁻ ₁ ₂)와 ⇒ ∘ ∠ ⋯ ≡ ✔ 글리프가 없어 평문화한 수식이 □ 로 깨진다.
# 맑은 고딕은 Windows·한글·워드에 기본 설치돼 있고 이 글자들을 모두 덮는다.
_BODY_FONT: Final[str] = "맑은 고딕"
# 본문 글자 크기. 같은 시험지를 hwpx 로 뽑으면 본문이 10pt(`charPr height="1000"`,
# 줄간격 160%)다. 글자 크기가 다르면 줄이 접히는 횟수가 달라져 두 형식의 페이지
# 수가 끝내 수렴하지 않으므로 hwpx 에 맞춘다. python-docx 기본값은 11pt 였다.
_BODY_FONT_SIZE: Final[Length] = Pt(10)
# 제목 스타일별 글자 크기(본문보다 크게, 위에서 아래로 줄어드는 사다리).
# 템플릿 기본 Title 은 26pt 로 과해서 hwpx 제목과 같은 16pt 로 낮춘다.
# Heading 1·2 는 템플릿 값(14pt·13pt)을 그대로 못박은 것이고, Heading 3 은
# 본래 Normal 을 상속해 11pt 였다 — 본문이 10pt 로 내려가도 그 크기를 유지한다.
_HEADING_FONT_SIZES: Final[Mapping[str, Length]] = {
    "Title": Pt(16),
    "Heading 1": Pt(14),
    "Heading 2": Pt(13),
    "Heading 3": Pt(11),
}
# 언어권별 폰트 지정. python-docx 의 `font.name` 은 ascii/hAnsi 만 건드리는데,
# 한글은 eastAsia, 수학 기호는 cs 를 따라가므로 네 가지를 모두 넣어야 한다.
_FONT_ATTRIBUTES: Final[tuple[str, ...]] = (
    "w:ascii",
    "w:eastAsia",
    "w:hAnsi",
    "w:cs",
)
# 테마 폰트 지정. 남아 있으면 워드가 위 명시값 대신 테마(Calibri)를 쓴다.
_FONT_THEME_ATTRIBUTES: Final[tuple[str, ...]] = (
    "w:asciiTheme",
    "w:eastAsiaTheme",
    "w:hAnsiTheme",
    "w:cstheme",
)


def _apply_font(style: Any, name: str, size: Length) -> None:
    """스타일에 폰트와 글자 크기를 못박는다(테마 해제 + 복합 스크립트 동기화).

    python-docx 의 `font.name` 은 `w:ascii` 와 `w:hAnsi` 만 쓰고 테마 속성
    (`w:asciiTheme` 등)은 그대로 둔다. 테마 속성이 남아 있으면 워드가 그쪽을
    우선해 Calibri 로 되돌아가므로 XML 에서 직접 지우고 네 언어권을 다 채운다.
    `font.size` 도 `w:sz` 만 쓰므로 `w:szCs` 를 같은 값으로 맞춰 준다.

    Args:
        style: python-docx 스타일 객체(`ParagraphStyle`). 정확한 타입이
            `Styles.__getitem__` 반환형(`BaseStyle`)으로 좁혀지지 않아 `Any` 다.
        name: 지정할 폰트 이름.
        size: 지정할 글자 크기.
    """
    style.font.name = name
    style.font.size = size
    rpr = style.element.get_or_add_rPr()
    fonts = rpr.get_or_add_rFonts()
    for attribute in _FONT_ATTRIBUTES:
        fonts.set(qn(attribute), name)
    for attribute in _FONT_THEME_ATTRIBUTES:
        fonts.attrib.pop(qn(attribute), None)
    complex_size = rpr.find(qn("w:szCs"))
    if complex_size is None:
        complex_size = OxmlElement("w:szCs")
        rpr.get_or_add_sz().addnext(complex_size)
    complex_size.set(qn("w:val"), str(int(size.pt * 2)))


def _tighten(document: DocxDocument) -> None:
    """문단 여백·줄간격·글자 크기를 hwpx 쪽에 맞춰 페이지 수를 정상화한다.

    python-docx 기본 템플릿의 `docDefaults` 는 문단마다 뒤 여백 10pt
    (`w:after="200"`)와 줄간격 1.15배(`w:line="276"`)를 준다. 이 렌더러는 평문을
    줄 단위로 문단화하므로 그 여백이 문단 수만큼 곱해져, 같은 내용이 hwpx 14쪽
    대비 docx 74쪽으로 불어났다(설계 §2-1 실측).

    글자 크기도 같이 맞춘다. hwpx 는 본문 10pt 인데 docx 기본은 11pt 라, 여백을
    없애도 긴 줄이 더 자주 접혀 페이지 수가 수렴하지 않는다.

    Args:
        document: 방금 만든 빈 문서. 본문을 채우기 전에 부른다.
    """
    normal = document.styles["Normal"]
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(0)
    # SINGLE 은 `w:line="240" w:lineRule="auto"`(=1.0배)를 만든다.
    normal.paragraph_format.line_spacing_rule = WD_LINE_SPACING.SINGLE
    _apply_font(normal, _BODY_FONT, _BODY_FONT_SIZE)

    for name, size in _HEADING_FONT_SIZES.items():
        try:
            style = document.styles[name]
        except KeyError:
            continue
        style.paragraph_format.space_before = Pt(6)
        style.paragraph_format.space_after = Pt(2)
        _apply_font(style, _BODY_FONT, size)


def _fit_width(path: Path) -> Length:
    """이미지 폭을 페이지 폭(6인치)에 맞춰 계산한다(원본보다 키우지 않음).

    python-docx 는 `width` 만 주면 세로를 원본 비율대로 맞춘다.

    Args:
        path: 크롭 PNG 경로.

    Returns:
        문서에 넣을 이미지 폭(EMU).
    """
    with PilImage.open(path) as image:
        width_px = image.width
    native_inches = (
        width_px / _CROP_RENDER_DPI if width_px > 0 else _MAX_IMAGE_WIDTH_INCHES
    )
    return Inches(min(native_inches, _MAX_IMAGE_WIDTH_INCHES))


def build_docx(doc: ExportDoc) -> bytes:
    """`ExportDoc` 을 `.docx` 바이트로 렌더한다.

    본문 텍스트는 줄 단위로 문단을 나눈다. 한 문단에 개행을 그대로 넣으면
    워드가 줄바꿈으로 표시하지 않기 때문이다. 그래서 문단이 아주 많아지므로
    `_tighten` 으로 문단 여백을 0 으로 눌러 두고 시작한다.

    Args:
        doc: 렌더할 문서.

    Returns:
        `.docx` 파일 바이트(ZIP 컨테이너, 시그니처 ``PK``).
    """
    document = Document()
    _tighten(document)
    document.add_heading(doc.title, level=0)
    for block in doc.blocks:
        if isinstance(block, Heading):
            document.add_heading(block.text, level=block.level)
        elif isinstance(block, Image):
            document.add_picture(str(block.path), width=_fit_width(block.path))
        elif isinstance(block, Text):
            for line in block.text.split("\n"):
                document.add_paragraph(line)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


__all__ = ["build_docx"]
