"""스캔본(사진) PDF 에서 OCR 로 **문항 번호 앵커만** 찾는다 (AI 호출 0회).

왜 필요한가
----------
스캔본은 페이지마다 JPEG 한 장뿐이고 텍스트가 0자다(`extractor.looks_scanned`).
`extractor` 는 텍스트 줄 좌표에서 문항 번호를 앵커로 잡으므로 앵커 0개 → 0문항이
된다. 지금까지는 그 사유를 안내하는 것까지만 했다(`service._SCANNED_PDF_ERROR`).

여기서는 페이지를 렌더해 OCR 로 **번호와 그 좌표만** 읽고, 그 줄을 `extractor` 에
주입해 그 뒤 파이프라인(들여쓰기 필터 · 우세 구분자 · 번호 사슬 · 칼럼 판정 ·
크롭 · 번호 재매김)을 **그대로** 태운다. 문서 `docs/scanned-pdf-extraction.md`
3-2 절의 (b) 안이다.

**OCR 결과 텍스트는 저장하지도 AI 에 보내지도 않는다.** 수식 인식률이 낮아도
상관없다 — 필요한 것은 "몇 번 문제가 페이지 어디에 있는가" 뿐이고, AI 가 실제로
보는 것은 종전과 똑같이 잘라낸 크롭 이미지다(mode='image', 판독본 없음).

AI 를 부르지 않는다. 로컬 CPU 계산이라 프로바이더 해석도 필요 없고, AI 연결이
없는 환경에서도 그대로 돈다.

느리다 — 실측 1.6초/쪽(20쪽 32초, 54쪽 3분). 그래서 **업로드 요청 안에서 돌리지
않는다.** 작업 큐(`jobs`)의 `ocr` 종류로 백그라운드에서 돌고, 진행률은 기존 배너가
그린다. 단위는 문항이 아니라 **페이지**다(문항 수를 미리 알 수 없다).
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from functools import partial
from typing import Any, Final, NamedTuple, Protocol

import anyio
import fitz
import numpy as np
import numpy.typing as npt
from fastapi.concurrency import run_in_threadpool

import extractor
import service
import storage
from ai_service import Event

logger: Final[logging.Logger] = logging.getLogger("math_teacher.core.ocr")

#: 작업 params 와 로그에 남기는 엔진 이름.
ENGINE_NAME: Final[str] = "rapidocr-onnxruntime"

#: 진행 이벤트의 단위. 문항 수를 미리 모르므로 페이지로 센다.
UNIT_PAGE: Final[str] = "page"

# --- 렌더 배율 ---------------------------------------------------------------
# 페이지를 이 배율로 렌더해 OCR 에 넣는다(72dpi 기준이므로 2.0 = 144dpi).
#
# **무조건 크게 하면 나빠진다.** 실측(`2027 강대X 시즌2 6회 문제.pdf` 같은 페이지):
# 2.0 은 앵커 4개, 3.0 은 3개였다. 검출 모델(PP-OCRv4 det)이 입력 장변을 자체
# 상한(config.yaml 의 `max_side_len: 2000`)으로 되줄이므로, 원본을 키울수록
# 되줄임이 심해져 작은 글리프가 뭉개지는 것으로 보인다(추측 — 되줄임 로그를
# 직접 확인하지는 않았다).
#
# 2.0 에서 20쪽 32초(1.6초/쪽), 앵커 후보 49개를 읽어 문항 번호 1~30 중 29개를
# 잡았다(20번만 놓쳤다).
RENDER_SCALE: Final[float] = 2.0

# --- 신뢰도 임계 -------------------------------------------------------------
# 이 값 미만인 OCR 줄은 아예 버린다.
#
# 실측에서 실제 문항 번호의 신뢰도는 0.70~1.00 이었다(대부분 0.8 이상). 반대로
# 오탐(페이지 하단의 `0.`, 정답표의 `0.`/`1.`)도 0.64~1.00 이 나왔다 — **신뢰도로
# 오탐을 가릴 수는 없다.** 오탐은 뒤따르는 번호 사슬 필터
# (`extractor._pick_anchor_chain`)가 잡는다.
#
# 그래서 이 임계는 "엔진이 글자로 읽어내지 못한 것" 만 떨어내는 하한으로 쓴다.
# 0.5 는 실제 번호의 최저값(0.70)보다 넉넉히 아래다.
MIN_CONFIDENCE: Final[float] = 0.5

# OCR 로 읽은 글자의 x 범위에 붙이는 여유(pt). **좌우 대칭으로** 붙인다 —
# 이 범위의 중앙이 칼럼 분기선이라, 한쪽에만 붙이면 분기선이 움직인다.
_CONTENT_PAD_PT: Final[float] = 2.0


def release_render_cache() -> None:
    """MuPDF 의 **전역** 렌더 캐시를 비운다.

    왜 필요한가 (2026-08-22 OOMKilled 실측)
    ------------------------------------
    `page.get_pixmap()` 은 페이지를 그리면서 원본 이미지의 디코드 결과를 MuPDF
    전역 store 에 넣어 둔다. 스캔본은 페이지마다 큰 JPEG 한 장이라 그 캐시가
    **페이지당 약 12MiB** 쌓이고, 캐시 상한(약 256MiB)까지 단조 증가한다.
    그리고 그 256MiB 는 `doc.close()` 로도 잡이 끝나도 돌아오지 않는다 —
    store 는 문서가 아니라 MuPDF 컨텍스트에 매달려 있기 때문이다.

    실측(풍문고 54쪽 → 강대X 20쪽을 한 프로세스에서 연달아):
      - 이 함수 없이: 1번 잡에서 RSS 234 → 506MiB(피크 876MiB), 잡이 끝나고
        정리해도 **418MiB** 에서 안 내려간다. 그래서 2번 잡은 418MiB 에서
        시작해 한계를 넘는다. 프로덕션에서 죽은 것이 정확히 이 2번 잡이다
        (커널 로그: anon-rss 1037576kB + file-rss 97320kB > 1Gi).
      - 이 함수를 페이지마다 부르면: RSS 가 244MiB 에서 **평평하다**(54쪽 내내),
        피크 876 → 640MiB.

    전역 캐시를 비우므로 같은 시각 다른 요청이 쓰던 디코드 결과도 함께
    버려진다. OCR 잡은 단일 워커에서 순차로 도는 백그라운드 작업이고
    (`jobs`), 캐시가 비면 다시 디코드할 뿐 결과는 같으므로 그 편을 택했다.
    """
    fitz.TOOLS.store_shrink(100)


class OcrLine(NamedTuple):
    """OCR 이 읽은 글자 한 덩어리. 좌표는 **PDF 좌표계**(pt)로 환산해 둔다."""

    text: str
    bbox: tuple[float, float, float, float]
    confidence: float


#: OCR 원시 결과 한 줄: (4점 폴리곤, 텍스트, 신뢰도).
RawOcrItem = tuple[Sequence[Sequence[float]], str, float]


class OcrEngine(Protocol):
    """이미지 배열을 받아 (결과 목록, 소요시간) 을 주는 엔진.

    `rapidocr_onnxruntime.RapidOCR` 의 호출 규약이다. 읽은 것이 없으면 결과 자리에
    `None` 이 온다(실측 — 빈 목록이 아니다).
    """

    def __call__(
        self, image: npt.NDArray[np.uint8]
    ) -> tuple[list[RawOcrItem] | None, Any]:
        """이미지 한 장을 읽는다."""
        ...


#: 페이지 한 장을 읽어 줄 목록을 주는 함수. **테스트가 갈아끼우는 경계**다
#: (실제 엔진은 느리고 CI 에 모델이 없을 수 있어 단위 테스트에서 부르지 않는다).
PageReader = Callable[[fitz.Page], list[OcrLine]]


def default_page_reader() -> PageReader:
    """실제 엔진(`rapidocr-onnxruntime`)으로 페이지를 읽는 리더를 만든다.

    엔진 객체는 onnx 모델 3개(약 16MB)를 메모리에 올리므로 리더 하나당 한 번만
    만든다. 모델은 **휠에 들어 있다**(실측: `rapidocr_onnxruntime/models/*.onnx`
    3개, 16.2MB) — 첫 호출에 네트워크를 타지 않으므로 오프라인 컨테이너에서도
    기동한다.

    Returns:
        페이지를 받아 OCR 줄 목록을 주는 함수.

    Raises:
        ExtractionError: 엔진을 올릴 수 없을 때(패키지 미설치·공유 라이브러리 없음).
    """
    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception as exc:  # ImportError 외에 OSError(공유 라이브러리)도 온다
        raise extractor.ExtractionError(
            f"OCR 엔진({ENGINE_NAME})을 불러올 수 없습니다: {exc}"
        ) from exc
    engine: OcrEngine = RapidOCR()
    return partial(read_page, engine=engine)


def read_page(page: fitz.Page, *, engine: OcrEngine) -> list[OcrLine]:
    """페이지를 렌더해 OCR 로 읽는다 (블로킹 CPU 계산).

    Args:
        page: 읽을 페이지.
        engine: OCR 엔진.

    Returns:
        읽은 줄들(PDF 좌표계). 아무것도 못 읽으면 빈 목록.
    """
    try:
        pix = page.get_pixmap(matrix=fitz.Matrix(RENDER_SCALE, RENDER_SCALE))
        image: npt.NDArray[np.uint8] = np.frombuffer(
            pix.samples, dtype=np.uint8
        ).reshape(pix.height, pix.width, pix.n)
        if pix.n == 4:  # RGBA -> RGB (엔진은 3채널을 받는다)
            image = image[:, :, :3]
        # `pix.samples` 는 이미 복사본이다(`image` 가 그 bytes 를 붙잡고 있다).
        # 추론이 순간 268MiB 를 쓰므로 그 전에 렌더 버퍼(약 6MiB)를 놓는다.
        del pix
        result, _elapsed = engine(image)
        del image
    finally:
        # 페이지마다 반드시 비운다 — 안 비우면 페이지당 12MiB 가 쌓인다.
        release_render_cache()
    if not result:
        return []

    lines: list[OcrLine] = []
    for box, text, confidence in result:
        xs = [float(point[0]) / RENDER_SCALE for point in box]
        ys = [float(point[1]) / RENDER_SCALE for point in box]
        lines.append(
            OcrLine(
                text=str(text),
                bbox=(min(xs), min(ys), max(xs), max(ys)),
                confidence=float(confidence),
            )
        )
    return lines


def text_lines(
    lines: Sequence[OcrLine], *, min_confidence: float = MIN_CONFIDENCE
) -> list[extractor.TextLine]:
    """OCR 줄을 `extractor` 가 쓰는 텍스트 줄로 바꾼다(신뢰도 미달은 버린다).

    신뢰도 판정을 **여기서** 한다. 이 줄들은 앵커 후보이면서 동시에 들여쓰기
    판정의 정렬선 표본이기도 하므로(`extractor._body_x0_buckets`), 못 읽은 줄이
    정렬선을 오염시키지 않게 한 곳에서 한 번에 걸러 내는 것이 맞다.

    Args:
        lines: 한 페이지의 OCR 줄.
        min_confidence: 이 값 미만은 버린다.

    Returns:
        `extractor` 용 텍스트 줄.
    """
    return [
        extractor.TextLine(text=line.text, bbox=line.bbox)
        for line in lines
        if line.confidence >= min_confidence
    ]


def page_layout(
    page: fitz.Page,
    lines: Sequence[extractor.TextLine],
    *,
    single_column: bool = False,
) -> extractor.PageLayout:
    """스캔본 페이지의 기하를 OCR 로 읽은 글자의 x 범위로 잡는다.

    **세로는 기존 규칙 그대로다**(`extractor.content_rect`). 머리말·꼬리말을
    밴드로 배제하는 그 판정을 바꿀 이유가 없고, 실측에서 스캔본 앵커의 y
    (78~623pt)가 전부 그 안이었다.

    가로만 바꾼다. 스캔본은 종이를 스캐너에 올린 결과라 PDF 페이지 상자가 인쇄
    지면과 어긋나고, 그 어긋남이 페이지마다 다르다. 실측(강대X 20쪽): 페이지
    중앙은 297.5pt 인데 우측 칼럼 번호가 290.0~322.5pt 에서 시작한다(같은 페이지
    좌측 칼럼 번호와 항상 약 257pt 차이 = 페이지별 스캔 오프셋). 페이지 중앙으로
    좌/우를 가르면 290.0~294.5pt 에서 시작한 우측 칼럼 앵커 4개가 좌측으로
    분류돼 들여쓰기 필터에서 통째로 탈락했다. OCR 글자 범위의 중앙으로 가르면
    20쪽 전부에서 좌/우 분류가 맞았다.

    단 수(1단/2단)는 여기서 정하지 않는다. 그것은 지면 전체의 성질이라 문서를 다
    보고 한 번 정하는 것이 맞다(`detect_single_column`). 실측에서 쪽 단위로 끊으면
    2단 스캔본(강대X) 17쪽 중 2쪽이 1단으로 뒤집혔다.

    Args:
        page: 대상 페이지.
        lines: 그 페이지에서 읽은(신뢰도 필터를 통과한) 줄들.
        single_column: 1단(전폭) 지면이면 True. 기본값은 기존 동작(2단)이다.

    Returns:
        페이지 기하. 읽은 줄이 없으면 기존 규칙 그대로(`extractor.page_layout`).
    """
    if not lines:
        return extractor.page_layout(page, single_column=single_column)
    content = extractor.content_rect(page)
    x0 = max(
        float(page.rect.x0), min(line.bbox[0] for line in lines) - _CONTENT_PAD_PT
    )
    x1 = min(
        float(page.rect.x1), max(line.bbox[2] for line in lines) + _CONTENT_PAD_PT
    )
    if x1 - x0 <= 0.0:
        return extractor.page_layout(page, single_column=single_column)
    scanned = fitz.Rect(x0, content.y0, x1, content.y1)
    return extractor.PageLayout(
        content=scanned,
        left=extractor.column_bounds(scanned, "left"),
        right=extractor.column_bounds(scanned, "right"),
        split_x=(x0 + x1) / 2.0,
        single_column=single_column,
    )


def detect_single_column(
    doc: fitz.Document, lines: Mapping[int, Sequence[extractor.TextLine]]
) -> bool:
    """스캔본 문서가 1단 조판인지 OCR 줄 박스로 판정한다.

    판정 규칙은 텍스트 레이어 경로와 **같은 것**(`extractor.is_single_column`)을
    쓴다. 글자 박스만 OCR 줄 박스로 바꾼다 — 스캔본에는 단어 좌표가 없다.
    분기선은 이 모듈의 규칙(OCR 글자 x 범위의 중앙)을 그대로 쓴다.

    Args:
        doc: 열려 있는 PDF 문서.
        lines: 쪽번호(0부터) → 그 페이지의 OCR 줄.

    Returns:
        1단(전폭) 문서면 True.
    """
    pages: list[tuple[int, int]] = []
    for index in range(doc.page_count):
        page_lines = lines.get(index, ())
        layout = page_layout(doc[index], page_lines)
        pages.append(
            extractor.full_width_rows(
                [line.bbox for line in page_lines], layout.content, layout.split_x
            )
        )
    return extractor.is_single_column(pages)


def extract_with_ocr(
    pdf_bytes: bytes,
    ocr_lines: Mapping[int, Sequence[OcrLine]],
    *,
    min_confidence: float = MIN_CONFIDENCE,
    dpi: int = extractor.DEFAULT_DPI,
    render_images: bool = True,
) -> extractor.ExtractResult:
    """OCR 줄을 주입해 문항을 추출한다 (블로킹 — `run_in_threadpool` 로 부른다).

    앵커를 미리 골라 넘기지 않고 **줄을 넘긴다.** 그래야 들여쓰기 필터 · 우세
    구분자 · 번호 사슬 필터가 `extractor` 안에서 그대로 돌아간다(오탐 `0.` 이
    실제로 여기서 걸러진다). 앵커를 밖에서 확정해 넘기면 그 필터들을 이 모듈이
    다시 구현해야 한다.

    mode 는 `image` 로 **고정**한다. 텍스트 레이어가 없으니 PUA 비율 자동 판정이
    무의미하고(분모 0), 풀이는 크롭 이미지로 가야 한다.

    Args:
        pdf_bytes: 원본 PDF.
        ocr_lines: 0부터 센 쪽번호 → 그 페이지의 OCR 줄.
        min_confidence: 앵커·정렬선에 쓸 최소 신뢰도.
        dpi: 크롭 렌더링 해상도.
        render_images: False 면 크롭 이미지를 만들지 않는다(분할만 확인할 때).

    Returns:
        추출 결과. `problems[*].text` 는 빈 문자열이다(OCR 텍스트를 본문으로
        쓰지 않는다 — `extractor.extract_problems` 의 `anchor_lines_provider` 참고).
    """
    lines = {
        index: text_lines(items, min_confidence=min_confidence)
        for index, items in ocr_lines.items()
    }

    def provide_lines(_page: fitz.Page, index: int) -> list[extractor.TextLine]:
        return lines.get(index, [])

    # 단 수는 문서 단위로 한 번 정한다(쪽 단위 판정의 뒤집힘은 `page_layout` 참고).
    with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
        single_column = detect_single_column(doc, lines)

    def provide_layout(page: fitz.Page, index: int) -> extractor.PageLayout:
        return page_layout(page, lines.get(index, []), single_column=single_column)

    return extractor.extract_problems(
        pdf_bytes=pdf_bytes,
        mode="image",
        dpi=dpi,
        render_images=render_images,
        anchor_lines_provider=provide_lines,
        layout_provider=provide_layout,
    )


def plan_ocr_job(node_id: str) -> tuple[int, str]:
    """OCR 작업의 진행 단위 수(페이지 수)와 표시용 시험지 이름 (블로킹).

    페이지 수는 등록할 때 기록해 둔 값을 쓰고, 없으면(추출 자체가 실패한 파일)
    원본 PDF 를 열어 센다.

    Args:
        node_id: 시험지 파일 노드 id.

    Returns:
        (페이지 수, 시험지 이름).

    Raises:
        ApiError: 시험지 파일 노드가 아니거나 원본 PDF 가 없을 때.
    """
    with storage.transaction() as conn:
        node = service.require_file_node(conn, node_id)
        meta = storage.get_file(conn, node_id)
    path = service.raw_pdf_path(node_id)
    pages = int((meta or {}).get("pages") or 0)
    if pages <= 0:
        doc = fitz.open(str(path))
        try:
            pages = int(doc.page_count)
        finally:
            doc.close()
    return pages, str(node["name"])


async def ocr_events(
    *,
    node_id: str,
    reader: PageReader | None = None,
    min_confidence: float = MIN_CONFIDENCE,
) -> AsyncIterator[Event]:
    """스캔본을 OCR 로 읽어 문항을 만들며 진행 이벤트를 흘린다.

    이벤트 이름은 다른 작업과 같다(`start` → 단위마다 `problem`/`done` → `end`).
    프론트의 진행률 배너가 그 이름으로 그리므로 새 이름을 만들지 않는다. 다만
    **단위가 문항이 아니라 페이지**다 — 문항 수를 미리 알 수 없기 때문이다.
    그래서 `total` 은 페이지 수이고 `problem.no` / `done.no` 는 1부터 세는 페이지
    번호다. 헷갈리지 않도록 모든 이벤트에 `unit="page"` 를 함께 싣는다.

    OCR 은 블로킹 CPU 계산이라 **페이지마다** `run_in_threadpool` 로 넘긴다
    (이벤트 루프를 붙잡으면 다른 요청이 멈춘다). 그 결과 취소는 페이지 경계에서
    걸린다(실측 1.6초/쪽).

    문항 저장은 마지막에 한 번이다. 번호 사슬 필터가 문서 전체를 봐야 결정되므로
    페이지 단위로 미리 저장할 수 없다.

    Args:
        node_id: 시험지 노드 id.
        reader: 페이지를 읽는 함수. None 이면 실제 엔진을 올린다(테스트 주입점).
        min_confidence: 앵커·정렬선에 쓸 최소 신뢰도.

    Yields:
        진행 이벤트들.
    """
    try:
        read_page_fn = (
            reader if reader is not None else await run_in_threadpool(default_page_reader)
        )
        path = await run_in_threadpool(service.raw_pdf_path, node_id)
        raw: bytes = await run_in_threadpool(path.read_bytes)

        ocr_lines: dict[int, list[OcrLine]] = {}
        doc = fitz.open(stream=raw, filetype="pdf")
        try:
            page_count = int(doc.page_count)
            yield ("start", {"total": page_count, "unit": UNIT_PAGE})
            for index in range(page_count):
                yield (
                    "problem",
                    {"no": index + 1, "status": "running", "unit": UNIT_PAGE},
                )
                lines = await run_in_threadpool(read_page_fn, doc[index])
                ocr_lines[index] = lines
                yield (
                    "done",
                    {"no": index + 1, "unit": UNIT_PAGE, "line_count": len(lines)},
                )
        finally:
            doc.close()

        result = await run_in_threadpool(
            partial(extract_with_ocr, raw, ocr_lines, min_confidence=min_confidence)
        )
        # 크롭 렌더도 같은 전역 캐시를 채운다. 잡 경계에서 비워, 다음 잡이
        # 남은 캐시를 짊어지고 시작하지 않게 한다.
        await run_in_threadpool(release_render_cache)
        problem_count = await run_in_threadpool(
            service.apply_ocr_problems, node_id, result
        )
        logger.info(
            "스캔본 OCR 완료 (node_id=%s, %d쪽 → %d문항)",
            node_id,
            page_count,
            problem_count,
        )
        yield (
            "end",
            {
                "unit": UNIT_PAGE,
                "engine": ENGINE_NAME,
                "page_count": page_count,
                "problem_count": problem_count,
            },
        )
    except (anyio.get_cancelled_exc_class(), GeneratorExit):
        logger.info("OCR 작업이 취소됐습니다 (node_id=%s)", node_id)
        raise
