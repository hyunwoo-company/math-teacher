"""문서 내보내기 엔드포인트 테스트 (시험지/변형/오답노트 x docx/hwpx).

- 6개 라우트가 200 과 올바른 media type 을 준다.
- `.docx` 는 ZIP 시그니처 `PK`, `.hwpx` 는 ZIP 안 `mimetype == application/hwp+zip`.
- `.hwpx` 안에 `BinData/` 이미지가 문항 수만큼 있다.
- `include=full` 이 `include=problems` 보다 크다(해설이 실제로 들어갔다).
- `include=full` 은 해설을 **문서 끝으로 모은다**(페이지 나눔 + `정답 및 해설`).
- 내보낼 것이 없으면 400 + 한국어 메시지.
- Content-Disposition 의 한글 파일명이 RFC5987 로 인코딩된다.
- 접속 비밀번호가 설정된 상태에서 `?access=` 로 `.hwpx` 가 200 (미들웨어 회귀 방지).
"""

from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path
from urllib.parse import quote

import pytest
from conftest import make_note, upload_test_pdf
from fastapi.testclient import TestClient
from PIL import Image as PilImage

import config
import storage
from export import build as export_build
from export import docx as export_docx
from export import hwpx as export_hwpx
from export import model as export_model

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
    """풀이가 들어간다. `## 문제 확인` 은 빠진다.

    수식(`$\\left(1, 4\\right)$`)은 이제 평문이 아니라 한글 수식 개체로 나가므로
    문장이 `꼭짓점 ` + 수식 + ` 에서 ...` 로 쪼개진다(`test_math_typesetting.py`).
    """
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
    assert "꼭짓점 " in body
    assert " 에서 최댓값을 갖습니다." in body
    # 변환기가 토큰마다 넣는 공백은 한글에서 실제 간격으로 그려지므로 지운다.
    assert "<hp:script>LEFT (1,4 RIGHT )</hp:script>" in body
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
    assert "꼭짓점 " in body
    assert " 에서 최댓값을 갖습니다." in body
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


# ------------------------------------------------------------------- 출처
SOURCE_LINE = "HY EDU"


def _document_text(payload: bytes, suffix: str) -> str:
    """내보낸 문서의 본문 XML(형식별). 텍스트가 들어갔는지 확인할 때 쓴다."""
    if suffix == "hwpx":
        return _section_text(payload)
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return archive.read("word/document.xml").decode("utf-8")


def _exam_items(tmp_path: Path) -> list[export_build.ExamItem]:
    """조립만 검증할 때 쓸 문항 1개(빈 크롭 PNG)."""
    crop = tmp_path / "crop.png"
    PilImage.new("RGB", (600, 200), "white").save(crop)
    return [export_build.ExamItem(no=1, image=crop)]


def test_build_exam_doc_puts_source_in_the_footer(tmp_path: Path) -> None:
    """출처는 본문 블록이 아니라 문서 끝 한 줄(`footer`)로 들어간다."""
    doc = export_build.build_exam_doc(
        title="시험지",
        items=_exam_items(tmp_path),
        include_full=False,
        source=SOURCE_LINE,
    )
    assert doc.footer == SOURCE_LINE


def test_build_exam_doc_without_source_has_no_footer(tmp_path: Path) -> None:
    """빈 값이면 지금과 똑같은 문서가 나온다(기존 호출부 보호)."""
    items = _exam_items(tmp_path)
    default = export_build.build_exam_doc(
        title="시험지", items=items, include_full=False
    )
    blank = export_build.build_exam_doc(
        title="시험지", items=items, include_full=False, source="   "
    )
    assert default.footer is None
    assert blank.footer is None


def test_build_variants_and_note_docs_take_source(tmp_path: Path) -> None:
    """세 조립 함수가 모두 같은 방식으로 출처를 받는다."""
    variants = export_build.build_variants_doc(
        title="변형",
        items=[export_build.VariantItem(no=1, mode="number", text=VARIANT_TEXT)],
        include_full=False,
        source=SOURCE_LINE,
    )
    note = export_build.build_note_doc(
        title="오답노트",
        items=[export_build.NoteItem(source_name="풍문고", problem_no=1)],
        include_full=False,
        source=SOURCE_LINE,
    )
    assert variants.footer == SOURCE_LINE
    assert note.footer == SOURCE_LINE


def test_docx_renders_source_line() -> None:
    """docx 는 출처를 마지막 문단으로 낸다."""
    payload = export_docx.build_docx(
        export_model.ExportDoc(title="시험지", blocks=[], footer=SOURCE_LINE)
    )
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        document = archive.read("word/document.xml").decode("utf-8")
    assert SOURCE_LINE in document


def test_hwpx_renders_source_line() -> None:
    """hwpx 도 같은 한 줄을 낸다(서식은 지정하지 않는 기존 방침)."""
    payload = export_hwpx.build_hwpx(
        export_model.ExportDoc(title="시험지", blocks=[], footer=SOURCE_LINE)
    )
    assert SOURCE_LINE in _section_text(payload)


def test_docx_omits_the_footer_when_there_is_none() -> None:
    """출처가 없으면 문단이 늘지 않는다 — 지금과 완전히 같은 문서다."""
    blocks = [export_model.Text("본문")]
    without = _document_text(
        export_docx.build_docx(export_model.ExportDoc(title="시험지", blocks=blocks)),
        "docx",
    )
    with_source = _document_text(
        export_docx.build_docx(
            export_model.ExportDoc(title="시험지", blocks=blocks, footer=SOURCE_LINE)
        ),
        "docx",
    )
    assert SOURCE_LINE not in without
    assert without.count("<w:p>") + 1 == with_source.count("<w:p>")


@pytest.mark.parametrize("suffix", ["docx", "hwpx"])
def test_exam_export_route_accepts_source_query(
    client: TestClient, suffix: str
) -> None:
    """시험지 라우트가 `source` 를 받아 문서 끝까지 흘린다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.get(
        f"/api/files/{node_id}/export.{suffix}", params={"source": SOURCE_LINE}
    )
    assert response.status_code == 200, response.text
    assert SOURCE_LINE in _document_text(response.content, suffix)


@pytest.mark.parametrize("suffix", ["docx", "hwpx"])
def test_variants_and_note_export_routes_accept_source_query(
    client: TestClient, suffix: str
) -> None:
    """변형·오답노트 라우트도 같은 파라미터를 받는다(6개 라우트 전부)."""
    source_id = upload_test_pdf(client)["node"]["id"]
    _save_variant(source_id, 1, "number")
    note_id = make_note(client, "이현우 오답")
    client.post(
        f"/api/notes/{note_id}/items",
        json={"source_node_id": source_id, "problem_numbers": [1]},
    )

    for path in (
        f"/api/files/{source_id}/variants/export.{suffix}",
        f"/api/notes/{note_id}/export.{suffix}",
    ):
        response = client.get(path, params={"source": SOURCE_LINE})
        assert response.status_code == 200, response.text
        assert SOURCE_LINE in _document_text(response.content, suffix), path


def test_export_source_is_squeezed_and_blank_is_dropped(client: TestClient) -> None:
    """개행·연속 공백은 한 칸으로 접고, 공백뿐이면 출처가 없는 것으로 본다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    messy = client.get(
        f"/api/files/{node_id}/export.hwpx",
        params={"source": "HY\nEDU   학원"},
    )
    assert messy.status_code == 200, messy.text
    assert "HY EDU 학원" in _section_text(messy.content)

    blank = client.get(
        f"/api/files/{node_id}/export.hwpx", params={"source": "   "}
    )
    plain = client.get(f"/api/files/{node_id}/export.hwpx")
    assert blank.status_code == 200
    # 문단 수로 비교한다 — python-hwpx 가 문단 id 를 난수로 넣어 바이트는 매번 다르다.
    assert _section_text(blank.content).count("<hp:p ") == _section_text(
        plain.content
    ).count("<hp:p ")


def test_export_source_too_long_422(client: TestClient) -> None:
    """상한 100자를 넘기면 문서를 만들지 않는다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.get(
        f"/api/files/{node_id}/export.docx", params={"source": "가" * 101}
    )
    assert response.status_code == 422


# -------------------------------------------------------- hwpx 지면(회귀)
def _hwpx_body_width(payload: bytes) -> int:
    """hwpx 본문 폭(HWPUNIT = 1/7200in). 용지 폭에서 좌우 여백을 뺀 값이다."""
    section = _section_text(payload)
    page = re.search(r'<hp:pagePr[^>]*\swidth="(\d+)"', section)
    assert page is not None, "pagePr 가 없다"
    margin = re.search(r"<hp:margin[^>]*>", section)
    assert margin is not None, "margin 이 없다"
    sides = {
        name: int(value)
        for name, value in re.findall(r'(left|right)="(\d+)"', margin.group(0))
    }
    return int(page.group(1)) - sides["left"] - sides["right"]


def _hwpx_image_widths(payload: bytes) -> list[int]:
    """hwpx 에 들어간 그림 폭들(HWPUNIT)."""
    return [
        int(width)
        for width in re.findall(r'<hp:sz\s+width="(\d+)"', _section_text(payload))
    ]


def test_hwpx_image_never_exceeds_the_body_width(tmp_path: Path) -> None:
    """넓은 크롭이 오른쪽 여백을 침범하지 않는다.

    상한이 6인치(152.4mm)로 박혀 있어 A4 본문 폭(150mm)을 2.4mm 넘고 있었다.
    지면 값을 문서에서 직접 읽어 비교하므로 상수를 바꿔도 이 관계가 유지된다.
    """
    wide = tmp_path / "wide.png"
    PilImage.new("RGB", (3000, 300), "white").save(wide)

    payload = export_hwpx.build_hwpx(
        export_model.ExportDoc(title="시험지", blocks=[export_model.Image(wide)])
    )
    widths = _hwpx_image_widths(payload)
    assert widths, "그림이 들어가지 않았다"
    assert max(widths) <= _hwpx_body_width(payload)


# ------------------------------------------------------- docx 스타일(회귀)
def _docx_styles_xml(payload: bytes) -> str:
    """생성된 docx 에서 styles.xml 을 꺼낸다."""
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return archive.read("word/styles.xml").decode("utf-8")


def _docx_style(payload: bytes, style_id: str) -> str:
    """styles.xml 에서 스타일 하나의 XML 조각을 꺼낸다."""
    styles = _docx_styles_xml(payload)
    found = re.search(
        rf'<w:style [^>]*w:styleId="{style_id}".*?</w:style>', styles, re.S
    )
    assert found is not None, f"{style_id} 스타일이 없다"
    return found.group(0)


def _docx_sect_pr(payload: bytes) -> dict[str, int]:
    """생성된 docx 의 `sectPr` 에서 용지·여백을 twip 단위로 꺼낸다."""
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        document = archive.read("word/document.xml").decode("utf-8")
    found = re.search(r"<w:sectPr.*?</w:sectPr>", document, re.S)
    assert found is not None, "sectPr 가 없다"
    values: dict[str, int] = {}
    for tag in ("pgSz", "pgMar"):
        element = re.search(rf"<w:{tag}[^>]*/?>", found.group(0))
        assert element is not None, f"{tag} 가 없다"
        for name, value in re.findall(r'w:(\w+)="(-?\d+)"', element.group(0)):
            values[name] = int(value)
    return values


def test_docx_page_is_a4_with_hwpx_margins() -> None:
    """용지는 A4 다. python-docx 기본값은 Letter(8.5x11in)라 한국 인쇄에 안 맞다.

    여백은 같은 문서의 hwpx 실측값(좌우 1.18in / 위 0.79in / 아래 0.59in)에
    맞췄다. 1440 twip = 1 인치이고, mm→twip 환산에서 1 twip 오차가 난다.
    """
    payload = export_docx.build_docx(
        export_model.ExportDoc(title="시험지", blocks=[export_model.Text("본문")])
    )
    page = _docx_sect_pr(payload)
    # A4 210x297mm = 11906 x 16838 twip.
    assert abs(page["w"] - 11906) <= 2
    assert abs(page["h"] - 16838) <= 2
    # 좌우 30mm(1701), 위 20mm(1134), 아래 15mm(850).
    assert abs(page["left"] - 1701) <= 2
    assert abs(page["right"] - 1701) <= 2
    assert abs(page["top"] - 1134) <= 2
    assert abs(page["bottom"] - 850) <= 2
    # 본문 폭이 이미지 폭 상한보다 좁으면 크롭이 여백을 넘는다.
    body_width_inches = (page["w"] - page["left"] - page["right"]) / 1440
    assert body_width_inches + 0.01 >= export_docx._MAX_IMAGE_WIDTH_INCHES


def test_docx_normal_style_has_no_paragraph_spacing() -> None:
    """문단마다 붙는 10pt 여백이 74페이지를 만들었다(hwpx 는 14페이지).

    평문을 줄 단위로 문단화하므로 문단 여백이 그대로 페이지 수가 된다.
    """
    payload = export_docx.build_docx(
        export_model.ExportDoc(title="시험지", blocks=[export_model.Text("가\n나\n다")])
    )
    normal = _docx_style(payload, "Normal")
    assert 'w:after="0"' in normal
    assert 'w:before="0"' in normal
    assert 'w:line="240"' in normal


def test_docx_uses_a_font_that_covers_math_glyphs() -> None:
    """Calibri 는 위·아래첨자와 ⇒ ∘ ∠ ⋯ ≡ ✔ 글리프가 없어 수식이 깨진다."""
    payload = export_docx.build_docx(
        export_model.ExportDoc(title="시험지", blocks=[export_model.Text("x² ⇒ a₁ ✔")])
    )
    normal = _docx_style(payload, "Normal")
    for attribute in ("w:ascii", "w:eastAsia", "w:hAnsi", "w:cs"):
        assert f'{attribute}="맑은 고딕"' in normal


def test_docx_body_font_size_matches_hwpx() -> None:
    """본문은 10pt 다. 같은 시험지의 hwpx 본문(`charPr height="1000"`)과 같다.

    글자 크기가 다르면 긴 줄이 접히는 횟수가 달라져 두 형식의 페이지 수가
    끝내 수렴하지 않는다. `w:sz` 는 half-point 단위라 10pt = 20 이다.
    """
    payload = export_docx.build_docx(
        export_model.ExportDoc(title="시험지", blocks=[export_model.Text("본문")])
    )
    normal = _docx_style(payload, "Normal")
    assert '<w:sz w:val="20"/>' in normal
    assert '<w:szCs w:val="20"/>' in normal


@pytest.mark.parametrize("style_id", ["Title", "Heading1", "Heading2", "Heading3"])
def test_docx_heading_styles_are_tight_and_use_the_body_font(style_id: str) -> None:
    """제목 스타일도 여백을 줄이고 같은 폰트를 쓰되 본문(10pt)보다 크다(설계 §3-6)."""
    payload = export_docx.build_docx(
        export_model.ExportDoc(
            title="시험지",
            blocks=[
                export_model.Heading("1번", level=2),
                export_model.Heading("풀이", level=3),
                export_model.Text("본문"),
            ],
        )
    )
    style = _docx_style(payload, style_id)
    after = re.search(r'<w:spacing[^>]*w:after="(\d+)"', style)
    assert after is not None, f"{style_id} 에 w:after 가 없다"
    assert int(after.group(1)) <= 100
    for attribute in ("w:ascii", "w:eastAsia", "w:hAnsi", "w:cs"):
        assert f'{attribute}="맑은 고딕"' in style
    size = re.search(r'<w:sz w:val="(\d+)"/>', style)
    assert size is not None, f"{style_id} 에 w:sz 가 없다"
    # 본문 10pt(=20) 보다 크고, 제목이라도 16pt(=32) 를 넘지 않는다.
    assert 20 < int(size.group(1)) <= 32


# ------------------------------------------------- 판독본 + 그림(도형) 동반 크롭
#
# 판독본은 글자와 수식만 복원하고 **그림은 복원하지 못한다.** 그래서 판독본이
# 그림을 가리키는 문항을 텍스트로만 내보내면 좌표평면 그래프·도형이 사라져
# 문제가 성립하지 않는다. 그런 문항은 크롭을 함께 실어야 한다.

# 그림을 가리키는 판독본(좌표평면 그래프 문항).
FIGURE_TRANSCRIPT = "그림과 같이 좌표평면 위의 두 점 A, B 에 대하여 값을 구하시오."
# 그림을 가리키지 않는 판독본.
PLAIN_TRANSCRIPT = "두 다항식의 합을 구하시오. [3점]"


def _crop(tmp_path: Path, name: str = "crop.png") -> Path:
    """빈 크롭 PNG 한 장."""
    path = tmp_path / name
    PilImage.new("RGB", (600, 200), "white").save(path)
    return path


def _blocks_of(doc: export_model.ExportDoc) -> list[object]:
    return list(doc.blocks)


@pytest.mark.parametrize(
    "phrase",
    [
        "그림과 같이",
        "그림에서",
        "그림의",
        "다음 그림",
        "아래 그림",
        "위 그림",
        "그래프와 같이",
        "그래프에서",
        "도형과 같이",
        "다음과 같은 그림",
    ],
)
def test_needs_figure_catches_figure_references(phrase: str) -> None:
    """도형 참조 표현이 있으면 그림이 필요하다고 본다(공백 변형에도 관대하다)."""
    assert export_build._needs_figure(f"{phrase} 값을 구하시오.")
    # 공백이 늘어나거나 문장 중간에 나와도 잡는다.
    spaced = phrase.replace(" ", "  ")
    assert export_build._needs_figure(f"좌표평면 위에 {spaced} 나타낸 도형이 있다.")


@pytest.mark.parametrize(
    "transcript",
    [
        "",
        PLAIN_TRANSCRIPT,
        "이차방정식 x^2-1=0 의 두 근의 합을 구하시오.",
        "다음 수열의 첫째항을 구하시오.",
    ],
)
def test_needs_figure_is_false_for_plain_text(transcript: str) -> None:
    """평범한 발문은 크롭을 끌어오지 않는다."""
    assert not export_build._needs_figure(transcript)


def test_text_body_keeps_the_crop_when_the_transcript_points_at_a_figure(
    tmp_path: Path,
) -> None:
    """판독본 텍스트 **다음에** 크롭 이미지가 온다(그림이 사라지지 않는다)."""
    crop = _crop(tmp_path)
    doc = export_build.build_exam_doc(
        title="시험지",
        items=[
            export_build.ExamItem(
                no=1,
                image=crop,
                transcript=FIGURE_TRANSCRIPT,
                transcript_source=storage.TRANSCRIPT_PUA,
            )
        ],
        include_full=False,
        body="text",
    )
    blocks = _blocks_of(doc)
    texts = [b for b in blocks if isinstance(b, export_model.Text)]
    images = [b for b in blocks if isinstance(b, export_model.Image)]
    assert texts and "좌표평면" in texts[0].text
    assert [b.path for b in images] == [crop]
    assert blocks.index(texts[0]) < blocks.index(images[0])
    # 텍스트로 나갔으므로 고지도 붙는다.
    assert doc.notice == export_build.NOTICE_RESTORED


def test_text_body_omits_the_crop_without_a_figure_reference(tmp_path: Path) -> None:
    """도형 참조가 없으면 예전처럼 텍스트만 나간다."""
    doc = export_build.build_exam_doc(
        title="시험지",
        items=[
            export_build.ExamItem(
                no=1,
                image=_crop(tmp_path),
                transcript=PLAIN_TRANSCRIPT,
                transcript_source=storage.TRANSCRIPT_PUA,
            )
        ],
        include_full=False,
        body="text",
    )
    blocks = _blocks_of(doc)
    assert not [b for b in blocks if isinstance(b, export_model.Image)]
    assert any(isinstance(b, export_model.Text) for b in blocks)


def test_text_body_without_a_crop_stays_text_only() -> None:
    """크롭이 없으면(`image=None`) 도형 참조가 있어도 텍스트만 낸다."""
    doc = export_build.build_exam_doc(
        title="시험지",
        items=[
            export_build.ExamItem(
                no=1,
                image=None,
                transcript=FIGURE_TRANSCRIPT,
                transcript_source=storage.TRANSCRIPT_PUA,
            )
        ],
        include_full=False,
        body="text",
    )
    blocks = _blocks_of(doc)
    assert not [b for b in blocks if isinstance(b, export_model.Image)]
    assert any(isinstance(b, export_model.Text) for b in blocks)


def test_image_body_is_unchanged_by_the_figure_rule(tmp_path: Path) -> None:
    """`body="image"`(기본) 경로는 그대로다 — 판독본을 아예 보지 않는다."""
    crop = _crop(tmp_path)
    items = [
        export_build.ExamItem(
            no=1,
            image=crop,
            transcript=FIGURE_TRANSCRIPT,
            transcript_source=storage.TRANSCRIPT_PUA,
        )
    ]
    doc = export_build.build_exam_doc(
        title="시험지", items=items, include_full=False, body="image"
    )
    blocks = _blocks_of(doc)
    assert [type(b) for b in blocks] == [export_model.Heading, export_model.Image]
    assert not [b for b in blocks if isinstance(b, export_model.Text)]
    assert doc.notice is None
    # 렌더한 본문 XML 도 판독본이 없을 때와 바이트 단위로 같다.
    bare = export_build.build_exam_doc(
        title="시험지",
        items=[export_build.ExamItem(no=1, image=crop)],
        include_full=False,
        body="image",
    )
    assert _document_text(export_docx.build_docx(doc), "docx") == _document_text(
        export_docx.build_docx(bare), "docx"
    )


def test_note_text_body_keeps_the_crop_snapshot_for_a_figure(tmp_path: Path) -> None:
    """오답노트도 같은 규칙을 쓴다(크롭 스냅샷을 함께 낸다)."""
    crop = _crop(tmp_path)
    doc = export_build.build_note_doc(
        title="오답노트",
        items=[
            export_build.NoteItem(
                source_name="풍문고",
                problem_no=1,
                image=crop,
                transcript=FIGURE_TRANSCRIPT,
                transcript_source=storage.TRANSCRIPT_PUA,
            )
        ],
        include_full=False,
        body="text",
    )
    blocks = _blocks_of(doc)
    texts = [b for b in blocks if isinstance(b, export_model.Text)]
    images = [b for b in blocks if isinstance(b, export_model.Image)]
    assert texts and images
    assert blocks.index(texts[0]) < blocks.index(images[0])


# ------------------------------------------------- 지면 번호 표기(problems.label)
# `no` 는 저장·조회용 통짜 순번이고 `label` 은 지면에 실제로 찍힌 표기다.
# 정석 계열(`기본 문제 1-1` / `유제 1-1`)처럼 구획마다 번호가 되돌아가는 교재는
# 둘이 달라서, 내보낸 문서가 `1번` 이면 원본과 대조할 수 없다.
PRINTED_LABEL = "기본 문제 1-1"


def _headings(doc: export_model.ExportDoc) -> list[str]:
    """문서의 2수준 제목(문항 제목)만."""
    return [
        block.text
        for block in doc.blocks
        if isinstance(block, export_model.Heading) and block.level == 2
    ]


@pytest.mark.parametrize("label", ["", "1", "  1  "])
def test_label_same_as_the_number_changes_nothing(tmp_path: Path, label: str) -> None:
    """표기가 없거나 `str(no)` 와 같으면 문서가 **완전히 동일**하다(회귀 방지선).

    보통 시험지는 `label == str(no)` 다. 이 경로에서 결과물이 한 글자라도
    달라지면 이미 배포한 문서와 대조가 깨지므로, 조립 결과를 통째로 비교한다.
    """
    crop = _crop(tmp_path)
    exam_bare = export_build.build_exam_doc(
        title="시험지",
        items=[export_build.ExamItem(no=1, image=crop)],
        include_full=False,
    )
    exam_labeled = export_build.build_exam_doc(
        title="시험지",
        items=[export_build.ExamItem(no=1, label=label, image=crop)],
        include_full=False,
    )
    assert exam_labeled == exam_bare

    variants_bare = export_build.build_variants_doc(
        title="변형",
        items=[export_build.VariantItem(no=1, mode="number", text=VARIANT_TEXT)],
        include_full=False,
    )
    variants_labeled = export_build.build_variants_doc(
        title="변형",
        items=[
            export_build.VariantItem(
                no=1, mode="number", text=VARIANT_TEXT, label=label
            )
        ],
        include_full=False,
    )
    assert variants_labeled == variants_bare

    note_bare = export_build.build_note_doc(
        title="오답노트",
        items=[export_build.NoteItem(source_name="풍문고", problem_no=1, image=crop)],
        include_full=False,
    )
    note_labeled = export_build.build_note_doc(
        title="오답노트",
        items=[
            export_build.NoteItem(
                source_name="풍문고", problem_no=1, label=label, image=crop
            )
        ],
        include_full=False,
    )
    assert note_labeled == note_bare


def test_exam_doc_uses_the_printed_label_without_adding_beon(tmp_path: Path) -> None:
    """표기가 다르면 제목이 그 표기이고, `번` 을 덧붙이지 않는다.

    `기본 문제 1-1번` 은 이상하다 — `번` 은 순번을 읽어 주는 조수사이고 지면
    표기는 이미 완성된 이름이다.
    """
    crop = _crop(tmp_path)
    doc = export_build.build_exam_doc(
        title="시험지",
        items=[
            export_build.ExamItem(no=1, label=PRINTED_LABEL, image=crop),
            export_build.ExamItem(no=2, label="유제 1-1", image=crop),
        ],
        include_full=False,
    )
    assert _headings(doc) == [PRINTED_LABEL, "유제 1-1"]
    assert not any(heading.endswith("번") for heading in _headings(doc))


def test_variants_doc_puts_the_printed_label_before_the_mode() -> None:
    """변형은 `{표기} · {종류}` 형태를 유지한다."""
    doc = export_build.build_variants_doc(
        title="변형",
        items=[
            export_build.VariantItem(
                no=1, mode="number", text=VARIANT_TEXT, label=PRINTED_LABEL
            )
        ],
        include_full=False,
    )
    assert _headings(doc) == [f"{PRINTED_LABEL} · 숫자 변형"]


def test_note_doc_uses_the_printed_label_snapshot(tmp_path: Path) -> None:
    """오답노트 제목은 `{시험지명} {표기}` 다(`번` 없음)."""
    crop = _crop(tmp_path)
    doc = export_build.build_note_doc(
        title="오답노트",
        items=[
            export_build.NoteItem(
                source_name="오리진1", problem_no=1, label=PRINTED_LABEL, image=crop
            )
        ],
        include_full=False,
    )
    assert _headings(doc) == [f"오리진1 {PRINTED_LABEL}"]


def _set_label(node_id: str, no: int, label: str) -> None:
    """문항의 지면 표기를 직접 바꾼다(정석 계열 교재를 흉내낸다)."""
    with storage.transaction() as conn:
        conn.execute(
            "UPDATE problems SET label = ? WHERE node_id = ? AND no = ?",
            (label, node_id, no),
        )


def test_exam_export_route_uses_the_printed_label(client: TestClient) -> None:
    """업로드 → 내보내기 경로 끝까지 지면 표기가 흐른다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_label(node_id, 3, PRINTED_LABEL)

    response = client.get(f"/api/files/{node_id}/export.docx")
    assert response.status_code == 200, response.text
    text = _document_text(response.content, "docx")
    assert PRINTED_LABEL in text
    assert f"{PRINTED_LABEL}번" not in text
    # 표기가 번호와 같은 나머지 문항은 예전 제목 그대로다.
    assert "1번" in text


def test_variants_export_route_uses_the_printed_label(client: TestClient) -> None:
    """변형은 `variants` 에 표기가 없으므로 `problems.label` 을 조회해 붙인다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_label(node_id, 2, PRINTED_LABEL)
    _save_variant(node_id, 2, "number")

    response = client.get(f"/api/files/{node_id}/variants/export.docx")
    assert response.status_code == 200, response.text
    text = _document_text(response.content, "docx")
    assert f"{PRINTED_LABEL} · 숫자 변형" in text
    assert f"{PRINTED_LABEL}번" not in text


def test_note_export_uses_the_label_snapshot_from_when_it_was_added(
    client: TestClient,
) -> None:
    """오답노트는 **담은 시점**의 표기를 쓴다.

    원본이 재추출돼 표기가 바뀌어도(여기서는 직접 갈아 끼운다) 이미 담은 항목은
    담긴 그 시점의 표기로 남아야 한다 — 크롭·판독본 스냅샷과 같은 규칙이다.
    """
    source_id = upload_test_pdf(client)["node"]["id"]
    _set_label(source_id, 3, PRINTED_LABEL)
    note_id = make_note(client, "이현우 오답")
    added = client.post(
        f"/api/notes/{note_id}/items",
        json={"source_node_id": source_id, "problem_numbers": [3]},
    )
    assert added.status_code == 201, added.text

    # 담은 뒤 원본 표기가 바뀐다(재추출 상황).
    _set_label(source_id, 3, "유제 9-9")

    response = client.get(f"/api/notes/{note_id}/export.docx")
    assert response.status_code == 200, response.text
    text = _document_text(response.content, "docx")
    assert PRINTED_LABEL in text
    assert "유제 9-9" not in text


# --------------------------------------- 해설 미주(문서 끝 해설 모음, ERR-12)
# 요구: "문항은 위에 따로 해설은 밑에 미주로 모아주기 (항상)".
# 시험지 앞장만 떼어 학생에게 나눠 줄 수 있어야 한다. 설정은 만들지 않는다 —
# `include_full=True` 면 항상 뒤로 모인다.
SOLUTION_ONLY_SKIPPED = """## 문제 확인
이 문항은 이차함수의 최댓값을 묻습니다.

## 검산
구한 값을 원식에 도로 넣으면 성립합니다.
"""

ANSWER_SECTION_HEADING = export_model.Heading("정답 및 해설", 1)


def _headings_2(blocks: list[export_model.Block]) -> list[str]:
    """블록 목록의 2수준 제목(문항 제목)만."""
    return [
        block.text
        for block in blocks
        if isinstance(block, export_model.Heading) and block.level == 2
    ]


def _split_at_page_break(
    doc: export_model.ExportDoc,
) -> tuple[list[export_model.Block], list[export_model.Block]]:
    """문서를 페이지 나눔 기준으로 (문항부, 해설부)로 자른다.

    해설부는 `정답 및 해설` 표제를 뺀 나머지다.
    """
    blocks = list(doc.blocks)
    breaks = [
        index
        for index, block in enumerate(blocks)
        if isinstance(block, export_model.PageBreak)
    ]
    assert len(breaks) == 1, f"페이지 나눔이 1개여야 한다: {breaks}"
    cut = breaks[0]
    assert blocks[cut + 1] == ANSWER_SECTION_HEADING, blocks[cut + 1]
    return blocks[:cut], blocks[cut + 2 :]


def test_problems_only_export_is_exactly_the_old_document(tmp_path: Path) -> None:
    """`include_full=False` 는 예전과 **완전히 동일**하다(회귀 방지선).

    풀이를 애초에 넣지 않으므로 나눌 것이 없다 — 페이지 나눔도 `정답 및 해설`
    표제도 생기면 안 된다. 이미 배포한 문제지와 대조가 깨지지 않게 조립 결과를
    통째로 비교한다.
    """
    crop = _crop(tmp_path)
    doc = export_build.build_exam_doc(
        title="시험지",
        items=[
            export_build.ExamItem(no=1, image=crop, solution=SOLUTION_TEXT),
            export_build.ExamItem(no=2, image=crop, solution=SOLUTION_TEXT),
        ],
        include_full=False,
    )
    assert doc == export_model.ExportDoc(
        title="시험지",
        blocks=[
            export_model.Heading("1번", 2),
            export_model.Image(crop),
            export_model.Heading("2번", 2),
            export_model.Image(crop),
        ],
        footer=None,
        notice=None,
    )


def test_full_export_puts_every_solution_behind_a_page_break(tmp_path: Path) -> None:
    """`include_full=True` 면 문항부 → 페이지 나눔 → 표제 → 해설부 순서다.

    문항부에는 풀이 소제목(3수준)이 하나도 없고, 해설부에는 크롭 이미지가 하나도
    없어야 한다 — 섞여 있으면 앞장만 떼어 나눠 줄 수 없다.
    """
    crop = _crop(tmp_path)
    doc = export_build.build_exam_doc(
        title="시험지",
        items=[
            export_build.ExamItem(no=1, image=crop, solution=SOLUTION_TEXT),
            export_build.ExamItem(no=2, image=crop, solution=SOLUTION_TEXT),
        ],
        include_full=True,
    )
    problems, answers = _split_at_page_break(doc)

    assert problems == [
        export_model.Heading("1번", 2),
        export_model.Image(crop),
        export_model.Heading("2번", 2),
        export_model.Image(crop),
    ]
    assert not any(
        isinstance(block, export_model.Heading) and block.level == 3 for block in problems
    )
    assert not any(isinstance(block, export_model.Image) for block in answers)
    assert _headings_2(answers) == ["1번", "2번"]
    # 해설부 안 구성은 예전 그대로다(문항 제목 아래 3수준 소제목).
    assert [
        block.text for block in answers if isinstance(block, export_model.Heading)
    ] == ["1번", "풀이", "정답", "2번", "풀이", "정답"]


def test_answer_section_lists_only_items_that_have_a_solution(tmp_path: Path) -> None:
    """풀이가 없는 문항은 해설부에 **제목조차 나오지 않는다**.

    제목만 남기면 해설이 있는 척하는 빈 항목이 되어, 학생이 빠진 것을 찾는다.
    문항부에는 세 문항이 그대로 다 있어야 한다.
    """
    crop = _crop(tmp_path)
    doc = export_build.build_exam_doc(
        title="시험지",
        items=[
            export_build.ExamItem(no=1, image=crop),
            export_build.ExamItem(no=2, image=crop, solution=SOLUTION_TEXT),
            # 섹션이 전부 `_SKIPPED_SECTIONS` 라 넣을 블록이 남지 않는 풀이.
            export_build.ExamItem(no=3, image=crop, solution=SOLUTION_ONLY_SKIPPED),
        ],
        include_full=True,
    )
    problems, answers = _split_at_page_break(doc)

    assert _headings_2(problems) == ["1번", "2번", "3번"]
    assert _headings_2(answers) == ["2번"]


def test_full_export_without_any_solution_has_no_answer_section(tmp_path: Path) -> None:
    """풀이가 하나도 없으면 페이지 나눔도 표제도 없다(빈 페이지 방지).

    결과가 `include_full=False` 와 **완전히 같아야** 한다.
    """
    crop = _crop(tmp_path)
    items = [export_build.ExamItem(no=1, image=crop)]
    full = export_build.build_exam_doc(title="시험지", items=items, include_full=True)
    problems_only = export_build.build_exam_doc(
        title="시험지", items=items, include_full=False
    )
    assert full == problems_only
    assert not any(isinstance(block, export_model.PageBreak) for block in full.blocks)
    assert ANSWER_SECTION_HEADING not in list(full.blocks)


def test_answer_heading_matches_the_problem_heading(tmp_path: Path) -> None:
    """지면 표기가 다른 문항도 문항부와 해설부의 제목이 **같다**.

    둘이 어긋나면 뒷장에서 해당 문항을 찾을 수 없다.
    """
    crop = _crop(tmp_path)
    doc = export_build.build_exam_doc(
        title="시험지",
        items=[
            export_build.ExamItem(
                no=1, label=PRINTED_LABEL, image=crop, solution=SOLUTION_TEXT
            )
        ],
        include_full=True,
    )
    problems, answers = _split_at_page_break(doc)
    assert _headings_2(problems) == [PRINTED_LABEL]
    assert _headings_2(answers) == [PRINTED_LABEL]


def test_variants_and_note_docs_keep_solutions_inline(tmp_path: Path) -> None:
    """변형·오답노트는 **바뀌지 않는다** — 해설이 문항 옆에 그대로 있다.

    오답노트는 틀린 문제를 바로 다시 보는 용도라 해설이 옆에 있어야 하고,
    변형은 이번 요구 범위가 아니다.
    """
    crop = _crop(tmp_path)
    variants = export_build.build_variants_doc(
        title="변형",
        items=[export_build.VariantItem(no=1, mode="number", text=VARIANT_TEXT)],
        include_full=True,
    )
    note = export_build.build_note_doc(
        title="오답노트",
        items=[
            export_build.NoteItem(
                source_name="풍문고",
                problem_no=1,
                image=crop,
                solution=SOLUTION_TEXT,
            )
        ],
        include_full=True,
    )
    for doc in (variants, note):
        assert not any(isinstance(block, export_model.PageBreak) for block in doc.blocks)
        assert ANSWER_SECTION_HEADING not in list(doc.blocks)
    # 오답노트는 문항 제목 → 크롭 → 풀이 소제목이 이어진다(예전 구성).
    assert [type(block).__name__ for block in note.blocks][:3] == [
        "Heading",
        "Image",
        "Heading",
    ]


PAGE_BREAK_DOC = export_model.ExportDoc(
    title="시험지",
    blocks=[
        export_model.Text("문항부"),
        export_model.PageBreak(),
        export_model.Heading("정답 및 해설", 1),
        export_model.Text("해설부"),
    ],
)


def test_docx_renders_a_hard_page_break() -> None:
    """docx 는 워드 네이티브 페이지 나눔(`w:br w:type="page"`)으로 지면을 끊는다."""
    payload = export_docx.build_docx(PAGE_BREAK_DOC)
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        document = archive.read("word/document.xml").decode("utf-8")
    assert '<w:br w:type="page"/>' in document
    assert document.count('w:type="page"') == 1


def test_hwpx_renders_a_hard_page_break() -> None:
    """hwpx 는 문단 속성(`hp:p/@pageBreak="1"`)으로 지면을 끊는다.

    한글이 없는 환경이라 렌더는 못 보지만 저장된 XML 은 확인할 수 있다. 보통
    문단은 모두 `pageBreak="0"` 으로 나가므로 `1` 이 유의미한 값이다.
    """
    payload = export_hwpx.build_hwpx(PAGE_BREAK_DOC)
    section = _section_text(payload)
    assert 'pageBreak="1"' in section
    assert section.count('pageBreak="1"') == 1
