"""유형 문제집 PDF 를 공용 문항 코퍼스(bank)에 적재한다. **AI 호출 0회**.

유형 문제집은 문항마다 4단계 분류 라벨이 페이지에 **인쇄돼 있다**::

    08 공통수학2                 <- 과목
    06 집합의연산                <- 대단원
    01 집합의연산자              <- 중단원
    01 집합연산자1 (기본의미)    <- 유형

이 라벨을 좌표와 함께 읽어 문항에 짝지으면 태깅이 공짜다(AI 분류 불필요).
그래서 이 스크립트의 정확도 = 짝짓기의 정확도이고, 짝짓기는 **보수적**이다.

    잘못 붙은 라벨은 없는 라벨보다 훨씬 나쁘다.

이 데이터셋이 앞으로 태깅 정확도의 정답지로 쓰이기 때문이다. 그래서 한 페이지의
라벨 블록과 문항이 1:1 로 딱 떨어지지 않으면 **그 페이지는 라벨을 붙이지 않는다**
(문항 자체는 태그 없이 코퍼스에 들어가고, 리포트에 '미매칭' 으로 센다).

사용법::

    python scripts/ingest_typebook.py <pdf...> [--db PATH] [--outdir PATH]
                                      [--source-label TEXT] [--dry-run]
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import re
import sqlite3
import sys
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final

# 스크립트로 직접 실행하면(`python scripts/ingest_typebook.py`) sys.path[0] 이
# `scripts/` 라서 core 모듈을 못 찾는다. 패키지로 import 될 때는 이미 들어 있다.
_CORE_DIR: Final[Path] = Path(__file__).resolve().parents[1]
if str(_CORE_DIR) not in sys.path:
    sys.path.insert(0, str(_CORE_DIR))

import fitz  # noqa: E402

import config  # noqa: E402
import extractor  # noqa: E402
import storage  # noqa: E402
from extractor import Column, TextLine  # noqa: E402

# 라벨 줄: 두 자리 번호 + 공백 + 한글. 본문(수식·선택지)은 이 형태가 아니다.
LABEL_LINE_RE: Final[re.Pattern[str]] = re.compile(r"^(\d\d) [가-힣]")

# 라벨 블록의 첫 줄(과목)에만 허용하는 번호. 지금 코퍼스는 '08 공통수학2' 하나다.
# 다른 과목을 넣을 때 여기를 넓힌다 — 넓게 잡으면 대단원 줄이 블록의 첫 줄로
# 잘못 인정돼 3줄짜리 오탐이 생긴다.
SUBJECT_PREFIX: Final[str] = "08"

# 한 블록의 줄 수(과목/대단원/중단원/유형).
LABEL_LINES: Final[int] = 4

# 블록 안에서 이웃한 두 줄의 세로 간격 상한(pt). 실측 20pt 내외라 40pt 면
# 넉넉하고, 멀리 떨어진 남의 줄이 한 블록으로 엮이는 것은 막는다.
LABEL_MAX_GAP_PT: Final[float] = 40.0

# 해시 정규화에서 떼어내는 앞머리 문항번호("12." / "3)").
NUMBER_PREFIX_RE: Final[re.Pattern[str]] = re.compile(r"^\s*\d+[.)]\s*")

# 앞머리 번호를 몇 번까지 벗길지. 이 교재는 번호가 **두 겹**이다 — 크롭 왼쪽의
# 큰 번호("12.")와 본문 첫 글자로 들어간 번호("12)")가 텍스트 레이어에 둘 다
# 나온다. 한 번만 벗기면 안쪽 번호가 남아, 같은 문항이라도 교재 내 위치가
# 다르면 해시가 갈린다(= 중복을 못 잡는다). 번호는 위치 메타이지 내용이 아니다.
# 무한루프 방지로 상한을 둔다. 본문이 진짜 숫자로 시작하는 경우("3의 배수를…")는
# 뒤에 `.`/`)` 가 없어 애초에 매치되지 않는다.
NUMBER_PREFIX_MAX_STRIPS: Final[int] = 3

# 인쇄된 라벨은 추정이 아니라 사실이므로 confidence 는 1.0 이다.
LABEL_CONFIDENCE: Final[float] = 1.0

# 리포트에 찍는 유형 분포 상위 개수.
TOP_TYPES: Final[int] = 15

# 태그를 붙이지 못한 사유. 리포트에서 "왜 못 붙였는지"를 구분해 보여준다.
UNTAGGED_NO_LABEL: Final[str] = "라벨 0개"
UNTAGGED_MULTIPLE: Final[str] = "라벨 2개 이상"
UNTAGGED_MISPLACED: Final[str] = "라벨이 문항 아래"


# ------------------------------------------------------------------ 자료구조
@dataclass(frozen=True)
class LabelBlock:
    """페이지에 인쇄된 4단계 분류 라벨 한 블록."""

    subject: str
    area: str
    chapter: str
    name: str
    type_id: str
    column: Column
    y0: float
    y1: float

    @property
    def evidence(self) -> str:
        """태그의 판단 근거로 남길 라벨 원문 4줄."""
        return "\n".join((self.subject, self.area, self.chapter, self.name))


@dataclass(frozen=True)
class ProblemBox:
    """짝짓기에 필요한 문항의 위치 정보만 추린 것.

    `extractor.Problem` 을 그대로 쓰지 않는 이유는 짝짓기 로직을 PDF 없이
    테스트할 수 있게 하기 위해서다.
    """

    no: int
    column: Column
    top: float


@dataclass(frozen=True)
class PageMatch:
    """한 페이지의 짝짓기 결과.

    태그를 못 붙인 문항은 **사유와 함께** 남긴다. 그냥 세기만 하면 "안전장치가
    작동한 것"과 "파싱이 깨진 것"을 구분할 수 없다.
    """

    labels: dict[int, LabelBlock]
    untagged: dict[int, str]


@dataclass
class FileReport:
    """PDF 한 건의 적재 결과."""

    path: Path
    problems: int = 0
    matched: int = 0
    unmatched: int = 0
    duplicates: int = 0
    tagged: int = 0
    untagged_reasons: Counter[str] = field(default_factory=Counter)
    unmatched_pages: list[int] = field(default_factory=list)


# ------------------------------------------------------------------ 라벨 파싱
def type_id_from_lines(lines: Sequence[str]) -> str | None:
    """라벨 4줄 -> 유형 id.

    각 줄의 앞 두 자리 숫자를 점으로 잇는다::

        ['08 공통수학2', '06 집합의연산', '01 집합의연산자', '01 집합연산자1 (기본의미)']
        -> '08.06.01.01'

    Args:
        lines: 라벨 줄 4개(과목/대단원/중단원/유형 순).

    Returns:
        유형 id. 줄 수가 4가 아니거나 형식이 맞지 않으면 None.
    """
    if len(lines) != LABEL_LINES:
        return None
    numbers: list[str] = []
    for line in lines:
        match = LABEL_LINE_RE.match(line.strip())
        if match is None:
            return None
        numbers.append(match.group(1))
    return ".".join(numbers)


def _is_block(group: Sequence[TextLine]) -> bool:
    """연속 4줄이 한 라벨 블록인지.

    첫 줄이 과목 번호로 시작하고, 이웃한 줄 사이가 `LABEL_MAX_GAP_PT` 안이어야
    한다. 첫 줄 조건이 없으면 두 블록이 붙어 있을 때 경계가 밀려 엉킨다.
    """
    if len(group) != LABEL_LINES:
        return False
    if not group[0].text.strip().startswith(f"{SUBJECT_PREFIX} "):
        return False
    return all(
        (group[index + 1].bbox[1] - group[index].bbox[1]) <= LABEL_MAX_GAP_PT
        for index in range(LABEL_LINES - 1)
    )


def find_label_blocks(
    lines: Sequence[TextLine], *, page_center: float
) -> list[LabelBlock]:
    """페이지 텍스트 줄에서 라벨 블록을 찾는다.

    칼럼(좌/우)별로 나눠 세로 순서대로 훑으며, 과목 줄에서 시작하는 연속 4줄만
    블록으로 인정한다. 2단 조판이라 같은 y 에 좌·우 블록이 나란히 오므로 칼럼을
    먼저 가르지 않으면 두 블록이 섞인다.

    Args:
        lines: `extractor._page_lines` 결과.
        page_center: 칼럼 판정 기준 x(= 페이지 가로 중앙).

    Returns:
        블록 목록. 좌측 칼럼 먼저, 각 칼럼 안에서는 위에서 아래 순서.
    """
    by_column: dict[Column, list[TextLine]] = {"left": [], "right": []}
    for line in lines:
        if LABEL_LINE_RE.match(line.text.strip()) is None:
            continue
        column: Column = "left" if line.bbox[0] < page_center else "right"
        by_column[column].append(line)

    blocks: list[LabelBlock] = []
    for column, column_lines in by_column.items():
        column_lines.sort(key=lambda line: line.bbox[1])
        index = 0
        while index < len(column_lines):
            group = column_lines[index : index + LABEL_LINES]
            texts = [line.text.strip() for line in group]
            type_id = type_id_from_lines(texts) if _is_block(group) else None
            if type_id is None:
                index += 1
                continue
            blocks.append(
                LabelBlock(
                    subject=texts[0],
                    area=texts[1],
                    chapter=texts[2],
                    name=texts[3],
                    type_id=type_id,
                    column=column,
                    y0=group[0].bbox[1],
                    y1=group[-1].bbox[3],
                )
            )
            index += LABEL_LINES

    blocks.sort(key=lambda block: (0 if block.column == "left" else 1, block.y0))
    return blocks


# ------------------------------------------------------------------ 짝짓기
def match_labels(
    blocks: Sequence[LabelBlock], problems: Sequence[ProblemBox]
) -> PageMatch:
    """라벨 블록을 같은 페이지의 문항에 짝지운다 (칼럼 단위, 보수적).

    **라벨은 문항이 아니라 칼럼에 붙는다.** 실측(집합1/집합10 전 페이지)에서
    라벨 상자는 칼럼 맨 위에 하나만 인쇄되고, 그 아래 문항이 둘·셋이어도 상자는
    늘어나지 않는다. 문항당 1:1 로 보면 한 칼럼에 문항이 둘 이상인 페이지를
    통째로 버리게 되므로(집합1 기준 13% 손실), 칼럼 단위로 잇는다.

    규칙: 한 칼럼의 라벨 블록이 **정확히 1개일 때만** 그 칼럼의 **모든 문항**에
    그 라벨을 붙인다. 다음 경우는 그 칼럼의 문항을 태그 없이 남긴다.

      * 블록 0개 -> 붙일 라벨이 없다.
      * 블록 2개 이상 -> 어느 쪽이 맞는지 알 수 없다.
      * 하나뿐인 블록이 문항보다 아래에 있다 -> 라벨 상자가 아닐 수 있다.

    잘못 붙은 라벨은 없는 라벨보다 나쁘다. 이 데이터가 앞으로 태깅 정확도
    측정의 정답지로 쓰이기 때문이다.

    Args:
        blocks: 그 페이지의 라벨 블록.
        problems: 그 페이지의 문항 위치.

    Returns:
        붙인 라벨과, 못 붙인 문항의 사유.
    """
    labels: dict[int, LabelBlock] = {}
    untagged: dict[int, str] = {}
    for column in ("left", "right"):
        column_blocks = [block for block in blocks if block.column == column]
        column_problems = [
            problem for problem in problems if problem.column == column
        ]
        if not column_problems:
            continue

        if not column_blocks:
            reason = UNTAGGED_NO_LABEL
        elif len(column_blocks) > 1:
            reason = UNTAGGED_MULTIPLE
        else:
            block = column_blocks[0]
            if all(block.y1 <= problem.top for problem in column_problems):
                for problem in column_problems:
                    labels[problem.no] = block
                continue
            reason = UNTAGGED_MISPLACED

        for problem in column_problems:
            untagged[problem.no] = reason
    return PageMatch(labels=labels, untagged=untagged)


# ------------------------------------------------------------------ 해시
def normalize_for_hash(raw_text: str) -> str:
    """해시용 정규화: 앞머리 문항번호를 떼고 모든 공백을 지운다.

    번호는 문제집마다 다르게 매겨지고 줄바꿈은 조판 산물이라, 둘 다 문항의
    **내용**이 아니다. 남기면 같은 문항이 서로 다른 문항으로 보인다.

    번호는 `NUMBER_PREFIX_MAX_STRIPS` 회까지 반복해서 벗긴다 — 이 교재는
    큰 번호("12.")와 본문 첫 글자 번호("12)")가 줄바꿈을 사이에 두고 잇달아
    나오므로, 한 번만 벗기면 안쪽 번호가 남는다.
    """
    text = raw_text
    for _ in range(NUMBER_PREFIX_MAX_STRIPS):
        stripped = NUMBER_PREFIX_RE.sub("", text, count=1)
        if stripped == text:
            break
        text = stripped
    return re.sub(r"\s+", "", text)


def compute_content_hash(raw_text: str, image_bytes: bytes | None) -> str:
    """문항의 중복 판정 키(sha256).

    텍스트 레이어가 있으면 정규화 본문으로, 없으면(스캔 PDF 등) 크롭 PNG
    바이트로 낸다.

    Args:
        raw_text: PDF 텍스트 레이어 원문.
        image_bytes: 크롭 PNG 바이트(없으면 None).

    Returns:
        16진 sha256.

    Raises:
        ValueError: 텍스트도 이미지도 없을 때(해시할 내용이 없다).
    """
    normalized = normalize_for_hash(raw_text)
    if normalized:
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    if image_bytes:
        return hashlib.sha256(image_bytes).hexdigest()
    raise ValueError("본문도 크롭 이미지도 없어 content_hash 를 낼 수 없습니다.")


# ------------------------------------------------------------------ DB 쓰기
def open_db(path: Path) -> sqlite3.Connection:
    """지정한 경로의 DB 를 열고 스키마를 최신으로 맞춘다.

    `storage.connect()` 는 전역 설정(`config.db_path()`)을 보므로 쓰지 않는다.
    개발 중 실수로 운영 DB 를 건드리지 않게 `--db` 를 그대로 존중한다.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(storage.SCHEMA)
    storage.migrate(conn)
    conn.commit()
    return conn


def _hash_exists(conn: sqlite3.Connection, content_hash: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM bank_problems WHERE content_hash = ?", (content_hash,)
    ).fetchone()
    return row is not None


def store_bank_problem(
    conn: sqlite3.Connection,
    *,
    bank_id: str,
    content_hash: str,
    crop_path: str,
    raw_text: str,
    source_label: str,
    seen: set[str],
    dry_run: bool = False,
) -> bool:
    """코퍼스에 문항을 넣는다. **중복이면 넣지 않고 False**.

    같은 문항이 여러 교재 파일에 실려 있는 것은 정상이므로 중복은 오류가 아니다.
    이번 실행에서 이미 본 해시(`seen`)와 DB 에 있는 해시를 모두 본다 — 전자만
    보면 한 실행 안의 중복을 못 걸러 유니크 인덱스에 걸리고, 후자만 보면
    dry-run 이 아무것도 못 센다.

    Args:
        conn: 열린 커넥션.
        bank_id: 호출자가 미리 만든 문항 id. 크롭 파일 이름도 이 값이라
            호출자가 먼저 알아야 한다.
        content_hash: `compute_content_hash` 결과.
        crop_path: 크롭 PNG 경로(저장할 값).
        raw_text: PDF 텍스트 레이어 원문.
        source_label: 출처 표기.
        seen: 이번 실행에서 이미 넣은 해시 집합(호출자가 유지, 갱신됨).
        dry_run: True 면 DB 에 쓰지 않고 판정만 한다.

    Returns:
        넣었으면 True, 중복이라 건너뛰었으면 False.
    """
    if content_hash in seen or _hash_exists(conn, content_hash):
        seen.add(content_hash)
        return False
    seen.add(content_hash)
    if dry_run:
        return True
    return storage.insert_bank_problem(
        conn,
        bank_id=bank_id,
        crop_path=crop_path,
        raw_text=raw_text,
        content_hash=content_hash,
        origin=storage.BANK_ORIGIN_SEED,
        visibility=storage.BANK_SHARED,
        source_label=source_label,
        owner_id=None,
    )


# ------------------------------------------------------------------ 적재
def _crop_path_value(path: Path) -> str:
    """저장할 크롭 경로 문자열.

    데이터 루트 아래면 상대경로(기존 `crops/...` 와 같은 규칙), 밖이면 절대경로.
    임시 디렉터리로 시험 적재할 때 경로가 깨지지 않게 하려는 것이다.
    """
    resolved = path.resolve()
    try:
        return resolved.relative_to(config.data_dir().resolve()).as_posix()
    except ValueError:
        return resolved.as_posix()


def _page_label_blocks(
    pdf_path: Path,
) -> tuple[dict[int, list[LabelBlock]], dict[int, float]]:
    """페이지(1-based) -> 라벨 블록 목록, 페이지 -> 가로 중앙 x."""
    blocks_by_page: dict[int, list[LabelBlock]] = {}
    centers: dict[int, float] = {}
    doc = fitz.open(str(pdf_path))
    try:
        for index in range(doc.page_count):
            page = doc[index]
            center = page.rect.x0 + page.rect.width / 2.0
            centers[index + 1] = center
            blocks_by_page[index + 1] = find_label_blocks(
                extractor._page_lines(page), page_center=center
            )
    finally:
        doc.close()
    return blocks_by_page, centers


def ingest_pdf(
    conn: sqlite3.Connection,
    pdf_path: Path,
    *,
    outdir: Path,
    source_label: str,
    seen: set[str],
    type_counts: Counter[str],
    type_names: dict[str, str],
    dry_run: bool = False,
) -> FileReport:
    """PDF 한 건을 코퍼스에 적재한다.

    Args:
        conn: 열린 커넥션.
        pdf_path: 유형 문제집 PDF.
        outdir: 크롭 PNG 저장 폴더.
        source_label: 출처 표기.
        seen: 실행 전체에서 공유하는 해시 집합.
        type_counts: 유형별 태그 수(누적, 갱신됨).
        type_names: 유형 id -> 이름(리포트용, 갱신됨).
        dry_run: True 면 DB·파일에 쓰지 않는다.

    Returns:
        이 파일의 적재 결과.
    """
    report = FileReport(path=pdf_path)
    result = extractor.extract_problems(pdf_path, render_images=True)
    report.problems = len(result.problems)
    blocks_by_page, centers = _page_label_blocks(pdf_path)

    # 1) 페이지별로 라벨 <-> 문항 짝짓기
    by_page: dict[int, list[extractor.Problem]] = {}
    for problem in result.problems:
        by_page.setdefault(problem.page, []).append(problem)

    labels: dict[int, LabelBlock] = {}
    for page_no, page_problems in sorted(by_page.items()):
        center = centers.get(page_no, 0.0)
        boxes = [
            ProblemBox(
                no=problem.no,
                column="left" if problem.bbox[0] < center else "right",
                top=problem.bbox[1],
            )
            for problem in page_problems
        ]
        page_match = match_labels(blocks_by_page.get(page_no, []), boxes)
        if page_match.untagged:
            report.unmatched_pages.append(page_no)
            report.untagged_reasons.update(page_match.untagged.values())
        labels.update(page_match.labels)
    report.matched = len(labels)
    report.unmatched = report.problems - report.matched

    # 2) 문항 저장 + 태그
    if not dry_run:
        outdir.mkdir(parents=True, exist_ok=True)
    for problem in result.problems:
        image_bytes = (
            base64.b64decode(problem.image_b64) if problem.image_b64 else None
        )
        content_hash = compute_content_hash(problem.text, image_bytes)
        # 크롭 파일 이름은 문항 id 다. 페이지·번호로 지으면 여러 교재를 한
        # 폴더에 적재할 때 이름이 겹쳐 남의 크롭을 덮어쓴다(실측: 300건 중 7건).
        bank_id = storage.new_id()
        crop_path = outdir / f"{bank_id}.png"
        stored = store_bank_problem(
            conn,
            bank_id=bank_id,
            content_hash=content_hash,
            crop_path=_crop_path_value(crop_path),
            raw_text=problem.text,
            source_label=source_label,
            seen=seen,
            dry_run=dry_run,
        )
        if not stored:
            report.duplicates += 1
            continue
        if not dry_run and image_bytes is not None:
            crop_path.write_bytes(image_bytes)

        block = labels.get(problem.no)
        if block is None:
            continue
        type_counts[block.type_id] += 1
        type_names.setdefault(block.type_id, block.name)
        report.tagged += 1
        if dry_run:
            continue
        storage.upsert_problem_type(
            conn,
            type_id=block.type_id,
            subject=block.subject,
            area=block.area,
            chapter=block.chapter,
            name=block.name,
        )
        storage.insert_problem_tag(
            conn,
            bank_id=bank_id,
            type_id=block.type_id,
            confidence=LABEL_CONFIDENCE,
            source=storage.TAG_SOURCE_LABEL,
            evidence=block.evidence,
        )
    if not dry_run:
        conn.commit()
    return report


# ------------------------------------------------------------------ 리포트
def print_report(
    reports: Sequence[FileReport],
    type_counts: Counter[str],
    type_names: dict[str, str],
    *,
    dry_run: bool,
) -> None:
    """적재 결과를 stdout 에 출력한다."""
    title = "유형 문제집 적재 리포트"
    if dry_run:
        title += " (dry-run: 아무것도 쓰지 않음)"
    print("=" * 78)
    print(title)
    print("=" * 78)
    header = (
        f"{'파일':<28} {'문항':>6} {'라벨매칭':>8}"
        f" {'미매칭':>7} {'중복':>6} {'태그':>6}"
    )
    print(header)
    print("-" * 78)
    for report in reports:
        print(
            f"{report.path.name:<28} {report.problems:>6} {report.matched:>8} "
            f"{report.unmatched:>7} {report.duplicates:>6} {report.tagged:>6}"
        )
    print("-" * 78)

    total_problems = sum(report.problems for report in reports)
    total_matched = sum(report.matched for report in reports)
    total_duplicates = sum(report.duplicates for report in reports)
    rate = (total_matched / total_problems * 100.0) if total_problems else 0.0
    print(
        f"전체: 문항 {total_problems}, 유형 {len(type_counts)}개, "
        f"매칭률 {rate:.1f}% (중복 건너뜀 {total_duplicates})"
    )

    reasons: Counter[str] = Counter()
    for report in reports:
        reasons.update(report.untagged_reasons)
    total_untagged = sum(reasons.values())
    print(f"\n태그 없이 저장된 문항 {total_untagged}건 — 사유별")
    if not reasons:
        print("  (없음)")
    for reason, count in reasons.most_common():
        print(f"  {reason:<20} {count:>5}")

    print(f"\n유형별 분포 상위 {TOP_TYPES}개")
    if not type_counts:
        print("  (없음)")
    for type_id, count in type_counts.most_common(TOP_TYPES):
        print(f"  {type_id}  {type_names.get(type_id, ''):<40} {count:>5}")

    unmatched = [report for report in reports if report.unmatched_pages]
    if unmatched:
        print("\n라벨 미매칭 페이지 (그 칼럼의 문항은 태그 없이 저장됨)")
        for report in unmatched:
            pages = ", ".join(str(page) for page in report.unmatched_pages)
            print(f"  {report.path.name}: {pages}")


# ------------------------------------------------------------------ CLI
def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="유형 문제집 PDF 를 공용 문항 코퍼스(bank)에 적재한다 (AI 호출 0회)"
    )
    parser.add_argument("pdf", nargs="+", help="PDF 경로 (한글/공백 포함 가능)")
    parser.add_argument(
        "--db", default=None, help=f"SQLite 경로 (기본 {config.db_path()})"
    )
    parser.add_argument(
        "--outdir", default=None, help=f"크롭 PNG 폴더 (기본 {config.bank_crops_dir()})"
    )
    parser.add_argument(
        "--source-label",
        default=None,
        help="출처 표기. 생략하면 파일명에서 만든다('학원자료 <파일명>')",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="DB·파일에 쓰지 않고 결과만 센다"
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI 진입점."""
    args = _build_arg_parser().parse_args(argv)

    pdf_paths = [Path(item) for item in args.pdf]
    missing = [path for path in pdf_paths if not path.is_file()]
    if missing:
        for path in missing:
            print(f"[error] 파일을 찾을 수 없습니다: {path}", file=sys.stderr)
        return 2

    db_path = Path(args.db) if args.db else config.db_path()
    outdir = Path(args.outdir) if args.outdir else config.bank_crops_dir()

    conn = open_db(db_path)
    try:
        seen: set[str] = set()
        type_counts: Counter[str] = Counter()
        type_names: dict[str, str] = {}
        reports: list[FileReport] = []
        for path in pdf_paths:
            source_label = args.source_label or f"학원자료 {path.stem}"
            reports.append(
                ingest_pdf(
                    conn,
                    path,
                    outdir=outdir,
                    source_label=source_label,
                    seen=seen,
                    type_counts=type_counts,
                    type_names=type_names,
                    dry_run=args.dry_run,
                )
            )
    finally:
        conn.close()

    print_report(reports, type_counts, type_names, dry_run=args.dry_run)
    print(f"\nDB     : {db_path}")
    print(f"크롭   : {outdir}")
    print("AI 호출: 0회 (비용 0원)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
