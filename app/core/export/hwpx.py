"""`ExportDoc` -> `.hwpx` 바이트 (python-hwpx).

한컴 오피스 설치가 필요 없다. 결과물은 `mimetype = application/hwp+zip` 인 ZIP
컨테이너이고 이미지는 `BinData/BIN0001.png` 로 들어간다.

서식(글꼴·여백·머리말)은 지정하지 않는다 — 기본 서식으로 낸다. 제목/소제목도
별도 스타일 없이 문단으로 넣는다.

수식은 한글 수식 개체(`<hp:equation>`)로 넣는다(`export/hwpeq.py`). 변환에
실패한 수식은 기존 평문 유니코드(`x²`)로 폴백하고 로그를 남긴다.

이 모듈은 **블로킹**(파일 IO / 이미지 인코딩)이다.
`async def` 라우트에서 부를 때는 `run_in_threadpool` 로 감싼다.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Final

from hwpx.document import HwpxDocument
from hwpx.errors import HwpxError
from hwpx.oxml.paragraph import HwpxOxmlParagraph
from PIL import Image as PilImage

from export import layout
from export.hwpeq import HwpEquationError, latex_to_hwp_equation
from export.model import ExportDoc, Heading, Image, MathRun, PageBreak, Text, TextRun

_LOGGER: Final[logging.Logger] = logging.getLogger(__name__)

# 크롭 렌더 해상도(extractor.DEFAULT_DPI 와 동일). 픽셀→mm 환산 기준.
_CROP_RENDER_DPI: Final[int] = 150
# 이미지 폭 상한 = 본문 폭(A4 210mm - 좌우 여백 각 30mm = 150mm). docx 렌더러와
# 같은 `export.layout` 에서 온다. 예전 값 152.4mm(6인치)는 Letter 시절의 상한이
# 남은 것이라 본문 폭을 2.4mm 넘겨 넓은 크롭이 오른쪽 여백을 침범했다.
_MAX_IMAGE_WIDTH_MM: Final[float] = layout.BODY_WIDTH_MM


def _fit_width_mm(path: Path) -> float:
    """이미지 폭을 본문 폭(150mm)에 맞춰 계산한다.

    python-hwpx 는 PNG 라면 `width_mm` 만 줘도 세로를 원본 비율대로 맞춘다.

    Args:
        path: 크롭 PNG 경로.

    Returns:
        문서에 넣을 이미지 폭(mm). 원본보다 키우지 않는다.
    """
    with PilImage.open(path) as image:
        width_px = image.width
    native_mm = (
        width_px / _CROP_RENDER_DPI * layout.MM_PER_INCH
        if width_px > 0
        else _MAX_IMAGE_WIDTH_MM
    )
    return min(native_mm, _MAX_IMAGE_WIDTH_MM)


def _add_math(
    document: HwpxDocument, paragraph: HwpxOxmlParagraph, run: MathRun
) -> None:
    """문단 끝에 한글 수식 개체를 붙인다. 변환 실패 시 평문으로 폴백한다.

    `doc.shapes.add_equation` 은 넣은 뒤 표준 섹션 스캔으로 스크립트가 그대로
    저장됐는지 확인해 주는 경로다(실패하면 예외). 확인 비용은 수식 200개에
    0.04초 수준이라 검증을 포기할 이유가 없다.

    Args:
        document: 대상 문서.
        paragraph: 붙일 문단.
        run: 수식 런.
    """
    try:
        script = latex_to_hwp_equation(run.latex)
    except HwpEquationError as error:
        _LOGGER.info("한글 수식 변환 실패, 평문으로 폴백: %r (%s)", run.latex, error)
        paragraph.add_run(run.plain)
        return
    try:
        document.shapes.add_equation(script, paragraph=paragraph)
    except HwpxError as error:
        _LOGGER.info(
            "한글 수식 삽입 실패, 평문으로 폴백: %r -> %r (%s)",
            run.latex,
            script,
            error,
        )
        paragraph.add_run(run.plain)


def _add_text(document: HwpxDocument, block: Text) -> None:
    """본문 블록을 문단들로 넣는다(docx 렌더러와 같은 줄 나누기).

    Args:
        document: 대상 문서.
        block: 본문 블록.
    """
    if block.lines is None:
        # 수식이 없는 블록. 예전 경로 그대로다.
        for line in block.text.split("\n"):
            document.add_paragraph(line)
        return
    for runs in block.lines:
        paragraph = document.add_paragraph("", include_run=False)
        for run in runs:
            if isinstance(run, TextRun):
                paragraph.add_run(run.text)
            else:
                _add_math(document, paragraph, run)


def build_hwpx(doc: ExportDoc) -> bytes:
    """`ExportDoc` 을 `.hwpx` 바이트로 렌더한다.

    본문 텍스트는 줄 단위로 문단을 나눈다(docx 렌더러와 동일).

    `doc.notice` 가 있으면 제목 바로 아래(첫 페이지)에, `doc.footer` 는 문서 맨
    끝에 넣는다. 이 모듈의 방침대로 서식은 지정하지 않고 기본 문단으로 낸다.

    Args:
        doc: 렌더할 문서.

    Returns:
        `.hwpx` 파일 바이트(ZIP 컨테이너, 시그니처 ``PK``).
    """
    document = HwpxDocument.new()
    document.add_paragraph(doc.title)
    if doc.notice:
        # 고지는 **제목 바로 아래**(= 첫 페이지)다. 읽기 전에 보여야 의미가 있다.
        document.add_paragraph(doc.notice)
    for block in doc.blocks:
        if isinstance(block, Heading):
            document.add_paragraph(block.text)
        elif isinstance(block, Image):
            document.add_picture(
                block.path.read_bytes(), "png", width_mm=_fit_width_mm(block.path)
            )
        elif isinstance(block, Text):
            _add_text(document, block)
        elif isinstance(block, PageBreak):
            # 한글은 페이지 나눔을 문단 속성으로 표현한다(`hp:p/@pageBreak`).
            # 전용 API 가 없어 `add_paragraph` 의 raw 속성 통로(`**extra_attrs`)로
            # 넣는다 — 서식을 지정하지 않는 이 모듈의 방침과 어긋나지 않는 최소
            # 조작이고, XML 을 직접 조립하지 않는다.
            document.add_paragraph("", pageBreak="1")
    if doc.footer:
        # 출처 한 줄. 서식을 지정하지 않는 이 모듈의 방침대로 기본 문단으로 넣는다.
        document.add_paragraph(doc.footer)
    return document.to_bytes()


__all__ = ["build_hwpx"]
