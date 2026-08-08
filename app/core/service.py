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
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Final

import config
import docx_export
import extractor
import storage
from errors import ApiError, bad_request, not_found

PDF_MAGIC: Final[bytes] = b"%PDF"

_SECTION_LABELS: Final[dict[str, str]] = {
    storage.SECTION_EXAM: "시험지",
    storage.SECTION_NOTE: "오답노트",
}


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
            extract_error = (
                "문제 번호 앵커를 찾지 못했습니다. "
                "'1.' '2.' 형태의 문항 번호가 있는 시험지인지 확인하세요."
            )

    with storage.transaction() as conn:
        storage.upsert_file(
            conn,
            node_id=node_id,
            stored_path=f"files/{node_id}.pdf",
            pages=pages,
            mode=mode,
            pua_ratio=pua_ratio,
            problem_count=len(problem_rows),
        )
        storage.replace_problems(conn, node_id, problem_rows)
        node = storage.get_node(conn, node_id)
    assert node is not None
    return node, extract_error


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
            }
        )
    return rows


# ------------------------------------------------------------------ 조회
def file_detail(node_id: str) -> dict[str, Any]:
    """`GET /api/files/{id}` 용 상세."""
    with storage.transaction() as conn:
        node = require_file_node(conn, node_id)
        problems = storage.list_problems(conn, node_id)
        solved = storage.solved_numbers(conn, node_id)
    return {
        "node": node,
        "problems": [
            {
                "no": problem["no"],
                "page": problem["page"],
                "bbox": problem["bbox"],
                "image_w": problem["image_w"],
                "image_h": problem["image_h"],
                "has_solution": problem["no"] in solved,
            }
            for problem in problems
        ],
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


def problems_docx(node_id: str) -> tuple[bytes, str]:
    """시험지 문항 크롭 이미지를 '문제만' 담은 DOCX 바이트와 표시용 이름을 돌려준다.

    문항을 **번호 순서대로** 순회하며 크롭 PNG 를 삽입한다. 풀이/변형/정답은
    넣지 않는다(문제만).

    Returns:
        (docx 바이트, 표시용 시험지 이름(뒤 `.pdf` 제거)).

    Raises:
        ApiError: 파일이 아니거나 없을 때(400/404), 내보낼 문항/이미지가 없을 때(400).
    """
    with storage.transaction() as conn:
        node = require_file_node(conn, node_id)
        problems = storage.list_problems(conn, node_id)
    if not problems:
        raise bad_request(
            "no_problems",
            "내보낼 문항이 없습니다.",
            "문항이 추출된 시험지인지 확인하세요.",
        )
    images: list[tuple[int, Path]] = []
    for problem in sorted(problems, key=lambda item: int(item["no"])):
        crop = config.data_dir() / str(problem["crop_path"])
        if crop.is_file():
            images.append((int(problem["no"]), crop))
    if not images:
        raise bad_request(
            "no_crops",
            "내보낼 문항 이미지가 없습니다.",
            "파일을 다시 업로드해 추출을 재실행하세요.",
        )
    display_name = _display_exam_name(str(node["name"]))
    content = docx_export.build_problems_docx(display_name, images)
    return content, display_name


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
    """오답노트 표시용으로 파싱 텍스트를 정리한다.

    이미지 모드 시험지는 수식이 PUA(U+E000–U+F8FF)로 깨져 들어와 그대로 두면
    tofu(□) 로 보인다. PUA 와 제어/포맷 문자를 공백으로 치환하고 문두 번호를
    제거한 뒤 공백을 정돈한다. 남는 내용이 없으면 None 을 돌려준다.

    개행(``\\n``)/탭(``\\t``)은 문단 구조라 보존한다.
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

    추가 시점의 시험지 이름과 크롭 PNG 를 **스냅샷으로 복사**해 둔다. 원본
    크롭 경로를 참조하면 원본 삭제 시 깨지기 때문이다.

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
    "file_detail",
    "list_conversations",
    "list_tree",
    "note_crop_path",
    "note_detail",
    "problems_docx",
    "raw_pdf_path",
    "register_pdf",
    "rename_conversation",
    "require_file_node",
    "require_note_node",
    "save_conversation_assistant_message",
    "save_conversation_user_message",
    "solutions",
    "update_node",
    "validate_pdf",
]
