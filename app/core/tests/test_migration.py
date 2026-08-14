"""마이그레이션 테스트: 기존 DB 를 파괴하지 않고 컬럼/테이블만 더한다."""

from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

import config
import storage

# 마이그레이션 이전(v1) 스키마 그대로. section / problem_no / note_items 가 없다.
LEGACY_SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    parent_id TEXT NULL,
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
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    usage_json TEXT NULL,
    cost_json TEXT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_node ON chat_messages(node_id, id);
"""


def _make_legacy_db(path: Path) -> None:
    """v1 스키마 + 사용자 데이터가 들어 있는 DB 를 만든다."""
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.executescript(LEGACY_SCHEMA)
        conn.execute(
            "INSERT INTO nodes (id, type, name, parent_id, created_at)"
            " VALUES ('folder1', 'folder', 'test-hw', NULL, '2026-07-31T20:00:00+09:00')"
        )
        conn.execute(
            "INSERT INTO nodes (id, type, name, parent_id, created_at)"
            " VALUES ('file1', 'file', '[2026-1-1-M][공수1][풍문고].pdf', 'folder1',"
            " '2026-07-31T20:01:00+09:00')"
        )
        conn.execute(
            "INSERT INTO files"
            " (node_id, stored_path, pages, mode, pua_ratio, problem_count)"
            " VALUES ('file1', 'files/file1.pdf', 7, 'image', 0.39, 22)"
        )
        conn.executemany(
            "INSERT INTO problems (node_id, no, page, bbox, crop_path)"
            " VALUES ('file1', ?, 1, '[0,0,1,1]', ?)",
            [(no, f"crops/file1/q{no:02d}.png") for no in range(1, 23)],
        )
        conn.execute(
            "INSERT INTO chat_messages (node_id, role, content, created_at)"
            " VALUES ('file1', 'user', '예전 질문', '2026-07-31T20:02:00+09:00')"
        )
        conn.commit()
    finally:
        conn.close()


def test_migration_preserves_data_and_adds_schema(tmp_path: Path) -> None:
    data_dir = tmp_path / "legacy-data"
    _make_legacy_db(data_dir / "app.db")
    original = config.data_dir()
    try:
        config.use_data_dir(data_dir)
        storage.init_db()

        conn = storage.connect()
        try:
            # ⒜ 기존 데이터가 그대로 살아 있다.
            nodes = conn.execute(
                "SELECT id, name, section FROM nodes ORDER BY id"
            ).fetchall()
            assert [(row["id"], row["section"]) for row in nodes] == [
                ("file1", "exam"),
                ("folder1", "exam"),
            ]
            assert conn.execute(
                "SELECT problem_count FROM files WHERE node_id = 'file1'"
            ).fetchone()["problem_count"] == 22
            assert conn.execute(
                "SELECT COUNT(*) AS n FROM problems WHERE node_id = 'file1'"
            ).fetchone()["n"] == 22

            # ⒝ chat_messages.problem_no 는 NULL(전역 스레드)로 백필된다.
            chats = conn.execute(
                "SELECT content, problem_no FROM chat_messages"
            ).fetchall()
            assert [(row["content"], row["problem_no"]) for row in chats] == [
                ("예전 질문", None)
            ]

            # ⒞ 새 컬럼/테이블/인덱스가 생겼다.
            assert "section" in storage.table_columns(conn, "nodes")
            assert "problem_no" in storage.table_columns(conn, "chat_messages")
            assert storage.table_columns(conn, "note_items") == {
                "id",
                "note_node_id",
                "source_node_id",
                "source_name",
                "problem_no",
                "crop_snapshot_path",
                "memo",
                # 판독본 스냅샷(v7). 담을 때 복사하고 원본이 지워져도 남는다.
                "transcript",
                "transcript_source",
                "created_at",
            }
            indexes = {
                str(row["name"])
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'index'"
                )
            }
            assert {"idx_nodes_section", "idx_chat_thread"} <= indexes
            # 문항 텍스트화 3열이 생기고, 기존 행은 NULL(아직 판독 안 함)이다.
            assert {
                "transcript",
                "transcript_source",
                "transcript_note",
            } <= storage.table_columns(conn, "problems")
            assert storage.transcribed_numbers(conn, "file1") == set()
            assert storage.table_columns(conn, "variants") == {
                "node_id",
                "no",
                "mode",
                "text",
                "usage_json",
                "cost_json",
                "created_at",
            }
            assert storage.user_version(conn) == storage.SCHEMA_VERSION
        finally:
            conn.close()
    finally:
        config.use_data_dir(original)


def test_migration_is_idempotent(tmp_path: Path) -> None:
    data_dir = tmp_path / "legacy-data"
    _make_legacy_db(data_dir / "app.db")
    original = config.data_dir()
    try:
        config.use_data_dir(data_dir)
        for _ in range(3):  # 여러 번 기동해도 안전해야 한다
            storage.init_db()
        conn = storage.connect()
        try:
            assert conn.execute("SELECT COUNT(*) AS n FROM nodes").fetchone()["n"] == 2
            assert (
                conn.execute("SELECT COUNT(*) AS n FROM chat_messages").fetchone()["n"]
                == 1
            )
        finally:
            conn.close()
    finally:
        config.use_data_dir(original)


V2_EXTRA_SCHEMA = """
ALTER TABLE nodes ADD COLUMN section TEXT NOT NULL DEFAULT 'exam';
ALTER TABLE chat_messages ADD COLUMN problem_no INTEGER NULL;

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
PRAGMA user_version = 2;
"""


def _make_v2_db(path: Path) -> None:
    """v2 스키마(section / problem_no / note_items) + 사용자 데이터 DB."""
    _make_legacy_db(path)
    conn = sqlite3.connect(path)
    try:
        conn.executescript(V2_EXTRA_SCHEMA)
        conn.execute(
            "INSERT INTO solutions (node_id, no, solution, created_at)"
            " VALUES ('file1', 3, '예전 풀이', '2026-07-31T20:03:00+09:00')"
        )
        conn.commit()
    finally:
        conn.close()


def test_v2_db_gains_variants_table(tmp_path: Path) -> None:
    """v2 DB 를 열면 `variants` 가 생기고 기존 데이터는 그대로 남는다."""
    data_dir = tmp_path / "v2-data"
    _make_v2_db(data_dir / "app.db")
    original = config.data_dir()
    try:
        config.use_data_dir(data_dir)
        conn = storage.connect()
        try:
            assert storage.user_version(conn) == 2
        finally:
            conn.close()

        storage.init_db()

        conn = storage.connect()
        try:
            assert storage.user_version(conn) == storage.SCHEMA_VERSION == 7
            assert "variants" in {
                str(row["name"])
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            # 기존 데이터가 남아 있다.
            assert (
                conn.execute("SELECT COUNT(*) AS n FROM problems").fetchone()["n"] == 22
            )
            assert (
                conn.execute(
                    "SELECT solution FROM solutions WHERE node_id = 'file1' AND no = 3"
                ).fetchone()["solution"]
                == "예전 풀이"
            )
            # 새 테이블은 비어 있고 바로 쓸 수 있다.
            assert storage.list_variants(conn, "file1") == []
            storage.upsert_variant(
                conn, node_id="file1", no=3, mode="number", text="## 문제\n변형"
            )
            conn.commit()
            assert len(storage.list_variants(conn, "file1")) == 1
        finally:
            conn.close()
    finally:
        config.use_data_dir(original)


def test_migrated_db_serves_api(tmp_path: Path) -> None:
    """마이그레이션된 기존 DB 로 새 API(섹션/스레드/노트)가 동작한다."""
    import main

    data_dir = tmp_path / "legacy-data"
    _make_legacy_db(data_dir / "app.db")
    original = config.data_dir()
    try:
        config.use_data_dir(data_dir)
        with TestClient(main.app) as client:
            exam_nodes = client.get("/api/tree").json()["nodes"]
            assert {node["name"] for node in exam_nodes} == {
                "test-hw",
                "[2026-1-1-M][공수1][풍문고].pdf",
            }
            assert all(node["section"] == "exam" for node in exam_nodes)
            assert client.get("/api/tree", params={"section": "note"}).json() == {
                "nodes": []
            }

            # 기존 채팅은 전역 스레드로 보인다.
            threads = client.get("/api/files/file1/chat/threads").json()["threads"]
            assert threads == [
                {
                    "problem_no": None,
                    "turns": 1,
                    "updated_at": "2026-07-31T20:02:00+09:00",
                }
            ]

            note = client.post("/api/notes", json={"name": "이현우 오답"}).json()["node"]
            added = client.post(
                f"/api/notes/{note['id']}/items",
                json={"source_node_id": "file1", "problem_numbers": [5]},
            )
            assert added.status_code == 201
            assert added.json() == {"added": [5], "skipped": []}
            # 크롭 원본이 없는(파일이 지워진) 항목은 crop_url 이 null 이다.
            item = client.get(f"/api/notes/{note['id']}").json()["items"][0]
            assert item["crop_url"] is None
            assert item["source_available"] is True
    finally:
        config.use_data_dir(original)


def test_real_user_db_copy_migrates_safely(tmp_path: Path) -> None:
    """사용자 실제 DB **복사본**으로 마이그레이션 안전성을 검증한다.

    원본(`app/core/data/app.db`)은 읽기만 하고, 없으면 건너뛴다.
    """
    source = Path(__file__).resolve().parents[1] / "data" / "app.db"
    if not source.is_file():
        return
    data_dir = tmp_path / "copy-of-real"
    data_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, data_dir / "app.db")

    original = config.data_dir()
    try:
        config.use_data_dir(data_dir)
        before = storage.connect()
        try:
            names_before = [
                str(row["name"])
                for row in before.execute("SELECT name FROM nodes ORDER BY id")
            ]
            problems_before = int(
                before.execute("SELECT COUNT(*) AS n FROM problems").fetchone()["n"]
            )
        finally:
            before.close()

        storage.init_db()

        after = storage.connect()
        try:
            rows = after.execute("SELECT name, section FROM nodes ORDER BY id").fetchall()
            assert [str(row["name"]) for row in rows] == names_before
            assert all(row["section"] == "exam" for row in rows)
            assert (
                int(after.execute("SELECT COUNT(*) AS n FROM problems").fetchone()["n"])
                == problems_before
            )
            assert "note_items" in {
                str(row["name"])
                for row in after.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
        finally:
            after.close()
    finally:
        config.use_data_dir(original)


def test_v4_db_gains_problem_label(tmp_path: Path) -> None:
    """v4 DB 를 열면 `problems.label` 이 생기고 기존 행은 번호로 채워진다.

    구획마다 번호가 되돌아가는 교재를 지원하려고 저장용 번호(`no`)를 통짜로
    다시 매기면서, 원문 표기를 담을 자리가 필요해졌다.
    """
    config.use_data_dir(tmp_path / "data")
    storage.init_db()

    with storage.transaction() as conn:
        assert "label" in storage.table_columns(conn, "problems")
        conn.execute(
            "INSERT INTO nodes (id, type, name, parent_id, section, created_at)"
            " VALUES ('n1', 'file', '시험지', NULL, 'exam', '2026-08-10')"
        )
        # label 을 비운 채(구버전처럼) 넣고 마이그레이션이 채우는지 본다.
        conn.execute(
            "INSERT INTO problems (node_id, no, page, bbox, crop_path, text, label)"
            " VALUES ('n1', 7, 1, '[0,0,1,1]', 'crops/n1/q07.png', '', '')"
        )

    with storage.transaction() as conn:
        storage.migrate(conn)
        row = conn.execute(
            "SELECT label FROM problems WHERE node_id = 'n1' AND no = 7"
        ).fetchone()
    assert row["label"] == "7"


def test_v5_db_gains_transcript_columns(tmp_path: Path) -> None:
    """v5 DB(판독본 3열 없음)를 열면 컬럼이 생기고 기존 문항은 그대로 남는다."""
    data_dir = tmp_path / "v5-data"
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / "app.db"
    conn = sqlite3.connect(path)
    try:
        conn.executescript(LEGACY_SCHEMA)
        conn.execute("ALTER TABLE problems ADD COLUMN label TEXT NOT NULL DEFAULT ''")
        conn.execute(
            "INSERT INTO problems (node_id, no, page, bbox, crop_path, text, label)"
            " VALUES ('file1', 4, 1, '[0,0,1,1]', 'crops/file1/q04.png',"
            " '옛 텍스트', '4')"
        )
        conn.execute("PRAGMA user_version = 5")
        conn.commit()
    finally:
        conn.close()

    original = config.data_dir()
    try:
        config.use_data_dir(data_dir)
        storage.init_db()
        with storage.transaction() as conn:
            assert storage.user_version(conn) == storage.SCHEMA_VERSION
            problem = storage.get_problem(conn, "file1", 4)
            assert problem is not None
            assert problem["text"] == "옛 텍스트"
            # 기존 행은 '아직 판독하지 않음' = NULL 세 개다(백필하지 않는다).
            assert problem["transcript"] is None
            assert problem["transcript_source"] is None
            assert problem["transcript_note"] is None
            # 새 컬럼을 바로 쓸 수 있다.
            assert (
                storage.set_transcript(
                    conn,
                    node_id="file1",
                    no=4,
                    transcript=r"\(x^{2}\)",
                    source=storage.TRANSCRIPT_PUA,
                    note=None,
                )
                is True
            )
            assert storage.transcribed_numbers(conn, "file1") == {4}
    finally:
        config.use_data_dir(original)


V6_NOTE_ITEMS_SCHEMA = """
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
PRAGMA user_version = 6;
"""


def test_v6_db_gains_note_item_transcript_snapshot(tmp_path: Path) -> None:
    """v6 DB(노트 판독본 스냅샷 없음)를 열면 2열이 생기고 기존 항목은 남는다.

    이미 담아 둔 항목은 NULL 로 남는다 — 담은 시점에 판독본이 없었던 것이 사실이라
    지금 값을 만들어 넣으면 거짓이 된다.
    """
    data_dir = tmp_path / "v6-data"
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / "app.db"
    conn = sqlite3.connect(path)
    try:
        conn.executescript(LEGACY_SCHEMA)
        conn.executescript(V6_NOTE_ITEMS_SCHEMA)
        conn.execute(
            "INSERT INTO note_items"
            " (id, note_node_id, source_node_id, source_name, problem_no,"
            "  crop_snapshot_path, memo, created_at)"
            " VALUES ('item1', 'note1', 'file1', '풍문고', 5,"
            "  'note_crops/item1.png', '계산 실수', '2026-08-13T10:00:00+09:00')"
        )
        conn.commit()
    finally:
        conn.close()

    original = config.data_dir()
    try:
        config.use_data_dir(data_dir)
        storage.init_db()
        with storage.transaction() as conn:
            assert storage.user_version(conn) == storage.SCHEMA_VERSION == 7
            assert {"transcript", "transcript_source"} <= storage.table_columns(
                conn, "note_items"
            )
            item = storage.get_note_item(conn, "item1")
            assert item is not None
            assert item["memo"] == "계산 실수"
            assert item["crop_snapshot_path"] == "note_crops/item1.png"
            assert item["transcript"] is None
            assert item["transcript_source"] is None
            # 새 컬럼을 바로 쓸 수 있다.
            assert (
                storage.insert_note_item(
                    conn,
                    item_id="item2",
                    note_node_id="note1",
                    source_node_id="file1",
                    source_name="풍문고",
                    problem_no=6,
                    crop_snapshot_path="",
                    memo=None,
                    transcript=r"값 \(x^{2}\)",
                    transcript_source=storage.TRANSCRIPT_PUA,
                )
                is True
            )
            saved = storage.get_note_item(conn, "item2")
            assert saved is not None
            assert saved["transcript"] == r"값 \(x^{2}\)"
            assert saved["transcript_source"] == storage.TRANSCRIPT_PUA
    finally:
        config.use_data_dir(original)
