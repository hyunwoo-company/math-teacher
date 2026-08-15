"""유형 문제집 적재 스크립트(`scripts/ingest_typebook.py`) 테스트.

핵심은 **짝짓기 안전장치**다. 잘못 붙은 라벨은 없는 라벨보다 훨씬 나쁘다 —
이 데이터셋이 앞으로 태깅 정확도의 정답지로 쓰이기 때문이다.
"""

from __future__ import annotations

import hashlib
import time
from pathlib import Path

import pytest

import storage
from extractor import TextLine
from scripts import ingest_typebook as ingest

# 실물 유형 문제집. 사용자 자료라 저장소에 없다 -> 없으면 건너뛴다.
TYPE_PDF = Path(__file__).resolve().parents[3] / "tmp" / "test" / "집합1 (1).pdf"

PAGE_CENTER = 364.0

LABEL_TEXTS = (
    "08 공통수학2",
    "06 집합의연산",
    "01 집합의연산자",
    "01 집합연산자1 (기본의미)",
)


def label_lines(
    texts: tuple[str, ...], *, x0: float, first_y: float, step: float = 20.0
) -> list[TextLine]:
    """라벨 블록 한 벌을 합성 TextLine 목록으로 만든다."""
    return [
        TextLine(text=text, bbox=(x0, first_y + step * index, x0 + 120.0,
                                 first_y + step * index + 10.0))
        for index, text in enumerate(texts)
    ]


# ------------------------------------------------------------------ 유형 id
def test_type_id_joins_leading_numbers() -> None:
    assert ingest.type_id_from_lines(LABEL_TEXTS) == "08.06.01.01"
    assert (
        ingest.type_id_from_lines(
            (
                "08 공통수학2",
                "05 집합의뜻",
                "01 집합과원소",
                "06 기호와의미5 (집합을원소로가지는집합)",
            )
        )
        == "08.05.01.06"
    )


def test_type_id_rejects_wrong_shape() -> None:
    assert ingest.type_id_from_lines(LABEL_TEXTS[:3]) is None
    # 두 자리 숫자 + 공백 + 한글 형태가 아니면 라벨 줄이 아니다.
    assert ingest.type_id_from_lines(("08 공통수학2", "6 집합", "01 가", "01 나")) is None


# ------------------------------------------------------------------ 블록 파싱
def test_find_label_blocks_splits_two_columns() -> None:
    """좌·우 칼럼의 블록을 섞지 않고 따로 뽑는다."""
    lines: list[TextLine] = []
    lines += label_lines(LABEL_TEXTS, x0=77.2, first_y=156.4)
    lines += label_lines(
        ("08 공통수학2", "06 집합의연산", "02 집합의연산법칙", "01 연산법칙1 (기본법칙)"),
        x0=401.5,
        first_y=156.4,
    )
    # 본문 줄은 라벨이 아니다.
    lines.append(TextLine(text="1.", bbox=(55.0, 252.2, 70.2, 267.2)))
    lines.append(TextLine(text="① 6", bbox=(56.0, 297.1, 88.9, 308.8)))

    blocks = ingest.find_label_blocks(lines, page_center=PAGE_CENTER)
    assert [(block.column, block.type_id) for block in blocks] == [
        ("left", "08.06.01.01"),
        ("right", "08.06.02.01"),
    ]
    assert blocks[0].name == "01 집합연산자1 (기본의미)"
    assert blocks[0].evidence == "\n".join(LABEL_TEXTS)
    assert blocks[0].y0 == pytest.approx(156.4)
    assert blocks[0].y1 == pytest.approx(226.4)


def test_find_label_blocks_ignores_block_not_starting_with_subject() -> None:
    """첫 줄이 과목 번호('08')가 아닌 4줄 묶음은 블록이 아니다."""
    lines = label_lines(
        ("05 집합의뜻", "01 집합과원소", "02 부분집합", "03 무엇인가"),
        x0=77.2,
        first_y=100.0,
    )
    assert ingest.find_label_blocks(lines, page_center=PAGE_CENTER) == []


def test_find_label_blocks_skips_noise_before_real_block() -> None:
    """앞에 붙은 잡음 4줄이 있어도 뒤의 진짜 블록을 찾는다."""
    lines = label_lines(
        ("05 집합의뜻", "01 집합과원소", "02 부분집합", "03 무엇인가"),
        x0=77.2,
        first_y=100.0,
    )
    lines += label_lines(LABEL_TEXTS, x0=77.2, first_y=200.0)

    blocks = ingest.find_label_blocks(lines, page_center=PAGE_CENTER)
    assert [block.type_id for block in blocks] == ["08.06.01.01"]


def test_find_label_blocks_rejects_far_apart_lines() -> None:
    """세로로 멀리 떨어진 줄은 한 블록으로 엮지 않는다."""
    lines = label_lines(LABEL_TEXTS, x0=77.2, first_y=156.4, step=200.0)
    assert ingest.find_label_blocks(lines, page_center=PAGE_CENTER) == []


# ------------------------------------------------------------------ 안전장치
def make_block(type_id: str, column: str, y0: float) -> ingest.LabelBlock:
    return ingest.LabelBlock(
        subject="08 공통수학2",
        area="06 집합의연산",
        chapter="01 집합의연산자",
        name="01 집합연산자1 (기본의미)",
        type_id=type_id,
        column=column,  # type: ignore[arg-type]
        y0=y0,
        y1=y0 + 70.0,
    )


def test_match_labels_pairs_each_column() -> None:
    blocks = [
        make_block("08.06.01.01", "left", 103.8),
        make_block("08.05.01.06", "right", 103.8),
    ]
    problems = [
        ingest.ProblemBox(no=12, column="left", top=197.5),
        ingest.ProblemBox(no=13, column="right", top=197.5),
    ]
    match = ingest.match_labels(blocks, problems)
    assert {no: block.type_id for no, block in match.labels.items()} == {
        12: "08.06.01.01",
        13: "08.05.01.06",
    }
    assert match.untagged == {}


def test_match_labels_gives_column_label_to_every_problem() -> None:
    """라벨은 문항이 아니라 **칼럼**에 붙는다.

    실측(집합1 18쪽 우측 칼럼): 라벨 '01 집합연산자1 (기본의미)' 하나 아래
    42·43·44 세 문항이 있고 셋 다 그 유형이다. 라벨 상자는 늘어나지 않는다.
    """
    blocks = [
        make_block("08.06.01.01", "left", 103.8),
        make_block("08.05.01.06", "right", 103.8),
    ]
    problems = [
        ingest.ProblemBox(no=41, column="left", top=197.5),
        ingest.ProblemBox(no=42, column="right", top=197.5),
        ingest.ProblemBox(no=43, column="right", top=411.9),
        ingest.ProblemBox(no=44, column="right", top=607.4),
    ]
    match = ingest.match_labels(blocks, problems)
    assert {no: block.type_id for no, block in match.labels.items()} == {
        41: "08.06.01.01",
        42: "08.05.01.06",
        43: "08.05.01.06",
        44: "08.05.01.06",
    }
    assert match.untagged == {}


def test_match_labels_gives_up_when_column_has_two_blocks() -> None:
    """라벨 블록이 2개인 칼럼은 **태그를 하나도 만들지 않는다**.

    어느 라벨이 그 문항의 것인지 알 수 없다. 잘못 붙은 라벨은 없는 라벨보다
    나쁘다 — 이 데이터셋이 태깅 정확도 측정의 정답지이기 때문이다.
    """
    blocks = [
        make_block("08.06.01.01", "left", 103.8),
        make_block("08.05.01.06", "left", 300.0),
    ]
    problems = [ingest.ProblemBox(no=12, column="left", top=500.0)]
    match = ingest.match_labels(blocks, problems)
    assert match.labels == {}
    assert match.untagged == {12: ingest.UNTAGGED_MULTIPLE}


def test_match_labels_gives_up_when_column_has_no_block() -> None:
    """라벨 블록이 없는 칼럼도 태그 없이 남는다(옆 칼럼 라벨을 빌려오지 않는다)."""
    blocks = [make_block("08.06.01.01", "left", 103.8)]
    problems = [
        ingest.ProblemBox(no=12, column="left", top=197.5),
        ingest.ProblemBox(no=13, column="right", top=197.5),
    ]
    match = ingest.match_labels(blocks, problems)
    assert {no: block.type_id for no, block in match.labels.items()} == {
        12: "08.06.01.01"
    }
    assert match.untagged == {13: ingest.UNTAGGED_NO_LABEL}


def test_match_labels_rejects_block_below_problem() -> None:
    """라벨이 문항보다 아래에 있으면 그 문항의 라벨이 아니다."""
    blocks = [make_block("08.06.01.01", "left", 400.0)]
    problems = [ingest.ProblemBox(no=12, column="left", top=197.5)]
    match = ingest.match_labels(blocks, problems)
    assert match.labels == {}
    assert match.untagged == {12: ingest.UNTAGGED_MISPLACED}


def test_match_labels_rejects_column_when_any_problem_is_above_block() -> None:
    """칼럼 안에 라벨보다 위에 있는 문항이 하나라도 있으면 그 칼럼 전체를 버린다."""
    blocks = [make_block("08.06.01.01", "left", 300.0)]
    problems = [
        ingest.ProblemBox(no=12, column="left", top=197.5),
        ingest.ProblemBox(no=13, column="left", top=500.0),
    ]
    match = ingest.match_labels(blocks, problems)
    assert match.labels == {}
    assert match.untagged == {
        12: ingest.UNTAGGED_MISPLACED,
        13: ingest.UNTAGGED_MISPLACED,
    }


def test_match_labels_handles_empty_page() -> None:
    match = ingest.match_labels([], [])
    assert match.labels == {}
    assert match.untagged == {}


def test_match_labels_ignores_labels_on_empty_column() -> None:
    """문항이 없는 칼럼의 라벨은 아무 데도 붙지 않는다."""
    blocks = [make_block("08.06.01.01", "right", 103.8)]
    match = ingest.match_labels(
        blocks, [ingest.ProblemBox(no=12, column="left", top=197.5)]
    )
    assert match.labels == {}
    assert match.untagged == {12: ingest.UNTAGGED_NO_LABEL}


# ------------------------------------------------------------------ 해시
def test_content_hash_ignores_number_prefix_and_whitespace() -> None:
    first = "12. 두 집합 A={1,2}, B={2,3}\n의 원소의 개수는?"
    second = "3)\n두집합 A={1,2},B={2,3}의   원소의 개수는?"
    assert ingest.normalize_for_hash(first) == ingest.normalize_for_hash(second)
    assert ingest.compute_content_hash(first, None) == ingest.compute_content_hash(
        second, None
    )
    # 내용이 다르면 해시도 다르다.
    assert ingest.compute_content_hash("12. 다른 문항", None) != (
        ingest.compute_content_hash(first, None)
    )


def test_content_hash_strips_double_number_prefix() -> None:
    """번호가 두 겹인 교재 조판에서도 같은 문항은 같은 해시가 된다.

    이 문제집의 텍스트 레이어는 "12.\\n12)전체집합…" 처럼 크롭 왼쪽의 큰 번호와
    본문 첫 글자 번호가 둘 다 나온다. 한 번만 벗기면 안쪽 번호가 남아, 교재 내
    위치가 다른 같은 문항이 서로 다른 문항으로 보인다.
    """
    first = "12.\n12)전체집합 U에 대하여"
    second = "3.\n3)전체집합 U에 대하여"
    assert ingest.normalize_for_hash(first) == "전체집합U에대하여"
    assert ingest.compute_content_hash(first, None) == ingest.compute_content_hash(
        second, None
    )


def test_content_hash_keeps_content_starting_with_a_number() -> None:
    """본문이 숫자로 시작해도 지우지 않는다(뒤에 '.' / ')' 가 없으므로)."""
    assert ingest.normalize_for_hash("7. 3의 배수를 모두 구하시오") == (
        "3의배수를모두구하시오"
    )


def test_content_hash_falls_back_to_image_bytes() -> None:
    """텍스트 레이어가 없으면(스캔 PDF) 크롭 PNG 바이트로 해시한다."""
    image = b"\x89PNG fake bytes"
    assert ingest.compute_content_hash("   \n ", image) == hashlib.sha256(
        image
    ).hexdigest()
    with pytest.raises(ValueError):
        ingest.compute_content_hash("", None)


# ------------------------------------------------------------------ 중복
def test_store_bank_problem_skips_duplicate_hash() -> None:
    """같은 해시를 두 번 넣으면 두 번째는 False(= 건너뜀)다."""
    with storage.transaction() as conn:
        seen: set[str] = set()
        assert (
            ingest.store_bank_problem(
                conn,
                bank_id="bankA",
                content_hash="deadbeef",
                crop_path="bank/bankA.png",
                raw_text="두 집합 A, B",
                source_label="학원자료 집합1",
                seen=seen,
            )
            is True
        )
        assert (
            ingest.store_bank_problem(
                conn,
                bank_id="bankB",
                content_hash="deadbeef",
                crop_path="bank/bankB.png",
                raw_text="두 집합 A, B",
                source_label="학원자료 집합2",
                seen=seen,
            )
            is False
        )
        assert (
            conn.execute("SELECT COUNT(*) AS n FROM bank_problems").fetchone()["n"] == 1
        )
        # 먼저 들어간 쪽이 남는다(뒤 파일이 앞 파일을 덮어쓰지 않는다).
        saved = storage.get_bank_problem(conn, "bankA")
        assert saved is not None
        assert saved["source_label"] == "학원자료 집합1"


def test_store_bank_problem_skips_hash_already_in_db() -> None:
    """실행이 달라져도(`seen` 이 비어 있어도) DB 에 있는 해시는 건너뛴다."""
    with storage.transaction() as conn:
        assert (
            ingest.store_bank_problem(
                conn,
                bank_id="bankA",
                content_hash="cafe1234",
                crop_path="bank/bankA.png",
                raw_text="본문",
                source_label="학원자료 집합1",
                seen=set(),
            )
            is True
        )
    with storage.transaction() as conn:
        assert (
            ingest.store_bank_problem(
                conn,
                bank_id="bankB",
                content_hash="cafe1234",
                crop_path="bank/bankB.png",
                raw_text="본문",
                source_label="학원자료 집합1",
                seen=set(),
            )
            is False
        )


def test_store_bank_problem_dry_run_writes_nothing() -> None:
    with storage.transaction() as conn:
        assert (
            ingest.store_bank_problem(
                conn,
                bank_id="bankA",
                content_hash="feed0001",
                crop_path="bank/bankA.png",
                raw_text="본문",
                source_label="학원자료 집합1",
                seen=set(),
                dry_run=True,
            )
            is True
        )
        assert (
            conn.execute("SELECT COUNT(*) AS n FROM bank_problems").fetchone()["n"] == 0
        )


# ------------------------------------------------------------------ 스키마
def test_bank_schema_exists_and_keeps_existing_tables() -> None:
    """`init_db()` 뒤에 코퍼스 3테이블 + 유니크 인덱스가 있고 기존 표도 그대로다."""
    storage.init_db()
    with storage.transaction() as conn:
        tables = {
            str(row["name"])
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert {"problem_types", "bank_problems", "problem_tags"} <= tables
        # 기존 테이블이 사라지지 않았다.
        assert {
            "nodes",
            "files",
            "problems",
            "solutions",
            "chat_messages",
            "note_items",
            "conversations",
            "conversation_messages",
            "jobs",
            "variants",
        } <= tables

        indexes = {
            str(row["name"]): str(row["sql"] or "")
            for row in conn.execute(
                "SELECT name, sql FROM sqlite_master WHERE type='index'"
            )
        }
        assert "idx_bank_hash" in indexes
        assert "UNIQUE" in indexes["idx_bank_hash"].upper()
        assert "idx_tags_type" in indexes

        assert storage.table_columns(conn, "problem_types") == {
            "id",
            "subject",
            "area",
            "chapter",
            "name",
            "achievement",
            "statement",
            "includes",
            "excludes",
            "status",
            "created_at",
        }
        assert storage.table_columns(conn, "bank_problems") == {
            "id",
            "crop_path",
            "raw_text",
            "transcript",
            "solution",
            "content_hash",
            "origin",
            "visibility",
            "owner_id",
            "source_label",
            "created_at",
        }
        assert storage.table_columns(conn, "problem_tags") == {
            "bank_id",
            "type_id",
            "confidence",
            "source",
            "evidence",
            "created_at",
        }
        assert storage.user_version(conn) == storage.SCHEMA_VERSION


def test_problem_type_upsert_does_not_overwrite() -> None:
    """유형을 다시 적재해도 나중에 채운 열(statement 등)을 덮어쓰지 않는다."""
    with storage.transaction() as conn:
        assert (
            storage.upsert_problem_type(
                conn,
                type_id="08.06.01.01",
                subject="08 공통수학2",
                area="06 집합의연산",
                chapter="01 집합의연산자",
                name="01 집합연산자1 (기본의미)",
            )
            is True
        )
        conn.execute(
            "UPDATE problem_types SET statement = ? WHERE id = ?",
            ("두 집합의 연산 결과를 구한다.", "08.06.01.01"),
        )
        assert (
            storage.upsert_problem_type(
                conn,
                type_id="08.06.01.01",
                subject="08 공통수학2",
                area="06 집합의연산",
                chapter="01 집합의연산자",
                name="바뀐 이름",
            )
            is False
        )
        saved = storage.get_problem_type(conn, "08.06.01.01")
        assert saved is not None
        assert saved["name"] == "01 집합연산자1 (기본의미)"
        assert saved["statement"] == "두 집합의 연산 결과를 구한다."


def test_problem_tag_roundtrip() -> None:
    with storage.transaction() as conn:
        storage.insert_bank_problem(
            conn,
            bank_id="bank1",
            crop_path="bank/bank1.png",
            raw_text="본문",
            content_hash="h1",
            origin=storage.BANK_ORIGIN_SEED,
            visibility=storage.BANK_SHARED,
            source_label="학원자료 집합1",
        )
        assert (
            storage.insert_problem_tag(
                conn,
                bank_id="bank1",
                type_id="08.06.01.01",
                confidence=1.0,
                source=storage.TAG_SOURCE_LABEL,
                evidence="\n".join(LABEL_TEXTS),
            )
            is True
        )
        tag = storage.get_problem_tag(conn, "bank1")
        assert tag is not None
        assert tag["type_id"] == "08.06.01.01"
        assert tag["confidence"] == 1.0
        assert tag["source"] == storage.TAG_SOURCE_LABEL
        assert storage.count_tags_by_type(conn) == {"08.06.01.01": 1}
        # 태그는 문항당 하나. 두 번째는 조용히 무시된다.
        assert (
            storage.insert_problem_tag(
                conn,
                bank_id="bank1",
                type_id="08.05.01.06",
                confidence=0.4,
                source=storage.TAG_SOURCE_AI,
                evidence="AI 추정",
            )
            is False
        )
        saved = storage.get_problem_tag(conn, "bank1")
        assert saved is not None
        assert saved["type_id"] == "08.06.01.01"


# ------------------------------------------------------------------ 실물 PDF
@pytest.mark.skipif(not TYPE_PDF.is_file(), reason=f"사용자 자료가 없다: {TYPE_PDF}")
def test_real_typebook_labels_are_above_their_problems() -> None:
    """실물 문제집에서 뽑은 라벨이 모두 자기 문항 **위**에, 같은 칼럼에 있다.

    실패하면 짝짓기가 엉킨 것이다. 여기서 확인하는 세 성질이 태깅 정확도의
    근거다: ⒜ 붙은 라벨은 항상 위쪽에 있고, ⒝ 라벨 블록이 정확히 1개가 아닌
    칼럼은 태그가 0개이며, ⒞ 태그된 문항과 태그 없는 문항이 겹치지 않는다.
    """
    import extractor

    result = extractor.extract_problems(TYPE_PDF, render_images=False)
    blocks_by_page, centers = ingest._page_label_blocks(TYPE_PDF)

    by_page: dict[int, list[extractor.Problem]] = {}
    for problem in result.problems:
        by_page.setdefault(problem.page, []).append(problem)

    matched_total = 0
    for page_no, page_problems in by_page.items():
        center = centers[page_no]
        boxes = [
            ingest.ProblemBox(
                no=problem.no,
                column="left" if problem.bbox[0] < center else "right",
                top=problem.bbox[1],
            )
            for problem in page_problems
        ]
        blocks = blocks_by_page[page_no]
        match = ingest.match_labels(blocks, boxes)
        tops = {box.no: box.top for box in boxes}
        columns = {box.no: box.column for box in boxes}
        for no, block in match.labels.items():
            assert block.y1 <= tops[no], f"{page_no}쪽 {no}번: 라벨이 문항 아래다"
            assert block.column == columns[no], f"{page_no}쪽 {no}번: 칼럼이 다르다"
        # 라벨 블록이 정확히 1개가 아닌 칼럼의 문항은 반드시 태그가 없다.
        for column in ("left", "right"):
            column_blocks = [block for block in blocks if block.column == column]
            if len(column_blocks) == 1:
                continue
            for box in boxes:
                if box.column == column:
                    assert box.no not in match.labels
        assert not (set(match.labels) & set(match.untagged))
        assert set(match.labels) | set(match.untagged) == set(tops)
        matched_total += len(match.labels)

    assert result.problems, "문항을 하나도 못 뽑았다"
    # 칼럼 단위 규칙이면 이 자료는 전 문항이 태그된다(칼럼마다 라벨이 정확히 1개).
    assert matched_total == len(result.problems)


@pytest.mark.skipif(not TYPE_PDF.is_file(), reason=f"사용자 자료가 없다: {TYPE_PDF}")
def test_real_typebook_dry_run_reports_without_writing(tmp_path: Path) -> None:
    """dry-run 은 DB·파일에 아무것도 쓰지 않고 숫자만 센다."""
    from collections import Counter

    started = time.monotonic()
    conn = ingest.open_db(tmp_path / "bank.db")
    try:
        report = ingest.ingest_pdf(
            conn,
            TYPE_PDF,
            outdir=tmp_path / "crops",
            source_label="테스트 집합1",
            seen=set(),
            type_counts=Counter(),
            type_names={},
            dry_run=True,
        )
        assert report.problems > 0
        assert report.matched + report.unmatched == report.problems
        # 중복으로 건너뛴 문항은 태그도 달지 않으므로 tagged <= matched 다.
        assert report.tagged <= report.matched
        counts = conn.execute(
            "SELECT (SELECT COUNT(*) FROM bank_problems) AS banks,"
            "       (SELECT COUNT(*) FROM problem_tags) AS tags"
        ).fetchone()
        assert (counts["banks"], counts["tags"]) == (0, 0)
    finally:
        conn.close()
    assert not (tmp_path / "crops").exists()
    # 렌더링이 들어가므로 시간이 튀면 알아채야 한다.
    assert time.monotonic() - started < 300.0


@pytest.mark.skipif(not TYPE_PDF.is_file(), reason=f"사용자 자료가 없다: {TYPE_PDF}")
def test_real_typebook_ingest_writes_one_crop_per_problem(tmp_path: Path) -> None:
    """적재하면 문항마다 크롭 PNG 가 정확히 하나씩 남는다.

    크롭 이름을 페이지·번호로 지으면 여러 교재를 한 폴더에 넣을 때 겹친다.
    문항 id 로 지어야 겹치지 않는다 — 겹치면 DB 의 `crop_path` 가 **남의 문항**
    이미지를 가리킨다.
    """
    from collections import Counter

    outdir = tmp_path / "crops"
    conn = ingest.open_db(tmp_path / "bank.db")
    try:
        report = ingest.ingest_pdf(
            conn,
            TYPE_PDF,
            outdir=outdir,
            source_label="테스트 집합1",
            seen=set(),
            type_counts=Counter(),
            type_names={},
        )
        inserted = report.problems - report.duplicates
        assert inserted > 0
        rows = conn.execute("SELECT id, crop_path FROM bank_problems").fetchall()
        assert len(rows) == inserted
        paths = [Path(str(row["crop_path"])) for row in rows]
        assert len({path.name for path in paths}) == inserted
        assert all(path.is_file() for path in paths)
        assert len(list(outdir.glob("*.png"))) == inserted
        assert (
            conn.execute("SELECT COUNT(*) AS n FROM problem_tags").fetchone()["n"]
            == report.tagged
        )
        # 태그가 가리키는 유형은 모두 사전에 있다.
        orphans = conn.execute(
            "SELECT COUNT(*) AS n FROM problem_tags t"
            " LEFT JOIN problem_types p ON p.id = t.type_id WHERE p.id IS NULL"
        ).fetchone()["n"]
        assert orphans == 0
    finally:
        conn.close()
