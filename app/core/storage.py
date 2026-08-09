"""SQLite 저장소 (ARCHITECTURE.md 7항 스키마).

* 커넥션은 요청/작업마다 열고 닫는다(스레드 간 공유 금지).
* 모든 함수는 **블로킹** 이다. `async def` 안에서 부르려면
  `run_in_threadpool` 로 감싼다.
* `problems.image_w / image_h` 두 컬럼은 문서 스키마에 더한 것이다
  (`GET /api/files/{id}` 응답이 크롭 픽셀 크기를 요구하므로).
* 마이그레이션(`migrate`)은 **파괴적이지 않다**. 기존 사용자 데이터가 살아 있으므로
  drop/recreate 없이 `ALTER TABLE ADD COLUMN` 과 `CREATE ... IF NOT EXISTS` 만 쓴다.
  여러 번 실행해도 안전하다(멱등).
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Final

import config

KST: Final[timezone] = timezone(timedelta(hours=9))

# 섹션: 'exam'(시험지) | 'note'(오답노트).
SECTION_EXAM: Final[str] = "exam"
SECTION_NOTE: Final[str] = "note"

# 스키마 버전. 1 = 최초, 2 = nodes.section / chat_messages.problem_no / note_items,
# 3 = jobs(작업 큐), 4 = variants(변형 저장).
SCHEMA_VERSION: Final[int] = 5

SCHEMA: Final[str] = """
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    parent_id TEXT NULL,
    section TEXT NOT NULL DEFAULT 'exam',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);

CREATE TABLE IF NOT EXISTS files (
    node_id TEXT PRIMARY KEY,
    stored_path TEXT NOT NULL,
    pages INTEGER NOT NULL,
    mode TEXT NOT NULL,
    pua_ratio REAL NOT NULL,
    problem_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS problems (
    node_id TEXT NOT NULL,
    no INTEGER NOT NULL,
    page INTEGER NOT NULL,
    bbox TEXT NOT NULL,
    crop_path TEXT NOT NULL,
    image_w INTEGER NOT NULL DEFAULT 0,
    image_h INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL DEFAULT '',
    -- 원문에 찍힌 번호 표기. `no` 는 저장용 통짜 순번이라 구획마다 번호가
    -- 되돌아가는 교재에서는 둘이 다르다(extractor._renumber_duplicates).
    label TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (node_id, no)
);

CREATE TABLE IF NOT EXISTS solutions (
    node_id TEXT NOT NULL,
    no INTEGER NOT NULL,
    solution TEXT NOT NULL,
    usage_json TEXT NULL,
    cost_json TEXT NULL,
    truncated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (node_id, no)
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL,
    problem_no INTEGER NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    usage_json TEXT NULL,
    cost_json TEXT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_node ON chat_messages(node_id, id);

CREATE TABLE IF NOT EXISTS note_items (
    id TEXT PRIMARY KEY,
    note_node_id TEXT NOT NULL,
    source_node_id TEXT NULL,
    source_name TEXT NOT NULL,
    problem_no INTEGER NOT NULL,
    crop_snapshot_path TEXT NOT NULL DEFAULT '',
    memo TEXT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (note_node_id, source_node_id, problem_no)
);
CREATE INDEX IF NOT EXISTS idx_note_items_note ON note_items(note_node_id);
CREATE INDEX IF NOT EXISTS idx_note_items_source ON note_items(source_node_id);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '새 대화',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    file_id TEXT NULL,
    problem_no INTEGER NULL,
    usage_json TEXT NULL,
    cost_json TEXT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conv_messages
    ON conversation_messages(conversation_id, created_at, id);

-- 풀이·변형 작업 큐. 진행 상태만 갖고, 결과는 solutions/variants 에 저장된다.
-- 서버가 재시작해도 이력이 남도록 영속한다(실행 상태는 jobs.py 가 메모리에 든다).
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    node_id TEXT NOT NULL,
    node_name TEXT NOT NULL,
    targets_json TEXT NOT NULL,
    params_json TEXT NOT NULL,
    status TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    done_count INTEGER NOT NULL DEFAULT 0,
    current_no INTEGER NULL,
    error TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_node ON jobs(node_id, status);

-- 변형 문항. (시험지, 문항, 변형종류) 당 **최신 1건**만 둔다.
-- "다시 생성" 은 같은 키를 덮어쓴다(upsert). 이력을 쌓으면 내보낼 때 어느 것을
-- 고를지 정해야 하는 문제가 생기는데, 선생님이 원하는 건 최신 한 벌이다.
CREATE TABLE IF NOT EXISTS variants (
    node_id TEXT NOT NULL,
    no INTEGER NOT NULL,
    mode TEXT NOT NULL,
    text TEXT NOT NULL,
    usage_json TEXT NULL,
    cost_json TEXT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (node_id, no, mode)
);
"""

# `SCHEMA` 뒤(= 컬럼 추가 뒤)에만 만들 수 있는 인덱스.
# 기존 DB 에는 `problem_no` / `section` 컬럼이 없으므로 마이그레이션 후에 만든다.
POST_MIGRATION_SCHEMA: Final[str] = """
CREATE INDEX IF NOT EXISTS idx_nodes_section ON nodes(section, parent_id);
CREATE INDEX IF NOT EXISTS idx_chat_thread
    ON chat_messages(node_id, problem_no, id);
"""


def new_id() -> str:
    """노드 ID (짧은 16진 문자열)."""
    return uuid.uuid4().hex[:12]


def now_iso() -> str:
    """한국 시간(KST) ISO-8601 문자열."""
    return datetime.now(KST).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    """새 커넥션. 호출자가 닫아야 한다."""
    config.ensure_dirs()
    conn = sqlite3.connect(config.db_path(), timeout=15.0)
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    """커넥션 + 트랜잭션. 예외가 나면 롤백한다."""
    conn = connect()
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    """테이블의 컬럼 이름 집합(테이블이 없으면 빈 집합)."""
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {str(row["name"]) for row in rows}


def user_version(conn: sqlite3.Connection) -> int:
    """`PRAGMA user_version` 값."""
    row = conn.execute("PRAGMA user_version").fetchone()
    return 0 if row is None else int(row[0])


def migrate(conn: sqlite3.Connection) -> None:
    """기존 DB 를 파괴하지 않고 스키마를 올린다 (멱등).

    사용자 데이터가 살아 있는 DB 를 다루므로 drop/recreate 를 하지 않는다.
    컬럼 존재를 `PRAGMA table_info` 로 확인하고 `ALTER TABLE ADD COLUMN` 만 쓴다.
    """
    node_columns = table_columns(conn, "nodes")
    if node_columns and "section" not in node_columns:
        # SQLite 는 NOT NULL 컬럼 추가 시 기본값이 있으면 기존 행을 그 값으로 채운다.
        conn.execute(
            f"ALTER TABLE nodes ADD COLUMN section TEXT NOT NULL DEFAULT '{SECTION_EXAM}'"
        )
    if node_columns:
        # 방어적 백필: 과거에 NULL/빈 값으로 들어간 행이 있어도 'exam' 으로 맞춘다.
        conn.execute(
            "UPDATE nodes SET section = ? WHERE section IS NULL OR section = ''",
            (SECTION_EXAM,),
        )

    chat_columns = table_columns(conn, "chat_messages")
    if chat_columns and "problem_no" not in chat_columns:
        # 기존 행은 NULL 로 남는다 = 시험지 전역 스레드.
        conn.execute("ALTER TABLE chat_messages ADD COLUMN problem_no INTEGER NULL")

    problem_columns = table_columns(conn, "problems")
    if problem_columns and "label" not in problem_columns:
        conn.execute("ALTER TABLE problems ADD COLUMN label TEXT NOT NULL DEFAULT ''")
    if problem_columns:
        # 방어적 백필: 컬럼만 있고 값이 빈 행(구버전 삽입분)도 번호로 채운다.
        # 예전에는 번호가 곧 표기였다.
        conn.execute(
            "UPDATE problems SET label = CAST(no AS TEXT)"
            " WHERE label IS NULL OR label = ''"
        )

    conn.executescript(POST_MIGRATION_SCHEMA)
    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def init_db() -> None:
    """스키마를 만들고 WAL 모드를 켠 뒤 마이그레이션을 적용한다."""
    conn = connect()
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        migrate(conn)
        conn.commit()
    finally:
        conn.close()


def _loads(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return loaded if isinstance(loaded, dict) else None


def _dumps(value: dict[str, Any] | None) -> str | None:
    return None if value is None else json.dumps(value, ensure_ascii=False)


# ---------------------------------------------------------------- usage 집계
# `total_tokens` 가 없을 때 더할 토큰 필드. agy 형(input/output/thinking/
# cache_read)과 Anthropic 형(cache_creation_input/cache_read_input)을 모두 포함한다.
_TOKEN_FIELDS: Final[tuple[str, ...]] = (
    "input_tokens",
    "output_tokens",
    "thinking_tokens",
    "cache_read_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
)


def _as_int(value: Any) -> int:
    """토큰 값을 방어적으로 int 로 바꾼다(숫자/숫자문자열이 아니면 0)."""
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(float(value))
        except ValueError:
            return 0
    return 0


def _usage_tokens(usage: dict[str, Any]) -> int:
    """Usage dict 한 건의 토큰 수.

    `total_tokens` 가 숫자로 있으면 그 값을, 없으면 알려진 토큰 필드의 합을 쓴다.
    """
    total = usage.get("total_tokens")
    if isinstance(total, bool):
        pass
    elif isinstance(total, (int, float)):
        return int(total)
    elif isinstance(total, str):
        try:
            return int(float(total))
        except ValueError:
            pass
    return sum(_as_int(usage.get(field)) for field in _TOKEN_FIELDS)


def _parse_created_at(raw: str | None) -> datetime | None:
    """`created_at`(KST ISO-8601, `now_iso()`) 을 tz-aware datetime 으로.

    파싱 불가/빈 값이면 None. 과거 데이터가 오프셋 없이 저장돼 있으면 KST 로 본다.
    """
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=KST)
    return parsed


def usage_summary(conn: sqlite3.Connection) -> dict[str, dict[str, int]]:
    """풀이+채팅+전역 대화의 토큰 사용량을 시간 창별로 집계한다.

    `solutions` / `chat_messages` / `conversation_messages` 의
    `usage_json`(NULL 아닌 행)을 모두 읽어 행별 토큰 수(`_usage_tokens`)를 더하고,
    usage 가 있는 행 수를 센다. 시간 창은 `created_at` 기준으로 최근
    24시간 / 7일 / 전체(제한 없음)로 나눈다.
    """
    now = datetime.now(KST)
    cutoff_24h = now - timedelta(hours=24)
    cutoff_7d = now - timedelta(days=7)
    windows: dict[str, dict[str, int]] = {
        "last_24h": {"tokens": 0, "calls": 0},
        "last_7_days": {"tokens": 0, "calls": 0},
        "total": {"tokens": 0, "calls": 0},
    }
    rows = conn.execute(
        "SELECT usage_json, created_at FROM solutions WHERE usage_json IS NOT NULL"
        " UNION ALL"
        " SELECT usage_json, created_at FROM chat_messages WHERE usage_json IS NOT NULL"
        " UNION ALL"
        " SELECT usage_json, created_at FROM conversation_messages"
        " WHERE usage_json IS NOT NULL"
    ).fetchall()
    for row in rows:
        usage = _loads(row["usage_json"])
        if usage is None:
            continue
        tokens = _usage_tokens(usage)
        created = _parse_created_at(row["created_at"])
        windows["total"]["tokens"] += tokens
        windows["total"]["calls"] += 1
        if created is not None and created >= cutoff_7d:
            windows["last_7_days"]["tokens"] += tokens
            windows["last_7_days"]["calls"] += 1
        if created is not None and created >= cutoff_24h:
            windows["last_24h"]["tokens"] += tokens
            windows["last_24h"]["calls"] += 1
    return windows


# ---------------------------------------------------------------- nodes
def _node_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    node: dict[str, Any] = {
        "id": row["id"],
        "type": row["type"],
        "name": row["name"],
        "parent_id": row["parent_id"],
        "section": row["section"] or SECTION_EXAM,
        "created_at": row["created_at"],
        "file": None,
    }
    if row["type"] == "file" and row["pages"] is not None:
        node["file"] = {
            "pages": int(row["pages"]),
            "problem_count": int(row["problem_count"]),
            "mode": row["mode"],
            "pua_ratio": float(row["pua_ratio"]),
        }
    return node


_NODE_SELECT: Final[str] = """
SELECT n.id, n.type, n.name, n.parent_id, n.section, n.created_at,
       f.pages, f.problem_count, f.mode, f.pua_ratio
  FROM nodes n
  LEFT JOIN files f ON f.node_id = n.id
"""


def list_nodes(
    conn: sqlite3.Connection, *, section: str = SECTION_EXAM
) -> list[dict[str, Any]]:
    """한 섹션의 노드를 플랫 배열로. 폴더 먼저 → 이름 오름차순(한글 포함).

    한글 음절은 유니코드 코드포인트 순서가 가나다 순서와 일치하므로
    별도 collation 없이 파이썬 기본 문자열 정렬을 쓴다.
    """
    rows = conn.execute(f"{_NODE_SELECT} WHERE n.section = ?", (section,)).fetchall()
    nodes = [_node_row_to_dict(row) for row in rows]
    nodes.sort(key=lambda node: (0 if node["type"] == "folder" else 1, node["name"]))
    return nodes


def get_node(conn: sqlite3.Connection, node_id: str) -> dict[str, Any] | None:
    """노드 1건(없으면 None)."""
    row = conn.execute(f"{_NODE_SELECT} WHERE n.id = ?", (node_id,)).fetchone()
    return None if row is None else _node_row_to_dict(row)


def insert_node(
    conn: sqlite3.Connection,
    *,
    node_id: str,
    node_type: str,
    name: str,
    parent_id: str | None,
    section: str = SECTION_EXAM,
) -> None:
    """노드를 추가한다."""
    conn.execute(
        "INSERT INTO nodes (id, type, name, parent_id, section, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (node_id, node_type, name, parent_id, section, now_iso()),
    )


def update_node_fields(
    conn: sqlite3.Connection,
    node_id: str,
    *,
    name: str | None = None,
    parent_id: str | None = None,
    set_parent: bool = False,
) -> None:
    """이름/부모를 갱신한다. `set_parent=True` 면 `parent_id=None` 도 반영한다."""
    assignments: list[str] = []
    params: list[Any] = []
    if name is not None:
        assignments.append("name = ?")
        params.append(name)
    if set_parent:
        assignments.append("parent_id = ?")
        params.append(parent_id)
    if not assignments:
        return
    params.append(node_id)
    conn.execute(f"UPDATE nodes SET {', '.join(assignments)} WHERE id = ?", params)


def child_ids(conn: sqlite3.Connection, node_id: str) -> list[str]:
    """직계 자식 ID 목록."""
    rows = conn.execute("SELECT id FROM nodes WHERE parent_id = ?", (node_id,))
    return [str(row["id"]) for row in rows]


def subtree_ids(conn: sqlite3.Connection, node_id: str) -> list[str]:
    """자기 자신 + 모든 자손 ID (너비 우선)."""
    collected = [node_id]
    frontier = [node_id]
    seen = {node_id}
    while frontier:
        current = frontier.pop()
        for child in child_ids(conn, current):
            if child in seen:  # 방어: 데이터가 깨져 순환이 생긴 경우
                continue
            seen.add(child)
            collected.append(child)
            frontier.append(child)
    return collected


def delete_nodes(conn: sqlite3.Connection, node_ids: Sequence[str]) -> None:
    """노드와 딸린 파일/문제/풀이/변형/채팅/노트항목 레코드를 지운다.

    노트 항목 처리는 두 규칙이 다르다(ARCHITECTURE 7항).
      1. **노트 노드**(`note_node_id`)가 지워지면 그 안의 항목도 지운다.
      2. **원본 시험지**(`source_node_id`)가 지워지면 항목은 **남기고**
         `source_node_id` 만 NULL 로 만든다(스냅샷으로 계속 보여준다).
    순서가 중요하다 — 1을 먼저 하지 않으면 지워질 노트의 항목까지 detach 된다.
    """
    if not node_ids:
        return
    marks = ",".join("?" for _ in node_ids)
    params = tuple(node_ids)
    conn.execute(f"DELETE FROM note_items WHERE note_node_id IN ({marks})", params)
    conn.execute(
        f"UPDATE note_items SET source_node_id = NULL WHERE source_node_id IN ({marks})",
        params,
    )
    for table in ("chat_messages", "solutions", "variants", "problems", "files"):
        conn.execute(f"DELETE FROM {table} WHERE node_id IN ({marks})", params)
    conn.execute(f"DELETE FROM nodes WHERE id IN ({marks})", params)


# ---------------------------------------------------------------- files
def upsert_file(
    conn: sqlite3.Connection,
    *,
    node_id: str,
    stored_path: str,
    pages: int,
    mode: str,
    pua_ratio: float,
    problem_count: int,
) -> None:
    """파일 메타를 넣거나 갱신한다."""
    conn.execute(
        """
        INSERT INTO files (node_id, stored_path, pages, mode, pua_ratio, problem_count)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
            stored_path = excluded.stored_path,
            pages = excluded.pages,
            mode = excluded.mode,
            pua_ratio = excluded.pua_ratio,
            problem_count = excluded.problem_count
        """,
        (node_id, stored_path, pages, mode, pua_ratio, problem_count),
    )


def get_file(conn: sqlite3.Connection, node_id: str) -> dict[str, Any] | None:
    """파일 메타(없으면 None)."""
    row = conn.execute("SELECT * FROM files WHERE node_id = ?", (node_id,)).fetchone()
    return None if row is None else dict(row)


def replace_problems(
    conn: sqlite3.Connection, node_id: str, problems: Sequence[dict[str, Any]]
) -> None:
    """문제 목록을 통째로 다시 쓴다."""
    conn.execute("DELETE FROM problems WHERE node_id = ?", (node_id,))
    conn.executemany(
        """
        INSERT INTO problems
            (node_id, no, page, bbox, crop_path, image_w, image_h, text, label)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                node_id,
                int(problem["no"]),
                int(problem["page"]),
                json.dumps(problem["bbox"]),
                str(problem["crop_path"]),
                int(problem["image_w"]),
                int(problem["image_h"]),
                str(problem.get("text") or ""),
                str(problem.get("label") or problem["no"]),
            )
            for problem in problems
        ],
    )


def _problem_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    bbox = json.loads(row["bbox"])
    return {
        "no": int(row["no"]),
        "page": int(row["page"]),
        "bbox": [float(v) for v in bbox],
        "crop_path": row["crop_path"],
        # `sqlite3.Row` 는 `in` 으로 키를 못 물으므로 keys() 목록으로 확인한다.
        # (마이그레이션 전에 열린 커넥션이 label 없는 행을 줄 수 있다.)
        "label": str(row["label"] if "label" in list(row.keys()) else row["no"]),
        "image_w": int(row["image_w"]),
        "image_h": int(row["image_h"]),
        "text": row["text"],
    }


def list_problems(conn: sqlite3.Connection, node_id: str) -> list[dict[str, Any]]:
    """문항 목록(번호 오름차순)."""
    rows = conn.execute(
        "SELECT * FROM problems WHERE node_id = ? ORDER BY no", (node_id,)
    ).fetchall()
    return [_problem_row_to_dict(row) for row in rows]


def get_problem(conn: sqlite3.Connection, node_id: str, no: int) -> dict[str, Any] | None:
    """문항 1건(없으면 None)."""
    row = conn.execute(
        "SELECT * FROM problems WHERE node_id = ? AND no = ?", (node_id, no)
    ).fetchone()
    return None if row is None else _problem_row_to_dict(row)


# ---------------------------------------------------------------- solutions
def upsert_solution(
    conn: sqlite3.Connection,
    *,
    node_id: str,
    no: int,
    solution: str,
    usage: dict[str, Any] | None,
    cost: dict[str, Any] | None,
    truncated: bool,
) -> None:
    """풀이를 넣거나 갱신한다."""
    conn.execute(
        """
        INSERT INTO solutions
            (node_id, no, solution, usage_json, cost_json, truncated, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id, no) DO UPDATE SET
            solution = excluded.solution,
            usage_json = excluded.usage_json,
            cost_json = excluded.cost_json,
            truncated = excluded.truncated,
            created_at = excluded.created_at
        """,
        (
            node_id,
            no,
            solution,
            _dumps(usage),
            _dumps(cost),
            int(truncated),
            now_iso(),
        ),
    )


def list_solutions(conn: sqlite3.Connection, node_id: str) -> list[dict[str, Any]]:
    """저장된 풀이 목록."""
    rows = conn.execute(
        "SELECT * FROM solutions WHERE node_id = ? ORDER BY no", (node_id,)
    ).fetchall()
    return [
        {
            "no": int(row["no"]),
            "solution": row["solution"],
            "usage": _loads(row["usage_json"]),
            "cost": _loads(row["cost_json"]),
            "truncated": bool(row["truncated"]),
            "created_at": row["created_at"],
        }
        for row in rows
    ]


def solved_numbers(conn: sqlite3.Connection, node_id: str) -> set[int]:
    """풀이가 있는 문항 번호 집합."""
    rows = conn.execute("SELECT no FROM solutions WHERE node_id = ?", (node_id,))
    return {int(row["no"]) for row in rows}


def delete_solutions(conn: sqlite3.Connection, node_id: str) -> int:
    """그 시험지의 풀이를 모두 지우고 지운 건수를 돌려준다.

    재추출로 문항 번호·영역이 달라지면 기존 풀이가 엉뚱한 문항에 붙는다.
    그래서 재추출은 풀이를 남기지 않는다.

    Args:
        conn: 열린 커넥션.
        node_id: 시험지 노드 id.

    Returns:
        삭제된 풀이 건수.
    """
    cursor = conn.execute("DELETE FROM solutions WHERE node_id = ?", (node_id,))
    return int(cursor.rowcount or 0)


def get_solution(
    conn: sqlite3.Connection, node_id: str, no: int
) -> dict[str, Any] | None:
    """풀이 1건(없으면 None)."""
    row = conn.execute(
        "SELECT * FROM solutions WHERE node_id = ? AND no = ?", (node_id, no)
    ).fetchone()
    if row is None:
        return None
    return {
        "no": int(row["no"]),
        "solution": row["solution"],
        "usage": _loads(row["usage_json"]),
        "cost": _loads(row["cost_json"]),
        "truncated": bool(row["truncated"]),
        "created_at": row["created_at"],
    }


# ---------------------------------------------------------------- variants
# 변형 문항. (node_id, no, mode) 당 최신 1건만 남긴다(이력 없음).
def upsert_variant(
    conn: sqlite3.Connection,
    *,
    node_id: str,
    no: int,
    mode: str,
    text: str,
    usage: dict[str, Any] | None = None,
    cost: dict[str, Any] | None = None,
) -> None:
    """변형 문항을 넣거나 갱신한다(같은 키는 덮어쓴다).

    Args:
        conn: 열린 커넥션.
        node_id: 시험지 노드 id.
        no: 원본 문항 번호.
        mode: 변형 종류(`number` / `condition` / `number_condition`).
        text: 변형 응답 원문(`## 문제 / ## 정답 / ## 풀이` 마크다운).
        usage: 토큰 사용량(없으면 None).
        cost: 비용(없으면 None).
    """
    conn.execute(
        """
        INSERT INTO variants
            (node_id, no, mode, text, usage_json, cost_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id, no, mode) DO UPDATE SET
            text = excluded.text,
            usage_json = excluded.usage_json,
            cost_json = excluded.cost_json,
            created_at = excluded.created_at
        """,
        (node_id, no, mode, text, _dumps(usage), _dumps(cost), now_iso()),
    )


def _variant_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "no": int(row["no"]),
        "mode": row["mode"],
        "text": row["text"],
        "usage": _loads(row["usage_json"]),
        "cost": _loads(row["cost_json"]),
        "created_at": row["created_at"],
    }


def list_variants(conn: sqlite3.Connection, node_id: str) -> list[dict[str, Any]]:
    """저장된 변형 목록(문항 번호 → mode 순).

    mode 정렬은 프론트 탭 순서(`number` → `condition` → `number_condition`)를
    따른다. 알파벳 순은 `condition` 이 먼저 와 탭 순서와 어긋난다.
    """
    rows = conn.execute(
        """
        SELECT * FROM variants WHERE node_id = ?
         ORDER BY no,
               CASE mode
                   WHEN 'number' THEN 0
                   WHEN 'condition' THEN 1
                   WHEN 'number_condition' THEN 2
                   ELSE 3
               END,
               mode
        """,
        (node_id,),
    ).fetchall()
    return [_variant_row_to_dict(row) for row in rows]


def get_variant(
    conn: sqlite3.Connection, node_id: str, no: int, mode: str
) -> dict[str, Any] | None:
    """변형 1건(없으면 None)."""
    row = conn.execute(
        "SELECT * FROM variants WHERE node_id = ? AND no = ? AND mode = ?",
        (node_id, no, mode),
    ).fetchone()
    return None if row is None else _variant_row_to_dict(row)


def delete_variants(conn: sqlite3.Connection, node_id: str) -> int:
    """그 시험지의 변형을 모두 지우고 지운 건수를 돌려준다.

    재추출로 문항 번호·영역이 달라지면 기존 변형이 엉뚱한 문항에 붙는다
    (`delete_solutions` 와 같은 이유).

    Args:
        conn: 열린 커넥션.
        node_id: 시험지 노드 id.

    Returns:
        삭제된 변형 건수.
    """
    cursor = conn.execute("DELETE FROM variants WHERE node_id = ?", (node_id,))
    return int(cursor.rowcount or 0)


# ---------------------------------------------------------------- chat
# 스레드 = (node_id, problem_no). `problem_no IS NULL` 이 시험지 전역 스레드다.
# `problem_no IS ?` 는 SQLite 에서 NULL 바인딩도 올바르게 비교한다(`= NULL` 은 안 된다).
def add_chat_message(
    conn: sqlite3.Connection,
    *,
    node_id: str,
    role: str,
    content: str,
    problem_no: int | None = None,
    usage: dict[str, Any] | None = None,
    cost: dict[str, Any] | None = None,
) -> None:
    """채팅 메시지를 추가한다. `problem_no=None` 이면 전역 스레드."""
    conn.execute(
        """
        INSERT INTO chat_messages
            (node_id, problem_no, role, content, usage_json, cost_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            node_id,
            problem_no,
            role,
            content,
            _dumps(usage),
            _dumps(cost),
            now_iso(),
        ),
    )


def _chat_message_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "role": row["role"],
        "content": row["content"],
        "problem_no": None if row["problem_no"] is None else int(row["problem_no"]),
        "usage": _loads(row["usage_json"]),
        "cost": _loads(row["cost_json"]),
        "created_at": row["created_at"],
    }


def list_chat_messages(
    conn: sqlite3.Connection,
    node_id: str,
    *,
    problem_no: int | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """한 스레드의 이력을 오래된 순서로. `limit` 이 있으면 **최근 N개만**.

    `limit` 은 compaction 이 아니라 **truncation** 이다 — 앞쪽 메시지를 요약하지 않고
    그냥 버린다. 몇 개가 버려졌는지는 `count_chat_messages` 로 알 수 있고,
    호출자는 그 사실을 사용자에게 알려야 한다.
    """
    rows = conn.execute(
        "SELECT * FROM chat_messages WHERE node_id = ? AND problem_no IS ? ORDER BY id",
        (node_id, problem_no),
    ).fetchall()
    if limit is not None:
        rows = rows[-limit:]
    return [_chat_message_to_dict(row) for row in rows]


def count_chat_messages(
    conn: sqlite3.Connection, node_id: str, *, problem_no: int | None = None
) -> int:
    """한 스레드의 전체 메시지 수."""
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM chat_messages WHERE node_id = ? AND problem_no IS ?",
        (node_id, problem_no),
    ).fetchone()
    return 0 if row is None else int(row["n"])


def list_chat_threads(conn: sqlite3.Connection, node_id: str) -> list[dict[str, Any]]:
    """스레드 목록. 전역(problem_no NULL) 스레드가 먼저, 그 뒤 번호 오름차순."""
    rows = conn.execute(
        """
        SELECT problem_no,
               COUNT(*) AS turns,
               MAX(created_at) AS updated_at
          FROM chat_messages
         WHERE node_id = ?
         GROUP BY problem_no
         ORDER BY problem_no IS NOT NULL, problem_no
        """,
        (node_id,),
    ).fetchall()
    return [
        {
            "problem_no": None if row["problem_no"] is None else int(row["problem_no"]),
            "turns": int(row["turns"]),
            "updated_at": row["updated_at"],
        }
        for row in rows
    ]


def clear_chat_messages(conn: sqlite3.Connection, node_id: str) -> None:
    """파일의 모든 스레드를 지운다(노드 삭제 시)."""
    conn.execute("DELETE FROM chat_messages WHERE node_id = ?", (node_id,))


def clear_chat_thread(
    conn: sqlite3.Connection, node_id: str, *, problem_no: int | None = None
) -> None:
    """한 스레드만 지운다."""
    conn.execute(
        "DELETE FROM chat_messages WHERE node_id = ? AND problem_no IS ?",
        (node_id, problem_no),
    )


# ---------------------------------------------------------- conversations
# ChatGPT 식 전역(파일 무관) 자유 대화. 시험지 채팅(`chat_messages`)과 별도 테이블.
# 메시지 순서는 `created_at, rowid`(= 삽입 순서) 로 판정한다 — id 가 랜덤 hex 라
# id 정렬은 시간순이 아니기 때문이다.
def _preview(content: str, *, limit: int = 60) -> str:
    """대화 목록용 미리보기(공백 정리 후 앞 `limit` 자)."""
    cleaned = " ".join(content.split())
    return cleaned[:limit]


def insert_conversation(
    conn: sqlite3.Connection, *, conversation_id: str, title: str
) -> None:
    """대화를 추가한다. `created_at == updated_at`."""
    stamp = now_iso()
    conn.execute(
        "INSERT INTO conversations (id, title, created_at, updated_at)"
        " VALUES (?, ?, ?, ?)",
        (conversation_id, title, stamp, stamp),
    )


def get_conversation(
    conn: sqlite3.Connection, conversation_id: str
) -> dict[str, Any] | None:
    """대화 1건(없으면 None). preview 없이 메타만."""
    row = conn.execute(
        "SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?",
        (conversation_id,),
    ).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"],
        "title": row["title"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "preview": None,
    }


def list_conversations(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """대화 목록. `updated_at` 내림차순(동률이면 최근 생성 먼저).

    각 항목에 마지막 메시지 preview 를 포함한다(메시지가 없으면 None).
    """
    rows = conn.execute(
        """
        SELECT c.id, c.title, c.created_at, c.updated_at,
               (SELECT m.content FROM conversation_messages m
                 WHERE m.conversation_id = c.id
                 ORDER BY m.created_at DESC, m.rowid DESC
                 LIMIT 1) AS last_content
          FROM conversations c
         ORDER BY c.updated_at DESC, c.rowid DESC
        """
    ).fetchall()
    return [
        {
            "id": row["id"],
            "title": row["title"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "preview": (
                None if row["last_content"] is None else _preview(row["last_content"])
            ),
        }
        for row in rows
    ]


def update_conversation_title(
    conn: sqlite3.Connection, conversation_id: str, title: str
) -> None:
    """대화 제목을 바꾸고 `updated_at` 을 갱신한다."""
    conn.execute(
        "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
        (title, now_iso(), conversation_id),
    )


def touch_conversation(conn: sqlite3.Connection, conversation_id: str) -> None:
    """대화의 `updated_at` 만 현재 시각으로 갱신한다."""
    conn.execute(
        "UPDATE conversations SET updated_at = ? WHERE id = ?",
        (now_iso(), conversation_id),
    )


def delete_conversation(conn: sqlite3.Connection, conversation_id: str) -> None:
    """대화와 딸린 메시지를 지운다.

    FK(ON DELETE CASCADE)를 선언해 두었지만 이 코드베이스는 `PRAGMA foreign_keys`
    를 켜지 않으므로(기존 `delete_nodes` 와 동일), 메시지를 먼저 명시적으로 지운다.
    """
    conn.execute(
        "DELETE FROM conversation_messages WHERE conversation_id = ?",
        (conversation_id,),
    )
    conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))


def add_conversation_message(
    conn: sqlite3.Connection,
    *,
    message_id: str,
    conversation_id: str,
    role: str,
    content: str,
    file_id: str | None = None,
    problem_no: int | None = None,
    usage: dict[str, Any] | None = None,
    cost: dict[str, Any] | None = None,
) -> None:
    """대화 메시지를 추가한다."""
    conn.execute(
        """
        INSERT INTO conversation_messages
            (id, conversation_id, role, content, file_id, problem_no,
             usage_json, cost_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            message_id,
            conversation_id,
            role,
            content,
            file_id,
            problem_no,
            _dumps(usage),
            _dumps(cost),
            now_iso(),
        ),
    )


def _conversation_message_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "role": row["role"],
        "content": row["content"],
        "file_id": row["file_id"],
        "problem_no": None if row["problem_no"] is None else int(row["problem_no"]),
        "usage": _loads(row["usage_json"]),
        "cost": _loads(row["cost_json"]),
        "created_at": row["created_at"],
    }


def list_conversation_messages(
    conn: sqlite3.Connection, conversation_id: str, *, limit: int | None = None
) -> list[dict[str, Any]]:
    """대화 메시지를 시간순(오래된 순)으로. `limit` 이 있으면 **최근 N개만**."""
    rows = conn.execute(
        "SELECT * FROM conversation_messages"
        " WHERE conversation_id = ? ORDER BY created_at, rowid",
        (conversation_id,),
    ).fetchall()
    if limit is not None:
        rows = rows[-limit:]
    return [_conversation_message_to_dict(row) for row in rows]


def count_conversation_messages(conn: sqlite3.Connection, conversation_id: str) -> int:
    """대화의 전체 메시지 수."""
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ?",
        (conversation_id,),
    ).fetchone()
    return 0 if row is None else int(row["n"])


# ---------------------------------------------------------- note_items
def _note_item_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "note_node_id": row["note_node_id"],
        "source_node_id": row["source_node_id"],
        "source_name": row["source_name"],
        "problem_no": int(row["problem_no"]),
        "crop_snapshot_path": row["crop_snapshot_path"],
        "memo": row["memo"],
        "created_at": row["created_at"],
    }


def note_item_exists(
    conn: sqlite3.Connection, *, note_node_id: str, source_node_id: str, problem_no: int
) -> bool:
    """같은 (노트, 시험지, 문항) 항목이 이미 있는지."""
    row = conn.execute(
        "SELECT 1 FROM note_items"
        " WHERE note_node_id = ? AND source_node_id = ? AND problem_no = ?",
        (note_node_id, source_node_id, problem_no),
    ).fetchone()
    return row is not None


def insert_note_item(
    conn: sqlite3.Connection,
    *,
    item_id: str,
    note_node_id: str,
    source_node_id: str | None,
    source_name: str,
    problem_no: int,
    crop_snapshot_path: str,
    memo: str | None,
) -> bool:
    """노트 항목을 추가한다. 이미 있으면 아무것도 하지 않고 False."""
    cursor = conn.execute(
        """
        INSERT INTO note_items
            (id, note_node_id, source_node_id, source_name, problem_no,
             crop_snapshot_path, memo, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(note_node_id, source_node_id, problem_no) DO NOTHING
        """,
        (
            item_id,
            note_node_id,
            source_node_id,
            source_name,
            problem_no,
            crop_snapshot_path,
            memo,
            now_iso(),
        ),
    )
    return cursor.rowcount > 0


def list_note_items(conn: sqlite3.Connection, note_node_id: str) -> list[dict[str, Any]]:
    """노트 항목 목록(추가한 순서)."""
    rows = conn.execute(
        "SELECT * FROM note_items WHERE note_node_id = ? ORDER BY created_at, rowid",
        (note_node_id,),
    ).fetchall()
    return [_note_item_to_dict(row) for row in rows]


def get_note_item(conn: sqlite3.Connection, item_id: str) -> dict[str, Any] | None:
    """노트 항목 1건(없으면 None)."""
    row = conn.execute("SELECT * FROM note_items WHERE id = ?", (item_id,)).fetchone()
    return None if row is None else _note_item_to_dict(row)


def note_item_ids_for_notes(
    conn: sqlite3.Connection, note_node_ids: Sequence[str]
) -> list[str]:
    """주어진 노트들에 속한 항목 ID 목록(스냅샷 파일 정리용)."""
    if not note_node_ids:
        return []
    marks = ",".join("?" for _ in note_node_ids)
    rows = conn.execute(
        f"SELECT id FROM note_items WHERE note_node_id IN ({marks})",
        tuple(note_node_ids),
    )
    return [str(row["id"]) for row in rows]


def delete_note_item(conn: sqlite3.Connection, item_id: str) -> None:
    """노트 항목 1건을 지운다."""
    conn.execute("DELETE FROM note_items WHERE id = ?", (item_id,))


# --------------------------------------------------------------------- jobs
# 작업 큐. 상태만 영속하고 실행은 `jobs.py` 의 인메모리 러너가 맡는다.


def _job_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    """작업 행을 API 응답용 dict 로. JSON 컬럼은 파싱해 돌려준다."""
    return {
        "id": str(row["id"]),
        "kind": str(row["kind"]),
        "node_id": str(row["node_id"]),
        "node_name": str(row["node_name"]),
        "targets": json.loads(str(row["targets_json"])),
        "params": json.loads(str(row["params_json"])),
        "status": str(row["status"]),
        "total": int(row["total"]),
        "done_count": int(row["done_count"]),
        "current_no": None if row["current_no"] is None else int(row["current_no"]),
        "error": None if row["error"] is None else str(row["error"]),
        "created_at": str(row["created_at"]),
        "updated_at": str(row["updated_at"]),
    }


def insert_job(
    conn: sqlite3.Connection,
    *,
    job_id: str,
    kind: str,
    node_id: str,
    node_name: str,
    targets: Any,
    params: dict[str, Any],
    total: int,
) -> dict[str, Any]:
    """작업을 `queued` 상태로 넣고 그 행을 돌려준다."""
    stamp = now_iso()
    conn.execute(
        """
        INSERT INTO jobs
            (id, kind, node_id, node_name, targets_json, params_json,
             status, total, done_count, current_no, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, NULL, NULL, ?, ?)
        """,
        (
            job_id,
            kind,
            node_id,
            node_name,
            json.dumps(targets, ensure_ascii=False),
            json.dumps(params, ensure_ascii=False),
            total,
            stamp,
            stamp,
        ),
    )
    row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    assert row is not None
    return _job_row_to_dict(row)


def get_job(conn: sqlite3.Connection, job_id: str) -> dict[str, Any] | None:
    """작업 1건(없으면 None)."""
    row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return None if row is None else _job_row_to_dict(row)


def update_job(
    conn: sqlite3.Connection,
    job_id: str,
    **fields: Any,
) -> None:
    """작업의 일부 컬럼만 갱신한다(`updated_at` 은 자동).

    허용 컬럼: status, total, done_count, current_no, error.
    """
    allowed = {"status", "total", "done_count", "current_no", "error"}
    sets = [f"{key} = ?" for key in fields if key in allowed]
    values = [fields[key] for key in fields if key in allowed]
    if not sets:
        return
    sets.append("updated_at = ?")
    values.append(now_iso())
    values.append(job_id)
    conn.execute(f"UPDATE jobs SET {', '.join(sets)} WHERE id = ?", tuple(values))


def list_active_jobs(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """대기·실행 중인 작업(오래된 순)."""
    rows = conn.execute(
        """
        SELECT * FROM jobs WHERE status IN ('queued', 'running')
        ORDER BY created_at, id
        """
    ).fetchall()
    return [_job_row_to_dict(row) for row in rows]


def list_recent_jobs(conn: sqlite3.Connection, limit: int = 10) -> list[dict[str, Any]]:
    """최근 종료된 작업(최신 순)."""
    rows = conn.execute(
        """
        SELECT * FROM jobs WHERE status NOT IN ('queued', 'running')
        ORDER BY updated_at DESC, id DESC LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [_job_row_to_dict(row) for row in rows]


def find_active_job_for(
    conn: sqlite3.Connection, node_id: str, kind: str
) -> list[dict[str, Any]]:
    """그 시험지에 대해 진행 중인 같은 종류의 작업들(중복 요청 판정용)."""
    rows = conn.execute(
        """
        SELECT * FROM jobs
        WHERE node_id = ? AND kind = ? AND status IN ('queued', 'running')
        ORDER BY created_at, id
        """,
        (node_id, kind),
    ).fetchall()
    return [_job_row_to_dict(row) for row in rows]


def interrupt_unfinished_jobs(conn: sqlite3.Connection) -> int:
    """서버 시작 시 남아 있던 대기·실행 작업을 `interrupted` 로 표시한다.

    프로세스가 죽으면 인메모리 큐도 사라진다. 자동 재개는 하지 않는다 —
    중단 지점 추적과 중복 과금 위험이 있고, 사용자가 다시 걸면 이미 저장된
    문항은 건너뛰므로 손실이 적다.

    Returns:
        표시된 작업 수.
    """
    cursor = conn.execute(
        """
        UPDATE jobs SET status = 'interrupted', current_no = NULL, updated_at = ?
        WHERE status IN ('queued', 'running')
        """,
        (now_iso(),),
    )
    return int(cursor.rowcount or 0)
