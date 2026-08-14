"""문서 내보내기 엔드포인트 테스트 (시험지/변형/오답노트 x docx/hwpx).

- 6개 라우트가 200 과 올바른 media type 을 준다.
- `.docx` 는 ZIP 시그니처 `PK`, `.hwpx` 는 ZIP 안 `mimetype == application/hwp+zip`.
- `.hwpx` 안에 `BinData/` 이미지가 문항 수만큼 있다.
- `include=full` 이 `include=problems` 보다 크다(해설이 실제로 들어갔다).
- 내보낼 것이 없으면 400 + 한국어 메시지.
- Content-Disposition 의 한글 파일명이 RFC5987 로 인코딩된다.
- 접속 비밀번호가 설정된 상태에서 `?access=` 로 `.hwpx` 가 200 (미들웨어 회귀 방지).
"""

from __future__ import annotations

import io
import zipfile
from urllib.parse import quote

import pytest
from conftest import make_note, upload_test_pdf
from fastapi.testclient import TestClient

import config
import storage

DOCX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)
HWPX_MEDIA_TYPE = "application/hwp+zip"

# 테스트 PDF 의 추출 문항 수.
PROBLEM_COUNT = 22

SOLUTION_TEXT = """## 문제 확인
이 문항은 이차함수의 최댓값을 묻습니다.

## 풀이
꼭짓점 $\\left(1, 4\\right)$ 에서 최댓값을 갖습니다.

## 정답
$4$
"""

VARIANT_TEXT = """## 문제
곡선 $y = x^2$ 위의 점 P 에 대하여 넓이를 구하시오. [3점]

## 정답
$12$

## 풀이
1단계: 접선의 기울기를 $\\frac{dy}{dx}$ 로 봅니다.
2단계: 넓이를 계산합니다.
"""

# 모델이 프롬프트 지시를 어기고 `## 검산` 을 낸 응답. 내보내기에서 걸러져야 한다.
SOLUTION_WITH_VERIFY = """## 문제 확인
이 문항은 이차함수의 최댓값을 묻습니다.

## 풀이
꼭짓점 $\\left(1, 4\\right)$ 에서 최댓값을 갖습니다.

## 검산
구한 값을 원식에 도로 넣으면 성립합니다.

## 정답
$4$
"""

VARIANT_TEXT_WITH_VERIFY = """## 문제
곡선 $y = x^2$ 위의 점 P 에 대하여 넓이를 구하시오. [3점]

## 정답
$12$

## 검산
구한 값을 원식에 도로 넣으면 성립합니다.

## 풀이
1단계: 접선의 기울기를 봅니다.
"""


def _save_solution(
    client: TestClient, node_id: str, no: int, text: str = SOLUTION_TEXT
) -> None:
    response = client.post(
        f"/api/files/{node_id}/problems/{no}/solution",
        json={"content": text},
    )
    assert response.status_code == 200, response.text


def _save_variant(node_id: str, no: int, mode: str, text: str = VARIANT_TEXT) -> None:
    """작업 큐를 거치지 않고 변형을 직접 저장한다(내보내기만 검증하므로)."""
    with storage.transaction() as conn:
        storage.upsert_variant(conn, node_id=node_id, no=no, mode=mode, text=text)


def _bin_data_names(content: bytes) -> list[str]:
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        return [name for name in archive.namelist() if name.startswith("BinData/")]


def _section_text(content: bytes) -> str:
    """hwpx 본문(`Contents/section*`)을 하나의 문자열로 이어 붙인다."""
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        return b"".join(
            archive.read(name)
            for name in archive.namelist()
            if name.startswith("Contents/section")
        ).decode("utf-8")


def _mimetype(content: bytes) -> bytes:
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        return archive.read("mimetype")


# ------------------------------------------------------------------ 시험지
def test_exam_docx_contains_all_problem_images(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]

    response = client.get(f"/api/files/{node_id}/export.docx")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith(DOCX_MEDIA_TYPE)
    assert response.content[:2] == b"PK"

    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        media = [n for n in archive.namelist() if n.startswith("word/media/")]
    assert len(media) == PROBLEM_COUNT


def test_exam_hwpx_is_hwp_zip_with_all_images(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]

    response = client.get(f"/api/files/{node_id}/export.hwpx")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith(HWPX_MEDIA_TYPE)
    assert response.content[:2] == b"PK"
    assert _mimetype(response.content) == b"application/hwp+zip"
    assert len(_bin_data_names(response.content)) == PROBLEM_COUNT


def test_exam_full_is_larger_than_problems_only(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    for no in (1, 2, 3):
        _save_solution(client, node_id, no)

    for suffix in ("docx", "hwpx"):
        problems = client.get(f"/api/files/{node_id}/export.{suffix}")
        full = client.get(
            f"/api/files/{node_id}/export.{suffix}", params={"include": "full"}
        )
        assert problems.status_code == 200
        assert full.status_code == 200
        assert len(full.content) > len(problems.content), suffix


def test_exam_full_hwpx_contains_solution_text(client: TestClient) -> None:
    """풀이가 평문(유니코드)으로 들어간다. `## 문제 확인` 은 빠진다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _save_solution(client, node_id, 1)

    response = client.get(
        f"/api/files/{node_id}/export.hwpx", params={"include": "full"}
    )
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        body = b"".join(
            archive.read(name)
            for name in archive.namelist()
            if name.startswith("Contents/section")
        ).decode("utf-8")
    assert "꼭짓점 (1, 4) 에서 최댓값을 갖습니다." in body
    assert "문제 확인" not in body
    # LaTeX 구분자가 그대로 남지 않는다.
    assert "\\left" not in body


def test_exam_full_drops_verification_section(client: TestClient) -> None:
    """모델이 규칙을 어기고 `## 검산` 을 내도 문서에는 넣지 않는다(요청 4)."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _save_solution(client, node_id, 1, SOLUTION_WITH_VERIFY)

    response = client.get(
        f"/api/files/{node_id}/export.hwpx", params={"include": "full"}
    )
    assert response.status_code == 200
    body = _section_text(response.content)
    assert "꼭짓점 (1, 4) 에서 최댓값을 갖습니다." in body
    assert "검산" not in body
    assert "도로 넣으면 성립합니다" not in body


def test_exam_filename_is_rfc5987_encoded(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]

    problems = client.get(f"/api/files/{node_id}/export.docx")
    disposition = problems.headers["content-disposition"]
    assert disposition.startswith("attachment; filename*=UTF-8''")
    assert disposition.endswith(quote("_문제.docx", safe=""))

    full = client.get(
        f"/api/files/{node_id}/export.hwpx", params={"include": "full"}
    )
    assert full.headers["content-disposition"].endswith(
        quote("_문제와해설.hwpx", safe="")
    )


def test_exam_no_problems_400(client: TestClient) -> None:
    node_id = client.post(
        "/api/files",
        files={"file": ("깨진파일.pdf", b"%PDF-1.7\nnot a pdf", "application/pdf")},
    ).json()["node"]["id"]

    for suffix in ("docx", "hwpx"):
        result = client.get(f"/api/files/{node_id}/export.{suffix}")
        assert result.status_code == 400
        assert result.json()["error_code"] == "no_problems"
        assert "문항" in result.json()["message"]


def test_exam_unknown_file_404(client: TestClient) -> None:
    assert client.get("/api/files/does-not-exist/export.docx").status_code == 404
    assert client.get("/api/files/does-not-exist/export.hwpx").status_code == 404


def test_invalid_include_422(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.get(
        f"/api/files/{node_id}/export.docx", params={"include": "everything"}
    )
    assert response.status_code == 422


# -------------------------------------------------------------------- 변형
def test_variants_export_ok(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    _save_variant(node_id, 1, "number")
    _save_variant(node_id, 1, "condition")
    _save_variant(node_id, 3, "number")

    docx = client.get(f"/api/files/{node_id}/variants/export.docx")
    assert docx.status_code == 200, docx.text
    assert docx.headers["content-type"].startswith(DOCX_MEDIA_TYPE)
    assert docx.content[:2] == b"PK"
    assert docx.headers["content-disposition"].endswith(
        quote("_변형문제.docx", safe="")
    )

    hwpx = client.get(f"/api/files/{node_id}/variants/export.hwpx")
    assert hwpx.status_code == 200, hwpx.text
    assert hwpx.headers["content-type"].startswith(HWPX_MEDIA_TYPE)
    assert _mimetype(hwpx.content) == b"application/hwp+zip"
    # 변형에는 원본 크롭을 넣지 않는다.
    assert _bin_data_names(hwpx.content) == []


def test_variants_full_is_larger_and_labeled(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    _save_variant(node_id, 1, "number")

    problems = client.get(f"/api/files/{node_id}/variants/export.hwpx")
    full = client.get(
        f"/api/files/{node_id}/variants/export.hwpx", params={"include": "full"}
    )
    assert len(full.content) > len(problems.content)

    with zipfile.ZipFile(io.BytesIO(full.content)) as archive:
        body = b"".join(
            archive.read(name)
            for name in archive.namelist()
            if name.startswith("Contents/section")
        ).decode("utf-8")
    assert "1번 · 숫자 변형" in body
    assert "정답" in body
    assert "12" in body

    assert full.headers["content-disposition"].endswith(
        quote("_변형문제와해설.hwpx", safe="")
    )


def test_variants_full_drops_verification_section(client: TestClient) -> None:
    """변형 응답에 `## 검산` 이 섞여도 문서에는 넣지 않는다(요청 4)."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _save_variant(node_id, 1, "number", VARIANT_TEXT_WITH_VERIFY)

    response = client.get(
        f"/api/files/{node_id}/variants/export.hwpx", params={"include": "full"}
    )
    assert response.status_code == 200
    body = _section_text(response.content)
    assert "1단계: 접선의 기울기를 봅니다." in body
    assert "검산" not in body
    assert "도로 넣으면 성립합니다" not in body


def test_variants_no_variants_400(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    for suffix in ("docx", "hwpx"):
        result = client.get(f"/api/files/{node_id}/variants/export.{suffix}")
        assert result.status_code == 400
        assert result.json()["error_code"] == "no_variants"
        assert "변형" in result.json()["message"]


# --------------------------------------------------------------- 오답노트
def test_note_export_ok(client: TestClient) -> None:
    source_id = upload_test_pdf(client)["node"]["id"]
    note_id = make_note(client, "이현우 오답")
    added = client.post(
        f"/api/notes/{note_id}/items",
        json={
            "source_node_id": source_id,
            "problem_numbers": [1, 3],
            "memo": "계산 실수",
        },
    )
    assert added.status_code == 201, added.text

    docx = client.get(f"/api/notes/{note_id}/export.docx")
    assert docx.status_code == 200, docx.text
    assert docx.headers["content-type"].startswith(DOCX_MEDIA_TYPE)
    assert docx.content[:2] == b"PK"

    hwpx = client.get(f"/api/notes/{note_id}/export.hwpx")
    assert hwpx.status_code == 200, hwpx.text
    assert _mimetype(hwpx.content) == b"application/hwp+zip"
    # 담은 항목 수만큼 스냅샷 크롭이 들어간다.
    assert len(_bin_data_names(hwpx.content)) == 2
    assert hwpx.headers["content-disposition"].endswith(
        quote("_문제.hwpx", safe="")
    )


def test_note_full_includes_source_solution(client: TestClient) -> None:
    source_id = upload_test_pdf(client)["node"]["id"]
    _save_solution(client, source_id, 1)
    note_id = make_note(client, "이현우 오답")
    client.post(
        f"/api/notes/{note_id}/items",
        json={"source_node_id": source_id, "problem_numbers": [1]},
    )

    problems = client.get(f"/api/notes/{note_id}/export.docx")
    full = client.get(
        f"/api/notes/{note_id}/export.docx", params={"include": "full"}
    )
    assert problems.status_code == 200
    assert full.status_code == 200
    assert len(full.content) > len(problems.content)


def test_note_keeps_items_whose_source_is_deleted(client: TestClient) -> None:
    """원본 시험지가 지워져도 스냅샷 크롭으로 내보낸다(풀이만 빠진다)."""
    source_id = upload_test_pdf(client)["node"]["id"]
    _save_solution(client, source_id, 1)
    note_id = make_note(client, "이현우 오답")
    client.post(
        f"/api/notes/{note_id}/items",
        json={"source_node_id": source_id, "problem_numbers": [1]},
    )
    assert client.delete(f"/api/nodes/{source_id}").status_code == 200

    response = client.get(
        f"/api/notes/{note_id}/export.hwpx", params={"include": "full"}
    )
    assert response.status_code == 200, response.text
    assert len(_bin_data_names(response.content)) == 1


def test_note_no_items_400(client: TestClient) -> None:
    note_id = make_note(client, "빈 오답노트")
    for suffix in ("docx", "hwpx"):
        result = client.get(f"/api/notes/{note_id}/export.{suffix}")
        assert result.status_code == 400
        assert result.json()["error_code"] == "no_items"
        assert "오답노트" in result.json()["message"]


def test_note_export_rejects_exam_node(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    result = client.get(f"/api/notes/{node_id}/export.docx")
    assert result.status_code == 400
    assert result.json()["error_code"] == "not_a_note"


# ---------------------------------------------------------------- 인증
@pytest.mark.parametrize("suffix", ["docx", "hwpx"])
def test_export_allows_access_query_when_password_set(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, suffix: str
) -> None:
    """`?access=` 쿼리 인증이 `.docx`/`.hwpx` 모두에서 통한다(`_is_binary_asset`)."""
    node_id = upload_test_pdf(client)["node"]["id"]
    # 업로드 후 비밀번호를 켠다(미들웨어는 요청 시점에 env 를 읽는다).
    password = "unit-test-pw-export"
    monkeypatch.setenv(config.ACCESS_PASSWORD_ENV, password)

    path = f"/api/files/{node_id}/export.{suffix}"
    assert client.get(path).status_code == 401
    assert client.get(f"{path}?access={password}").status_code == 200
    assert client.get(path, headers={"X-Access-Password": password}).status_code == 200


def test_variants_and_note_export_allow_access_query(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """변형/오답노트 내보내기 경로도 `?access=` 로 통한다."""
    source_id = upload_test_pdf(client)["node"]["id"]
    _save_variant(source_id, 1, "number")
    note_id = make_note(client, "이현우 오답")
    client.post(
        f"/api/notes/{note_id}/items",
        json={"source_node_id": source_id, "problem_numbers": [1]},
    )

    password = "unit-test-pw-export2"
    monkeypatch.setenv(config.ACCESS_PASSWORD_ENV, password)

    for path in (
        f"/api/files/{source_id}/variants/export.hwpx",
        f"/api/notes/{note_id}/export.hwpx",
    ):
        assert client.get(path).status_code == 401
        assert client.get(f"{path}?access={password}").status_code == 200
