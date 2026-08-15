"""유형 정의문 시드(`seeds/types_08/*.json`)와 그 로더 검증.

정의문은 태거가 유형을 고르는 유일한 근거라, 여기서 막지 못한 오류는 그대로
태깅 정확도로 나타난다. 특히 `excludes` 에 적은 형제 유형 id 의 오타는 눈으로는
잘 안 보이면서 "무엇이 아닌지" 를 통째로 무의미하게 만든다.

정의문 파일은 여러 사람이 나눠 쓰는 중이므로, 이 테스트는 **그때 있는 파일만**
검사한다. 아직 없는 파일을 요구하지 않는다.
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

import pytest

import config
import storage
from scripts import load_type_definitions as loader

# 유형 id 표기. `excludes` 본문에서 이 패턴을 찾아 실재 여부를 확인한다.
TYPE_ID_RE = re.compile(r"\d{2}\.\d{2}\.\d{2}\.\d{2}")

# 사전에 실재하는 유형 id 의 출처. 45개 유형 전부가 여기 들어 있다.
MANIFEST = config.CORE_DIR / "data" / "type_sample_manifest.json"

# 이 코퍼스의 과목은 한 가지뿐이다(`storage.SCHEMA` 주석, ingest 의 SUBJECT_PREFIX).
SUBJECT = "08 공통수학2"

# 이름만으로는 갈리지 않아 서로를 반드시 지목해야 하는 유형들.
# 각 묶음의 모든 유형은 같은 묶음의 나머지 id 를 `excludes` 에 적어야 한다.
COLLISION_GROUPS: list[tuple[str, tuple[str, ...]]] = [
    ("원소배치해석", ("08.06.01.04", "08.06.02.06", "08.06.03.01")),
    ("부등식", ("08.05.01.09", "08.06.03.06")),
    ("순열과조합", ("08.05.01.11", "08.06.03.07")),
    ("기본", ("08.06.03.08", "08.06.04.01")),
]

GROUP_IDS = [label for label, _ in COLLISION_GROUPS]


# ------------------------------------------------------------------ 픽스처
def _manifest_types() -> list[dict[str, str]]:
    if not MANIFEST.is_file():
        pytest.skip(f"유형 매니페스트가 없습니다: {MANIFEST}")
    payload = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return [
        {
            "id": str(item["id"]),
            "area": str(item["area"]),
            "chapter": str(item["chapter"]),
            "name": str(item["name"]),
        }
        for item in payload
    ]


@pytest.fixture
def bank_db(tmp_path: Path) -> Path:
    """유형 사전만 채운 임시 코퍼스 DB.

    운영 DB(`data/app.db`)도 시드 DB(`data/bank.db`)도 건드리지 않는다.
    """
    path = tmp_path / "bank.db"
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(storage.SCHEMA)
        storage.migrate(conn)
        for item in _manifest_types():
            storage.upsert_problem_type(
                conn,
                type_id=item["id"],
                subject=SUBJECT,
                area=item["area"],
                chapter=item["chapter"],
                name=item["name"],
            )
        conn.commit()
    finally:
        conn.close()
    return path


@pytest.fixture
def definitions() -> list[loader.TypeDefinition]:
    """지금 존재하는 시드 파일 전체의 정의문."""
    return loader.load_definitions()


def _known_ids(bank_db: Path) -> set[str]:
    conn = loader.open_db(bank_db)
    try:
        return loader.existing_type_ids(conn)
    finally:
        conn.close()


# ------------------------------------------------------------------ 시드 내용
def test_seed_dir_has_collision_file() -> None:
    """경계 유형 정의문 파일은 있어야 한다(이 테스트가 지키는 대상)."""
    names = {path.name for path in loader.seed_files()}
    assert "collision.json" in names


def test_every_definition_id_exists_in_dictionary(
    bank_db: Path, definitions: list[loader.TypeDefinition]
) -> None:
    """정의문의 id 가 전부 `problem_types` 에 실재한다."""
    assert definitions, "정의문이 하나도 없습니다."
    known = _known_ids(bank_db)
    missing = sorted(
        item.type_id for item in definitions if item.type_id not in known
    )
    assert not missing, f"사전에 없는 유형 id: {missing}"


def test_required_fields_are_not_empty(
    definitions: list[loader.TypeDefinition],
) -> None:
    """`statement`/`includes`/`excludes` 가 모두 채워져 있다."""
    for item in definitions:
        for field in loader.REQUIRED_FIELDS:
            value = str(getattr(item, field))
            assert value.strip(), f"{item.type_id}: {field} 가 비었습니다."


def test_excludes_reference_real_type_ids(
    bank_db: Path, definitions: list[loader.TypeDefinition]
) -> None:
    """`excludes` 에 적힌 유형 id 가 전부 실재한다 (오타 방지).

    없는 id 를 가리키는 `excludes` 는 태거에게 아무 정보도 주지 못하면서 있는
    것처럼 보인다. 자기 자신을 가리키는 것도 오류로 본다.
    """
    known = _known_ids(bank_db)
    problems: list[str] = []
    for item in definitions:
        for referenced in TYPE_ID_RE.findall(item.excludes):
            if referenced not in known:
                problems.append(f"{item.type_id} -> {referenced} (사전에 없음)")
            elif referenced == item.type_id:
                problems.append(f"{item.type_id} -> 자기 자신")
    assert not problems, "excludes 의 유형 id 오류:\n" + "\n".join(problems)


@pytest.mark.parametrize(("label", "group"), COLLISION_GROUPS, ids=GROUP_IDS)
def test_collision_group_members_name_their_siblings(
    label: str, group: tuple[str, ...], definitions: list[loader.TypeDefinition]
) -> None:
    """경계 묶음의 각 유형이 같은 묶음의 형제 id 를 `excludes` 에서 지목한다."""
    by_id = {item.type_id: item for item in definitions}
    for type_id in group:
        assert type_id in by_id, f"[{label}] {type_id} 의 정의문이 없습니다."
        excludes = by_id[type_id].excludes
        for sibling in group:
            if sibling == type_id:
                continue
            assert sibling in excludes, (
                f"[{label}] {type_id} 의 excludes 가 형제 {sibling} 를 "
                "언급하지 않습니다."
            )


def test_statement_is_not_just_the_label(
    definitions: list[loader.TypeDefinition],
) -> None:
    """`statement` 가 라벨명을 되풀이한 것이 아니다(무엇을 하는지 서술해야 한다)."""
    for item in definitions:
        assert len(item.statement) > 30, (
            f"{item.type_id}: statement 가 너무 짧습니다 — 라벨명 되풀이로 보입니다."
        )


# ------------------------------------------------------------------ 로더
def test_loader_writes_definitions_into_db(bank_db: Path) -> None:
    """로더가 시드를 DB 에 반영하고, 라벨명·성취기준은 건드리지 않는다."""
    definitions = loader.load_definitions()
    conn = loader.open_db(bank_db)
    try:
        before = {
            str(row["id"]): str(row["name"])
            for row in conn.execute("SELECT id, name FROM problem_types")
        }
        assert loader.apply_definitions(conn, definitions) == len(definitions)
        rows = {
            str(row["id"]): dict(row)
            for row in conn.execute("SELECT * FROM problem_types")
        }
    finally:
        conn.close()

    for item in definitions:
        row = rows[item.type_id]
        assert row["statement"] == item.statement
        assert row["includes"] == item.includes
        assert row["excludes"] == item.excludes
        assert row["name"] == before[item.type_id]
        assert row["achievement"] is None

    untouched = set(rows) - {item.type_id for item in definitions}
    for type_id in untouched:
        assert rows[type_id]["statement"] is None


def test_loader_dry_run_writes_nothing(bank_db: Path) -> None:
    """`--dry-run` 은 검사만 하고 아무것도 쓰지 않는다."""
    definitions = loader.load_definitions()
    conn = loader.open_db(bank_db)
    try:
        assert loader.apply_definitions(conn, definitions, dry_run=True) == len(
            definitions
        )
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM problem_types WHERE statement IS NOT NULL"
        ).fetchone()
    finally:
        conn.close()
    assert row["n"] == 0


def test_loader_rejects_unknown_type_id(bank_db: Path, tmp_path: Path) -> None:
    """사전에 없는 id 는 오류로 알리고 **아무것도 쓰지 않는다**."""
    seed_dir = tmp_path / "seeds"
    seed_dir.mkdir()
    (seed_dir / "bogus.json").write_text(
        json.dumps(
            {
                "types": [
                    {
                        "id": "99.99.99.99",
                        "statement": "있을 수 없는 유형.",
                        "includes": "없음.",
                        "excludes": "없음.",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    conn = loader.open_db(bank_db)
    try:
        with pytest.raises(loader.SeedError, match="99"):
            loader.apply_definitions(conn, loader.load_definitions(seed_dir))
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM problem_types WHERE statement IS NOT NULL"
        ).fetchone()
    finally:
        conn.close()
    assert row["n"] == 0


def test_loader_rejects_duplicate_id_across_files(tmp_path: Path) -> None:
    """같은 id 가 두 파일에 있으면 오류다(어느 쪽이 맞는지 알 수 없다)."""
    seed_dir = tmp_path / "seeds"
    seed_dir.mkdir()
    item = {
        "id": "08.06.03.01",
        "statement": "같은 유형을 두 사람이 썼다.",
        "includes": "가.",
        "excludes": "나.",
    }
    for name in ("a.json", "b.json"):
        (seed_dir / name).write_text(json.dumps({"types": [item]}), encoding="utf-8")

    with pytest.raises(loader.SeedError, match="두 곳"):
        loader.load_definitions(seed_dir)


def test_loader_rejects_empty_field(tmp_path: Path) -> None:
    """필수 항목이 비면 오류다."""
    seed_dir = tmp_path / "seeds"
    seed_dir.mkdir()
    (seed_dir / "a.json").write_text(
        json.dumps(
            {
                "types": [
                    {
                        "id": "08.06.03.01",
                        "statement": "무엇을 하는지.",
                        "includes": "  ",
                        "excludes": "나.",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(loader.SeedError, match="includes"):
        loader.load_definitions(seed_dir)


def test_missing_seed_dir_is_not_an_error(tmp_path: Path) -> None:
    """아직 아무도 파일을 만들지 않았어도 오류가 아니다."""
    assert loader.load_definitions(tmp_path / "nope") == []
