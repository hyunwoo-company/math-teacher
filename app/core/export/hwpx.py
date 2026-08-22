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
from collections.abc import Sequence
from pathlib import Path
from typing import Final

from hwpx.document import HwpxDocument
from hwpx.errors import HwpxError
from hwpx.oxml.paragraph import HwpxOxmlParagraph
from PIL import Image as PilImage

from export import layout
from export.hwpeq import HwpEquationError, latex_to_hwp_equation
from export.model import (
    Block,
    ExportDoc,
    Heading,
    Image,
    MathRun,
    Text,
    TextRun,
    item_spans,
)

_LOGGER: Final[logging.Logger] = logging.getLogger(__name__)

# 크롭 렌더 해상도(extractor.DEFAULT_DPI 와 동일). 픽셀→mm 환산 기준.
_CROP_RENDER_DPI: Final[int] = 150
# 이미지 폭 상한 = 본문 폭(A4 210mm - 좌우 여백 각 30mm = 150mm). docx 렌더러와
# 같은 `export.layout` 에서 온다. 예전 값 152.4mm(6인치)는 Letter 시절의 상한이
# 남은 것이라 본문 폭을 2.4mm 넘겨 넓은 크롭이 오른쪽 여백을 침범했다.
# 1단 문서(오답노트)가 쓰는 값이다.
_MAX_IMAGE_WIDTH_MM: Final[float] = layout.BODY_WIDTH_MM
# 2단 문서(시험지·변형)의 상한은 본문 폭이 아니라 **단 폭**(71mm)이다.
_MAX_COLUMN_IMAGE_WIDTH_MM: Final[float] = layout.COLUMN_WIDTH_MM
# 단 사이 간격(HWPUNIT). `set_columns(same_gap=...)` 가 이 단위를 받는다.
_COLUMN_GAP_HWPUNIT: Final[int] = round(
    layout.COLUMN_GAP_MM / layout.MM_PER_INCH * layout.HWPUNIT_PER_INCH
)
# 단 사이 세로 구분선. `separator_type` 이 그 선이고, 굵기·색은 한글 기본값
# (0.12mm 검정)을 그대로 적어 준다 — 지정하지 않으면 선 요소가 아예 없다.
_COLUMN_SEPARATOR_TYPE: Final[str] = "SOLID"
_COLUMN_SEPARATOR_WIDTH: Final[str] = "0.12 mm"
_COLUMN_SEPARATOR_COLOR: Final[str] = "#000000"


def _fit_width_mm(path: Path, max_mm: float) -> float:
    """이미지 폭을 지면이 허용하는 폭에 맞춰 계산한다.

    python-hwpx 는 PNG 라면 `width_mm` 만 줘도 세로를 원본 비율대로 맞춘다.

    Args:
        path: 크롭 PNG 경로.
        max_mm: 폭 상한(mm). 1단은 본문 폭(150mm), 2단은 단 폭(71mm)이다.

    Returns:
        문서에 넣을 이미지 폭(mm). 원본보다 키우지 않는다.
    """
    with PilImage.open(path) as image:
        width_px = image.width
    native_mm = (
        width_px / _CROP_RENDER_DPI * layout.MM_PER_INCH if width_px > 0 else max_mm
    )
    return min(native_mm, max_mm)


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


def _add_text(document: HwpxDocument, block: Text) -> list[HwpxOxmlParagraph]:
    """본문 블록을 문단들로 넣는다(docx 렌더러와 같은 줄 나누기).

    Args:
        document: 대상 문서.
        block: 본문 블록.

    Returns:
        만든 문단들(호출자가 문항 단위 조판 속성을 걸 수 있게 돌려준다).
    """
    if block.lines is None:
        # 수식이 없는 블록. 예전 경로 그대로다.
        return [document.add_paragraph(line) for line in block.text.split("\n")]
    paragraphs: list[HwpxOxmlParagraph] = []
    for runs in block.lines:
        paragraph = document.add_paragraph("", include_run=False)
        paragraphs.append(paragraph)
        for run in runs:
            if isinstance(run, TextRun):
                paragraph.add_run(run.text)
            else:
                _add_math(document, paragraph, run)
    return paragraphs


def _add_block(
    document: HwpxDocument, block: Block, *, max_image_mm: float
) -> list[HwpxOxmlParagraph]:
    """블록 하나를 렌더하고 그때 만든 문단들을 돌려준다.

    문단을 돌려주는 이유는 문항 단위로 조판 속성을 걸어야 하기 때문이다
    (`_apply_item_layout`). `add_picture` 는 그림을 **새 문단**에 넣고 그 문단을
    돌려주지 않지만, 반환된 개체가 `paragraph` 로 자기 문단을 가리킨다.

    Args:
        document: 대상 문서.
        block: 렌더할 블록.
        max_image_mm: 이미지 폭 상한(mm).

    Returns:
        만든 문단들. 페이지 나눔은 문항 구간 밖이므로 빈 목록을 준다.
    """
    if isinstance(block, Heading):
        return [document.add_paragraph(block.text)]
    if isinstance(block, Image):
        picture = document.add_picture(
            block.path.read_bytes(),
            "png",
            width_mm=_fit_width_mm(block.path, max_image_mm),
        )
        return [picture.paragraph]
    if isinstance(block, Text):
        return _add_text(document, block)
    # 남은 것은 `PageBreak` 뿐이다(`Block` 유니온 4종 중 셋을 위에서 처리했다).
    # 한글은 페이지 나눔을 문단 속성으로 표현한다(`hp:p/@pageBreak`). 전용 API 가
    # 없어 `add_paragraph` 의 raw 속성 통로(`**extra_attrs`)로 넣는다 — XML 을
    # 직접 조립하지 않는 최소 조작이다.
    document.add_paragraph("", pageBreak="1")
    return []


def _set_columns(document: HwpxDocument, paragraph: HwpxOxmlParagraph) -> None:
    """문서를 좌우 2단으로 만들고 단 사이에 세로 구분선을 세운다.

    한글은 단 설정을 구역 속성이 아니라 **문단 안의 제어 문자**
    (`hp:ctrl/hp:colPr`)로 갖는다. 그래서 문서 첫 문단(제목)에 걸어 두면 그
    뒤 전체가 2단이 된다. `separator_type` 이 중앙 세로선(`hp:colLine`)이다.

    Args:
        document: 대상 문서.
        paragraph: 단 정의를 실을 문단(문서 첫 문단).
    """
    document.page.set_columns(
        layout.COLUMN_COUNT,
        same_gap=_COLUMN_GAP_HWPUNIT,
        separator_type=_COLUMN_SEPARATOR_TYPE,
        separator_width=_COLUMN_SEPARATOR_WIDTH,
        separator_color=_COLUMN_SEPARATOR_COLOR,
        paragraph=paragraph,
    )


def _apply_item_layout(
    document: HwpxDocument, items: Sequence[Sequence[HwpxOxmlParagraph]]
) -> None:
    """문항마다 쪼개짐 방지와 문항 간 간격을 건다(docx 렌더러와 같은 규칙).

    높이를 우리가 계산하지 않는다. 조판 엔진에 "이 문단들은 쪼개지 마라"
    (`keepLines`)와 "다음 문단과 붙어라"(`keepWithNext`)를 걸어 두면, 남은
    공간에 안 들어갈 때 한글이 문항을 **통째로** 다음 단이나 다음 페이지로
    넘긴다. 마지막 문단만 `keepWithNext` 를 끈다 — 켜 두면 다음 문항까지
    끌려와 문서 전체가 한 덩이가 된다.

    첫 문단(= 문항 제목)에는 문항 간 간격을 준다. 문항 안 문단 사이는 그대로
    촘촘하게 둔다 — 그래야 한 문항이 한 덩이로 보인다.

    **문서를 다 만든 뒤 한 번에 부른다.** 이유가 둘 있다. (1) `add_paragraph` 는
    앞 문단의 서식 참조를 물려받으므로, 만드는 중에 서식을 걸면 그 뒤 문단까지
    keep 속성이 번진다. (2) `apply_paragraph_format` 은 문단마다 새 `paraPr` 을
    찍어내므로(중복을 합치지 않는다) 문단 수만큼 부르면 434문항 문서의
    `header.xml` 이 수천 개 항목으로 불어난다. 그래서 같은 자리(첫/중간/마지막)
    끼리 모아 자리마다 한 번만 찍고, 나머지 문단은 그 참조를 그대로 쓴다.

    **한계**: 문항 하나가 한 단 높이보다 크면 넘길 곳이 없다. 그런 문항은 결국
    단 사이에서 쪼개지거나 한 단을 통째로 차지한다.

    Args:
        document: 대상 문서(문단이 모두 들어간 상태).
        items: 문항마다의 문단 목록(제목부터 순서대로).
    """
    # (다음 문단과 붙일지, 문항 간 간격을 줄지, 물려받은 서식) -> 그 자리의 문단들.
    buckets: dict[tuple[bool, bool, str | None], list[HwpxOxmlParagraph]] = {}
    for paragraphs in items:
        last = len(paragraphs) - 1
        for index, paragraph in enumerate(paragraphs):
            key = (index != last, index == 0, paragraph.para_pr_id_ref)
            buckets.setdefault(key, []).append(paragraph)
    if not buckets:
        return
    position = {
        id(paragraph.element): index
        for index, paragraph in enumerate(document.paragraphs)
    }
    for (keep_with_next, gap, _base), paragraphs in buckets.items():
        first = paragraphs[0]
        document.styles.apply_paragraph_format(
            paragraph_index=position[id(first.element)],
            keep_lines=True,
            keep_with_next=keep_with_next,
            spacing_before_pt=layout.ITEM_GAP_PT if gap else None,
        )
        minted = first.para_pr_id_ref
        for paragraph in paragraphs[1:]:
            paragraph.para_pr_id_ref = minted


def build_hwpx(doc: ExportDoc) -> bytes:
    """`ExportDoc` 을 `.hwpx` 바이트로 렌더한다.

    본문 텍스트는 줄 단위로 문단을 나눈다(docx 렌더러와 동일).

    `doc.notice` 가 있으면 제목 바로 아래(첫 페이지)에, `doc.footer` 는 문서 맨
    끝에 넣는다. 이 모듈의 방침대로 서식은 지정하지 않고 기본 문단으로 낸다.

    `doc.two_column` 이면 예외가 둘 생긴다 — 문서를 좌우 2단(중앙 세로선)으로
    세우고, 문항마다 쪼개짐 방지와 문항 간 간격을 건다(`_set_columns` /
    `_apply_item_layout`). 1단 문서(오답노트)는 예전과 똑같이 나간다.

    Args:
        doc: 렌더할 문서.

    Returns:
        `.hwpx` 파일 바이트(ZIP 컨테이너, 시그니처 ``PK``).
    """
    document = HwpxDocument.new()
    title = document.add_paragraph(doc.title)
    if doc.two_column:
        _set_columns(document, title)
    max_image_mm = (
        _MAX_COLUMN_IMAGE_WIDTH_MM if doc.two_column else _MAX_IMAGE_WIDTH_MM
    )
    if doc.notice:
        # 고지는 **제목 바로 아래**(= 첫 페이지)다. 읽기 전에 보여야 의미가 있다.
        document.add_paragraph(doc.notice)
    blocks = list(doc.blocks)
    # 1단 문서는 문항 구간을 찾지 않는다 — 걸 속성이 없으므로 예전 경로 그대로다.
    spans = item_spans(blocks) if doc.two_column else {}
    items: list[list[HwpxOxmlParagraph]] = []
    index = 0
    while index < len(blocks):
        stop = spans.get(index)
        if stop is None:
            _add_block(document, blocks[index], max_image_mm=max_image_mm)
            index += 1
            continue
        items.append(
            [
                paragraph
                for block in blocks[index:stop]
                for paragraph in _add_block(
                    document, block, max_image_mm=max_image_mm
                )
            ]
        )
        index = stop
    if doc.footer:
        # 출처 한 줄. 서식을 지정하지 않는 이 모듈의 방침대로 기본 문단으로 넣는다.
        document.add_paragraph(doc.footer)
    # 문단을 **다 만든 뒤에** 건다(`_apply_item_layout` docstring 의 두 이유).
    # 꼬리말보다 뒤에 두는 것도 그래서다 — `add_paragraph` 는 앞 문단의 서식을
    # 물려받으므로, 먼저 걸면 꼬리말이 마지막 문항의 keep 속성을 물려받는다.
    _apply_item_layout(document, items)
    return document.to_bytes()


__all__ = ["build_hwpx"]
