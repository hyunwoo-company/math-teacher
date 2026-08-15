"""유형 정의문 시드(`seeds/types_08/*.json`)를 `problem_types` 에 채운다.

**AI 호출 0회.** 사람이 표본 문항을 읽고 쓴 문장을 DB 로 옮기기만 한다.

채우는 열은 `statement` / `includes` / `excludes` 세 개다. `name` 은 문제집에
인쇄된 라벨 원문이라 건드리지 않고, `achievement`(성취기준 코드)는 별도 매핑
작업이라 NULL 로 둔다.

정의문은 여러 사람이 파일을 나눠 쓴다(`collision.json`, `area05.json`, ...).
그래서 이 로더는 디렉터리를 **전부 글롭**해 읽고, 다음 두 가지를 오류로 본다.

  * 같은 유형 id 가 두 파일에 있는 경우 -> 어느 쪽이 맞는지 알 수 없다.
  * 사전에 없는 유형 id 가 적힌 경우 -> 오타이거나 라벨이 바뀐 것이다.

둘 다 **아무것도 쓰지 않고 중단**한다. 정의문은 태깅 정확도를 그대로 결정하는
자료라, 절반만 반영된 상태가 아예 반영 안 된 상태보다 나쁘다.

사용법::

    python scripts/load_type_definitions.py [--db PATH] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

# 스크립트로 직접 실행하면 sys.path[0] 이 `scripts/` 라서 core 모듈을 못 찾는다.
_CORE_DIR: Final[Path] = Path(__file__).resolve().parents[1]
if str(_CORE_DIR) not in sys.path:
    sys.path.insert(0, str(_CORE_DIR))

import storage  # noqa: E402

# 정의문 시드 디렉터리. `08` 은 과목 번호(공통수학2)다.
SEED_DIR: Final[Path] = _CORE_DIR / "seeds" / "types_08"

# 유형 사전이 들어 있는 DB. 운영 DB(`data/app.db`)가 아니라 코퍼스 DB 다.
DEFAULT_DB: Final[Path] = _CORE_DIR / "data" / "bank.db"

# 유형 사전 테이블. 이 표가 없는 DB 는 대상이 아니다.
TYPES_TABLE: Final[str] = "problem_types"

# 시드 JSON 에서 유형 목록을 담는 키. 나머지 최상위 키(`_note` 등)는 무시한다.
TYPES_KEY: Final[str] = "types"

# 반드시 채워야 하는 열. 하나라도 비면 그 유형은 태거에게 쓸모가 없다.
REQUIRED_FIELDS: Final[tuple[str, ...]] = ("statement", "includes", "excludes")


class SeedError(Exception):
    """시드 파일이나 대상 DB 가 기대와 다를 때. 메시지를 그대로 사용자에게 보인다."""


@dataclass(frozen=True)
class TypeDefinition:
    """유형 하나의 정의문."""

    type_id: str
    statement: str
    includes: str
    excludes: str
    source: Path

    @property
    def values(self) -> tuple[str, str, str]:
        """UPDATE 에 넣을 세 값."""
        return (self.statement, self.includes, self.excludes)


# ------------------------------------------------------------------ 시드 읽기
def _required_text(item: dict[str, Any], field: str, *, where: str) -> str:
    """항목에서 비어 있지 않은 문자열 하나를 꺼낸다."""
    value = item.get(field)
    if not isinstance(value, str) or not value.strip():
        raise SeedError(f"{where}: '{field}' 가 비어 있거나 문자열이 아닙니다.")
    return value.strip()


def parse_seed_file(path: Path) -> list[TypeDefinition]:
    """시드 JSON 한 개를 정의문 목록으로.

    Args:
        path: `seeds/types_08/xxx.json`.

    Returns:
        그 파일이 정의한 유형들. 파일 안의 순서를 지킨다.

    Raises:
        SeedError: JSON 이 깨졌거나, `types` 가 없거나, 필수 항목이 비었을 때.
    """
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SeedError(f"{path.name}: 읽을 수 없습니다 ({error})") from error

    if not isinstance(payload, dict) or not isinstance(payload.get(TYPES_KEY), list):
        raise SeedError(f"{path.name}: 최상위에 '{TYPES_KEY}' 배열이 있어야 합니다.")

    definitions: list[TypeDefinition] = []
    for index, item in enumerate(payload[TYPES_KEY]):
        where = f"{path.name}[{index}]"
        if not isinstance(item, dict):
            raise SeedError(f"{where}: 객체가 아닙니다.")
        type_id = _required_text(item, "id", where=where)
        texts = {
            field: _required_text(item, field, where=f"{where}({type_id})")
            for field in REQUIRED_FIELDS
        }
        definitions.append(
            TypeDefinition(
                type_id=type_id,
                statement=texts["statement"],
                includes=texts["includes"],
                excludes=texts["excludes"],
                source=path,
            )
        )
    return definitions


def seed_files(seed_dir: Path = SEED_DIR) -> list[Path]:
    """시드 디렉터리의 JSON 파일 목록(이름 순).

    다른 작업자가 아직 자기 파일을 만들지 않았을 수 있으므로, 디렉터리가 없거나
    비어 있는 것은 오류가 아니다.
    """
    if not seed_dir.is_dir():
        return []
    return sorted(seed_dir.glob("*.json"))


def load_definitions(seed_dir: Path = SEED_DIR) -> list[TypeDefinition]:
    """시드 디렉터리를 전부 글롭해 정의문을 모은다.

    Args:
        seed_dir: `seeds/types_08`.

    Returns:
        유형 id 순으로 정렬한 정의문.

    Raises:
        SeedError: 같은 유형 id 가 두 번 나올 때(어느 파일에 있는지 알려준다).
    """
    by_id: dict[str, TypeDefinition] = {}
    for path in seed_files(seed_dir):
        for definition in parse_seed_file(path):
            previous = by_id.get(definition.type_id)
            if previous is not None:
                raise SeedError(
                    f"유형 {definition.type_id} 의 정의가 두 곳에 있습니다: "
                    f"{previous.source.name}, {definition.source.name}"
                )
            by_id[definition.type_id] = definition
    return [by_id[type_id] for type_id in sorted(by_id)]


# ------------------------------------------------------------------ DB 반영
def open_db(path: Path) -> sqlite3.Connection:
    """지정한 경로의 DB 를 연다.

    `storage.connect()` 는 전역 설정(`config.db_path()` = 운영 DB)을 보므로 쓰지
    않는다. `--db` 를 그대로 존중해 실수로 운영 DB 를 건드리지 않게 한다.

    Raises:
        SeedError: 파일이 없거나 유형 사전 표가 없을 때. 유형 사전은 적재
            스크립트가 미리 만들어 두는 것이라, 여기서 빈 DB 를 새로 만들면
            "id 가 전부 없다" 는 엉뚱한 오류로 이어진다.
    """
    if not path.is_file():
        raise SeedError(f"DB 가 없습니다: {path}")
    conn = sqlite3.connect(path, timeout=15.0)
    conn.row_factory = sqlite3.Row
    if not storage.table_columns(conn, TYPES_TABLE):
        conn.close()
        raise SeedError(f"유형 사전 표({TYPES_TABLE})가 없는 DB 입니다: {path}")
    return conn


def existing_type_ids(conn: sqlite3.Connection) -> set[str]:
    """DB 에 있는 유형 id 전체."""
    rows = conn.execute(f"SELECT id FROM {TYPES_TABLE}").fetchall()
    return {str(row["id"]) for row in rows}


def check_known(definitions: Iterable[TypeDefinition], known: set[str]) -> None:
    """정의문의 id 가 전부 사전에 있는지 확인한다.

    Raises:
        SeedError: 사전에 없는 id 가 하나라도 있을 때. 어느 파일의 어떤 id 인지
            모두 모아서 알린다(하나씩 고치게 만들지 않는다).
    """
    unknown = [item for item in definitions if item.type_id not in known]
    if not unknown:
        return
    lines = "\n".join(f"  {item.type_id}  ({item.source.name})" for item in unknown)
    raise SeedError(f"사전에 없는 유형 id {len(unknown)}개:\n{lines}")


def apply_definitions(
    conn: sqlite3.Connection,
    definitions: Sequence[TypeDefinition],
    *,
    dry_run: bool = False,
) -> int:
    """정의문을 `problem_types` 에 반영한다.

    쓰기 전에 id 를 **전부** 검사한다. 절반만 반영된 사전은 아예 반영되지 않은
    사전보다 나쁘다.

    Args:
        conn: 열린 커넥션.
        definitions: `load_definitions` 결과.
        dry_run: True 면 검사만 하고 쓰지 않는다.

    Returns:
        반영한(또는 dry-run 에서 반영할) 유형 수.

    Raises:
        SeedError: 사전에 없는 id 가 있을 때.
    """
    check_known(definitions, existing_type_ids(conn))
    if dry_run:
        return len(definitions)
    for definition in definitions:
        conn.execute(
            f"""
            UPDATE {TYPES_TABLE}
               SET statement = ?, includes = ?, excludes = ?
             WHERE id = ?
            """,
            (*definition.values, definition.type_id),
        )
    conn.commit()
    return len(definitions)


# ------------------------------------------------------------------ CLI
def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="유형 정의문 시드를 problem_types 에 채운다 (AI 호출 0회)"
    )
    parser.add_argument("--db", default=None, help=f"SQLite 경로 (기본 {DEFAULT_DB})")
    parser.add_argument(
        "--dry-run", action="store_true", help="DB 에 쓰지 않고 검사만 한다"
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI 진입점."""
    args = _build_arg_parser().parse_args(argv)
    db_path = Path(args.db) if args.db else DEFAULT_DB

    try:
        definitions = load_definitions()
        conn = open_db(db_path)
        try:
            count = apply_definitions(conn, definitions, dry_run=args.dry_run)
        finally:
            conn.close()
    except SeedError as error:
        print(f"[error] {error}", file=sys.stderr)
        return 2

    files = seed_files()
    print(f"시드 파일 : {len(files)}개 ({', '.join(path.name for path in files)})")
    print(f"유형 정의 : {count}개" + (" (dry-run: 쓰지 않음)" if args.dry_run else ""))
    print(f"DB        : {db_path}")
    print("AI 호출   : 0회")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
