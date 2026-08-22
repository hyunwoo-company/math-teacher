"""0문항 사유(스캔본 / 앵커 없음)와 그 사유의 저장·조회 테스트 (AI 호출 없음).

배경: `extract_error` 는 업로드·재추출 **응답에만** 실려 토스트로 한 번 뜨고
사라졌고, 문구도 한 가지였다. 그래서 (ⓐ) 스캔본을 올린 사용자가 [문제 다시 추출]
을 반복하게 되고, (ⓑ) 파일을 다시 열면 사유를 알 수 없었다.
"""

from __future__ import annotations

import fitz
from conftest import TEST_PDF, upload_test_pdf
from fastapi.testclient import TestClient

import config
import extractor
import storage


def _scanned_like_pdf(pages: int = 3) -> bytes:
    """텍스트 레이어가 전혀 없는 PDF(스캔본 대역).

    실측한 스캔본(`풍문고 부교재.pdf` 54쪽 / `2027 강대X 시즌2 6회 문제.pdf` 20쪽)은
    페이지마다 JPEG 1장뿐이고 텍스트 총량이 **0자**다. 여기서는 그 성질(글자 0자)만
    재현한다 — 감지 근거가 글자 수이기 때문이다.
    """
    doc = fitz.open()
    try:
        for _ in range(pages):
            page = doc.new_page(width=595, height=841)
            page.draw_rect(fitz.Rect(40, 40, 555, 800), color=(0, 0, 0), width=0.5)
        data: bytes = doc.tobytes()
        return data
    finally:
        doc.close()


def _text_without_anchors_pdf() -> bytes:
    """글자는 넉넉하지만 문항 번호(`1.` `2.`)가 없는 PDF."""
    doc = fitz.open()
    try:
        page = doc.new_page(width=595, height=841)
        for index in range(12):
            page.insert_text(
                (50, 60 + index * 20), "no numbered problem here at all", fontsize=11
            )
        data: bytes = doc.tobytes()
        return data
    finally:
        doc.close()


def _upload(client: TestClient, name: str, raw: bytes) -> dict[str, object]:
    response = client.post(
        "/api/files", files={"file": (name, raw, "application/pdf")}
    )
    assert response.status_code == 201, response.text
    payload: dict[str, object] = response.json()
    return payload


def test_scanned_pdf_reason_differs_from_missing_anchor_reason(
    client: TestClient,
) -> None:
    """두 사유는 **다른 문구**다. 사용자가 해야 할 일이 다르기 때문이다."""
    scanned = _upload(client, "스캔본.pdf", _scanned_like_pdf())
    no_anchor = _upload(client, "번호없음.pdf", _text_without_anchors_pdf())

    scanned_reason = scanned["extract_error"]
    no_anchor_reason = no_anchor["extract_error"]
    assert isinstance(scanned_reason, str)
    assert isinstance(no_anchor_reason, str)
    assert scanned_reason != no_anchor_reason

    # 스캔본: 원인 + 지금 서버가 무엇을 하는지(OCR 예약) + 그래도 안 되면 할 일.
    # 예전에는 "다시 추출해도 결과는 같다" 고 안내했다. 이제 스캔본은 업로드·재추출
    # 시 OCR 작업이 자동으로 걸리므로(main._autoqueue_ocr) 그 안내가 거짓이 된다.
    assert "스캔본" in scanned_reason
    assert "OCR" in scanned_reason
    # 앵커 없음: 기존 문구를 그대로 유지한다.
    assert no_anchor_reason.startswith("문제 번호 앵커를 찾지 못했습니다.")
    assert "스캔본" not in no_anchor_reason


def test_scanned_pdf_is_registered_with_zero_problems(client: TestClient) -> None:
    """스캔본도 파일 자체는 등록된다(0문항). 판정 근거는 글자 수다."""
    payload = _upload(client, "스캔본.pdf", _scanned_like_pdf(pages=3))
    node = payload["node"]
    assert isinstance(node, dict)
    file_meta = node["file"]
    assert isinstance(file_meta, dict)
    assert file_meta["problem_count"] == 0
    assert file_meta["pages"] == 3
    # `pua_ratio` 는 분모가 0이라 0.0 이고 `mode` 도 'text' 로 떨어진다.
    # 즉 이 두 값으로는 스캔본을 알 수 없다(그래서 글자 수로 판정한다).
    assert file_meta["pua_ratio"] == 0.0
    assert file_meta["mode"] == "text"


def test_file_detail_carries_extract_error(client: TestClient) -> None:
    """`GET /api/files/{id}` 가 사유를 실어 준다(토스트가 사라진 뒤에도 보이게)."""
    payload = _upload(client, "스캔본.pdf", _scanned_like_pdf())
    node = payload["node"]
    assert isinstance(node, dict)
    node_id = node["id"]

    detail = client.get(f"/api/files/{node_id}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["problems"] == []
    assert body["extract_error"] == payload["extract_error"]
    assert "스캔본" in body["extract_error"]


def test_file_detail_extract_error_is_null_on_success(client: TestClient) -> None:
    """정상 추출된 파일은 사유가 없다(null)."""
    node_id = upload_test_pdf(client)["node"]["id"]
    body = client.get(f"/api/files/{node_id}").json()
    assert len(body["problems"]) == 22
    assert body["extract_error"] is None


def test_reextract_success_clears_stored_reason(client: TestClient) -> None:
    """재추출로 해결되면 옛 사유를 비운다.

    0문항으로 올라간 파일의 원본을 정상 시험지로 바꿔 놓고 재추출한다
    (extractor 를 고친 뒤 기존 업로드분에 반영하는 실제 흐름과 같은 경로다).
    """
    payload = _upload(client, "스캔본.pdf", _scanned_like_pdf())
    node = payload["node"]
    assert isinstance(node, dict)
    node_id = str(node["id"])
    with storage.transaction() as conn:
        stored = storage.get_file(conn, node_id)
    assert stored is not None
    assert stored["extract_error"] == payload["extract_error"]

    # 원본을 정상 시험지로 교체한다.
    (config.files_dir() / f"{node_id}.pdf").write_bytes(TEST_PDF.read_bytes())

    response = client.post(f"/api/files/{node_id}/reextract")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["extract_error"] is None
    assert len(body["problems"]) == 22

    # 응답만이 아니라 **저장된 값**도 비워져야 한다.
    with storage.transaction() as conn:
        cleared = storage.get_file(conn, node_id)
    assert cleared is not None
    assert cleared["extract_error"] is None
    assert client.get(f"/api/files/{node_id}").json()["extract_error"] is None


def test_reextract_keeps_reason_when_still_zero(client: TestClient) -> None:
    """다시 추출해도 스캔본이면 사유가 그대로 남는다(문구가 약속한 대로)."""
    payload = _upload(client, "스캔본.pdf", _scanned_like_pdf())
    node = payload["node"]
    assert isinstance(node, dict)
    node_id = node["id"]

    body = client.post(f"/api/files/{node_id}/reextract").json()
    assert body["extract_error"] == payload["extract_error"]
    assert body["problems"] == []
    assert client.get(f"/api/files/{node_id}").json()["extract_error"] == (
        payload["extract_error"]
    )


def test_broken_pdf_reason_is_not_the_scanned_one(client: TestClient) -> None:
    """PDF 자체를 열 수 없는 실패는 스캔본 사유로 뭉개지 않는다."""
    response = client.post(
        "/api/files",
        files={"file": ("깨진파일.pdf", b"%PDF-1.7\nnot a pdf", "application/pdf")},
    )
    assert response.status_code == 201
    reason = response.json()["extract_error"]
    assert reason.startswith("문제 추출에 실패했습니다:")
    assert "스캔본" not in reason


def test_scanned_threshold_constant_matches_docs() -> None:
    """임계(페이지당 50자)는 docs/scanned-pdf-extraction.md 3-1 절 그대로다."""
    assert extractor.SCANNED_MAX_CHARS_PER_PAGE == 50
