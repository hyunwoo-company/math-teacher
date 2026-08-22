"""문서 내보내기 엔드포인트 테스트 (시험지/변형/오답노트 x docx/hwpx).

- 6개 라우트가 200 과 올바른 media type 을 준다.
- `.docx` 는 ZIP 시그니처 `PK`, `.hwpx` 는 ZIP 안 `mimetype == application/hwp+zip`.
- `.hwpx` 안에 `BinData/` 이미지가 문항 수만큼 있다.
- `include=full` 이 `include=problems` 보다 크다(해설이 실제로 들어갔다).
- `include=full` 은 해설을 **문서 끝으로 모은다**(페이지 나눔 + `정답 및 해설`).
  시험지·변형·오답노트 셋 다 같다(오답노트 메모만 문항부에 남는다).
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
from docx.shared import Mm, Pt
from fastapi.testclient import TestClient
from PIL import Image as PilImage

import config
import storage
from export import build as export_build
from export import docx as export_docx
from export import hwpx as export_hwpx
from export import layout as export_layout
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
    """`include_full=False` 의 **블록 목록**은 예전과 완전히 동일하다(회귀 방지선).

    풀이를 애초에 넣지 않으므로 나눌 것이 없다 — 페이지 나눔도 `정답 및 해설`
    표제도 생기면 안 된다. 이미 배포한 문제지와 대조가 깨지지 않게 조립 결과를
    통째로 비교한다.

    2단 조판(`two_column=True`)만 새로 붙는다. 문항 내용이 아니라 지면에 앉히는
    방식이므로 블록에는 영향이 없다.
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
        two_column=True,
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


# --------------------------------- 해설 미주: 변형·오답노트에도 같은 규칙 적용
# 요구: "해설을 문서 끝으로 모으는 것을 변형·오답노트에도 적용". 시험지와 똑같이
# `include_full=True` 면 항상 뒤로 모인다 — 설정은 만들지 않는다.

# 수식이 없는 변형 응답. 조립 결과를 통째로 비교할 때 쓴다(수식이 있으면
# `Text.lines` 를 손으로 적어야 해서 회귀 방지선이 흐려진다).
VARIANT_TEXT_PLAIN = """## 문제
넓이를 구하시오.

## 정답
12

## 풀이
1단계: 계산한다.
"""

# `## 문제` 만 있는 변형 응답. 해설부에 넣을 것이 하나도 없는 경우다.
VARIANT_TEXT_PROBLEM_ONLY = """## 문제
넓이를 구하시오.
"""

MEMO = "계산 실수"


def _headings_3(blocks: list[export_model.Block]) -> list[str]:
    """블록 목록의 3수준 제목(풀이 소제목)만."""
    return [
        block.text
        for block in blocks
        if isinstance(block, export_model.Heading) and block.level == 3
    ]


def _texts(blocks: list[export_model.Block]) -> list[export_model.Text]:
    """블록 목록의 본문 블록만."""
    return [block for block in blocks if isinstance(block, export_model.Text)]


def test_variants_problems_only_export_is_exactly_the_old_document() -> None:
    """변형 `include_full=False` 의 **블록 목록**은 예전과 완전히 동일하다.

    정답·풀이를 애초에 넣지 않으므로 나눌 것이 없다 — 페이지 나눔도 표제도
    생기면 안 된다. 2단 조판(`two_column=True`)만 새로 붙는다.
    """
    doc = export_build.build_variants_doc(
        title="변형",
        items=[
            export_build.VariantItem(no=1, mode="number", text=VARIANT_TEXT_PLAIN),
            export_build.VariantItem(no=2, mode="condition", text=VARIANT_TEXT_PLAIN),
        ],
        include_full=False,
    )
    assert doc == export_model.ExportDoc(
        title="변형",
        blocks=[
            export_model.Heading("1번 · 숫자 변형", 2),
            export_model.Text("넓이를 구하시오."),
            export_model.Heading("2번 · 조건 변형", 2),
            export_model.Text("넓이를 구하시오."),
        ],
        footer=None,
        notice=None,
        two_column=True,
    )


def test_variants_full_export_puts_every_answer_behind_a_page_break() -> None:
    """변형도 문항부 → 페이지 나눔 → 표제 → 해설부 순서다.

    문항부에는 3수준 제목(`정답`/`풀이`)이 **0개**여야 하고, 해설부에는 문제
    본문이 **없어야** 한다 — 섞여 있으면 앞장만 떼어 배포할 수 없다.
    """
    doc = export_build.build_variants_doc(
        title="변형",
        items=[
            export_build.VariantItem(no=1, mode="number", text=VARIANT_TEXT),
            export_build.VariantItem(no=2, mode="condition", text=VARIANT_TEXT),
        ],
        include_full=True,
    )
    problems, answers = _split_at_page_break(doc)

    assert _headings_2(problems) == ["1번 · 숫자 변형", "2번 · 조건 변형"]
    assert _headings_3(problems) == []
    # `## 문제` 는 소제목 없이 본문만 들어간다(기존 규칙).
    problem_bodies = _texts(problems)
    assert len(problem_bodies) == 2
    for body in problem_bodies:
        assert body not in answers
    assert _headings_2(answers) == ["1번 · 숫자 변형", "2번 · 조건 변형"]
    assert [
        block.text for block in answers if isinstance(block, export_model.Heading)
    ] == [
        "1번 · 숫자 변형",
        "정답",
        "풀이",
        "2번 · 조건 변형",
        "정답",
        "풀이",
    ]


def test_variants_answer_heading_matches_the_problem_heading() -> None:
    """지면 표기가 다른 변형도 문항부와 해설부의 제목이 **같다**."""
    doc = export_build.build_variants_doc(
        title="변형",
        items=[
            export_build.VariantItem(
                no=1, mode="number_condition", text=VARIANT_TEXT, label=PRINTED_LABEL
            )
        ],
        include_full=True,
    )
    problems, answers = _split_at_page_break(doc)
    expected = f"{PRINTED_LABEL} · 숫자·조건 변형"
    assert _headings_2(problems) == [expected]
    assert _headings_2(answers) == [expected]


def test_variants_answer_section_skips_combinations_without_anything_to_show() -> None:
    """`## 문제` 외에 넣을 섹션이 없는 조합은 해설부에 나오지 않는다.

    `## 검산` 만 남은 조합도 같다(`_SKIPPED_SECTIONS` 는 해설부에도 적용된다).
    """
    doc = export_build.build_variants_doc(
        title="변형",
        items=[
            export_build.VariantItem(
                no=1, mode="number", text=VARIANT_TEXT_PROBLEM_ONLY
            ),
            export_build.VariantItem(no=2, mode="number", text=VARIANT_TEXT_PLAIN),
        ],
        include_full=True,
    )
    problems, answers = _split_at_page_break(doc)
    assert _headings_2(problems) == ["1번 · 숫자 변형", "2번 · 숫자 변형"]
    assert _headings_2(answers) == ["2번 · 숫자 변형"]


def test_variants_full_export_without_any_answer_has_no_answer_section() -> None:
    """넣을 해설이 하나도 없으면 페이지 나눔도 표제도 없다(빈 페이지 방지).

    결과가 `include_full=False` 와 **완전히 같아야** 한다.
    """
    items = [
        export_build.VariantItem(no=1, mode="number", text=VARIANT_TEXT_PROBLEM_ONLY)
    ]
    full = export_build.build_variants_doc(
        title="변형", items=items, include_full=True
    )
    problems_only = export_build.build_variants_doc(
        title="변형", items=items, include_full=False
    )
    assert full == problems_only
    assert not any(isinstance(block, export_model.PageBreak) for block in full.blocks)
    assert ANSWER_SECTION_HEADING not in list(full.blocks)


def test_note_problems_only_export_is_exactly_the_old_document(tmp_path: Path) -> None:
    """오답노트 `include_full=False` 는 예전과 **완전히 동일**하다(회귀 방지선)."""
    crop = _crop(tmp_path)
    doc = export_build.build_note_doc(
        title="오답노트",
        items=[
            export_build.NoteItem(
                source_name="풍문고",
                problem_no=1,
                image=crop,
                memo=MEMO,
                solution=SOLUTION_TEXT,
            ),
            export_build.NoteItem(
                source_name="풍문고",
                problem_no=2,
                image=crop,
                solution=SOLUTION_TEXT,
            ),
        ],
        include_full=False,
    )
    assert doc == export_model.ExportDoc(
        title="오답노트",
        blocks=[
            export_model.Heading("풍문고 1번", 2),
            export_model.Image(crop),
            export_model.Text(f"메모: {MEMO}"),
            export_model.Heading("풍문고 2번", 2),
            export_model.Image(crop),
        ],
        footer=None,
        notice=None,
    )


def test_note_full_export_keeps_the_memo_with_the_problem(tmp_path: Path) -> None:
    """메모는 **문항부에 남는다** — 해설부에 넘어가지 않는다.

    메모는 "이 문제를 왜 담았나" 를 적은 것이라 문항 옆에 있어야 한다. 해설이
    아니므로 뒤로 모으는 대상이 아니다.
    """
    crop = _crop(tmp_path)
    doc = export_build.build_note_doc(
        title="오답노트",
        items=[
            export_build.NoteItem(
                source_name="풍문고",
                problem_no=1,
                label=PRINTED_LABEL,
                image=crop,
                memo=MEMO,
                solution=SOLUTION_TEXT,
            )
        ],
        include_full=True,
    )
    problems, answers = _split_at_page_break(doc)

    assert problems == [
        export_model.Heading(f"풍문고 {PRINTED_LABEL}", 2),
        export_model.Image(crop),
        export_model.Text(f"메모: {MEMO}"),
    ]
    assert _headings_3(problems) == []
    assert not any(MEMO in block.text for block in _texts(answers))
    assert not any(isinstance(block, export_model.Image) for block in answers)
    # 해설부 제목은 문항부와 같은 문자열이다(지면 표기 스냅샷 포함).
    assert _headings_2(answers) == [f"풍문고 {PRINTED_LABEL}"]
    assert _headings_3(answers) == ["풀이", "정답"]


def test_note_answer_section_lists_only_items_that_have_a_solution(
    tmp_path: Path,
) -> None:
    """풀이가 있는 항목만 해설부에 나온다(원본이 지워진 항목은 풀이가 없다)."""
    crop = _crop(tmp_path)
    doc = export_build.build_note_doc(
        title="오답노트",
        items=[
            export_build.NoteItem(source_name="풍문고", problem_no=1, image=crop),
            export_build.NoteItem(
                source_name="풍문고",
                problem_no=2,
                image=crop,
                solution=SOLUTION_TEXT,
            ),
            # 섹션이 전부 `_SKIPPED_SECTIONS` 라 넣을 블록이 남지 않는 풀이.
            export_build.NoteItem(
                source_name="풍문고",
                problem_no=3,
                image=crop,
                solution=SOLUTION_ONLY_SKIPPED,
            ),
        ],
        include_full=True,
    )
    problems, answers = _split_at_page_break(doc)
    assert _headings_2(problems) == ["풍문고 1번", "풍문고 2번", "풍문고 3번"]
    assert _headings_2(answers) == ["풍문고 2번"]


def test_note_full_export_without_any_solution_has_no_answer_section(
    tmp_path: Path,
) -> None:
    """풀이가 하나도 없으면 페이지 나눔도 표제도 없다(빈 페이지 방지)."""
    crop = _crop(tmp_path)
    items = [
        export_build.NoteItem(
            source_name="풍문고", problem_no=1, image=crop, memo=MEMO
        )
    ]
    full = export_build.build_note_doc(
        title="오답노트", items=items, include_full=True
    )
    problems_only = export_build.build_note_doc(
        title="오답노트", items=items, include_full=False
    )
    assert full == problems_only
    assert not any(isinstance(block, export_model.PageBreak) for block in full.blocks)
    assert ANSWER_SECTION_HEADING not in list(full.blocks)


def test_variants_and_note_page_breaks_reach_both_renderers(tmp_path: Path) -> None:
    """변형·오답노트의 페이지 나눔이 docx·hwpx XML 에 실제로 들어간다.

    조립만 맞고 렌더러에서 사라지면 종이에서는 앞장/뒷장이 갈리지 않는다.
    """
    crop = _crop(tmp_path)
    docs = [
        export_build.build_variants_doc(
            title="변형",
            items=[
                export_build.VariantItem(no=1, mode="number", text=VARIANT_TEXT_PLAIN)
            ],
            include_full=True,
        ),
        export_build.build_note_doc(
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
        ),
    ]
    for doc in docs:
        payload = export_docx.build_docx(doc)
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            document = archive.read("word/document.xml").decode("utf-8")
        assert '<w:br w:type="page"/>' in document
        assert document.count('w:type="page"') == 1

        section = _section_text(export_hwpx.build_hwpx(doc))
        assert 'pageBreak="1"' in section
        assert section.count('pageBreak="1"') == 1


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


# --------------------------------------------------- 2단 조판(시험지·변형)
# 시험지·변형은 종이 시험지처럼 좌우 2단으로 나가고, 오답노트만 1단이다.
# 설정도 쿼리 파라미터도 없다(사용자 결정).

# 문항 두 개짜리 최소 문서. 1번은 문단 3개(제목+본문 2줄), 2번은 2개다 —
# 문항 안의 "중간 문단" 과 "마지막 문단" 이 다르게 취급되는지 보려면 둘이 필요하다.
TWO_COLUMN_BLOCKS: list[export_model.Block] = [
    export_model.Heading("1번", 2),
    export_model.Text("가\n나"),
    export_model.Heading("2번", 2),
    export_model.Text("다"),
]
TWO_COLUMN_DOC = export_model.ExportDoc(
    title="시험지", blocks=TWO_COLUMN_BLOCKS, two_column=True
)
ONE_COLUMN_DOC = export_model.ExportDoc(title="오답노트", blocks=TWO_COLUMN_BLOCKS)


def _docx_document_xml(payload: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return archive.read("word/document.xml").decode("utf-8")


def _docx_sect_prs(payload: bytes) -> list[str]:
    """문서의 `sectPr` 조각들(구역 순서 그대로).

    2단 문서는 전폭/2단이 갈리는 자리마다 연속 구역을 만들므로 여러 개가 나온다.
    마지막 구역만 `w:body` 직속이고, 나머지는 그 구역 **마지막 문단**의 `w:pPr`
    안에 있다(ECMA-376 의 정식 표현).
    """
    return re.findall(r"<w:sectPr\b.*?</w:sectPr>", _docx_document_xml(payload), re.S)


def _docx_cols(payload: bytes) -> list[dict[str, str]]:
    """구역마다의 `w:cols` 속성. `w:num` 이 없으면 1단이므로 `"1"` 로 채운다."""
    cols: list[dict[str, str]] = []
    for sect_pr in _docx_sect_prs(payload):
        found = re.search(r"<w:cols[^>]*/?>", sect_pr)
        assert found is not None, "w:cols 가 없다"
        attributes = dict(re.findall(r'w:(\w+)="([^"]*)"', found.group(0)))
        cols.append({"num": "1", **attributes})
    return cols


def _docx_section_paragraphs(payload: bytes) -> list[list[str]]:
    """구역마다의 문단 텍스트. 구역 속성을 실은 문단이 그 구역의 마지막이다."""
    sections: list[list[str]] = [[]]
    for paragraph in re.findall(r"<w:p\b.*?</w:p>", _docx_document_xml(payload), re.S):
        sections[-1].append("".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", paragraph)))
        if "<w:sectPr" in paragraph:
            sections.append([])
    return sections


def _docx_paragraph_props(payload: bytes) -> list[str]:
    """문단마다의 `w:pPr` 조각(없으면 빈 문자열). 본문 문단 순서 그대로다."""
    props: list[str] = []
    for paragraph in re.findall(r"<w:p\b.*?</w:p>", _docx_document_xml(payload), re.S):
        found = re.search(r"<w:pPr>.*?</w:pPr>", paragraph, re.S)
        props.append(found.group(0) if found is not None else "")
    return props


def _hwpx_part(payload: bytes, name: str) -> str:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return archive.read(name).decode("utf-8")


def _hwpx_columns(payload: bytes) -> list[dict[str, str]]:
    """본문에 실린 단 정의(`hp:colPr`)들. 새 문서 템플릿에 1단짜리가 하나 있다."""
    return [
        dict(re.findall(r'(\w+)="([^"]*)"', found))
        for found in re.findall(r"<hp:colPr[^>]*>", _section_text(payload))
    ]


def _hwpx_para_pr_refs(payload: bytes) -> list[str]:
    """본문 문단들이 가리키는 문단 서식 id(문단 순서 그대로)."""
    return re.findall(r'<hp:p [^>]*paraPrIDRef="(\d+)"', _section_text(payload))


def _hwpx_break_settings(payload: bytes) -> list[dict[str, str]]:
    """문단마다의 `hh:breakSetting` 속성(문단 서식 참조를 header 에서 되짚는다)."""
    header = _hwpx_part(payload, "Contents/header.xml")
    settings: dict[str, dict[str, str]] = {}
    for para_pr in re.findall(r"<hh:paraPr\b.*?</hh:paraPr>", header, re.S):
        # `\s` 가 없으면 `snapToGrid="1"` 의 뒤쪽(`id="1"`)에 걸린다.
        para_pr_id = re.search(r'\sid="(\d+)"', para_pr)
        break_setting = re.search(r"<hh:breakSetting[^>]*/>", para_pr)
        if para_pr_id is None or break_setting is None:
            continue
        settings[para_pr_id.group(1)] = dict(
            re.findall(r'(\w+)="([^"]*)"', break_setting.group(0))
        )
    return [settings[ref] for ref in _hwpx_para_pr_refs(payload)]


def _hwpx_space_before(payload: bytes) -> list[int]:
    """문단마다의 위 여백(HWPUNIT). 문항 사이 간격이 첫 문단에만 붙는지 본다."""
    header = _hwpx_part(payload, "Contents/header.xml")
    margins: dict[str, int] = {}
    for para_pr in re.findall(r"<hh:paraPr\b.*?</hh:paraPr>", header, re.S):
        # `\s` 가 없으면 `snapToGrid="1"` 의 뒤쪽(`id="1"`)에 걸린다.
        para_pr_id = re.search(r'\sid="(\d+)"', para_pr)
        previous = re.search(r'<hc:prev value="(-?\d+)"', para_pr)
        if para_pr_id is None:
            continue
        margins[para_pr_id.group(1)] = int(previous.group(1)) if previous else 0
    return [margins[ref] for ref in _hwpx_para_pr_refs(payload)]


def test_item_spans_reads_the_problem_boundary_from_the_heading_level() -> None:
    """문항 경계는 `Heading.level == 2`(모델의 계약)로 읽는다.

    문항 안 소제목(3수준 `풀이`/`정답`)은 경계가 아니라 같은 덩이에 남고,
    다음 문항 제목·해설부 표제(1수준)·페이지 나눔은 경계다.
    """
    blocks: list[export_model.Block] = [
        export_model.Text("표지"),  # 0 문항 밖
        export_model.Heading("1번", 2),  # 1 문항 시작
        export_model.Image(Path("a.png")),  # 2
        export_model.Heading("풀이", 3),  # 3 소제목은 경계가 아니다
        export_model.Text("본문"),  # 4
        export_model.Heading("2번", 2),  # 5 다음 문항
        export_model.Text("본문"),  # 6
        export_model.PageBreak(),  # 7 경계
        export_model.Heading("정답 및 해설", 1),  # 8 표제는 문항이 아니다
        export_model.Heading("1번", 2),  # 9 해설부의 문항
        export_model.Text("해설"),  # 10
    ]
    assert export_model.item_spans(blocks) == {1: 5, 5: 7, 9: 11}


def test_exam_and_variant_docs_are_two_column_and_the_note_is_not(
    tmp_path: Path,
) -> None:
    """시험지·변형은 2단, 오답노트는 1단이다(복습용이라 문항을 크게 본다)."""
    crop = _crop(tmp_path)
    exam = export_build.build_exam_doc(
        title="시험지",
        items=[export_build.ExamItem(no=1, image=crop)],
        include_full=False,
    )
    variants = export_build.build_variants_doc(
        title="변형",
        items=[export_build.VariantItem(no=1, mode="number", text=VARIANT_TEXT_PLAIN)],
        include_full=False,
    )
    note = export_build.build_note_doc(
        title="오답노트",
        items=[export_build.NoteItem(source_name="풍문고", problem_no=1, image=crop)],
        include_full=False,
    )
    assert exam.two_column is True
    assert variants.two_column is True
    assert note.two_column is False


def test_docx_two_column_has_a_center_separator_and_a_gap() -> None:
    """docx 는 구역 속성(`w:cols`)으로 2단을 낸다. `w:sep="1"` 이 중앙 세로선이다."""
    # 제목은 전폭 구역(0)에 있고 본문이 2단 구역(1)이다.
    cols = _docx_cols(export_docx.build_docx(TWO_COLUMN_DOC))[1]
    assert cols["num"] == "2"
    assert cols["sep"] == "1"
    # 단 간격은 `export.layout` 이 단일 소스다(8mm = 454 twip).
    assert int(cols["space"]) == Mm(export_layout.COLUMN_GAP_MM).twips


def test_docx_one_column_doc_has_no_column_settings() -> None:
    """오답노트(1단)는 구역이 하나뿐이고 단 수도 구분선도 붙지 않는다."""
    cols = _docx_cols(export_docx.build_docx(ONE_COLUMN_DOC))
    assert len(cols) == 1, cols
    assert "sep" not in cols[0]
    # `w:num` 은 템플릿에 없다(= 1단). 헬퍼가 채운 기본값만 남는다.
    assert cols[0]["num"] == "1"
    assert "w:num" not in _docx_document_xml(export_docx.build_docx(ONE_COLUMN_DOC))


def test_hwpx_two_column_has_a_center_separator_and_a_gap() -> None:
    """hwpx 는 문단 제어 문자(`hp:colPr`)로 2단을 낸다. `hp:colLine` 이 세로선이다."""
    payload = export_hwpx.build_hwpx(TWO_COLUMN_DOC)
    columns = [column for column in _hwpx_columns(payload) if column["colCount"] == "2"]
    assert len(columns) == 1, _hwpx_columns(payload)
    # 단 간격은 `export.layout` 이 단일 소스다(8mm = 2268 HWPUNIT).
    expected_gap = round(
        export_layout.COLUMN_GAP_MM
        / export_layout.MM_PER_INCH
        * export_layout.HWPUNIT_PER_INCH
    )
    assert int(columns[0]["sameGap"]) == expected_gap
    assert re.search(r"<hp:colLine[^>]*/>", _section_text(payload)) is not None


def test_hwpx_one_column_doc_has_no_column_settings() -> None:
    """오답노트(1단)에는 2단 정의가 실리지 않는다(새 문서 기본 1단짜리만 남는다)."""
    payload = export_hwpx.build_hwpx(ONE_COLUMN_DOC)
    assert all(column["colCount"] == "1" for column in _hwpx_columns(payload))
    assert "<hp:colLine" not in _section_text(payload)


def test_docx_keeps_a_problem_together_and_frees_its_last_paragraph() -> None:
    """문항 문단은 모두 `keepLines`, 마지막 문단만 `keepNext` 가 꺼진다.

    마지막 문단까지 `keepNext` 를 켜면 다음 문항이 끌려와 문서 전체가 한 덩이가
    된다. 워드 기본 제목 스타일이 `keepNext` 를 켜는 경우가 있어 상속에 맡기지
    않고 `w:val="0"` 으로 명시해 끈다.
    """
    props = _docx_paragraph_props(export_docx.build_docx(TWO_COLUMN_DOC))
    # 문서 제목(0) 뒤로 1번 문항 3문단, 2번 문항 2문단이다.
    item_props = props[1:]
    assert len(item_props) == 5, props
    assert all("<w:keepLines/>" in prop for prop in item_props)
    assert ["<w:keepNext/>" in prop for prop in item_props] == [
        True,
        True,
        False,
        True,
        False,
    ]
    assert ['<w:keepNext w:val="0"/>' in prop for prop in item_props] == [
        False,
        False,
        True,
        False,
        True,
    ]
    # 문서 제목 문단에는 아무 것도 걸지 않는다(문항 구간이 아니다).
    assert "keepNext" not in props[0]


def test_docx_one_column_doc_gets_no_keep_attributes() -> None:
    """오답노트(1단)는 예전과 똑같이 나간다 — 문단에 조판 속성이 붙지 않는다."""
    document = _docx_document_xml(export_docx.build_docx(ONE_COLUMN_DOC))
    assert "keepNext" not in document
    assert "keepLines" not in document


def test_docx_puts_the_problem_gap_only_before_the_first_paragraph() -> None:
    """문항 간 간격은 **문항 첫 문단 앞에만** 넣는다(문항 안은 촘촘하게).

    간격이 문항 안에도 들어가면 한 문항이 여러 덩이로 보인다.
    """
    props = _docx_paragraph_props(export_docx.build_docx(TWO_COLUMN_DOC))
    gap = f'<w:spacing w:before="{Pt(export_layout.ITEM_GAP_PT).twips}"/>'
    assert [prop.count(gap) for prop in props[1:]] == [1, 0, 0, 1, 0]


def test_hwpx_keeps_a_problem_together_and_frees_its_last_paragraph() -> None:
    """hwpx 도 같은 규칙이다(`hh:breakSetting` 의 keepLines/keepWithNext)."""
    payload = export_hwpx.build_hwpx(TWO_COLUMN_DOC)
    # 새 문서 템플릿의 빈 문단과 문서 제목 뒤로 문항 문단 5개다.
    settings = _hwpx_break_settings(payload)[-5:]
    assert all(setting["keepLines"] == "1" for setting in settings)
    assert [setting["keepWithNext"] for setting in settings] == ["1", "1", "0", "1", "0"]


def test_hwpx_one_column_doc_gets_no_keep_attributes() -> None:
    """오답노트(1단)는 예전과 똑같이 나간다 — 기본 문단 서식만 쓴다."""
    settings = _hwpx_break_settings(export_hwpx.build_hwpx(ONE_COLUMN_DOC))
    assert all(setting["keepLines"] == "0" for setting in settings)
    assert all(setting["keepWithNext"] == "0" for setting in settings)


def test_hwpx_puts_the_problem_gap_only_before_the_first_paragraph() -> None:
    """hwpx 도 문항 첫 문단 앞에만 간격을 넣는다(12pt = 1200 HWPUNIT)."""
    payload = export_hwpx.build_hwpx(TWO_COLUMN_DOC)
    expected = round(export_layout.ITEM_GAP_PT / 72 * export_layout.HWPUNIT_PER_INCH)
    assert _hwpx_space_before(payload)[-5:] == [expected, 0, 0, expected, 0]


def test_hwpx_two_column_layout_adds_only_a_few_paragraph_formats() -> None:
    """문단마다 서식을 찍지 않는다 — 자리(첫/중간/마지막)마다 한 벌만 만든다.

    `apply_paragraph_format` 은 부를 때마다 새 `paraPr` 을 찍고 중복을 합치지
    않으므로, 문단마다 부르면 434문항 문서의 `header.xml` 이 수천 개로 불어난다.
    """
    counts = [
        _hwpx_part(export_hwpx.build_hwpx(doc), "Contents/header.xml").count(
            "<hh:paraPr "
        )
        for doc in (ONE_COLUMN_DOC, TWO_COLUMN_DOC)
    ]
    assert counts[1] - counts[0] == 3, counts


def test_two_column_image_is_capped_at_the_column_width(tmp_path: Path) -> None:
    """2단 문서의 이미지 폭 상한은 본문 폭이 아니라 **단 폭**이다.

    본문 폭(150mm)을 상한으로 두면 크롭이 옆 단과 오른쪽 여백을 통째로 덮는다.
    1단(오답노트)은 지금까지처럼 본문 폭이 상한이다.
    """
    wide = tmp_path / "wide.png"
    PilImage.new("RGB", (3000, 300), "white").save(wide)
    blocks: list[export_model.Block] = [
        export_model.Heading("1번", 2),
        export_model.Image(wide),
    ]

    column_width_hwpunit = round(
        export_layout.COLUMN_WIDTH_MM
        / export_layout.MM_PER_INCH
        * export_layout.HWPUNIT_PER_INCH
    )
    two_column = export_hwpx.build_hwpx(
        export_model.ExportDoc(title="시험지", blocks=blocks, two_column=True)
    )
    assert _hwpx_image_widths(two_column) == [column_width_hwpunit]
    one_column = export_hwpx.build_hwpx(
        export_model.ExportDoc(title="오답노트", blocks=blocks)
    )
    assert _hwpx_image_widths(one_column) == [_hwpx_body_width(one_column)]

    document = _docx_document_xml(
        export_docx.build_docx(
            export_model.ExportDoc(title="시험지", blocks=blocks, two_column=True)
        )
    )
    extents = [int(cx) for cx in re.findall(r'<wp:extent cx="(\d+)"', document)]
    assert extents, "그림이 들어가지 않았다"
    # mm -> EMU 환산에서 1 EMU 안쪽 오차가 난다.
    column_width_emu = Mm(export_layout.COLUMN_WIDTH_MM).emu
    assert all(abs(cx - column_width_emu) <= 2 for cx in extents), extents


def test_hwpx_footer_does_not_inherit_the_problem_keep_attributes() -> None:
    """꼬리말은 문항의 keep 속성을 물려받지 않는다(2단 문서에서도 기본 서식).

    hwpx 의 `add_paragraph` 는 앞 문단의 서식 참조를 물려받는다. 그래서 문항
    서식을 꼬리말보다 먼저 걸면 꼬리말이 마지막 문항의 서식을 그대로 쓴다.
    """
    payload = export_hwpx.build_hwpx(
        export_model.ExportDoc(
            title="시험지",
            blocks=TWO_COLUMN_BLOCKS,
            footer="출처: 풍문고",
            two_column=True,
        )
    )
    assert "출처: 풍문고" in _section_text(payload)
    footer = _hwpx_break_settings(payload)[-1]
    assert footer == {**footer, "keepLines": "0", "keepWithNext": "0"}


# --------------------------------- 전폭(단 걸치기): 제목·해설부 표제·고지·출처
# 2단으로 짠 뒤 "제목이 세로선 기준 좌측 단에만 나온다" 는 보고를 고친 것이다.
# 문서를 감싸는 것(제목·고지·출처)과 문서를 가르는 표제(`정답 및 해설`)는 좌우
# 단을 걸쳐야 한다. 나머지(문항·해설 본문)만 2단이다.

# 시험지 한 벌의 최소 형태 — 문항부 2문항 + 페이지 나눔 + 해설부 표제 + 해설 1문항.
FULL_WIDTH_BLOCKS: list[export_model.Block] = [
    export_model.Heading("1번", 2),
    export_model.Text("문항 1"),
    export_model.Heading("2번", 2),
    export_model.Text("문항 2"),
    export_model.PageBreak(),
    export_model.Heading("정답 및 해설", 1),
    export_model.Heading("1번", 2),
    export_model.Text("해설 1"),
]
FULL_WIDTH_DOC = export_model.ExportDoc(
    title="omega 5회",
    blocks=FULL_WIDTH_BLOCKS,
    notice="※ 고지",
    footer="출처: 풍문고",
    two_column=True,
)
# 같은 내용의 오답노트(1단). 2단 쪽만 달라졌는지 대조하는 데 쓴다.
FULL_WIDTH_NOTE_DOC = export_model.ExportDoc(
    title="omega 5회",
    blocks=FULL_WIDTH_BLOCKS,
    notice="※ 고지",
    footer="출처: 풍문고",
)
# 지면 구성 순서: 전폭(제목·고지) / 2단(문항) / 전폭(표제) / 2단(해설) / 전폭(출처).
FULL_WIDTH_COLUMN_ORDER = ["1", "2", "1", "2", "1"]


def test_full_width_flags_marks_only_level_one_headings() -> None:
    """전폭 판정은 "1수준 Heading" 하나로 끝난다. `PageBreak` 만 None 이다.

    해설부 표제(`정답 및 해설`)가 1수준이고 문항은 2수준이라(`model.Heading` 의
    계약) 새 필드 없이 수준만 읽으면 된다. `PageBreak` 는 내용이 없는 지시라
    속할 단이 없다 — None 을 받은 렌더러는 지금 단 설정을 그대로 둔다.
    """
    blocks: list[export_model.Block] = [
        export_model.Heading("1번", 2),
        export_model.Image(Path("a.png")),
        export_model.Heading("풀이", 3),
        export_model.Text("본문"),
        export_model.PageBreak(),
        export_model.Heading("정답 및 해설", 1),
        export_model.Heading("1번", 2),
    ]
    assert export_model.full_width_flags(blocks) == [
        False,
        False,
        False,
        False,
        None,
        True,
        False,
    ]


def test_docx_puts_the_title_the_answer_heading_and_the_footer_in_full_width() -> None:
    """docx 는 전폭/2단이 갈리는 자리마다 **연속 구역**을 만든다.

    `w:cols` 는 구역 속성이라 문단 단위로 바꿀 수 없다. 그래서 구역이 다섯 개로
    갈리고 단 수가 `1 / 2 / 1 / 2 / 1` 로 번갈아 든다. 어느 문단이 어느 구역에
    있는지까지 못박아 둔다 — 제목만 전폭이고 표제가 단 안에 남으면 이 보고가
    반만 고쳐진 것이다.
    """
    payload = export_docx.build_docx(FULL_WIDTH_DOC)
    cols = _docx_cols(payload)
    assert [col["num"] for col in cols] == FULL_WIDTH_COLUMN_ORDER
    # 세로 구분선은 2단 구역에만 있다(1단 구역에 남으면 전폭 한가운데 선이 그어진다).
    assert [("sep" in col) for col in cols] == [False, True, False, True, False]
    # 페이지 나눔 문단(빈 문단)이 2단 구역의 마지막이다.
    assert _docx_section_paragraphs(payload) == [
        ["omega 5회", "※ 고지"],
        ["1번", "문항 1", "2번", "문항 2", ""],
        ["정답 및 해설"],
        ["1번", "해설 1"],
        ["출처: 풍문고"],
    ]


def test_docx_every_section_has_the_same_a4_page() -> None:
    """**모든** 구역의 용지가 A4 이고 여백이 같다.

    용지·여백도 단 수와 마찬가지로 구역 속성이다. 첫 구역에만 걸면 나머지가
    python-docx 기본값(Letter)으로 남아 문서 중간에서 페이지 크기가 바뀐다.
    """
    payload = export_docx.build_docx(FULL_WIDTH_DOC)
    sect_prs = _docx_sect_prs(payload)
    assert len(sect_prs) == len(FULL_WIDTH_COLUMN_ORDER)
    pages: set[tuple[str, str]] = set()
    for sect_pr in sect_prs:
        size = re.search(r"<w:pgSz[^>]*/>", sect_pr)
        margin = re.search(r"<w:pgMar[^>]*/>", sect_pr)
        assert size is not None and margin is not None, sect_pr
        pages.add((size.group(0), margin.group(0)))
    # 구역마다 같은 한 벌이어야 한다 — 하나라도 다르면 지면이 중간에 바뀐다.
    assert len(pages) == 1, pages
    # 그 한 벌이 A4(11906x16838 twip) + hwpx 여백인지는 1단 문서와 같은 기준이다.
    page = _docx_sect_pr(payload)
    assert abs(page["w"] - 11906) <= 2
    assert abs(page["h"] - 16838) <= 2
    assert abs(page["left"] - 1701) <= 2
    assert abs(page["right"] - 1701) <= 2
    assert abs(page["top"] - 1134) <= 2
    assert abs(page["bottom"] - 850) <= 2


def test_docx_section_breaks_are_continuous_and_add_no_paragraph() -> None:
    """연속 구역 나누기가 빈 문단(= 빈 페이지 씨앗)을 만들지 않는다.

    확인 방법이 둘이다. (1) 구역 나누기가 모두 `continuous` 다 — `nextPage` 가
    하나라도 있으면 그 자리에서 지면이 끊긴다. (2) 문단 순서가 같은 내용의 1단
    문서와 **완전히 같다** — `Document.add_section` 이 옛 구역 속성을 담으려고
    새로 만드는 빈 문단을 `_split_section` 이 지우기 때문이다. 문단이 늘지
    않으므로 지면이 밀려 빈 페이지가 생길 여지도 없다.
    """
    payload = export_docx.build_docx(FULL_WIDTH_DOC)
    types = re.findall(r'<w:type w:val="(\w+)"/>', _docx_document_xml(payload))
    # 첫 구역은 문서의 시작이라 `w:type` 이 없다. 나머지 넷이 연속 구역이다.
    assert types == ["continuous"] * (len(FULL_WIDTH_COLUMN_ORDER) - 1)
    sections = _docx_section_paragraphs(payload)
    # 문단이 하나도 없는 구역이 있으면 워드가 그 자리에 빈 지면을 낸다.
    assert all(sections), sections
    note = _docx_section_paragraphs(export_docx.build_docx(FULL_WIDTH_NOTE_DOC))
    assert [paragraph for section in sections for paragraph in section] == note[0]


def test_docx_keeps_problems_together_in_both_column_sections() -> None:
    """문항 쪼개짐 방지가 구역이 갈린 뒤(해설부 2단)에도 그대로 걸린다.

    전폭/2단을 갈랐다고 `item_spans` 가 끊기면 해설부 문항이 단 사이에서
    쪼개진다. 표제·고지·출처는 문항이 아니므로 아무 속성도 받지 않는다.
    """
    props = _docx_paragraph_props(export_docx.build_docx(FULL_WIDTH_DOC))
    # 제목, 고지, [1번 2문단], [2번 2문단], 페이지 나눔, 표제, [1번 2문단], 출처.
    assert len(props) == 11, props
    keep_lines = [False, False, True, True, True, True, False, False, True, True, False]
    keep_next = [False, False, True, False, True, False, False, False, True, False, False]
    assert [("<w:keepLines/>" in prop) for prop in props] == keep_lines
    assert [("<w:keepNext/>" in prop) for prop in props] == keep_next


def test_docx_one_column_doc_has_a_single_section() -> None:
    """오답노트(1단)는 구역이 하나다 — 구역 나누기도 단 설정도 붙지 않는다."""
    payload = export_docx.build_docx(FULL_WIDTH_NOTE_DOC)
    assert len(_docx_sect_prs(payload)) == 1
    document = _docx_document_xml(payload)
    assert "<w:type" not in document
    assert "w:num" not in document
    assert "w:sep" not in document


def _hwpx_column_switches(payload: bytes) -> list[tuple[str, str]]:
    """단 정의를 실은 문단마다 `(문단 텍스트, 단 수)`. 문단 순서 그대로다."""
    switches: list[tuple[str, str]] = []
    for paragraph in re.findall(r"<hp:p\b.*?</hp:p>", _section_text(payload), re.S):
        count = re.search(r'<hp:colPr[^>]*colCount="(\d+)"', paragraph)
        if count is None:
            continue
        text = "".join(re.findall(r"<hp:t>([^<]*)</hp:t>", paragraph))
        switches.append((text, count.group(1)))
    return switches


def test_hwpx_switches_columns_at_the_title_the_heading_and_the_footer() -> None:
    """hwpx 는 구역이 아니라 **문단 안 제어 문자**(`hp:colPr`)로 단을 바꾼다.

    그래서 docx 처럼 구역을 가를 필요 없이 자리마다 정의를 하나씩 싣는다. 첫
    항목은 새 문서 템플릿의 빈 문단(기본 1단)이라 우리가 넣은 것이 아니다.
    """
    payload = export_hwpx.build_hwpx(FULL_WIDTH_DOC)
    assert _hwpx_column_switches(payload) == [
        ("", "1"),
        ("omega 5회", "1"),
        ("1번", "2"),
        ("정답 및 해설", "1"),
        ("1번", "2"),
        ("출처: 풍문고", "1"),
    ]
    # 세로 구분선은 2단 정의에만 붙는다(1단에는 그을 자리가 없다).
    assert _section_text(payload).count("<hp:colLine") == 2


def test_hwpx_one_column_doc_keeps_the_default_single_column() -> None:
    """오답노트(1단)는 예전 그대로다 — 템플릿 기본 1단 정의 하나만 남는다."""
    payload = export_hwpx.build_hwpx(FULL_WIDTH_NOTE_DOC)
    assert _hwpx_column_switches(payload) == [("", "1")]
    assert "<hp:colLine" not in _section_text(payload)


def test_hwpx_keeps_problems_together_in_both_column_sections() -> None:
    """hwpx 도 단을 갈아 끼운 뒤(해설부)에도 문항 keep 속성이 그대로 걸린다."""
    settings = _hwpx_break_settings(export_hwpx.build_hwpx(FULL_WIDTH_DOC))
    # 템플릿 빈 문단, 제목, 고지, [1번 2문단], [2번 2문단], 페이지 나눔,
    # 표제, [1번 2문단], 출처.
    assert len(settings) == 12, settings
    keep_lines = ["0", "0", "0", "1", "1", "1", "1", "0", "0", "1", "1", "0"]
    keep_next = ["0", "0", "0", "1", "0", "1", "0", "0", "0", "1", "0", "0"]
    assert [setting["keepLines"] for setting in settings] == keep_lines
    assert [setting["keepWithNext"] for setting in settings] == keep_next
