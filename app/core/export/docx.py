"""`ExportDoc` -> `.docx` 바이트 (python-docx, 순수 파이썬).

기존 `core/docx_export.py` 를 이식한 것이다(이미지 폭 계산 로직 동일).
원본 PDF 는 수식 폰트(PUA)가 깨져 문항은 텍스트 대신 크롭 이미지를 쓴다.

이 모듈은 **블로킹**(파일 IO / 이미지 인코딩)이다.
`async def` 라우트에서 부를 때는 `run_in_threadpool` 로 감싼다.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Final

from docx import Document
from docx.shared import Inches, Length
from PIL import Image as PilImage

from export.model import ExportDoc, Heading, Image, Text

# 크롭 렌더 해상도(extractor.DEFAULT_DPI 와 동일). 픽셀→인치 환산 기준.
_CROP_RENDER_DPI: Final[int] = 150
# 이미지 폭 상한(A4 본문 폭에 맞춘 값). 세로 비율은 python-docx 가 유지한다.
_MAX_IMAGE_WIDTH_INCHES: Final[float] = 6.0


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
    워드가 줄바꿈으로 표시하지 않기 때문이다.

    Args:
        doc: 렌더할 문서.

    Returns:
        `.docx` 파일 바이트(ZIP 컨테이너, 시그니처 ``PK``).
    """
    document = Document()
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
