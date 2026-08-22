"""스캔본 OCR 경로 테스트 (실제 OCR 엔진을 부르지 않는다).

경계가 하나다: `ocr.PageReader` — "페이지를 받아 OCR 줄을 준다" 는 함수. 여기에
가짜를 넣으면 엔진(모델 16MB, 1.6초/쪽) 없이 그 뒤 파이프라인을 전부 검증할 수
있다. 실물 엔진을 쓰는 테스트는 파일 맨 아래에 **환경변수로 켜야만** 도는 형태로
하나 둔다(느리고 실물 PDF·모델이 있어야 한다).
"""

from __future__ import annotations

import os
from functools import partial
from pathlib import Path
from typing import Any

import fitz
import pytest
from conftest import (
    create_job,
    enable_ocr_autoqueue,
    upload_test_pdf,
    wait_job,
)
from fastapi.testclient import TestClient

import ai_service
import extractor
import jobs
import ocr
import storage

# --- 합성 스캔본 -------------------------------------------------------------
# 실물 스캔본의 성질 두 가지만 재현한다.
#   1. 텍스트 레이어가 0자다 -> `looks_scanned` 가 걸린다.
#   2. 우측 칼럼이 **페이지 중앙보다 왼쪽**에서 시작한다(실측 강대X: 페이지 중앙
#      297.5pt 인데 우측 번호가 290~294.5pt). 이 성질이 없으면 회귀를 못 잡는다.
_PAGE_W = 595.0
_PAGE_H = 841.0
_LEFT_X = 34.0
_RIGHT_X = 291.0  # < 페이지 중앙(297.5) — 여기가 함정이다
_CONTENT_X1 = 526.0


def _scanned_pdf(pages: int = 1) -> bytes:
    """글자가 하나도 없는 PDF(스캔본 대역). 그림만 그린다."""
    doc = fitz.open()
    try:
        for _ in range(pages):
            page = doc.new_page(width=_PAGE_W, height=_PAGE_H)
            page.draw_rect(fitz.Rect(40, 40, 555, 800), color=(0, 0, 0), width=0.5)
        return bytes(doc.tobytes())
    finally:
        doc.close()


def _line(
    text: str, x0: float, y0: float, x1: float, confidence: float = 0.9
) -> ocr.OcrLine:
    return ocr.OcrLine(text=text, bbox=(x0, y0, x1, y0 + 12.0), confidence=confidence)


def _page_lines(first_no: int) -> list[ocr.OcrLine]:
    """2단 조판 한 페이지분 가짜 OCR 결과(문항 4개 + 본문 줄)."""
    return [
        _line(f"{first_no}.", _LEFT_X, 100.0, _LEFT_X + 20.0),
        _line("좌측 본문", _LEFT_X, 120.0, 250.0),
        _line(f"{first_no + 1}.", _LEFT_X, 400.0, _LEFT_X + 20.0),
        _line("좌측 본문", _LEFT_X, 420.0, 250.0),
        _line(f"{first_no + 2}.", _RIGHT_X, 100.0, _RIGHT_X + 20.0),
        _line("우측 본문", _RIGHT_X, 120.0, _CONTENT_X1),
        _line(f"{first_no + 3}.", _RIGHT_X, 400.0, _RIGHT_X + 20.0),
        _line("우측 본문", _RIGHT_X, 420.0, _CONTENT_X1),
    ]


def _reader(per_page: dict[int, list[ocr.OcrLine]]) -> ocr.PageReader:
    """쪽번호로 미리 정해 둔 줄을 돌려주는 가짜 리더."""

    def read(page: fitz.Page) -> list[ocr.OcrLine]:
        return per_page.get(int(page.number), [])

    return read


# --- 앵커 주입 ---------------------------------------------------------------


def test_injected_lines_build_problems_from_coordinates() -> None:
    """OCR 좌표만으로 문항이 만들어진다(텍스트 레이어 0자인데도)."""
    raw = _scanned_pdf(pages=2)
    lines = {0: _page_lines(1), 1: _page_lines(5)}

    result = ocr.extract_with_ocr(raw, lines, render_images=False)

    assert [p.no for p in result.problems] == [1, 2, 3, 4, 5, 6, 7, 8]
    assert [p.page for p in result.problems] == [1, 1, 1, 1, 2, 2, 2, 2]
    # 텍스트 레이어가 없으니 판독본도 없다. OCR 텍스트를 본문으로 쓰지 않는다.
    assert all(p.text == "" for p in result.problems)
    # 풀이는 크롭으로 가야 한다.
    assert result.mode == "image"


def test_right_column_left_of_page_center_is_classified_right() -> None:
    """스캔 오프셋으로 우측 칼럼이 페이지 중앙보다 왼쪽에 있어도 우측으로 본다.

    실측(강대X 20쪽): 페이지 중앙 297.5pt 인데 우측 칼럼 번호는 290.0~322.5pt 에서
    시작한다. 기존 기하(페이지 중앙 기준)로는 좌측으로 분류돼 들여쓰기 필터에서
    탈락했다. OCR 글자 범위의 중앙으로 가르면 맞는다.
    """
    doc = fitz.open(stream=_scanned_pdf(), filetype="pdf")
    try:
        page = doc[0]
        text_lines = ocr.text_lines(_page_lines(1))
        # 기존 기하: 페이지 중앙(297.5) 기준 -> 291 은 좌측으로 잘못 분류된다.
        assert extractor.page_layout(page).column_of(_RIGHT_X) == "left"
        # OCR 기하: 글자 범위(32~528) 중앙(280) 기준 -> 우측.
        assert ocr.page_layout(page, text_lines).column_of(_RIGHT_X) == "right"
    finally:
        doc.close()


def test_low_confidence_lines_are_dropped() -> None:
    """신뢰도 임계 미달 줄은 앵커가 되지 못한다."""
    raw = _scanned_pdf()
    lines = list(_page_lines(1))
    # "3." 만 임계 아래로 떨어뜨린다.
    lines[4] = _line("3.", _RIGHT_X, 100.0, _RIGHT_X + 20.0, confidence=0.3)

    result = ocr.extract_with_ocr(raw, {0: lines}, render_images=False)

    assert [p.no for p in result.problems] == [1, 2, 4]


def test_confidence_threshold_is_a_constant_below_measured_anchors() -> None:
    """임계는 상수다. 실측 문항 번호 최저 신뢰도(0.70)보다 넉넉히 아래여야 한다."""
    assert ocr.MIN_CONFIDENCE == 0.5
    assert ocr.MIN_CONFIDENCE < 0.70


def test_render_scale_is_two() -> None:
    """렌더 배율은 2.0 이다(3.0 이 더 나빴다 — ocr.RENDER_SCALE 주석 참고)."""
    assert ocr.RENDER_SCALE == 2.0


def test_false_anchor_is_dropped_by_chain_filter() -> None:
    """오탐(`0.`)은 번호 사슬 필터에서 걸러진다.

    실측: 스캔본 페이지 하단·정답표에서 `0.` 이 신뢰도 0.64~1.00 으로 잡힌다.
    신뢰도로는 못 가린다 — 사슬 필터가 잡는 것이 이 설계의 요점이다.
    """
    raw = _scanned_pdf()
    false_anchor = _line("0.", _RIGHT_X, 600.0, _RIGHT_X + 20.0, confidence=1.0)
    lines = [*_page_lines(1), false_anchor]

    result = ocr.extract_with_ocr(raw, {0: lines}, render_images=False)

    assert [p.no for p in result.problems] == [1, 2, 3, 4]


# --- 작업 자동 등록 ----------------------------------------------------------


def _ocr_jobs(client: TestClient) -> list[dict[str, Any]]:
    payload = client.get("/api/jobs").json()
    return [
        job
        for job in payload["active"] + payload["recent"]
        if job["kind"] == jobs.JOB_KIND_OCR
    ]


def _upload(client: TestClient, name: str, raw: bytes) -> dict[str, Any]:
    response = client.post(
        "/api/files", files={"file": (name, raw, "application/pdf")}
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def test_scanned_upload_queues_ocr_job_and_creates_problems(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, ocr_autoqueue: None
) -> None:
    """스캔본을 올리면 OCR 작업이 자동으로 걸리고, 끝나면 문항이 생긴다.

    업로드 **응답 자체는 기다리지 않는다** — 0문항 + 사유를 그대로 돌려준다.
    """
    monkeypatch.setattr(
        ocr, "default_page_reader", lambda: _reader({0: _page_lines(1)})
    )
    body = _upload(client, "스캔본.pdf", _scanned_pdf())
    node_id = str(body["node"]["id"])
    assert body["node"]["file"]["problem_count"] == 0
    assert "OCR" in body["extract_error"]

    queued = _ocr_jobs(client)
    assert len(queued) == 1
    assert queued[0]["node_id"] == node_id
    assert queued[0]["total"] == 1  # 진행 단위는 **페이지**다

    final = wait_job(client, queued[0]["id"])
    assert final["status"] == "done"

    detail = client.get(f"/api/files/{node_id}").json()
    assert [p["no"] for p in detail["problems"]] == [1, 2, 3, 4]
    assert detail["extract_error"] is None


def test_reextract_of_scanned_file_queues_ocr_again(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, ocr_autoqueue: None
) -> None:
    """재추출도 업로드와 같다 — 스캔본이면 OCR 작업이 다시 걸린다."""
    monkeypatch.setattr(ocr, "default_page_reader", lambda: _reader({}))
    node_id = str(_upload(client, "스캔본.pdf", _scanned_pdf())["node"]["id"])
    first = _ocr_jobs(client)
    assert len(first) == 1
    wait_job(client, first[0]["id"])

    response = client.post(f"/api/files/{node_id}/reextract")
    assert response.status_code == 200, response.text
    assert len(_ocr_jobs(client)) == 2


def test_normal_pdf_upload_does_not_queue_ocr(
    client: TestClient, ocr_autoqueue: None
) -> None:
    """스캔본이 아니면 이 경로를 타지 않는다(회귀 방지)."""
    payload = upload_test_pdf(client)
    assert payload["extract_error"] is None
    assert payload["node"]["file"]["problem_count"] == 22
    assert _ocr_jobs(client) == []


def test_zero_anchor_text_pdf_does_not_queue_ocr(
    client: TestClient, ocr_autoqueue: None
) -> None:
    """글자는 있는데 번호가 없는 PDF 는 스캔본이 아니다 → OCR 을 걸지 않는다."""
    doc = fitz.open()
    try:
        page = doc.new_page(width=_PAGE_W, height=_PAGE_H)
        page.insert_text((60.0, 120.0), "번호가 없는 본문 " * 40, fontsize=11)
        raw = bytes(doc.tobytes())
    finally:
        doc.close()

    body = _upload(client, "번호없음.pdf", raw)
    assert body["extract_error"].startswith("문제 번호 앵커를 찾지 못했습니다.")
    assert _ocr_jobs(client) == []


def test_ocr_job_is_not_duplicated_for_same_node(client: TestClient) -> None:
    """같은 노드에 진행 중인 OCR 작업이 있으면 새로 만들지 않는다."""
    node_id = str(_upload(client, "스캔본.pdf", _scanned_pdf())["node"]["id"])
    # 진행 중(queued) 인 작업을 직접 심는다 — 워커가 언제 도는지에 의존하지 않는다.
    with storage.transaction() as conn:
        planted = storage.insert_job(
            conn,
            job_id="planted-ocr",
            kind=jobs.JOB_KIND_OCR,
            node_id=node_id,
            node_name="스캔본.pdf",
            targets=[],
            params={},
            total=1,
        )

    body = create_job(client, kind="ocr", node_id=node_id)
    assert body["existing"] is True
    assert body["job"]["id"] == planted["id"]


def test_reextract_skips_ocr_when_one_is_already_running(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """자동 등록도 같은 규칙을 쓴다(재추출을 연타해도 작업이 늘지 않는다)."""
    node_id = str(_upload(client, "스캔본.pdf", _scanned_pdf())["node"]["id"])
    with storage.transaction() as conn:
        storage.insert_job(
            conn,
            job_id="planted-ocr",
            kind=jobs.JOB_KIND_OCR,
            node_id=node_id,
            node_name="스캔본.pdf",
            targets=[],
            params={},
            total=1,
        )

    # 업로드까지는 자동 등록을 끈 채로 두고(심어 둔 작업 하나만 남게), 여기서 켠다.
    enable_ocr_autoqueue(monkeypatch)
    assert client.post(f"/api/files/{node_id}/reextract").status_code == 200
    assert len(_ocr_jobs(client)) == 1


def test_ocr_job_runs_without_any_provider(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AI 연결이 하나도 없어도 OCR 작업은 만들어지고 끝까지 돈다.

    프로바이더 해석 자체를 터뜨려 놓고 확인한다. OCR 은 로컬 CPU 계산이라 해석을
    한 번도 하면 안 되고(하면 AI 연결이 없는 환경에서 작업이 시작조차 못 한다),
    터진 해석기가 실제로 안 불렸다는 것이 이 테스트의 내용이다.
    """
    monkeypatch.setattr(
        ocr, "default_page_reader", lambda: _reader({0: _page_lines(1)})
    )

    def _boom(requested: str, api_key: str | None) -> Any:
        raise AssertionError("OCR 작업은 프로바이더를 해석하면 안 된다")

    monkeypatch.setattr(ai_service, "resolve_provider", _boom)
    node_id = str(_upload(client, "스캔본.pdf", _scanned_pdf())["node"]["id"])

    body = create_job(client, kind="ocr", node_id=node_id)
    assert body["existing"] is False
    final = wait_job(client, body["job"]["id"])
    assert final["status"] == "done"
    assert [p["no"] for p in client.get(f"/api/files/{node_id}").json()["problems"]] == [
        1,
        2,
        3,
        4,
    ]


def test_ocr_job_events_are_page_units(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """진행 이벤트 이름은 기존과 같고, 단위만 페이지다(`unit="page"`)."""
    monkeypatch.setattr(
        ocr, "default_page_reader", lambda: _reader({0: _page_lines(1), 1: []})
    )
    node_id = str(_upload(client, "스캔본.pdf", _scanned_pdf(pages=2))["node"]["id"])

    events: list[tuple[str, dict[str, Any]]] = []

    async def collect() -> None:
        async for name, data in ocr.ocr_events(
            node_id=node_id, reader=_reader({0: _page_lines(1), 1: []})
        ):
            events.append((name, data))

    import anyio

    anyio.run(collect)

    names = [name for name, _ in events]
    assert names == ["start", "problem", "done", "problem", "done", "end"]
    start = dict(events[0][1])
    assert start == {"total": 2, "unit": ocr.UNIT_PAGE}
    assert [data["no"] for name, data in events if name == "problem"] == [1, 2]
    assert all(data["unit"] == ocr.UNIT_PAGE for _, data in events)
    end = dict(events[-1][1])
    assert end["page_count"] == 2
    assert end["problem_count"] == 4
    assert end["engine"] == ocr.ENGINE_NAME


def test_ocr_result_with_no_anchor_gets_its_own_reason(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, ocr_autoqueue: None
) -> None:
    """OCR 도 번호를 못 찾으면 사유가 "OCR 로 읽었지만 못 찾았다" 로 바뀐다.

    앞 문구("OCR 작업을 예약했습니다")가 그대로 남으면 영영 기다리는 것처럼 보인다.
    """
    monkeypatch.setattr(ocr, "default_page_reader", lambda: _reader({}))
    node_id = str(_upload(client, "스캔본.pdf", _scanned_pdf())["node"]["id"])
    job = _ocr_jobs(client)[0]
    wait_job(client, job["id"])

    detail = client.get(f"/api/files/{node_id}").json()
    assert detail["problems"] == []
    assert "OCR 로 읽었지만" in detail["extract_error"]


# --- 실물 엔진 (로컬 전용) ---------------------------------------------------
# 느리고(20쪽 33초) 실물 PDF·onnx 모델이 있어야 한다. 기본 실행에서는 건너뛴다.
#   MATH_TEACHER_OCR_REAL=1 python -m pytest tests/test_ocr.py -k real
_REAL_PDF = Path(__file__).resolve().parents[3] / "tmp" / "2027 강대X 시즌2 6회 문제.pdf"


@pytest.mark.skipif(
    os.environ.get("MATH_TEACHER_OCR_REAL") != "1" or not _REAL_PDF.is_file(),
    reason="실물 OCR 은 로컬 전용이다 (MATH_TEACHER_OCR_REAL=1 + tmp 실물 PDF 필요)",
)
def test_real_engine_extracts_29_problems_from_scanned_exam() -> None:
    """실측 고정: 강대X 스캔본 20쪽 -> 29문항(1~19, 21~30)."""
    from rapidocr_onnxruntime import RapidOCR

    # `default_page_reader` 는 conftest 가 가짜로 바꿔 둔다(그게 기본 안전장치다).
    # 여기서는 엔진을 직접 붙여 실물 경로를 그대로 태운다.
    reader = partial(ocr.read_page, engine=RapidOCR())
    raw = _REAL_PDF.read_bytes()
    doc = fitz.open(stream=raw, filetype="pdf")
    try:
        lines = {index: reader(doc[index]) for index in range(doc.page_count)}
    finally:
        doc.close()

    result = ocr.extract_with_ocr(raw, lines, render_images=False)
    assert [p.no for p in result.problems] == [*range(1, 20), *range(21, 31)]
    assert result.mode == "image"
