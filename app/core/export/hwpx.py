"""`ExportDoc` -> `.hwpx` 바이트 (python-hwpx).

한컴 오피스 설치가 필요 없다. 결과물은 `mimetype = application/hwp+zip` 인 ZIP
컨테이너이고 이미지는 `BinData/BIN0001.png` 로 들어간다.

서식(글꼴·여백·머리말)은 지정하지 않는다 — 기본 서식으로 낸다. 제목/소제목도
별도 스타일 없이 문단으로 넣는다. **수식 객체(`add_equation`)는 v1 범위 밖이다**
(한글 수식 문법이 LaTeX 와 호환되지 않는다). 평문 유니코드(`x²`)로 넣는다.

이 모듈은 **블로킹**(파일 IO / 이미지 인코딩)이다.
`async def` 라우트에서 부를 때는 `run_in_threadpool` 로 감싼다.
"""

from __future__ import annotations

from pathlib import Path
from typing import Final

from hwpx.document import HwpxDocument
from PIL import Image as PilImage

from export.model import ExportDoc, Heading, Image, Text

# 크롭 렌더 해상도(extractor.DEFAULT_DPI 와 동일). 픽셀→mm 환산 기준.
_CROP_RENDER_DPI: Final[int] = 150
_MM_PER_INCH: Final[float] = 25.4
# docx 렌더러의 6인치 상한과 같은 값(6 * 25.4).
_MAX_IMAGE_WIDTH_MM: Final[float] = 152.4


def _fit_width_mm(path: Path) -> float:
    """이미지 폭을 페이지 폭(152.4mm = 6인치)에 맞춰 계산한다.

    python-hwpx 는 PNG 라면 `width_mm` 만 줘도 세로를 원본 비율대로 맞춘다.

    Args:
        path: 크롭 PNG 경로.

    Returns:
        문서에 넣을 이미지 폭(mm). 원본보다 키우지 않는다.
    """
    with PilImage.open(path) as image:
        width_px = image.width
    native_mm = (
        width_px / _CROP_RENDER_DPI * _MM_PER_INCH
        if width_px > 0
        else _MAX_IMAGE_WIDTH_MM
    )
    return min(native_mm, _MAX_IMAGE_WIDTH_MM)


def build_hwpx(doc: ExportDoc) -> bytes:
    """`ExportDoc` 을 `.hwpx` 바이트로 렌더한다.

    본문 텍스트는 줄 단위로 문단을 나눈다(docx 렌더러와 동일).

    Args:
        doc: 렌더할 문서.

    Returns:
        `.hwpx` 파일 바이트(ZIP 컨테이너, 시그니처 ``PK``).
    """
    document = HwpxDocument.new()
    document.add_paragraph(doc.title)
    for block in doc.blocks:
        if isinstance(block, Heading):
            document.add_paragraph(block.text)
        elif isinstance(block, Image):
            document.add_picture(
                block.path.read_bytes(), "png", width_mm=_fit_width_mm(block.path)
            )
        elif isinstance(block, Text):
            for line in block.text.split("\n"):
                document.add_paragraph(line)
    return document.to_bytes()


__all__ = ["build_hwpx"]
