"""판독본 내보내기(`body=text`) + 고지 + 오답노트 스냅샷 + 읽기·편집 API.

가장 중요한 것은 **회귀 방지**다. `body` 를 주지 않은(=`image`) 요청은 예전과
똑같은 문서를 내야 한다 — 여기서는 `word/document.xml` / `Contents/section0.xml`
을 `body=image` 와 바이트 단위로 비교해 못박는다.

`body=text` 는 판독본을 수식 개체 조판 경로로 태운다는 증거(`m:oMath` /
`<hp:equation`)와, 판독본이 없는 문항이 조용히 이미지로 폴백해 **혼합** 문서가
되는 것을 확인한다.
"""

from __future__ import annotations

import io
import re
import zipfile

from conftest import make_note, upload_test_pdf
from fastapi.testclient import TestClient

import config
import storage
from export import build as export_build
from export import docx as export_docx
from export import hwpx as export_hwpx

# 테스트 PDF 의 추출 문항 수(test_export.py 와 같은 값).
PROBLEM_COUNT = 22

# 판독본 예시. 수식 구간(`\( \)`)이 있어야 수식 개체 조판 경로를 탄다.
TRANSCRIPT = r"두 다항식 \(A=3x^{2}-xy\) 에 대하여 \(\frac{1}{2}A\) 를 구하시오. [3점]"
TRANSCRIPT_PLAIN = "선분의 길이를 구하시오."


def _set_transcript(
    node_id: str,
    no: int,
    text: str = TRANSCRIPT,
    source: str = storage.TRANSCRIPT_PUA,
) -> None:
    """판독본을 직접 저장한다(작업 큐·AI 를 거치지 않는다)."""
    with storage.transaction() as conn:
        assert storage.set_transcript(
            conn,
            node_id=node_id,
            no=no,
            transcript=text,
            source=source,
            note=None,
            overwrite_manual=True,
        )


def _docx_part(payload: bytes, name: str = "word/document.xml") -> bytes:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return archive.read(name)


def _docx_media(payload: bytes) -> list[str]:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return [n for n in archive.namelist() if n.startswith("word/media/")]


def _hwpx_section(payload: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return archive.read("Contents/section0.xml").decode("utf-8")


def _hwpx_images(payload: bytes) -> list[str]:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return [n for n in archive.namelist() if n.startswith("BinData/")]


_HWPX_ID_RE = re.compile(r'\b(?:inst)?id="\d+"')


def _hwpx_shape(payload: bytes) -> str:
    """hwpx 본문에서 **난수 id 만** 지운 문자열(두 문서 비교용).

    python-hwpx 는 문단·개체마다 무작위 id 를 새로 뽑으므로 같은 내용을 두 번
    렌더해도 원문이 바이트로 같지 않다. 그 외의 모든 태그·속성·글자는 그대로
    비교한다.
    """
    return _HWPX_ID_RE.sub("", _hwpx_section(payload))


# ─────────────────────────── 회귀: body 없이 = body=image ───────────────────────


def test_default_body_matches_explicit_image_for_all_routes(client: TestClient) -> None:
    """6개 라우트 모두 `body` 생략 == `body=image` (문서 본문 XML 이 같다).

    판독본을 저장해 둔 상태로 비교한다 — `body=image` 는 판독본이 있어도 보지
    않아야 한다는 것이 이 테스트의 핵심이다.
    """
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1)
    with storage.transaction() as conn:
        storage.upsert_variant(
            conn, node_id=node_id, no=1, mode="number", text="## 문제\n값을 구하라."
        )
    note_id = make_note(client, "회귀 노트")
    assert (
        client.post(
            f"/api/notes/{note_id}/items",
            json={"source_node_id": node_id, "problem_numbers": [1, 2]},
        ).status_code
        == 201
    )

    paths = [
        f"/api/files/{node_id}/export",
        f"/api/files/{node_id}/variants/export",
        f"/api/notes/{note_id}/export",
    ]
    for base in paths:
        docx_default = client.get(f"{base}.docx")
        docx_image = client.get(f"{base}.docx", params={"body": "image"})
        assert docx_default.status_code == 200, docx_default.text
        assert docx_image.status_code == 200, docx_image.text
        assert _docx_part(docx_default.content) == _docx_part(docx_image.content), base
        assert _docx_media(docx_default.content) == _docx_media(docx_image.content)

        hwpx_default = client.get(f"{base}.hwpx")
        hwpx_image = client.get(f"{base}.hwpx", params={"body": "image"})
        assert hwpx_default.status_code == 200, hwpx_default.text
        assert hwpx_image.status_code == 200, hwpx_image.text
        assert _hwpx_shape(hwpx_default.content) == _hwpx_shape(hwpx_image.content), base
        assert _hwpx_images(hwpx_default.content) == _hwpx_images(hwpx_image.content)


def test_image_body_keeps_all_crops_and_adds_no_notice(client: TestClient) -> None:
    """판독본이 있어도 `body=image` 는 크롭 22장 그대로, 고지 없음."""
    node_id = upload_test_pdf(client)["node"]["id"]
    for no in (1, 2, 3):
        _set_transcript(node_id, no)

    docx = client.get(f"/api/files/{node_id}/export.docx")
    assert len(_docx_media(docx.content)) == PROBLEM_COUNT
    assert export_build.NOTICE_RESTORED not in _docx_part(docx.content).decode("utf-8")

    hwpx = client.get(f"/api/files/{node_id}/export.hwpx")
    assert len(_hwpx_images(hwpx.content)) == PROBLEM_COUNT
    assert export_build.NOTICE_RESTORED not in _hwpx_section(hwpx.content)


def test_invalid_body_is_422(client: TestClient) -> None:
    node_id = upload_test_pdf(client)["node"]["id"]
    response = client.get(f"/api/files/{node_id}/export.docx", params={"body": "latex"})
    assert response.status_code == 422


# ─────────────────────────── body=text: 혼합 + 수식 개체 ───────────────────────


def test_text_body_docx_has_omml_and_falls_back_to_images(client: TestClient) -> None:
    """판독본 3건은 텍스트(수식 개체)로, 남은 19건은 크롭으로 나간다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    for no in (1, 2, 3):
        _set_transcript(node_id, no)

    response = client.get(f"/api/files/{node_id}/export.docx", params={"body": "text"})
    assert response.status_code == 200, response.text
    document = _docx_part(response.content).decode("utf-8")
    # 수식 개체 조판 경로를 탔다는 증거.
    assert "m:oMath" in document
    assert "두 다항식" in document
    # 판독본이 없는 문항은 조용히 이미지로 폴백한다(혼합).
    assert len(_docx_media(response.content)) == PROBLEM_COUNT - 3


def test_text_body_hwpx_has_equation_and_falls_back_to_images(
    client: TestClient,
) -> None:
    """hwpx 도 같다 — `<hp:equation` 이 실제로 들어간다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    for no in (1, 2, 3):
        _set_transcript(node_id, no)

    response = client.get(f"/api/files/{node_id}/export.hwpx", params={"body": "text"})
    assert response.status_code == 200, response.text
    section = _hwpx_section(response.content)
    assert "<hp:equation" in section
    assert len(_hwpx_images(response.content)) == PROBLEM_COUNT - 3


def test_text_body_without_any_transcript_is_all_images(client: TestClient) -> None:
    """판독본이 하나도 없으면 `body=text` 여도 예전 문서와 같다(고지도 없다)."""
    node_id = upload_test_pdf(client)["node"]["id"]

    text = client.get(f"/api/files/{node_id}/export.docx", params={"body": "text"})
    image = client.get(f"/api/files/{node_id}/export.docx", params={"body": "image"})
    assert _docx_part(text.content) == _docx_part(image.content)
    assert export_build.NOTICE_RESTORED not in _docx_part(text.content).decode("utf-8")


def test_text_body_exports_problem_without_crop_file(client: TestClient) -> None:
    """크롭 파일이 사라진 문항도 판독본이 있으면 텍스트로 나간다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1)
    with storage.transaction() as conn:
        problem = storage.get_problem(conn, node_id, 1)
    assert problem is not None
    (config.data_dir() / str(problem["crop_path"])).unlink()

    text = client.get(f"/api/files/{node_id}/export.docx", params={"body": "text"})
    assert text.status_code == 200
    assert "두 다항식" in _docx_part(text.content).decode("utf-8")
    # 이미지 모드에서는 그 문항이 통째로 빠진다(예전 동작 그대로).
    image = client.get(f"/api/files/{node_id}/export.docx", params={"body": "image"})
    assert len(_docx_media(image.content)) == PROBLEM_COUNT - 1


def test_text_body_keeps_solutions(client: TestClient) -> None:
    """`include=full` 과 함께 쓰면 판독본 텍스트 + 풀이가 같이 나간다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1)
    assert (
        client.post(
            f"/api/files/{node_id}/problems/1/solution",
            json={"content": "## 풀이\n계산하면 된다.\n\n## 정답\n$4$"},
        ).status_code
        == 200
    )

    response = client.get(
        f"/api/files/{node_id}/export.docx",
        params={"body": "text", "include": "full"},
    )
    document = _docx_part(response.content).decode("utf-8")
    assert "두 다항식" in document
    assert "계산하면 된다." in document


# ─────────────────────────── 고지 문구 ────────────────────────────────────────


def test_notice_appears_on_the_first_page(client: TestClient) -> None:
    """고지는 제목 바로 뒤(첫 페이지)에 들어간다 — 꼬리말 출처보다 앞이다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1)

    docx = client.get(
        f"/api/files/{node_id}/export.docx",
        params={"body": "text", "source": "HY EDU"},
    )
    document = _docx_part(docx.content).decode("utf-8")
    assert export_build.NOTICE_RESTORED in document
    assert document.index(export_build.NOTICE_RESTORED) < document.index("HY EDU")

    hwpx = client.get(f"/api/files/{node_id}/export.hwpx", params={"body": "text"})
    assert export_build.NOTICE_RESTORED in _hwpx_section(hwpx.content)


def test_notice_mentions_ai_when_any_item_is_ai(client: TestClient) -> None:
    """AI 판독본이 하나라도 섞이면 그 사실을 밝힌다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1, source=storage.TRANSCRIPT_PUA)
    _set_transcript(node_id, 2, source=storage.TRANSCRIPT_AI)

    document = _docx_part(
        client.get(
            f"/api/files/{node_id}/export.docx", params={"body": "text"}
        ).content
    ).decode("utf-8")
    assert export_build.NOTICE_AI_SUFFIX in document


def test_notice_is_lighter_when_every_item_is_manual(client: TestClient) -> None:
    """전부 사용자가 확인·수정한 것이면 경고 강도를 낮춘다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1, source=storage.TRANSCRIPT_MANUAL)

    document = _docx_part(
        client.get(
            f"/api/files/{node_id}/export.docx", params={"body": "text"}
        ).content
    ).decode("utf-8")
    assert export_build.NOTICE_MANUAL in document
    assert export_build.NOTICE_RESTORED not in document
    assert export_build.NOTICE_AI_SUFFIX not in document


def test_notice_source_values_match_storage() -> None:
    """`build.py` 가 쓰는 출처 문자열이 `storage` 상수와 어긋나지 않는다.

    `build.py` 는 DB 를 모르게 두려고 상수를 import 하지 않는다(모듈 docstring).
    그래서 두 곳이 조용히 갈라질 수 있는데, 갈라지면 고지 문구가 틀린다.
    """
    doc = export_build.build_exam_doc(
        title="t",
        items=[
            export_build.ExamItem(
                no=1,
                transcript="본문",
                transcript_source=storage.TRANSCRIPT_MANUAL,
            )
        ],
        include_full=False,
        body="text",
    )
    assert doc.notice == export_build.NOTICE_MANUAL

    mixed = export_build.build_exam_doc(
        title="t",
        items=[
            export_build.ExamItem(
                no=1, transcript="본문", transcript_source=storage.TRANSCRIPT_AI
            )
        ],
        include_full=False,
        body="text",
    )
    assert mixed.notice is not None
    assert export_build.NOTICE_AI_SUFFIX in mixed.notice


def test_notice_is_absent_when_every_item_falls_back_to_image() -> None:
    """텍스트로 나간 항목이 없으면 고지를 넣지 않는다(거짓 고지 방지)."""
    doc = export_build.build_exam_doc(
        title="t",
        items=[export_build.ExamItem(no=1, transcript=None)],
        include_full=False,
        body="text",
    )
    assert doc.notice is None


def test_renderers_ignore_missing_notice() -> None:
    """`notice=None` 이면 두 렌더러가 아무것도 넣지 않는다."""
    doc = export_build.build_exam_doc(title="t", items=[], include_full=False)
    assert doc.notice is None
    assert export_docx.build_docx(doc)[:2] == b"PK"
    assert export_hwpx.build_hwpx(doc)[:2] == b"PK"


# ─────────────────────────── 오답노트 스냅샷 ──────────────────────────────────


def _add_note_item(client: TestClient, note_id: str, node_id: str, no: int) -> None:
    response = client.post(
        f"/api/notes/{note_id}/items",
        json={"source_node_id": node_id, "problem_numbers": [no]},
    )
    assert response.status_code == 201, response.text


def test_note_item_snapshots_transcript_at_add_time(client: TestClient) -> None:
    """담은 뒤 원본 판독본을 고쳐도 노트는 담긴 시점의 텍스트로 나간다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1)
    note_id = make_note(client, "스냅샷 노트")
    _add_note_item(client, note_id, node_id, 1)

    # 원본을 완전히 다른 내용으로 바꾼다.
    _set_transcript(node_id, 1, text="바뀐 원본 판독본", source=storage.TRANSCRIPT_AI)

    document = _docx_part(
        client.get(f"/api/notes/{note_id}/export.docx", params={"body": "text"}).content
    ).decode("utf-8")
    assert "두 다항식" in document
    assert "바뀐 원본 판독본" not in document
    # 출처도 담은 시점 값(pua)이라 AI 문구가 붙지 않는다.
    assert export_build.NOTICE_AI_SUFFIX not in document


def test_note_text_export_survives_source_deletion(client: TestClient) -> None:
    """원본 시험지를 지워도 판독본 스냅샷으로 텍스트 내보내기가 된다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1)
    note_id = make_note(client, "삭제 대비 노트")
    _add_note_item(client, note_id, node_id, 1)
    assert client.delete(f"/api/nodes/{node_id}").status_code == 200

    response = client.get(
        f"/api/notes/{note_id}/export.hwpx", params={"body": "text"}
    )
    assert response.status_code == 200, response.text
    section = _hwpx_section(response.content)
    assert "두 다항식" in section
    assert "<hp:equation" in section
    assert export_build.NOTICE_RESTORED in section


def test_note_text_export_mixes_snapshot_and_crop(client: TestClient) -> None:
    """판독본을 담은 항목은 텍스트로, 없는 항목은 크롭 스냅샷으로 나간다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1)
    note_id = make_note(client, "혼합 노트")
    _add_note_item(client, note_id, node_id, 1)
    _add_note_item(client, note_id, node_id, 2)

    response = client.get(
        f"/api/notes/{note_id}/export.docx", params={"body": "text"}
    )
    assert "두 다항식" in _docx_part(response.content).decode("utf-8")
    assert len(_docx_media(response.content)) == 1


def test_note_image_export_ignores_snapshot_transcript(client: TestClient) -> None:
    """`body=image` 인 노트 문서는 판독본 스냅샷이 있어도 크롭만 쓴다."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1)
    note_id = make_note(client, "이미지 노트")
    _add_note_item(client, note_id, node_id, 1)

    response = client.get(f"/api/notes/{note_id}/export.docx")
    document = _docx_part(response.content).decode("utf-8")
    assert "두 다항식" not in document
    assert len(_docx_media(response.content)) == 1


def test_plain_transcript_without_math_still_exports(client: TestClient) -> None:
    """수식이 없는 판독본도 텍스트로 나간다(수식 개체는 만들지 않는다)."""
    node_id = upload_test_pdf(client)["node"]["id"]
    _set_transcript(node_id, 1, text=TRANSCRIPT_PLAIN)

    response = client.get(f"/api/files/{node_id}/export.hwpx", params={"body": "text"})
    section = _hwpx_section(response.content)
    assert TRANSCRIPT_PLAIN in section
    assert "<hp:equation" not in section


def _texts(doc: object) -> str:
    """문서의 Text 블록을 모두 이어붙인다(제목 제외)."""
    from export.model import Text

    blocks = getattr(doc, "blocks", [])
    return "\n".join(b.text for b in blocks if isinstance(b, Text))


def test_leading_problem_number_is_dropped_from_transcript() -> None:
    """판독본 앞머리의 문항 번호를 지운다.

    문서는 이미 `N번` 제목을 붙이므로 본문에 `N.` 이 또 나오면 `1번 1. …` 로
    번호가 두 번 보인다. 크롭 이미지에는 번호가 그림으로 들어 있어 문제가 없었으나
    텍스트로 내면 중복이 드러난다.
    """
    doc = export_build.build_exam_doc(
        title="t",
        items=[
            export_build.ExamItem(
                no=1,
                transcript=r"1. 두 다항식 \(A=3x^{2}\)에 대하여",
                transcript_source=storage.TRANSCRIPT_PUA,
            ),
            export_build.ExamItem(
                no=2,
                transcript="2) 이차방정식의 근은?",
                transcript_source=storage.TRANSCRIPT_PUA,
            ),
        ],
        include_full=False,
        body="text",
    )
    body = _texts(doc)
    assert "두 다항식" in body
    assert "이차방정식의 근은?" in body
    assert not body.lstrip().startswith("1.")
    assert "2)" not in body


def test_leading_number_of_a_different_problem_is_kept() -> None:
    """번호가 그 문항 번호와 다르면 지우지 않는다(본문 훼손 방지).

    `16. [단답형 1]` 처럼 번호가 실제로 그 문항의 것이면 지우지만, 5번 문항의
    본문이 `3.14 …` 로 시작한다면 그것은 내용이다.
    """
    doc = export_build.build_exam_doc(
        title="t",
        items=[
            export_build.ExamItem(
                no=5,
                transcript="3. 이 값을 구하시오",
                transcript_source=storage.TRANSCRIPT_PUA,
            )
        ],
        include_full=False,
        body="text",
    )
    assert "3. 이 값을 구하시오" in _texts(doc)
