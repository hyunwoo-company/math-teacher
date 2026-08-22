"""트리 CRUD + 업로드/추출 서비스.

모든 함수는 **블로킹**(SQLite / 파일 IO / PyMuPDF)이다.
`async def` 라우트에서 부를 때는 `run_in_threadpool` 로 감싼다.
"""

from __future__ import annotations

import base64
import re
import shutil
import sqlite3
import unicodedata
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, Final, Literal

import config
import export
import extractor
import storage
from errors import ApiError, bad_request, not_found
from export import build as export_build
from export.model import ExportDoc

PDF_MAGIC: Final[bytes] = b"%PDF"

_SECTION_LABELS: Final[dict[str, str]] = {
    storage.SECTION_EXAM: "시험지",
    storage.SECTION_NOTE: "오답노트",
}


# --- 0문항 사유 --------------------------------------------------------------
# 문항을 하나도 못 찾은 이유는 둘이고, 사용자가 해야 할 일이 서로 다르다.
# 한 문구로 뭉개면 스캔본을 올린 사람이 [문제 다시 추출] 을 반복하게 된다
# (다시 추출해도 결과가 같다 — 근거로 삼을 글자가 애초에 없다).
_NO_ANCHOR_ERROR: Final[str] = (
    "문제 번호 앵커를 찾지 못했습니다. "
    "'1.' '2.' 형태의 문항 번호가 있는 시험지인지 확인하세요."
)
_SCANNED_PDF_ERROR: Final[str] = (
    "글자 정보가 없는 스캔본(사진) PDF 입니다. 문항 번호를 읽기 위해 "
    "OCR 작업을 예약했습니다. 진행률 배너가 끝나면 새로고침해 주세요. "
    "OCR 로도 번호를 찾지 못하면 한글·워드에서 PDF 로 내보낸 파일"
    "(글자를 선택·복사할 수 있는 PDF)을 올려 주세요."
)
# OCR 까지 돌렸는데도 번호를 못 찾은 경우. 위 문구를 그대로 쓰면 "OCR 을
# 예약했다" 고 안내한 뒤 아무 일도 안 일어난 것처럼 보인다.
_OCR_NO_ANCHOR_ERROR: Final[str] = (
    "스캔본을 OCR 로 읽었지만 '1.' '2.' 형태의 문항 번호를 찾지 못했습니다. "
    "번호가 흐리거나 페이지가 기울어졌을 수 있습니다. "
    "한글·워드에서 PDF 로 내보낸 파일(글자를 선택·복사할 수 있는 PDF)을 "
    "올리면 확실합니다."
)


def is_scanned_pdf_error(message: str | None) -> bool:
    """그 추출 사유가 **스캔본이라 0문항** 인 경우인지.

    업로드·재추출 라우트가 OCR 작업을 자동 등록할지 판단하는 유일한 근거다.
    스캔본 판정 자체는 `_no_problem_error` 한 곳에만 두고, 호출부는 그 결과를
    되묻기만 한다(판정 기준이 두 곳으로 갈라지지 않게).

    Args:
        message: `register_pdf` / `reextract_pdf` 가 돌려준 추출 사유.

    Returns:
        스캔본 사유면 True.
    """
    return message == _SCANNED_PDF_ERROR


def _no_problem_error(result: extractor.ExtractResult) -> str:
    """문항 0개일 때의 사유 문구를 고른다.

    스캔본 판정은 **백엔드에만** 둔다. 화면은 이 문장을 그대로 보여주기만 하므로
    판정 기준이 두 곳으로 갈라지지 않는다.

    Args:
        result: 추출 결과(문항 0개).

    Returns:
        사용자에게 보여줄 한국어 사유.
    """
    if extractor.looks_scanned(result.text_chars, result.page_count):
        return _SCANNED_PDF_ERROR
    return _NO_ANCHOR_ERROR

# ------------------------------------------------------------------ 공통
def _clean_name(name: str) -> str:
    cleaned = name.strip()
    if not cleaned:
        raise bad_request("invalid_name", "이름을 입력하세요.")
    if len(cleaned) > config.MAX_NAME_LENGTH:
        raise bad_request(
            "invalid_name",
            f"이름이 너무 깁니다. {config.MAX_NAME_LENGTH}자 이내로 입력하세요.",
        )
    return cleaned


def _require_node(conn: sqlite3.Connection, node_id: str) -> dict[str, Any]:
    node = storage.get_node(conn, node_id)
    if node is None:
        raise not_found(
            f"항목을 찾을 수 없습니다. (id={node_id})",
            "새로고침 후 다시 시도하세요. 이미 삭제된 항목일 수 있습니다.",
        )
    return node


def _require_folder_parent(
    conn: sqlite3.Connection, parent_id: str | None, section: str
) -> None:
    """상위 노드가 같은 섹션의 폴더인지 확인한다.

    Raises:
        ApiError: 부모가 없거나 폴더가 아니거나 **섹션이 다를 때**(400).
    """
    if parent_id is None:
        return
    parent = storage.get_node(conn, parent_id)
    if parent is None:
        raise bad_request(
            "parent_not_found",
            f"상위 폴더를 찾을 수 없습니다. (parent_id={parent_id})",
        )
    if parent["type"] != "folder":
        raise bad_request(
            "parent_not_folder",
            "파일 안에는 항목을 넣을 수 없습니다. 상위 항목은 폴더여야 합니다.",
        )
    if parent["section"] != section:
        raise bad_request(
            "section_mismatch",
            f"{_SECTION_LABELS[section]} 항목을 "
            f"{_SECTION_LABELS[parent['section']]} 폴더로 옮길 수 없습니다.",
            "시험지와 오답노트는 별도 섹션입니다. 같은 섹션 안에서만 이동하세요.",
        )


def require_file_node(conn: sqlite3.Connection, node_id: str) -> dict[str, Any]:
    """시험지(exam) 파일 노드인지 확인하고 노드를 돌려준다."""
    node = _require_node(conn, node_id)
    if node["type"] != "file":
        raise bad_request(
            "not_a_file",
            "파일이 아닌 항목입니다. 파일을 선택하세요.",
        )
    if node["section"] != storage.SECTION_EXAM:
        raise bad_request(
            "not_a_file",
            "오답노트 항목에는 쓸 수 없는 요청입니다. 시험지 파일을 선택하세요.",
        )
    return node


def require_note_node(conn: sqlite3.Connection, node_id: str) -> dict[str, Any]:
    """오답노트(note) 파일형 노드인지 확인하고 노드를 돌려준다."""
    node = _require_node(conn, node_id)
    if node["section"] != storage.SECTION_NOTE or node["type"] != "file":
        raise bad_request(
            "not_a_note",
            "오답노트가 아닌 항목입니다. 오답노트를 선택하세요.",
        )
    return node


# ------------------------------------------------------------------ 트리
def list_tree(section: str = storage.SECTION_EXAM) -> list[dict[str, Any]]:
    """한 섹션의 노드를 플랫 배열로. 폴더 먼저 → 이름 오름차순."""
    with storage.transaction() as conn:
        return storage.list_nodes(conn, section=section)


def create_folder(
    name: str, parent_id: str | None, section: str = storage.SECTION_EXAM
) -> dict[str, Any]:
    """폴더를 만든다. 같은 부모 안에서 이름 중복은 허용한다.

    Raises:
        ApiError: 상위 폴더가 없거나 섹션이 다를 때(400).
    """
    cleaned = _clean_name(name)
    with storage.transaction() as conn:
        _require_folder_parent(conn, parent_id, section)
        node_id = storage.new_id()
        storage.insert_node(
            conn,
            node_id=node_id,
            node_type="folder",
            name=cleaned,
            parent_id=parent_id,
            section=section,
        )
        node = storage.get_node(conn, node_id)
    assert node is not None
    return node


def update_node(
    node_id: str,
    *,
    name: str | None,
    parent_id: str | None,
    move: bool,
) -> dict[str, Any]:
    """이름변경/이동. `move=True` 면 `parent_id`(None 포함)를 반영한다.

    섹션(시험지/오답노트)을 넘나드는 이동은 400 으로 거부한다.

    Raises:
        ApiError: 순환 참조가 되는 이동이거나 섹션이 다르거나 대상이 없을 때.
    """
    cleaned = None if name is None else _clean_name(name)
    with storage.transaction() as conn:
        current = _require_node(conn, node_id)
        if move:
            if parent_id == node_id:
                raise bad_request(
                    "cycle_detected",
                    "자기 자신을 상위 폴더로 지정할 수 없습니다.",
                )
            if parent_id is not None:
                _require_folder_parent(conn, parent_id, str(current["section"]))
                if parent_id in storage.subtree_ids(conn, node_id):
                    raise bad_request(
                        "cycle_detected",
                        "하위 폴더를 상위 폴더로 지정할 수 없습니다.",
                        "폴더를 자기 자손 안으로 옮기면 트리가 순환합니다.",
                    )
        storage.update_node_fields(
            conn,
            node_id,
            name=cleaned,
            parent_id=parent_id,
            set_parent=move,
        )
        node = storage.get_node(conn, node_id)
    assert node is not None
    return node


def delete_node(node_id: str) -> list[str]:
    """노드를 재귀 삭제한다(하위 노드/파일/크롭/풀이/채팅/노트항목 전부).

    노트를 지우면 그 안의 항목과 크롭 스냅샷도 지운다. 반면 **시험지 파일을 지우면
    그 시험지를 참조하는 노트 항목은 남는다**(`source_node_id` 만 NULL 이 되고
    스냅샷 PNG 는 유지된다). 두 규칙은 `storage.delete_nodes` 에 구현돼 있다.

    Returns:
        삭제된 노드 ID 목록.
    """
    with storage.transaction() as conn:
        _require_node(conn, node_id)
        ids = storage.subtree_ids(conn, node_id)
        # 지워질 노트에 속한 항목의 스냅샷 파일 목록을 먼저 확보한다.
        removed_items = storage.note_item_ids_for_notes(conn, ids)
        storage.delete_nodes(conn, ids)
    for deleted in ids:
        _remove_assets(deleted)
    for item_id in removed_items:
        _remove_note_snapshot(item_id)
    return ids


def _remove_assets(node_id: str) -> None:
    """업로드 PDF 와 크롭 PNG 디렉터리를 지운다(없으면 통과)."""
    pdf_path = config.files_dir() / f"{node_id}.pdf"
    pdf_path.unlink(missing_ok=True)
    shutil.rmtree(config.crops_dir() / node_id, ignore_errors=True)


def _remove_note_snapshot(item_id: str) -> None:
    """노트 항목의 크롭 스냅샷 PNG 를 지운다(없으면 통과)."""
    (config.note_crops_dir() / f"{item_id}.png").unlink(missing_ok=True)


# ------------------------------------------------------------------ 업로드
def validate_pdf(filename: str, raw: bytes) -> None:
    """PDF 만 허용한다.

    Raises:
        ApiError: 빈 파일 / 크기 초과 / PDF 아님.
    """
    if not raw:
        raise bad_request("empty_file", "빈 파일입니다. 파일을 다시 선택하세요.")
    if len(raw) > config.MAX_UPLOAD_BYTES:
        raise bad_request(
            "file_too_large",
            f"파일이 너무 큽니다 ({len(raw) / 1_048_576:.1f}MB). "
            f"상한은 {config.MAX_UPLOAD_BYTES // 1_048_576}MB 입니다.",
        )
    if not raw.startswith(PDF_MAGIC):
        raise bad_request(
            "not_a_pdf",
            f"PDF 파일만 업로드할 수 있습니다. ({filename})",
            "시험지를 PDF 로 저장한 뒤 다시 업로드하세요.",
        )


def register_pdf(
    filename: str, raw: bytes, parent_id: str | None
) -> tuple[dict[str, Any], str | None]:
    """PDF 를 등록하고 즉시 추출한다 (AI 호출 0회).

    추출이 실패해도 파일 자체는 등록하고 `problem_count=0` 으로 둔다.

    Returns:
        (노드, 추출 실패 사유 또는 None)
    """
    validate_pdf(filename, raw)
    name = Path(filename).name or "upload.pdf"

    with storage.transaction() as conn:
        _require_folder_parent(conn, parent_id, storage.SECTION_EXAM)
        node_id = storage.new_id()
        storage.insert_node(
            conn,
            node_id=node_id,
            node_type="file",
            name=name,
            parent_id=parent_id,
            section=storage.SECTION_EXAM,
        )

    config.ensure_dirs()
    stored_path = config.files_dir() / f"{node_id}.pdf"
    stored_path.write_bytes(raw)

    extract_error: str | None = None
    pages = 0
    mode = "text"
    pua_ratio = 0.0
    problem_rows: list[dict[str, Any]] = []

    try:
        result = extractor.extract_problems(pdf_bytes=raw)
    except (extractor.ExtractionError, ValueError) as exc:
        extract_error = f"문제 추출에 실패했습니다: {exc}"
    except Exception as exc:
        extract_error = f"문제 추출 중 예상치 못한 오류가 발생했습니다: {exc}"
    else:
        pages = result.page_count
        mode = result.mode
        pua_ratio = result.pua_ratio
        problem_rows = _write_crops(node_id, result)
        if not problem_rows:
            extract_error = _no_problem_error(result)

    with storage.transaction() as conn:
        storage.upsert_file(
            conn,
            node_id=node_id,
            stored_path=f"files/{node_id}.pdf",
            pages=pages,
            mode=mode,
            pua_ratio=pua_ratio,
            problem_count=len(problem_rows),
            # 성공이면 None → 옛 사유가 남지 않는다(재추출로 해결된 경우).
            extract_error=extract_error,
        )
        storage.replace_problems(conn, node_id, problem_rows)
        node = storage.get_node(conn, node_id)
    assert node is not None
    return node, extract_error


def reextract_pdf(node_id: str) -> tuple[dict[str, Any], str | None, int]:
    """이미 등록된 PDF 를 **원본 그대로** 다시 추출한다 (AI 호출 0회).

    extractor 를 고친 뒤 기존 업로드분에 반영하려면 예전에는 파일을 지우고 다시
    올려야 했다. 이 함수가 그 왕복을 없앤다. 원본 PDF(`files/{node_id}.pdf`)는
    건드리지 않고 문항만 다시 뽑는다.

    **기존 풀이와 변형은 지운다.** 재추출로 문항 번호와 크롭 영역이 달라질 수 있어
    (예: 0문항 → 15문항) 예전 풀이·변형이 다른 문제에 붙을 수 있기 때문이다.
    오답노트 항목은 추가 시점의 크롭을 스냅샷으로 갖고 있으므로 그대로 둔다.

    Args:
        node_id: 시험지 파일 노드 id.

    Returns:
        (파일 상세, 추출 실패 사유 또는 None, 삭제된 풀이 건수).

    Raises:
        ApiError: 파일 노드가 아니거나 없을 때(400/404), 원본 PDF 가
            사라졌을 때(400).
    """
    with storage.transaction() as conn:
        require_file_node(conn, node_id)

    stored_path = config.files_dir() / f"{node_id}.pdf"
    if not stored_path.is_file():
        raise bad_request(
            "raw_missing",
            "원본 PDF 파일을 찾을 수 없습니다.",
            "파일을 삭제한 뒤 다시 업로드해 주세요.",
        )
    raw = stored_path.read_bytes()

    extract_error: str | None = None
    pages = 0
    mode = "text"
    pua_ratio = 0.0
    problem_rows: list[dict[str, Any]] = []

    try:
        result = extractor.extract_problems(pdf_bytes=raw)
    except (extractor.ExtractionError, ValueError) as exc:
        extract_error = f"문제 추출에 실패했습니다: {exc}"
    except Exception as exc:
        extract_error = f"문제 추출 중 예상치 못한 오류가 발생했습니다: {exc}"
    else:
        pages = result.page_count
        mode = result.mode
        pua_ratio = result.pua_ratio
        # 문항 수가 줄면 예전 크롭이 남아 다음 추출 결과와 섞인다. 먼저 비운다.
        _clear_crops(node_id)
        problem_rows = _write_crops(node_id, result)
        if not problem_rows:
            extract_error = _no_problem_error(result)

    with storage.transaction() as conn:
        deleted_solutions = storage.delete_solutions(conn, node_id)
        storage.delete_variants(conn, node_id)
        storage.upsert_file(
            conn,
            node_id=node_id,
            stored_path=f"files/{node_id}.pdf",
            pages=pages,
            mode=mode,
            pua_ratio=pua_ratio,
            problem_count=len(problem_rows),
            # 성공이면 None → 옛 사유가 남지 않는다(재추출로 해결된 경우).
            extract_error=extract_error,
        )
        storage.replace_problems(conn, node_id, problem_rows)

    return file_detail(node_id), extract_error, deleted_solutions


def apply_ocr_problems(node_id: str, result: extractor.ExtractResult) -> int:
    """OCR 로 찾은 문항을 그 시험지에 반영한다 (블로킹, AI 호출 0회).

    스캔본은 텍스트 레이어가 없어 일반 추출이 0문항으로 끝난다. 그 뒤 작업 큐의
    `ocr` 작업이 페이지를 OCR 로 읽어 앵커를 만들고(`ocr.extract_with_ocr`), 그
    결과를 여기서 저장한다.

    **풀이·변형은 건드리지 않는다.** 이 함수가 불리는 시점의 문항 수는 0 이다 —
    업로드 직후이거나 재추출 직후(재추출이 이미 풀이를 지웠다)이기 때문에 지울
    것이 없다. 여기서 또 지우면 "OCR 이 풀이를 날렸다" 는 경로가 생긴다.

    Args:
        node_id: 시험지 파일 노드 id.
        result: OCR 앵커로 추출한 결과(`mode='image'`).

    Returns:
        저장한 문항 수.

    Raises:
        ApiError: 시험지 파일 노드가 아니거나 없을 때.
    """
    with storage.transaction() as conn:
        require_file_node(conn, node_id)

    # 문항 수가 줄면 예전 크롭이 남아 다음 결과와 섞인다(재추출과 같은 이유).
    _clear_crops(node_id)
    problem_rows = _write_crops(node_id, result)

    with storage.transaction() as conn:
        storage.upsert_file(
            conn,
            node_id=node_id,
            stored_path=f"files/{node_id}.pdf",
            pages=result.page_count,
            mode=result.mode,
            pua_ratio=result.pua_ratio,
            problem_count=len(problem_rows),
            # 성공이면 None. 실패면 "스캔본이라 0문항" 이 아니라 "OCR 도 못 찾았다"
            # 로 바꾼다 — 앞 문구는 OCR 을 예약했다고 안내하기 때문이다.
            extract_error=None if problem_rows else _OCR_NO_ANCHOR_ERROR,
        )
        storage.replace_problems(conn, node_id, problem_rows)
    return len(problem_rows)


def _clear_crops(node_id: str) -> None:
    """그 시험지의 크롭 PNG 를 모두 지운다(디렉터리는 남긴다)."""
    crop_dir = config.crops_dir() / node_id
    if not crop_dir.is_dir():
        return
    for path in crop_dir.glob("*.png"):
        path.unlink(missing_ok=True)


def _write_crops(
    node_id: str, result: extractor.ExtractResult
) -> list[dict[str, Any]]:
    """크롭 PNG 를 `data/crops/{node_id}/q{no:02d}.png` 로 저장한다."""
    crop_dir = config.crops_dir() / node_id
    crop_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    for problem in result.problems:
        relative = f"crops/{node_id}/q{problem.no:02d}.png"
        if problem.image_b64:
            (config.data_dir() / relative).write_bytes(
                base64.b64decode(problem.image_b64)
            )
        rows.append(
            {
                "no": problem.no,
                "page": problem.page,
                "bbox": problem.bbox,
                "crop_path": relative,
                "image_w": problem.image_w,
                "image_h": problem.image_h,
                "text": problem.text,
                "label": problem.label or str(problem.no),
            }
        )
    return rows


# ------------------------------------------------------------------ 조회
def file_detail(node_id: str) -> dict[str, Any]:
    """`GET /api/files/{id}` 용 상세.

    `extract_error` 는 **마지막 추출**의 실패/0문항 사유다(성공이면 None). 화면이
    0문항 안내를 고정 문구가 아니라 실제 사유로 그릴 수 있도록 여기서 내려보낸다.
    판정은 이미 백엔드에서 끝났고(`_no_problem_error`), 값은 완성된 한국어
    문장이다. 마이그레이션 이전 업로드분은 백필하지 않았으므로 None 일 수 있다.
    """
    with storage.transaction() as conn:
        node = require_file_node(conn, node_id)
        file_row = storage.get_file(conn, node_id)
        problems = storage.list_problems(conn, node_id)
        solved = storage.solved_numbers(conn, node_id)
    return {
        "node": node,
        "extract_error": (file_row or {}).get("extract_error"),
        "problems": [
            {
                "no": problem["no"],
                "label": problem.get("label") or str(problem["no"]),
                "page": problem["page"],
                "bbox": problem["bbox"],
                "image_w": problem["image_w"],
                "image_h": problem["image_h"],
                "has_solution": problem["no"] in solved,
                # 판독본은 **본문을 싣지 않는다**(풀이와 같은 규칙).
                # 전문은 `GET /api/files/{id}/transcripts` 로 받는다.
                "has_transcript": bool(problem.get("transcript")),
                "transcript_source": problem.get("transcript_source"),
                "transcript_note": problem.get("transcript_note"),
            }
            for problem in problems
        ],
    }


# --------------------------------------------------------------- 판독본
# 조회는 풀이(`solutions`)와 같은 모양이다 — 목록 응답에는 있음/출처만 싣고
# 전문은 전용 라우트로 받는다. 판독본은 문항당 최대 2만 자라 파일 상세에 통째로
# 실으면 시험지를 열 때마다 수백 KB 를 내려보내게 된다.


def transcripts(node_id: str) -> list[dict[str, Any]]:
    """`GET /api/files/{id}/transcripts` 용 판독본 목록(문항 번호 순).

    판독본도 없고 이유도 없는(= 아직 판독하지 않은) 문항은 빼고 돌려준다.
    빈 항목을 실어 보내도 화면에 그릴 것이 없다.

    Args:
        node_id: 시험지 파일 노드 id.

    Returns:
        `{"no", "transcript", "transcript_source", "transcript_note"}` 목록.

    Raises:
        ApiError: 파일 노드가 아니거나 없을 때.
    """
    with storage.transaction() as conn:
        require_file_node(conn, node_id)
        problems = storage.list_problems(conn, node_id)
    return [
        {
            "no": int(problem["no"]),
            "transcript": problem.get("transcript"),
            "transcript_source": problem.get("transcript_source"),
            "transcript_note": problem.get("transcript_note"),
        }
        for problem in problems
        if problem.get("transcript") or problem.get("transcript_note")
    ]


def save_transcript(node_id: str, no: int, text: str) -> dict[str, Any]:
    """사용자가 고친 판독본을 저장한다(`transcript_source='manual'`).

    빈 문자열(공백뿐인 값 포함)이면 판독본을 **지운다** — 사용자가 되돌리는
    경로다. 지우면 출처와 이유도 함께 비므로 다음 재실행이 그 문항을 다시
    판독한다(`storage.transcribed_numbers` 가 빈 판독본을 세지 않는다).

    `manual` 은 `force` 없는 재실행이 덮지 않는다(`storage.set_transcript` 의
    보호 조건). 여기서는 사용자가 직접 쓰는 경로라 기존 값이 `manual` 이어도
    덮어쓴다.

    Args:
        node_id: 시험지 파일 노드 id.
        no: 문항 번호.
        text: 저장할 전문. 빈 문자열이면 삭제.

    Returns:
        저장 후 상태(`transcripts` 항목과 같은 모양).

    Raises:
        ApiError: 파일 노드가 아니거나 문항이 없을 때(400/404),
            길이 상한을 넘겼을 때(400).
    """
    cleaned = text.strip()
    if len(cleaned) > config.MAX_TRANSCRIPT_LENGTH:
        raise bad_request(
            "transcript_too_long",
            "판독본이 너무 깁니다."
            f" {config.MAX_TRANSCRIPT_LENGTH:,}자 이내로 줄여 주세요.",
            f"현재 {len(cleaned):,}자입니다.",
        )
    with storage.transaction() as conn:
        require_file_node(conn, node_id)
        if storage.get_problem(conn, node_id, no) is None:
            raise not_found(
                f"{no}번 문항이 없습니다.",
                "문제 목록을 새로고침해 번호를 확인하세요.",
            )
        storage.set_transcript(
            conn,
            node_id=node_id,
            no=no,
            transcript=cleaned or None,
            source=storage.TRANSCRIPT_MANUAL if cleaned else None,
            note=None,
            overwrite_manual=True,
        )
        saved = storage.get_problem(conn, node_id, no)
    problem = saved or {}
    return {
        "no": no,
        "transcript": problem.get("transcript"),
        "transcript_source": problem.get("transcript_source"),
        "transcript_note": problem.get("transcript_note"),
    }


def raw_pdf_path(node_id: str) -> Path:
    """업로드 원본 PDF 경로.

    Raises:
        ApiError: 파일 노드가 아니거나 원본이 사라졌을 때.
    """
    with storage.transaction() as conn:
        require_file_node(conn, node_id)
        meta = storage.get_file(conn, node_id)
    stored = (meta or {}).get("stored_path") or f"files/{node_id}.pdf"
    path = config.data_dir() / str(stored)
    if not path.is_file():
        raise not_found(
            "업로드된 PDF 원본을 찾을 수 없습니다.",
            "파일을 다시 업로드하세요.",
        )
    return path


def crop_path(node_id: str, no: int) -> Path:
    """문제 크롭 PNG 경로.

    Raises:
        ApiError: 문항이 없거나 크롭 이미지가 없을 때.
    """
    with storage.transaction() as conn:
        require_file_node(conn, node_id)
        problem = storage.get_problem(conn, node_id, no)
    if problem is None:
        raise not_found(
            f"{no}번 문항이 없습니다.",
            "문제 목록을 새로고침해 번호를 확인하세요.",
        )
    path = config.data_dir() / str(problem["crop_path"])
    if not path.is_file():
        raise not_found(
            f"{no}번 문항의 크롭 이미지가 없습니다.",
            "파일을 다시 업로드해 추출을 재실행하세요.",
        )
    return path


def _display_exam_name(name: str) -> str:
    """파일명에서 뒤쪽 `.pdf` 확장자를 한 번 벗겨낸 표시용 이름.

    내보내기 파일명이 `[...].pdf_문제.docx` 처럼 되지 않게 한다.
    """
    stripped = name.strip()
    if stripped.lower().endswith(".pdf"):
        stripped = stripped[:-4].strip()
    return stripped or name.strip()


# 내보내기 형식(확장자)과 구성. `include` 기본값은 하위호환을 위해 `problems` 다.
ExportFormat = Literal["docx", "hwpx"]
ExportInclude = Literal["problems", "full"]
# 문항 본문(크롭 이미지 / 판독본 텍스트). 단일 소스는 `export.build` 다.
ExportBody = export_build.BodyMode

_RENDERERS: Final[dict[str, Callable[[ExportDoc], bytes]]] = {
    "docx": export.build_docx,
    "hwpx": export.build_hwpx,
}


def _export_filename(
    display_name: str,
    *,
    variants: bool,
    fmt: ExportFormat,
    include: ExportInclude,
) -> str:
    """다운로드 파일명. `<이름>_문제.docx` / `<이름>_변형문제와해설.hwpx` 형태."""
    kind = "변형문제" if variants else "문제"
    tail = "와해설" if include == "full" else ""
    return f"{display_name}_{kind}{tail}.{fmt}"


def export_exam(
    node_id: str,
    *,
    fmt: ExportFormat = "docx",
    include: ExportInclude = "problems",
    source: str | None = None,
    body: ExportBody = "image",
) -> tuple[bytes, str]:
    """시험지를 문서로 내보낸다.

    문항을 **번호 순서대로** 순회하며 크롭 PNG 를 삽입한다. `include="full"` 이면
    저장된 풀이를 문항 뒤에 붙인다(`## 문제 확인` 은 제외).

    `body="text"` 면 크롭 대신 판독본(`problems.transcript`)을 텍스트로 조판하고,
    판독본이 없는 문항만 이미지로 낸다(혼합). 판독본만 있고 크롭 파일이 사라진
    문항도 이때는 내보낼 수 있다.

    Args:
        node_id: 시험지 파일 노드 id.
        fmt: `docx` 또는 `hwpx`.
        include: `problems`(문제만) 또는 `full`(문제+해설).
        source: 문서 끝에 넣을 출처(예: 학원 이름). None 이면 넣지 않는다.
        body: `image`(기본, 지금과 동일) 또는 `text`(판독본 우선).

    Returns:
        (문서 바이트, 다운로드 파일명).

    Raises:
        ApiError: 파일이 아니거나 없을 때(400/404), 내보낼 문항/이미지가 없을 때(400).
    """
    with storage.transaction() as conn:
        node = require_file_node(conn, node_id)
        problems = storage.list_problems(conn, node_id)
        solutions_by_no = (
            {
                int(row["no"]): str(row["solution"])
                for row in storage.list_solutions(conn, node_id)
            }
            if include == "full"
            else {}
        )
    if not problems:
        raise bad_request(
            "no_problems",
            "내보낼 문항이 없습니다.",
            "문항이 추출된 시험지인지 확인하세요.",
        )

    items: list[export_build.ExamItem] = []
    for problem in sorted(problems, key=lambda item: int(item["no"])):
        crop = config.data_dir() / str(problem["crop_path"])
        has_crop = crop.is_file()
        transcript = problem.get("transcript") if body == "text" else None
        if not has_crop and not transcript:
            # 낼 것이 아무것도 없는 문항. 제목만 남기지 않고 통째로 건너뛴다.
            continue
        no = int(problem["no"])
        items.append(
            export_build.ExamItem(
                no=no,
                # 지면 표기. `no` 와 같으면 조립부가 예전 제목을 그대로 쓴다.
                label=str(problem.get("label") or ""),
                image=crop if has_crop else None,
                solution=solutions_by_no.get(no),
                transcript=transcript,
                transcript_source=problem.get("transcript_source"),
            )
        )
    if not items:
        raise bad_request(
            "no_crops",
            "내보낼 문항 이미지가 없습니다.",
            "파일을 다시 업로드해 추출을 재실행하세요.",
        )

    display_name = _display_exam_name(str(node["name"]))
    doc = export_build.build_exam_doc(
        title=display_name,
        items=items,
        include_full=include == "full",
        source=source,
        body=body,
    )
    filename = _export_filename(
        display_name, variants=False, fmt=fmt, include=include
    )
    return _RENDERERS[fmt](doc), filename


def export_variants(
    node_id: str,
    *,
    fmt: ExportFormat = "docx",
    include: ExportInclude = "problems",
    source: str | None = None,
    body: ExportBody = "image",
) -> tuple[bytes, str]:
    """저장된 변형 문제를 문서로 내보낸다.

    원본 크롭은 넣지 않는다(변형 문제만 배포할 수 있어야 한다). 한 문항에 여러
    변형 종류가 저장돼 있으면 모두 넣는다(번호 → 종류 순).

    Args:
        node_id: 시험지 파일 노드 id.
        fmt: `docx` 또는 `hwpx`.
        include: `problems`(변형 문제만) 또는 `full`(정답·풀이 포함).
        source: 문서 끝에 넣을 출처(예: 학원 이름). None 이면 넣지 않는다.
        body: **받기만 하고 쓰지 않는다.** 변형 문서에는 애초에 크롭 이미지가 없고
            본문이 이미 텍스트다. 내보내기 6개 라우트가 같은 쿼리를 받도록
            시그니처만 맞춘다(판독본 고지도 붙이지 않는다 — 변형은 복원본이
            아니라 AI 가 새로 만든 문제다).

    Returns:
        (문서 바이트, 다운로드 파일명).

    Raises:
        ApiError: 파일이 아니거나 없을 때(400/404), 저장된 변형이 없을 때(400).
    """
    with storage.transaction() as conn:
        node = require_file_node(conn, node_id)
        rows = storage.list_variants(conn, node_id)
        # `variants` 에는 `no` 만 있어 지면 표기를 따로 조회한다.
        labels = storage.problem_labels(conn, node_id)
    if not rows:
        raise bad_request(
            "no_variants",
            "내보낼 변형 문제가 없습니다.",
            "문항을 열어 변형 문제를 먼저 생성하세요.",
        )

    items = [
        export_build.VariantItem(
            no=int(row["no"]),
            mode=str(row["mode"]),
            text=str(row["text"]),
            label=labels.get(int(row["no"]), ""),
        )
        for row in rows
    ]
    display_name = _display_exam_name(str(node["name"]))
    doc = export_build.build_variants_doc(
        title=f"{display_name} 변형 문제",
        items=items,
        include_full=include == "full",
        source=source,
    )
    filename = _export_filename(display_name, variants=True, fmt=fmt, include=include)
    return _RENDERERS[fmt](doc), filename


def export_note(
    note_id: str,
    *,
    fmt: ExportFormat = "docx",
    include: ExportInclude = "problems",
    source: str | None = None,
    body: ExportBody = "image",
) -> tuple[bytes, str]:
    """오답노트를 문서로 내보낸다.

    원본이 삭제된 항목(`source_node_id IS NULL`)도 스냅샷 크롭으로 넣는다.
    `include="full"` 이면 **원본이 살아 있고 저장된 풀이가 있는** 항목에만
    풀이가 붙는다.

    `body="text"` 면 담을 때 복사한 판독본 스냅샷(`note_items.transcript`)을
    쓴다 — 원본 시험지가 지워진 항목도 텍스트로 나간다. 현재 원본의 판독본을
    다시 읽지 않는 것이 요점이다(크롭 스냅샷과 같은 규칙).

    Args:
        note_id: 오답노트 노드 id.
        fmt: `docx` 또는 `hwpx`.
        include: `problems`(문제만) 또는 `full`(문제+해설).
        source: 문서 끝에 넣을 출처(예: 학원 이름). None 이면 넣지 않는다.
        body: `image`(기본, 지금과 동일) 또는 `text`(판독본 스냅샷 우선).

    Returns:
        (문서 바이트, 다운로드 파일명).

    Raises:
        ApiError: 오답노트가 아니거나 없을 때(400/404), 항목이 없을 때(400).
    """
    with storage.transaction() as conn:
        node = require_note_node(conn, note_id)
        rows = storage.list_note_items(conn, note_id)
        solutions_by_item: dict[str, str] = {}
        if include == "full":
            for row in rows:
                source_id = row["source_node_id"]
                if source_id is None:
                    continue
                saved = storage.get_solution(
                    conn, str(source_id), int(row["problem_no"])
                )
                if saved is not None:
                    solutions_by_item[str(row["id"])] = str(saved["solution"])
    if not rows:
        raise bad_request(
            "no_items",
            "내보낼 오답노트 항목이 없습니다.",
            "시험지에서 문항을 담은 뒤 다시 시도하세요.",
        )

    items: list[export_build.NoteItem] = []
    for row in rows:
        snapshot = str(row["crop_snapshot_path"] or "")
        image = config.data_dir() / snapshot if snapshot else None
        items.append(
            export_build.NoteItem(
                source_name=_display_exam_name(str(row["source_name"])),
                problem_no=int(row["problem_no"]),
                # 담을 때 복사한 지면 표기 스냅샷. 원본을 다시 읽지 않는다
                # (크롭·판독본 스냅샷과 같은 규칙).
                label=str(row.get("problem_label") or ""),
                image=image if image is not None and image.is_file() else None,
                memo=row["memo"],
                solution=solutions_by_item.get(str(row["id"])),
                transcript=row.get("transcript") if body == "text" else None,
                transcript_source=row.get("transcript_source"),
            )
        )

    display_name = _display_exam_name(str(node["name"]))
    doc = export_build.build_note_doc(
        title=display_name,
        items=items,
        include_full=include == "full",
        source=source,
        body=body,
    )
    filename = _export_filename(
        display_name, variants=False, fmt=fmt, include=include
    )
    return _RENDERERS[fmt](doc), filename


def variants(node_id: str) -> list[dict[str, Any]]:
    """저장된 변형 목록(파일 노드 검증 포함).

    프론트가 시험지를 열 때 받아 스토어를 채운다 — 새로고침해도 남고, 이미 만든
    변형을 다시 생성해 쿼터를 낭비하지 않는다.
    """
    with storage.transaction() as conn:
        require_file_node(conn, node_id)
        return storage.list_variants(conn, node_id)


def solutions(node_id: str) -> list[dict[str, Any]]:
    """저장된 풀이 목록(파일 노드 검증 포함)."""
    with storage.transaction() as conn:
        require_file_node(conn, node_id)
        return storage.list_solutions(conn, node_id)


def save_solution_content(
    node_id: str,
    no: int,
    *,
    content: str,
    usage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """주어진 내용을 그 문항의 풀이로 저장(upsert)하고 저장된 풀이를 돌려준다.

    대화 답변을 "풀이" 탭에 완료로 반영할 때 쓴다. 이미 풀이가 있으면 덮어쓴다
    (기존 solve 저장과 동일한 upsert). agy 사용이라 `cost` 는 저장하지 않는다.

    Raises:
        ApiError: 파일이 아니거나 없을 때(400/404), 문항 번호가 없을 때(404).
    """
    with storage.transaction() as conn:
        require_file_node(conn, node_id)
        if storage.get_problem(conn, node_id, no) is None:
            raise not_found(
                f"{no}번 문항이 없습니다.",
                "문제 목록을 새로고침해 번호를 확인하세요.",
            )
        storage.upsert_solution(
            conn,
            node_id=node_id,
            no=no,
            solution=content,
            usage=usage,
            cost=None,
            truncated=False,
        )
        saved = storage.get_solution(conn, node_id, no)
    assert saved is not None  # 방금 upsert 했으므로 반드시 존재.
    return saved


def chat_history(node_id: str, problem_no: int | None = None) -> dict[str, Any]:
    """한 스레드의 채팅 이력.

    `truncated_before` 는 이 스레드에서 **AI 컨텍스트로 전달되지 않는** 앞쪽 메시지
    수다(= truncation 되는 개수). 요약(compaction)이 아니라 그냥 버려지는 것이므로
    프론트가 "이전 대화 일부가 생략됩니다" 를 띄울 수 있게 그 수를 함께 준다.
    """
    with storage.transaction() as conn:
        require_file_node(conn, node_id)
        messages = storage.list_chat_messages(conn, node_id, problem_no=problem_no)
    return {
        "problem_no": problem_no,
        "messages": messages,
        "truncated_before": max(0, len(messages) - config.CHAT_HISTORY_LIMIT),
    }


def chat_threads(node_id: str) -> list[dict[str, Any]]:
    """시험지의 스레드 목록(전역 스레드 먼저, 그 뒤 문항 번호 순)."""
    with storage.transaction() as conn:
        require_file_node(conn, node_id)
        return storage.list_chat_threads(conn, node_id)


def clear_chat(node_id: str, problem_no: int | None = None) -> None:
    """한 스레드의 채팅 이력을 지운다(`problem_no=None` 이면 전역 스레드)."""
    with storage.transaction() as conn:
        require_file_node(conn, node_id)
        storage.clear_chat_thread(conn, node_id, problem_no=problem_no)


# --------------------------------------------------------- 전역(자유) 대화
# ChatGPT 식 파일 무관 자유 대화. 시험지 채팅과 별도 테이블/엔드포인트다.
DEFAULT_CONVERSATION_TITLE: Final[str] = "새 대화"


def _auto_title(message: str) -> str:
    """첫 사용자 메시지에서 뽑는 자동 제목(공백 정리 후 앞 30자)."""
    cleaned = " ".join(message.split())
    return cleaned[:30] if cleaned else DEFAULT_CONVERSATION_TITLE


def _require_conversation(
    conn: sqlite3.Connection, conversation_id: str
) -> dict[str, Any]:
    conversation = storage.get_conversation(conn, conversation_id)
    if conversation is None:
        raise not_found(
            f"대화를 찾을 수 없습니다. (id={conversation_id})",
            "새로고침 후 다시 시도하세요. 이미 삭제된 대화일 수 있습니다.",
        )
    return conversation


def create_conversation(title: str | None) -> dict[str, Any]:
    """새 대화를 만든다. `title` 이 비면 기본 제목("새 대화")을 쓴다."""
    cleaned = (
        _clean_name(title) if title and title.strip() else DEFAULT_CONVERSATION_TITLE
    )
    with storage.transaction() as conn:
        conversation_id = storage.new_id()
        storage.insert_conversation(
            conn, conversation_id=conversation_id, title=cleaned
        )
        conversation = storage.get_conversation(conn, conversation_id)
    assert conversation is not None
    return conversation


def list_conversations() -> list[dict[str, Any]]:
    """대화 목록(updated_at 내림차순, 마지막 메시지 preview 포함)."""
    with storage.transaction() as conn:
        return storage.list_conversations(conn)


def rename_conversation(conversation_id: str, title: str) -> dict[str, Any]:
    """대화 이름을 바꾼다.

    Raises:
        ApiError: 대화가 없을 때(404) 또는 이름이 비었을 때(400).
    """
    cleaned = _clean_name(title)
    with storage.transaction() as conn:
        _require_conversation(conn, conversation_id)
        storage.update_conversation_title(conn, conversation_id, cleaned)
        conversation = storage.get_conversation(conn, conversation_id)
    assert conversation is not None
    return conversation


def delete_conversation(conversation_id: str) -> None:
    """대화와 딸린 메시지를 지운다.

    Raises:
        ApiError: 대화가 없을 때(404).
    """
    with storage.transaction() as conn:
        _require_conversation(conn, conversation_id)
        storage.delete_conversation(conn, conversation_id)


def conversation_messages(conversation_id: str) -> list[dict[str, Any]]:
    """대화 메시지 목록(시간순).

    Raises:
        ApiError: 대화가 없을 때(404).
    """
    with storage.transaction() as conn:
        _require_conversation(conn, conversation_id)
        return storage.list_conversation_messages(conn, conversation_id)


def save_conversation_user_message(
    *,
    conversation_id: str,
    message: str,
    file_id: str | None = None,
    problem_no: int | None = None,
) -> None:
    """사용자 메시지를 저장한다 (블로킹).

    이번이 대화의 **첫 메시지**이고 제목이 아직 기본값("새 대화")이면 메시지
    앞부분으로 제목을 자동 설정한다. 사용자 메시지 저장은 `updated_at` 도 갱신한다.
    """
    with storage.transaction() as conn:
        conversation = storage.get_conversation(conn, conversation_id)
        if conversation is None:
            return
        is_first = storage.count_conversation_messages(conn, conversation_id) == 0
        storage.add_conversation_message(
            conn,
            message_id=storage.new_id(),
            conversation_id=conversation_id,
            role="user",
            content=message,
            file_id=file_id,
            problem_no=problem_no,
        )
        if is_first and conversation["title"] == DEFAULT_CONVERSATION_TITLE:
            storage.update_conversation_title(
                conn, conversation_id, _auto_title(message)
            )
        else:
            storage.touch_conversation(conn, conversation_id)


def save_conversation_assistant_message(
    *,
    conversation_id: str,
    content: str,
    file_id: str | None = None,
    problem_no: int | None = None,
    usage: dict[str, Any] | None = None,
    cost: dict[str, Any] | None = None,
) -> None:
    """AI(assistant) 메시지를 저장하고 `updated_at` 을 갱신한다 (블로킹)."""
    with storage.transaction() as conn:
        if storage.get_conversation(conn, conversation_id) is None:
            return
        storage.add_conversation_message(
            conn,
            message_id=storage.new_id(),
            conversation_id=conversation_id,
            role="assistant",
            content=content,
            file_id=file_id,
            problem_no=problem_no,
            usage=usage,
            cost=cost,
        )
        storage.touch_conversation(conn, conversation_id)


# --------------------------------------------------------------- 사용량
def usage_summary() -> dict[str, dict[str, dict[str, int]]]:
    """풀이+채팅 토큰 사용량을 시간 창(24시간/7일/전체)별로 집계한다."""
    with storage.transaction() as conn:
        windows = storage.usage_summary(conn)
    return {"windows": windows}


# ------------------------------------------------------------- 오답노트
def create_note(name: str, parent_id: str | None) -> dict[str, Any]:
    """오답노트(section='note' 인 파일형 노드)를 만든다.

    Raises:
        ApiError: 이름이 비었거나 상위 폴더가 없거나 시험지 섹션 폴더일 때.
    """
    cleaned = _clean_name(name)
    with storage.transaction() as conn:
        _require_folder_parent(conn, parent_id, storage.SECTION_NOTE)
        node_id = storage.new_id()
        storage.insert_node(
            conn,
            node_id=node_id,
            node_type="file",
            name=cleaned,
            parent_id=parent_id,
            section=storage.SECTION_NOTE,
        )
        node = storage.get_node(conn, node_id)
    assert node is not None
    return node


# 문두 번호("3." "12.")를 한 번만 벗겨낸다.
_LEADING_NO_RE: Final[re.Pattern[str]] = re.compile(r"^\s*\d{1,2}\s*\.\s*")
_PUA_START: Final[int] = 0xE000
_PUA_END: Final[int] = 0xF8FF


def _clean_problem_text(text: str | None) -> str | None:
    r"""오답노트 표시용으로 파싱 텍스트를 정리한다.

    이미지 모드 시험지는 수식이 PUA(U+E000~U+F8FF)로 깨져 들어와 그대로 두면
    tofu(□) 로 보인다. PUA 와 제어/포맷 문자를 공백으로 치환하고 문두 번호를
    제거한 뒤 공백을 정돈한다. 남는 내용이 없으면 None 을 돌려준다.

    개행(``\n``)/탭(``\t``)은 문단 구조라 보존한다.
    """
    if not text:
        return None
    chars: list[str] = []
    for ch in text:
        if _PUA_START <= ord(ch) <= _PUA_END:
            chars.append(" ")
            continue
        if ch in ("\n", "\t"):
            chars.append(ch)
            continue
        if unicodedata.category(ch).startswith("C"):
            # 그 밖의 제어/포맷/서로게이트 문자는 공백으로.
            chars.append(" ")
            continue
        chars.append(ch)
    cleaned = _LEADING_NO_RE.sub("", "".join(chars), count=1)
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r" *\n *", "\n", cleaned)
    cleaned = cleaned.strip()
    return cleaned or None


def _note_item_out(
    item: dict[str, Any], *, source_available: bool, text: str | None = None
) -> dict[str, Any]:
    snapshot = str(item["crop_snapshot_path"] or "")
    has_snapshot = bool(snapshot) and (config.data_dir() / snapshot).is_file()
    return {
        "id": item["id"],
        "source_node_id": item["source_node_id"],
        "source_name": item["source_name"],
        "problem_no": item["problem_no"],
        "crop_url": (
            f"/api/notes/{item['note_node_id']}/items/{item['id']}/crop"
            if has_snapshot
            else None
        ),
        "text": text,
        "memo": item["memo"],
        "created_at": item["created_at"],
        "source_available": source_available,
    }


def note_detail(note_id: str) -> dict[str, Any]:
    """`GET /api/notes/{note_id}` 용 상세(항목 목록 포함)."""
    with storage.transaction() as conn:
        node = require_note_node(conn, note_id)
        items = storage.list_note_items(conn, note_id)
        # 원본이 살아 있는지는 노드 존재로 판정한다. 삭제되면 source_node_id 가
        # NULL 이 되지만, 방어적으로 노드 조회도 한다.
        alive = {
            str(item["source_node_id"])
            for item in items
            if item["source_node_id"] is not None
            and storage.get_node(conn, str(item["source_node_id"])) is not None
        }
        # 원본이 살아 있는 항목만 그 문항의 파싱 텍스트를 조회·정리한다.
        texts: dict[str, str | None] = {}
        for item in items:
            source_id = item["source_node_id"]
            if source_id is None or str(source_id) not in alive:
                continue
            problem = storage.get_problem(
                conn, str(source_id), int(item["problem_no"])
            )
            texts[str(item["id"])] = _clean_problem_text(
                problem["text"] if problem else None
            )
    return {
        "node": node,
        "items": [
            _note_item_out(
                item,
                source_available=str(item["source_node_id"]) in alive,
                text=texts.get(str(item["id"])),
            )
            for item in items
        ],
    }


def add_note_items(
    note_id: str,
    *,
    source_node_id: str,
    problem_numbers: Sequence[int],
    memo: str | None,
) -> dict[str, list[int]]:
    """여러 문항을 한 번에 담는다. 이미 있는 문항은 `skipped` 로 돌려준다(멱등).

    추가 시점의 시험지 이름·크롭 PNG·**판독본·지면 번호 표기**를 스냅샷으로
    복사해 둔다. 원본을 참조하면 원본 삭제 시 깨지기 때문이다(설계 §3-3). 담은
    뒤에 원본 판독본을 다시 만들거나 고쳐도 이미 담은 항목은 담긴 그 시점의
    텍스트·표기로 남는다.

    Raises:
        ApiError: 노트/시험지를 찾을 수 없거나 없는 문항 번호일 때.
    """
    wanted = sorted(dict.fromkeys(int(no) for no in problem_numbers))
    added: list[int] = []
    skipped: list[int] = []
    copies: list[tuple[Path, Path]] = []

    with storage.transaction() as conn:
        require_note_node(conn, note_id)
        source = require_file_node(conn, source_node_id)
        problems = storage.list_problems(conn, source_node_id)
        by_no = {problem["no"]: problem for problem in problems}
        missing = [no for no in wanted if no not in by_no]
        if missing:
            raise bad_request(
                "problem_not_found",
                f"이 시험지에 없는 문항 번호입니다: {missing}",
                f"사용 가능한 번호: {sorted(by_no)}",
            )

        for no in wanted:
            if storage.note_item_exists(
                conn,
                note_node_id=note_id,
                source_node_id=source_node_id,
                problem_no=no,
            ):
                skipped.append(no)
                continue
            item_id = storage.new_id()
            origin = config.data_dir() / str(by_no[no]["crop_path"])
            snapshot = (
                f"note_crops/{item_id}.png" if origin.is_file() else ""
            )
            inserted = storage.insert_note_item(
                conn,
                item_id=item_id,
                note_node_id=note_id,
                source_node_id=source_node_id,
                source_name=str(source["name"]),
                problem_no=no,
                crop_snapshot_path=snapshot,
                memo=memo,
                transcript=by_no[no].get("transcript"),
                transcript_source=by_no[no].get("transcript_source"),
                problem_label=by_no[no].get("label"),
            )
            if not inserted:  # 동시 요청이 먼저 넣은 경우
                skipped.append(no)
                continue
            added.append(no)
            if snapshot:
                copies.append((origin, config.data_dir() / snapshot))

    config.ensure_dirs()
    for origin, destination in copies:
        shutil.copyfile(origin, destination)
    return {"added": added, "skipped": skipped}


def delete_note_item(note_id: str, item_id: str) -> None:
    """노트 항목 1건과 그 크롭 스냅샷을 지운다.

    Raises:
        ApiError: 노트가 아니거나 항목이 그 노트에 없을 때.
    """
    with storage.transaction() as conn:
        require_note_node(conn, note_id)
        item = storage.get_note_item(conn, item_id)
        if item is None or item["note_node_id"] != note_id:
            raise not_found(
                "오답노트 항목을 찾을 수 없습니다.",
                "새로고침 후 다시 시도하세요. 이미 삭제된 항목일 수 있습니다.",
            )
        storage.delete_note_item(conn, item_id)
    _remove_note_snapshot(item_id)


def note_crop_path(note_id: str, item_id: str) -> Path:
    """노트 항목의 크롭 스냅샷 PNG 경로.

    Raises:
        ApiError: 항목이 없거나 스냅샷 파일이 없을 때(404).
    """
    with storage.transaction() as conn:
        require_note_node(conn, note_id)
        item = storage.get_note_item(conn, item_id)
    if item is None or item["note_node_id"] != note_id:
        raise not_found(
            "오답노트 항목을 찾을 수 없습니다.",
            "새로고침 후 다시 시도하세요.",
        )
    snapshot = str(item["crop_snapshot_path"] or "")
    path = config.data_dir() / snapshot
    if not snapshot or not path.is_file():
        raise not_found(
            f"{item['problem_no']}번 문항의 크롭 스냅샷이 없습니다.",
            "추가 시점에 크롭 이미지가 없었을 수 있습니다.",
        )
    return path


__all__ = [
    "ApiError",
    "add_note_items",
    "chat_history",
    "chat_threads",
    "clear_chat",
    "conversation_messages",
    "create_conversation",
    "create_folder",
    "create_note",
    "crop_path",
    "delete_conversation",
    "delete_node",
    "delete_note_item",
    "export_exam",
    "export_note",
    "export_variants",
    "file_detail",
    "list_conversations",
    "list_tree",
    "note_crop_path",
    "note_detail",
    "raw_pdf_path",
    "reextract_pdf",
    "register_pdf",
    "rename_conversation",
    "require_file_node",
    "require_note_node",
    "save_conversation_assistant_message",
    "save_conversation_user_message",
    "save_transcript",
    "solutions",
    "transcripts",
    "update_node",
    "validate_pdf",
    "variants",
]
