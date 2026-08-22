"""extractor 회귀 테스트 (AI 호출 없음, 합성 PDF 로만 검증).

실제 시험지 PDF 는 gitignore(tmp/) 라 커밋할 수 없으므로 fitz 로 최소 조판을
합성한다. 여기서 재현하는 버그: 괘선이 없어 content_rect 가 비율 마진으로
폴백하는 페이지에서, 각 칼럼 맨 위에서 시작하는 정상 문제 앵커가 상단 머리말
마진에 걸려 통째로 누락되던 문제.
"""

from __future__ import annotations

import re
from pathlib import Path

import fitz
import pytest

import extractor as ex

#: 저장소에 커밋된 22문항 시험지. 회귀 기준선이다.
REPO_ROOT = Path(__file__).resolve().parents[3]
EXAM_PDF = REPO_ROOT / "[2026-1-1-M][공수1][풍문고].pdf"
#: 사용자 자료(gitignore). 없으면 해당 테스트를 건너뛴다.
TYPE_WORKBOOK_PDF = REPO_ROOT / "tmp" / "test" / "집합1 (1).pdf"


def _build_two_column_pdf(pages: int = 2) -> bytes:
    """괘선 없이 2단 조판된 PDF 를 만든다.

    각 페이지 좌/우 칼럼 맨 위(y0≈40pt)와 중간(y0≈388pt)에 문제 번호를 배치한다.
    가로 괘선을 전혀 그리지 않으므로 content_rect 는 비율 마진 폴백을 탄다.
    """
    doc = fitz.open()
    try:
        for page_index in range(pages):
            base = page_index * 4
            page = doc.new_page(width=595, height=841)
            page.insert_text((40, 52), f"{base + 1}. 좌측 상단 문제", fontsize=11)
            page.insert_text((40, 400), f"{base + 2}. 좌측 하단 문제", fontsize=11)
            page.insert_text((310, 52), f"{base + 3}. 우측 상단 문제", fontsize=11)
            page.insert_text((310, 400), f"{base + 4}. 우측 하단 문제", fontsize=11)
        data: bytes = doc.tobytes()
        return data
    finally:
        doc.close()


def test_fallback_margin_top_smaller_than_bottom() -> None:
    """폴백 마진은 상단 3%, 하단 6% 로 비대칭이어야 한다.

    상단을 좁혀 칼럼 맨 위 문제를 살리되, 하단은 넓게 유지해 꼬리말(가운데
    페이지 번호)이 크롭에 딸려오지 않게 한 의도를 고정한다.
    """
    doc = fitz.open(stream=_build_two_column_pdf(1), filetype="pdf")
    try:
        page = doc[0]
        assert not page.get_drawings()  # 괘선이 없어 폴백 경로를 타는지 확인
        content = ex.content_rect(page)
        height = page.rect.height
        assert content.y0 == page.rect.y0 + height * 0.03
        assert content.y1 == page.rect.y1 - height * 0.06
    finally:
        doc.close()


def test_top_of_column_anchor_is_in_previously_broken_band() -> None:
    """합성 앵커가 '예전 6% 마진이라면 잘렸을' 상단 밴드에 실제로 놓였는지 확인.

    이게 성립해야 아래 검출 테스트가 회귀를 실제로 방어한다.
    """
    doc = fitz.open(stream=_build_two_column_pdf(1), filetype="pdf")
    try:
        page = doc[0]
        height = page.rect.height
        old_cutoff = page.rect.y0 + height * 0.06
        new_cutoff = page.rect.y0 + height * 0.03
        top_anchor_y0 = min(
            line.bbox[1]
            for line in ex._page_lines(page)
            if ex.ANCHOR_RE.match(line.text)
        )
        # 예전 컷오프(≈50.5)보다는 위, 새 컷오프(≈25.2)보다는 아래여야
        # "예전엔 잘렸고 이제는 살아난다" 를 보장한다.
        assert new_cutoff < top_anchor_y0 < old_cutoff
    finally:
        doc.close()


def test_top_of_column_problems_not_dropped() -> None:
    """칼럼 맨 위에서 시작하는 문제(1,3,5,7)가 누락되지 않는다."""
    pdf_bytes = _build_two_column_pdf(2)
    result = ex.extract_problems(pdf_bytes=pdf_bytes, render_images=False)
    numbers = [problem.no for problem in result.problems]
    assert numbers == [1, 2, 3, 4, 5, 6, 7, 8]


def test_footer_page_number_stays_out_of_content() -> None:
    """하단 6% 유지 덕분에 꼬리말(하단 ~2.4% 지점 페이지 번호)이 본문 밖에 남는다."""
    doc = fitz.open()
    try:
        page = doc.new_page(width=595, height=841)
        page.insert_text((40, 52), "1. 좌측 상단 문제", fontsize=11)
        page.insert_text((310, 52), "2. 우측 상단 문제", fontsize=11)
        # 꼬리말 페이지 번호: 하단에서 약 2.4% 지점(y≈811, baseline≈820)에 가운데 정렬
        page.insert_text((285, 820), "- 1 -", fontsize=9)
        pdf_bytes = doc.tobytes()
    finally:
        doc.close()

    doc2 = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        content = ex.content_rect(doc2[0])
        footer_y0 = next(
            line.bbox[1]
            for line in ex._page_lines(doc2[0])
            if line.text.strip().startswith("- 1 -")
        )
        # 꼬리말은 본문 하단 경계 아래에 있어 크롭 대상에서 제외된다.
        assert footer_y0 > content.y1
    finally:
        doc2.close()


# --- 유형 문제집 폴백 -----------------------------------------------------


def test_merge_type_number_glyphs_joins_split_number() -> None:
    """같은 줄에 쪼개진 "00"+"1" 이 하나의 번호 1 로 병합된다."""
    glyphs = [(42.5, 191.7, 59.0, "00"), (60.2, 191.7, 68.0, "1")]
    assert ex._merge_type_number_glyphs(glyphs) == [(1, 42.5, 191.7)]


def test_merge_type_number_glyphs_zero_padded_and_trailing_space() -> None:
    """zero-padded/후행 공백도 정수로 파싱한다 ("0"+"11 " -> 11)."""
    glyphs = [(334.5, 320.3, 342.3, "0"), (343.0, 320.3, 364.2, "11 ")]
    assert ex._merge_type_number_glyphs(glyphs) == [(11, 334.5, 320.3)]


def test_merge_type_number_glyphs_same_y_different_column_not_merged() -> None:
    """같은 y0 라도 가로 간격이 크면(다른 칼럼) 별개 번호로 끊는다."""
    glyphs = [
        (42.5, 69.2, 59.0, "00"),
        (60.2, 69.2, 87.0, "6"),  # 좌측 006
        (348.7, 69.2, 365.1, "00"),
        (366.4, 69.2, 374.2, "8"),  # 우측 008
    ]
    assert ex._merge_type_number_glyphs(glyphs) == [
        (6, 42.5, 69.2),
        (8, 348.7, 69.2),
    ]


def _build_type_workbook_pdf() -> bytes:
    """유형 문제집을 흉내낸 2단 PDF.

    실제 문서의 DINCondensed-Bold 는 합성할 수 없으므로, 큰 크기(21pt) 번호를
    builtin 폰트로 찍고(보고 이름 "Helvetica") 검출부의 폰트 힌트를 그 이름으로
    맞춘다. 시험지 앵커("1." 형식)는 하나도 두지 않아 폴백 경로가 트리거되게 한다.
    """
    doc = fitz.open()
    try:
        layout = [
            [("001", 40, 120), ("002", 40, 400), ("003", 320, 120), ("004", 320, 400)],
            [("005", 40, 120), ("006", 40, 400), ("007", 320, 120), ("008", 320, 400)],
        ]
        for numbers in layout:
            page = doc.new_page(width=595, height=841)
            for text, x, y in numbers:
                page.insert_text((x, y), text, fontsize=21, fontname="helv")
                # 본문 더미(작은 폰트) — "1." 앵커가 아니어야 한다.
                page.insert_text((x, y + 20), "본문 dummy", fontsize=10)
        data: bytes = doc.tobytes()
        return data
    finally:
        doc.close()


def test_type_workbook_fallback_detects_and_forces_image(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """시험지 앵커가 없으면 유형 폴백이 001..008 을 순서대로 잡고 image 로 강제."""
    # builtin 폰트는 "Helvetica" 로 보고되므로 힌트를 맞춘다.
    monkeypatch.setattr(ex, "TYPE_ANCHOR_FONT_HINT", "Helvetica")
    pdf_bytes = _build_type_workbook_pdf()

    result = ex.extract_problems(pdf_bytes=pdf_bytes, render_images=False)
    numbers = [problem.no for problem in result.problems]
    assert numbers == [1, 2, 3, 4, 5, 6, 7, 8]
    assert result.mode == "image"


def test_exam_paper_does_not_trigger_type_fallback() -> None:
    """시험지("1." 형식)는 폴백을 타지 않고 text 모드로 남는다(회귀 방지)."""
    pdf_bytes = _build_two_column_pdf(2)
    result = ex.extract_problems(pdf_bytes=pdf_bytes, render_images=False)
    numbers = [problem.no for problem in result.problems]
    assert numbers == [1, 2, 3, 4, 5, 6, 7, 8]
    # 폴백을 타면 image 로 바뀐다. text 유지 == 폴백 미발동.
    assert result.mode == "text"


# ── 번호 구분자 ")" 지원 + 머리글 표 괘선 방어 ────────────────────────
# 실측 회귀: `tmp/0809 일일테스트.pdf` (A3 2단, 서술형 15문항)
#   ① 문제 번호가 "1)" 형식이라 `\d+\.` 앵커로는 0문항이었다.
#   ② 첫 장 머리글 표(성명·일자 칸)의 가로선이 본문 괘선으로 잡혀
#      content_rect 가 높이 -4pt 인 뒤집힌 사각형이 되어 1~4번이 통째로 버려졌다.


def _build_paren_number_pdf(pages: int = 2) -> bytes:
    """문제 번호가 `1)` 형식인 2단 조판 PDF."""
    doc = fitz.open()
    try:
        for page_index in range(pages):
            base = page_index * 4
            page = doc.new_page(width=595, height=841)
            page.insert_text((40, 52), f"{base + 1})좌측 상단 문제", fontsize=11)
            page.insert_text((40, 400), f"{base + 2})좌측 하단 문제", fontsize=11)
            page.insert_text((310, 52), f"{base + 3})우측 상단 문제", fontsize=11)
            page.insert_text((310, 400), f"{base + 4})우측 하단 문제", fontsize=11)
        data: bytes = doc.tobytes()
        return data
    finally:
        doc.close()


def _build_header_table_pdf() -> bytes:
    """머리글 표의 가로선 2개만 있고 본문 괘선은 없는 페이지.

    두 선을 거의 같은 높이(y=230, 231)에 두어 괘선 검출이 '높이 0 이하'인
    본문 영역을 만들게 한다. 문제는 그 아래에 정상 배치한다.
    """
    doc = fitz.open()
    try:
        page = doc.new_page(width=595, height=841)
        for y in (230.0, 231.0):
            page.draw_line(fitz.Point(40, y), fitz.Point(555, y), width=0.5)
        page.insert_text((40, 300), "1. 좌측 문제", fontsize=11)
        page.insert_text((310, 300), "2. 우측 문제", fontsize=11)
        data: bytes = doc.tobytes()
        return data
    finally:
        doc.close()


def test_paren_style_numbers_are_detected() -> None:
    """`1)` 형식 문제 번호도 앵커로 잡힌다."""
    result = ex.extract_problems(
        pdf_bytes=_build_paren_number_pdf(2), render_images=False
    )
    assert [problem.no for problem in result.problems] == [1, 2, 3, 4, 5, 6, 7, 8]


def test_choice_parens_do_not_shadow_dot_anchors() -> None:
    """`1.` 형식 객관식 시험지에서 선택지 `1)`이 문제 번호를 밀어내지 않는다.

    선택지는 **개수로는 문제보다 많다**(문항 6개에 선택지 5개씩 = 30개 대 6개).
    개수로 구분자를 고르면 추출이 통째로 무너진다. 번호 단조증가 사슬 길이로
    고르는 규칙(`_dominant_delimiter`)이 이를 막는지 고정한다.

    최악을 가정해 선택지를 들여쓰기 없이 칼럼 왼쪽 끝에 붙인다(실제 시험지는
    들여쓰기되어 indent_tol 로도 걸러진다).
    """
    doc = fitz.open()
    try:
        # 문항 6개(마침표), 각 문항마다 선택지 5개(닫는 괄호) = 괄호가 5배 많다.
        for page_index in range(2):
            page = doc.new_page(width=595, height=841)
            for slot in range(3):
                no = page_index * 3 + slot + 1
                top = 52 + slot * 260
                page.insert_text((40, top), f"{no}. 좌측 문제", fontsize=11)
                for choice in range(1, 6):
                    page.insert_text(
                        (40, top + 20 + choice * 25), f"{choice}) 선택지", fontsize=11
                    )
        pdf_bytes = doc.tobytes()
    finally:
        doc.close()

    result = ex.extract_problems(pdf_bytes=pdf_bytes, render_images=False)
    assert [problem.no for problem in result.problems] == [1, 2, 3, 4, 5, 6]


def test_dominant_delimiter_uses_increasing_chain_not_count() -> None:
    """구분자는 개수가 아니라 번호 단조증가 사슬 길이로 고른다."""

    def anchor(no: int) -> ex.Anchor:
        return ex.Anchor(no=no, page=0, column="left", x0=40.0, y0=50.0)

    # 사슬이 같으면(둘 다 1) 마침표 — 기존 검증된 경로 우선.
    assert ex._dominant_delimiter([(anchor(1), "."), (anchor(1), ")")]) == "."
    assert ex._dominant_delimiter([]) == "."

    # 마침표가 없으면 괄호를 고른다(`1)` 형식 시험지).
    parens = [(anchor(no), ")") for no in range(1, 6)]
    assert ex._dominant_delimiter(parens) == ")"

    # 개수는 괄호가 3배 많지만 사슬은 마침표가 길다 → 마침표.
    dots = [(anchor(no), ".") for no in range(1, 5)]
    repeating = [(anchor(no), ")") for _ in range(4) for no in (1, 2, 3)]
    assert ex._dominant_delimiter(dots + repeating) == "."


def test_header_table_rules_fall_back_to_ratio_margins() -> None:
    """머리글 표 괘선만 잡히면 비율 폴백을 쓴다(높이 0 이하 본문 방지)."""
    doc = fitz.open(stream=_build_header_table_pdf(), filetype="pdf")
    try:
        page = doc[0]
        content = ex.content_rect(page)
        # 괘선 기반이었다면 높이가 음수였다. 폴백이면 상단 3% / 하단 6%.
        assert content.height > 0
        assert content.y0 == page.rect.y0 + page.rect.height * 0.03
        assert content.y1 == page.rect.y1 - page.rect.height * 0.06
    finally:
        doc.close()


def test_problems_below_header_table_are_not_dropped() -> None:
    """머리글 표가 있는 페이지의 문제가 통째로 버려지지 않는다."""
    result = ex.extract_problems(pdf_bytes=_build_header_table_pdf(), render_images=False)
    assert [problem.no for problem in result.problems] == [1, 2]


# ── 구획마다 번호가 되돌아가는 교재 (부교재/문제집) ──────────────────
# 실측: 풍문고 부교재는 `< 기 본 >` 1~5, `< 심 화 >` 1~2 로 번호가 리셋된다.
# 순증가만 인정하면 두 번째 구획이 통째로 버려지고, 그대로 저장하면
# problems 의 기본키 (node_id, no) 가 충돌해 뒤 문항이 앞 문항을 덮어쓴다.


def test_pick_anchor_chain_allows_section_reset() -> None:
    """`1` 이 다시 나오면 새 구획으로 보고 살린다."""
    assert ex._pick_anchor_chain([1, 2, 3, 1, 2]) == [0, 1, 2, 3, 4]


def test_pick_anchor_chain_still_drops_noise() -> None:
    """1 이 아닌데 작아지는 값(본문 오탐)은 계속 버린다."""
    assert ex._pick_anchor_chain([1, 2, 9, 3, 4]) == [0, 1, 3, 4]


def test_pick_anchor_chain_matches_increasing_for_plain_exam() -> None:
    """보통 시험지(리셋 없음)에서는 기존 순증가 결과와 같다."""
    numbers = [1, 2, 3, 4, 5, 6]
    assert ex._pick_anchor_chain(numbers) == ex._longest_increasing(numbers)


def test_duplicate_numbers_are_renumbered_with_label_kept() -> None:
    """번호가 겹치면 1..N 으로 다시 매기고 원문 표기는 label 에 남긴다."""
    problems = [
        ex.Problem(no=1, page=1, bbox=[0, 0, 1, 1], text="", label="1"),
        ex.Problem(no=2, page=1, bbox=[0, 0, 1, 1], text="", label="2"),
        ex.Problem(no=1, page=2, bbox=[0, 0, 1, 1], text="", label="1"),
    ]
    ex._renumber_duplicates(problems)

    assert [problem.no for problem in problems] == [1, 2, 3]
    assert [problem.label for problem in problems] == ["1", "2", "1"]


def test_unique_numbers_are_left_alone() -> None:
    """번호가 겹치지 않으면 손대지 않는다(보통 시험지 회귀 방지)."""
    problems = [
        ex.Problem(no=3, page=1, bbox=[0, 0, 1, 1], text="", label="3"),
        ex.Problem(no=7, page=1, bbox=[0, 0, 1, 1], text="", label="7"),
    ]
    ex._renumber_duplicates(problems)

    assert [problem.no for problem in problems] == [3, 7]


def test_section_reset_pdf_keeps_every_problem() -> None:
    """구획이 둘인 합성 PDF 에서 문항이 하나도 버려지지 않는다."""
    doc = fitz.open()
    try:
        page = doc.new_page(width=595, height=841)
        # < 기 본 > 1~3
        for index, y in enumerate((60, 200, 340), start=1):
            page.insert_text((40, y), f"{index}. 기본 문제", fontsize=11)
        # < 심 화 > 1~2 (번호가 되돌아간다)
        for index, y in enumerate((480, 620), start=1):
            page.insert_text((40, y), f"{index}. 심화 문제", fontsize=11)
        pdf_bytes = doc.tobytes()
    finally:
        doc.close()

    result = ex.extract_problems(pdf_bytes=pdf_bytes, render_images=False)

    # 5문항 모두 살아 있고 저장용 번호는 유일하다.
    assert [problem.no for problem in result.problems] == [1, 2, 3, 4, 5]
    # 원문 표기는 되돌아간 그대로 남는다.
    assert [problem.label for problem in result.problems] == ["1", "2", "3", "1", "2"]


# ── 세 자리 문제 번호 (100번 이상) ──────────────────────────────────────
# 실측 회귀: `ANCHOR_RE` 가 `\d{1,2}` 였던 탓에 100번부터가 통째로 앵커에서
# 빠졌다. 유형 문제집 12종이 전부 정확히 99번에서 잘렸다(150문항 중 99개만
# 추출, 약 34% 손실). `\d{1,3}` 으로 넓히되, 아래 오탐 방어 테스트로 기존
# 보호 장치(_dominant_delimiter / _pick_anchor_chain / indent_tol)가 여전히
# 작동함을 고정한다.


@pytest.mark.parametrize(
    ("line", "expected_no", "expected_delimiter"),
    [
        ("1. 한 자리", "1", "."),
        ("22. 두 자리", "22", "."),
        ("100. 세 자리 시작", "100", "."),
        ("137) 세 자리 괄호", "137", ")"),
        ("145. 세 자리 마침표", "145", "."),
        ("999. 세 자리 상한", "999", "."),
        ("  100.들여쓴 줄", "100", "."),
        ("100 . 공백 낀 구분자", "100", "."),
    ],
)
def test_anchor_re_matches_up_to_three_digits(
    line: str, expected_no: str, expected_delimiter: str
) -> None:
    """세 자리 문제 번호가 앵커로 잡히고 그룹1/그룹2 가 올바르다."""
    match = ex.ANCHOR_RE.match(line)
    assert match is not None, f"매치되어야 한다: {line!r}"
    assert match.group(1) == expected_no
    assert match.group(2) == expected_delimiter


@pytest.mark.parametrize(
    "line",
    [
        "2025. 연도로 시작하는 지문",  # 네 자리 + 마침표
        "2025) 연도 괄호",
        "1000. 네 자리 상한 초과",
        "12345. 다섯 자리",
    ],
)
def test_anchor_re_rejects_four_or_more_digits(line: str) -> None:
    """네 자리 이상은 앵커가 아니다 (연도 "2025." 오탐 방지).

    `\\d{1,3}` 는 "2025." 에서 "202" 를 잡은 뒤 구분자 자리에 "5" 가 와서
    실패하고, 백트래킹("20"/"2")해도 전부 실패해 최종적으로 매치되지 않는다.
    """
    assert ex.ANCHOR_RE.match(line) is None


def test_anchor_re_three_digit_widening_is_the_only_change() -> None:
    """두 자리 시절 동작은 그대로다 — 넓히기만 했지 좁히지 않았다."""
    narrow = re.compile(r"^\s*(\d{1,2})\s*([.)])")
    for line in ("1.", "9)", "22.", "99)", " 7. 본문", "abc 1.", "", "."):
        narrow_match = narrow.match(line)
        wide_match = ex.ANCHOR_RE.match(line)
        if narrow_match is None:
            continue  # 넓힌 쪽이 더 많이 잡는 것은 의도된 변경이다
        assert wide_match is not None
        assert wide_match.group(1) == narrow_match.group(1)
        assert wide_match.group(2) == narrow_match.group(2)


def _build_crossing_hundred_pdf() -> bytes:
    """98~103 번을 담은 1단 조판 PDF (99→100 경계를 넘는다)."""
    doc = fitz.open()
    try:
        page = doc.new_page(width=595, height=841)
        for offset, no in enumerate(range(98, 104)):
            page.insert_text((40, 60 + offset * 120), f"{no}. 문제 본문", fontsize=11)
        data: bytes = doc.tobytes()
        return data
    finally:
        doc.close()


def test_problems_past_ninety_nine_are_not_dropped() -> None:
    """99번에서 잘리지 않고 100~103 번까지 이어서 잡힌다."""
    result = ex.extract_problems(
        pdf_bytes=_build_crossing_hundred_pdf(), render_images=False
    )
    assert [problem.no for problem in result.problems] == [98, 99, 100, 101, 102, 103]


def test_three_digit_choices_still_do_not_shadow_problem_numbers() -> None:
    """세 자리 허용 후에도 선택지 `1)`~`5)` 가 문제 번호를 밀어내지 않는다.

    `_dominant_delimiter` 가 개수가 아니라 단조증가 사슬로 구분자를 고르는지
    100번대에서도 확인한다. 문제 번호를 98~103 으로 두어 3자리 경로를 태운다.
    """
    doc = fitz.open()
    try:
        for page_index in range(2):
            page = doc.new_page(width=595, height=841)
            for slot in range(3):
                no = 98 + page_index * 3 + slot
                top = 52 + slot * 260
                page.insert_text((40, top), f"{no}. 좌측 문제", fontsize=11)
                # 선택지는 문제보다 5배 많다. 들여쓰기 없이 최악을 가정한다.
                for choice in range(1, 6):
                    page.insert_text(
                        (40, top + 20 + choice * 25), f"{choice}) 선택지", fontsize=11
                    )
        pdf_bytes = doc.tobytes()
    finally:
        doc.close()

    result = ex.extract_problems(pdf_bytes=pdf_bytes, render_images=False)
    assert [problem.no for problem in result.problems] == [98, 99, 100, 101, 102, 103]


def test_year_like_text_does_not_become_an_anchor() -> None:
    """지문 첫머리의 "2025." 같은 연도가 문제로 승격되지 않는다."""
    doc = fitz.open()
    try:
        page = doc.new_page(width=595, height=841)
        page.insert_text((40, 60), "1. 첫 번째 문제", fontsize=11)
        # 칼럼 왼쪽 끝에 붙인 연도 — indent 필터로도 못 걸러지는 최악의 배치.
        page.insert_text((40, 120), "2025. 개정 교육과정에 따르면", fontsize=11)
        page.insert_text((40, 300), "2. 두 번째 문제", fontsize=11)
        page.insert_text((40, 540), "3. 세 번째 문제", fontsize=11)
        pdf_bytes = doc.tobytes()
    finally:
        doc.close()

    result = ex.extract_problems(pdf_bytes=pdf_bytes, render_images=False)
    assert [problem.no for problem in result.problems] == [1, 2, 3]


# ── 실물 PDF 회귀 ──────────────────────────────────────────────────────


@pytest.mark.skipif(not EXAM_PDF.is_file(), reason=f"시험지 PDF 없음: {EXAM_PDF}")
def test_committed_exam_pdf_extraction_is_unchanged() -> None:
    """저장소에 커밋된 22문항 시험지 결과를 고정한다 (제일 중요한 회귀 방어).

    세 자리 확장 **전** 실측값을 그대로 박아둔다: 22문항, 번호 1..22,
    label 도 번호와 같고, PUA 비율이 높아 image 모드다.
    """
    result = ex.extract_problems(EXAM_PDF, render_images=False)

    expected = list(range(1, 23))
    assert [problem.no for problem in result.problems] == expected
    assert [problem.label for problem in result.problems] == [str(no) for no in expected]
    assert result.mode == "image"


@pytest.mark.skipif(
    not TYPE_WORKBOOK_PDF.is_file(),
    reason=f"사용자 자료라 저장소에 없음: {TYPE_WORKBOOK_PDF}",
)
def test_type_workbook_pdf_goes_past_ninety_nine() -> None:
    """유형 문제집 실물에서 99번 천장이 사라졌는지 확인한다.

    수정 전 실측: 99문항, 최대 번호 99. 수정 후 실측: 150문항, 1..150 연속.
    렌더링은 시간이 오래 걸리므로 `render_images=False` 로 분할만 확인한다.
    """
    result = ex.extract_problems(TYPE_WORKBOOK_PDF, render_images=False)
    numbers = [problem.no for problem in result.problems]

    assert len(numbers) > 99, f"99번 천장이 남아 있다: {len(numbers)}문항"
    assert max(numbers) >= 100, f"최대 번호가 100 미만이다: {max(numbers)}"
    # 실측 고정: 빠짐 없이 1..150 이 연속으로 나온다.
    assert numbers == list(range(1, 151))


# ── 정석 계열 문항 번호 (`기본 문제 1-1` / `유제 1-1`) ────────────────────
# 사용자 보고 + 지면 확인: `수학의 정석` PDF 는 업로드 결과가 **0문항**이었다.
# 문항 번호가 `1.` 이 아니라 `기본 문제 1-1` / `유제 1-1` 형태라 ANCHOR_RE 에
# 하나도 걸리지 않는다. 지면에는 `기본 문제` 사이에 공백이 있었다(노션 본문의
# "기본문제" 는 붙여 쓴 것)므로 공백 유무를 모두 받는다.
#
# 같은 페이지 상단의 `12   1. 다항식의 연산`(페이지 번호 + 단원 제목)은 문항이
# 아니다. 오탐으로 승격되면 안 된다.


def _jeongseok_candidate(
    label: str, *, y0: float = 50.0, page: int = 0
) -> tuple[ex.Anchor, str]:
    """라벨 문자열로 `(앵커, 계열)` 후보를 만든다 (파싱 결과를 그대로 쓴다)."""
    parsed = ex._parse_anchor_line(label)
    assert parsed is not None, f"정석 앵커로 파싱되어야 한다: {label!r}"
    no, series, text = parsed
    anchor = ex.Anchor(no=no, page=page, column="left", x0=40.0, y0=y0, label=text)
    return anchor, series


@pytest.mark.parametrize(
    ("line", "expected_series", "expected_no", "expected_label"),
    [
        # 지면 실제 표기(공백 있음).
        ("기본 문제 1-1 다음 식을 전개하여라", "기본문제", 1001, "기본 문제 1-1"),
        # 노션 보고 표기(붙여 씀).
        ("기본문제 1-2", "기본문제", 1002, "기본문제 1-2"),
        # 한글 조판 자간 벌림.
        ("기 본 문 제 2-10", "기본문제", 2010, "기 본 문 제 2-10"),
        ("유제 1-1", "유제", 1001, "유제 1-1"),
        ("유제1-1", "유제", 1001, "유제1-1"),
        ("  유제 1 - 3 딸린 문제", "유제", 1003, "유제 1 - 3"),
        ("유제 1\u20131", "유제", 1001, "유제 1\u20131"),  # en dash
        ("유제 12-30", "유제", 12030, "유제 12-30"),
    ],
)
def test_jeongseok_anchor_is_parsed(
    line: str, expected_series: str, expected_no: int, expected_label: str
) -> None:
    """정석 계열 표기가 (정렬용 번호, 계열, 원문 라벨) 로 파싱된다."""
    parsed = ex._parse_anchor_line(line)
    assert parsed == (expected_no, expected_series, expected_label)


@pytest.mark.parametrize(
    "line",
    [
        "12   1. 다항식의 연산",  # 페이지 번호 + 단원 제목
        "유제 1",  # `N-M` 이 아니다
        "유제 1-1234",  # 4자리 이상은 배제
        "연습문제 1-1",  # 지원하지 않는 계열
        "기본 1-1",  # "문제" 가 없다
        "본문 중간의 유제 1-1 언급",  # 줄 맨 앞이 아니다
    ],
)
def test_non_jeongseok_lines_are_not_jeongseok_anchors(line: str) -> None:
    """정석 앵커로 잘못 승격되면 안 되는 줄들."""
    assert ex.JEONGSEOK_ANCHOR_RE.match(line) is None


def test_page_header_line_matches_neither_pattern() -> None:
    """`12   1. 다항식의 연산` 은 두 패턴 모두에 걸리지 않는다.

    `12` 는 페이지 번호, `1.` 은 단원 번호다. ANCHOR_RE 는 "12" 뒤에 구분자가
    없어서(백트래킹해도 "1" 뒤가 "2") 실패한다. 이 성질을 고정해 둔다.
    """
    line = "12   1. 다항식의 연산"
    assert ex.ANCHOR_RE.match(line) is None
    assert ex._parse_anchor_line(line) is None


def test_jeongseok_number_key_is_monotonic() -> None:
    """`1-1, 1-2, 1-12, 2-1` 이 단조증가 키로 접혀 사슬 필터를 통과한다.

    `N-M` 은 정수가 아니라 `_longest_increasing` 이 그대로 다룰 수 없다.
    `N*1000+M` 로 평탄화한 키가 실제로 오름차순인지, 그리고 하나도 버려지지
    않는지 확인한다.
    """
    keys = [
        ex._parse_anchor_line(f"유제 {chapter}-{item}")[0]  # type: ignore[index]
        for chapter, item in ((1, 1), (1, 2), (1, 12), (2, 1))
    ]
    assert keys == [1001, 1002, 1012, 2001]
    assert keys == sorted(keys)
    assert ex._longest_increasing(keys) == [0, 1, 2, 3]


def test_jeongseok_chain_keeps_interleaved_series() -> None:
    """`기본 문제`/`유제` 가 교대로 나와도 하나도 버리지 않는다.

    정석 지면은 `기본 문제 1-1` 다음에 딸린 `유제 1-1`, `유제 1-2` 가 오고 다시
    `기본 문제 1-2` 로 돌아간다. 읽는 순서의 번호는 1001, 1001, 1002, 1002, …
    처럼 두 계열이 교대하므로 한 사슬로 단조증가를 요구하면 절반이 날아간다.
    """
    labels = ["기본 문제 1-1", "유제 1-1", "유제 1-2", "기본 문제 1-2", "유제 1-3"]
    candidates = [
        _jeongseok_candidate(label, y0=60.0 + index * 100)
        for index, label in enumerate(labels)
    ]

    kept = ex._jeongseok_anchor_chain(candidates)
    assert [anchor.label for anchor in kept] == labels

    # 계열을 섞어 한 사슬로 보면 실제로 손실이 난다 — 계열 분리가 필요한 이유.
    single = ex._pick_anchor_chain([anchor.no for anchor, _ in candidates])
    assert len(single) < len(labels)


def test_jeongseok_chain_still_drops_noise_within_series() -> None:
    """계열 안에서는 번호가 튀는 오탐을 계속 버린다."""
    labels = ["유제 1-1", "유제 9-9", "유제 1-2", "유제 1-3"]
    candidates = [
        _jeongseok_candidate(label, y0=60.0 + index * 100)
        for index, label in enumerate(labels)
    ]

    kept = ex._jeongseok_anchor_chain(candidates)
    assert [anchor.label for anchor in kept] == ["유제 1-1", "유제 1-2", "유제 1-3"]


def _build_jeongseok_pdf(*, header: str = "12   1. 다항식의 연산") -> bytes:
    """정석 지면을 흉내낸 1단 조판 PDF.

    상단에 `페이지번호 + 단원 제목` 머리글을, 아래에 `기본 문제`/`유제` 가
    교대로 나오는 문항을 둔다. 한글 글리프는 PyMuPDF 내장 CJK 폰트("korea")로
    찍어 어느 PC 에서나 같은 결과가 나오게 한다.
    """
    layout = [
        ["기본 문제 1-1", "유제 1-1", "유제 1-2", "기본 문제 1-2"],
        ["유제 1-3", "유제 1-4", "기본 문제 1-3", "유제 1-5"],
    ]
    doc = fitz.open()
    try:
        for page_index, labels in enumerate(layout):
            page = doc.new_page(width=595, height=841)
            page.insert_text(
                (40, 40), header.replace("12", str(12 + page_index)), fontsize=9,
                fontname="korea",
            )
            for slot, label in enumerate(labels):
                page.insert_text(
                    (40, 100 + slot * 160),
                    f"{label} 다음 식을 간단히 하여라",
                    fontsize=11,
                    fontname="korea",
                )
        data: bytes = doc.tobytes()
        return data
    finally:
        doc.close()


def test_jeongseok_pdf_is_extracted_with_original_labels() -> None:
    """정석 PDF 가 0문항이 아니라 8문항으로 잡히고 원문 표기가 label 에 남는다."""
    result = ex.extract_problems(pdf_bytes=_build_jeongseok_pdf(), render_images=False)

    assert [problem.label for problem in result.problems] == [
        "기본 문제 1-1",
        "유제 1-1",
        "유제 1-2",
        "기본 문제 1-2",
        "유제 1-3",
        "유제 1-4",
        "기본 문제 1-3",
        "유제 1-5",
    ]
    # 저장용 번호는 정렬용 합성 키(1001…)가 아니라 통짜 순번이어야 한다.
    assert [problem.no for problem in result.problems] == [1, 2, 3, 4, 5, 6, 7, 8]
    assert [problem.page for problem in result.problems] == [1, 1, 1, 1, 2, 2, 2, 2]


def test_page_number_and_unit_title_are_not_extracted_as_problems() -> None:
    """머리글이 `1. 다항식의 연산` 처럼 단독 줄이어도 문항으로 잡히지 않는다.

    이 줄은 ANCHOR_RE 에 걸리는 진짜 후보다(칼럼 왼쪽 끝, 본문 밴드 안).
    정석 사슬이 더 길어서 보통 경로가 밀려나는지 확인한다.
    """
    result = ex.extract_problems(
        pdf_bytes=_build_jeongseok_pdf(header="1. 다항식의 연산"),
        render_images=False,
    )

    labels = [problem.label for problem in result.problems]
    assert len(labels) == 8
    assert all("다항식" not in label for label in labels)


def test_single_jeongseok_line_does_not_hijack_plain_exam() -> None:
    """보통 시험지에 `유제 1-1` 한 줄이 섞여 있어도 기존 경로를 유지한다.

    두 경로 중 **더 많이 살리는 쪽**을 고르므로, 정석 후보가 소수면 밀려난다.
    """
    doc = fitz.open()
    try:
        page = doc.new_page(width=595, height=841)
        for index, y in enumerate((60, 200, 340, 480), start=1):
            page.insert_text((40, y), f"{index}. 문제 본문", fontsize=11)
        page.insert_text((40, 620), "유제 1-1 참고", fontsize=11, fontname="korea")
        pdf_bytes = doc.tobytes()
    finally:
        doc.close()

    result = ex.extract_problems(pdf_bytes=pdf_bytes, render_images=False)
    assert [problem.no for problem in result.problems] == [1, 2, 3, 4]
    assert [problem.label for problem in result.problems] == ["1", "2", "3", "4"]


def test_renumber_force_reassigns_even_without_duplicates() -> None:
    """`force=True` 면 번호가 겹치지 않아도 1..N 으로 다시 매긴다.

    정석 계열의 `no` 는 정렬용 합성 키(`N*1000+M`)라 겹치지 않아도 그대로
    저장할 수 없다("1001번 문항" 이 된다).
    """
    problems = [
        ex.Problem(no=1001, page=1, bbox=[0, 0, 1, 1], text="", label="기본 문제 1-1"),
        ex.Problem(no=1002, page=1, bbox=[0, 0, 1, 1], text="", label="유제 1-2"),
    ]
    ex._renumber_duplicates(problems, force=True)

    assert [problem.no for problem in problems] == [1, 2]
    assert [problem.label for problem in problems] == ["기본 문제 1-1", "유제 1-2"]

    # force 를 안 주면 손대지 않는다(기존 동작).
    untouched = [ex.Problem(no=7, page=1, bbox=[0, 0, 1, 1], text="", label="7")]
    ex._renumber_duplicates(untouched)
    assert untouched[0].no == 7


# ── 들여쓰기 판정: 절대 기준 OR 본문 정렬선 ─────────────────────────────
# 실측 회귀: 28쪽짜리 시험지(a.pdf)가 0문항이었다. 문항 번호 68개가 정규식·칼럼
# 검사까지 전부 통과했는데, `content_rect.x0` 이 23.8 로 잡힌 반면 실제 글자는
# x0=85.0 부터 시작해 들여쓰기가 61.2pt(> 30pt)로 계산돼 마지막 관문에서 전멸했다.
# `content_rect` 는 크롭 영역 계산에도 쓰여 고칠 수 없으므로, "그 칼럼에서 본문이
# 실제로 정렬되는 x" 를 두 번째 기준으로 두고 OR 로 판정한다.


def test_indent_ok_absolute_pass_never_depends_on_baseline() -> None:
    """절대 기준을 통과하던 앵커는 정렬선이 어떻게 잡히든 그대로 통과한다.

    OR 판정의 핵심 성질이다. 이것이 지켜지면 "기존에 잡히던 문항이 빠지는"
    회귀가 구조적으로 불가능하다.
    """
    for baseline in (None, 40.0, 300.0, -100.0):
        assert ex._is_anchor_indent_ok(45.0, 40.0, baseline, ex.DEFAULT_ANCHOR_INDENT_TOL)


def test_indent_ok_accepts_when_only_baseline_passes() -> None:
    """a.pdf 상황: 절대 기준은 탈락이지만 본문 정렬선 기준으로는 통과한다."""
    # content_rect.x0=23.8, 정렬선 85.0, 앵커 85.0 → 절대 61.2pt / 상대 0.0pt.
    absolute_indent = 85.0 - 23.8
    assert absolute_indent > ex.DEFAULT_ANCHOR_INDENT_TOL
    assert ex._is_anchor_indent_ok(85.0, 23.8, 85.0, ex.DEFAULT_ANCHOR_INDENT_TOL)


def test_indent_ok_falls_back_to_absolute_without_baseline() -> None:
    """정렬선을 못 구한 칼럼(표본 부족)은 기존 절대 기준만 쓴다."""
    assert not ex._is_anchor_indent_ok(85.0, 23.8, None, ex.DEFAULT_ANCHOR_INDENT_TOL)


def test_indent_ok_still_rejects_deeply_indented_line() -> None:
    """정렬선 기준이 생겨도 정렬선에서 멀리 들어간 줄은 여전히 앵커가 아니다.

    본문 한가운데의 `1)` 오탐이 이 기준으로 통과해 버리지 않도록 고정한다.
    """
    assert not ex._is_anchor_indent_ok(
        85.0 + ex.DEFAULT_ANCHOR_INDENT_TOL + 0.1,
        23.8,
        85.0,
        ex.DEFAULT_ANCHOR_INDENT_TOL,
    )


def test_leftmost_supported_x0_requires_minimum_samples() -> None:
    """표본이 최소 개수에 못 미치는 정렬선은 근거가 없어 버린다."""
    short = [100.0] * (ex._BODY_X0_MIN_SAMPLES - 1)
    assert ex._leftmost_supported_x0(short) is None
    assert ex._leftmost_supported_x0([]) is None

    enough = [100.0] * ex._BODY_X0_MIN_SAMPLES
    assert ex._leftmost_supported_x0(enough) == 100.0


def test_leftmost_supported_x0_ignores_contaminating_minimum() -> None:
    """칼럼 경계를 넘어온 요소 하나가 최솟값을 오염시켜도 흔들리지 않는다.

    실측(a.pdf p0 우측 칼럼): 최솟값 298.9 가 칼럼 경계 300.5 보다 작았다.
    `min` 만 쓰면 기준이 기존과 같아져 효과가 사라진다.
    """
    values = [30.0, 31.5, *[85.0, 85.2, 85.4, 85.1, 85.3, 85.0, 84.9]]
    assert ex._leftmost_supported_x0(values) == 84.9


def test_leftmost_supported_x0_prefers_left_over_mode() -> None:
    """표본이 충분하면 최빈값이 아니라 **더 왼쪽** 정렬선을 쓴다(더 엄격한 쪽)."""
    values = [200.0] * 20 + [120.0] * ex._BODY_X0_MIN_SAMPLES
    assert ex._leftmost_supported_x0(values) == 120.0


def test_column_body_x0_measures_per_column_and_skips_headers() -> None:
    """정렬선은 칼럼별로, 머리말·꼬리말과 칼럼 밖 줄을 뺀 본문만으로 잰다."""
    doc = fitz.open()
    try:
        page = doc.new_page(width=595, height=841)
        content = fitz.Rect(23.8, 30.0, 571.0, 800.0)
        lines = [
            # 머리말: 칼럼 왼쪽 끝에 붙어 있지만 본문 영역 위라 무시된다.
            ex.TextLine(text="머리말", bbox=(24.0, 10.0, 400.0, 22.0)),
            # 꼬리말: 본문 영역 아래.
            ex.TextLine(text="- 1 -", bbox=(24.0, 810.0, 400.0, 822.0)),
        ]
        # 좌측 칼럼 본문 6줄(정렬선 85.0).
        lines += [
            ex.TextLine(text=f"{i}. 본문", bbox=(85.0, 100.0 + i * 20, 250.0, 112.0))
            for i in range(6)
        ]
        # 우측 칼럼은 3줄뿐 → 표본 부족.
        lines += [
            ex.TextLine(text="본문", bbox=(353.1, 100.0 + i * 20, 500.0, 112.0))
            for i in range(3)
        ]
        assert ex._column_body_x0(lines, content, page) == {
            "left": 85.0,
            "right": None,
        }
    finally:
        doc.close()


def _build_wide_content_rect_pdf() -> bytes:
    """a.pdf 형태 재현: 괘선이 글자보다 훨씬 왼쪽까지 뻗은 2단 시험지.

    괘선 폭 때문에 `content_rect.x0` 이 22pt 로 잡히지만, 본문 글자는 85pt
    부터 시작한다(차이 63pt > `DEFAULT_ANCHOR_INDENT_TOL`).
    """
    doc = fitz.open()
    try:
        page = doc.new_page(width=595, height=841)
        for y in (30.0, 31.0, 810.0, 811.0):
            page.draw_line(fitz.Point(20, y), fitz.Point(575, y), width=0.5)
        for index, no in enumerate(range(1, 7)):
            top = 60.0 + index * 120.0
            page.insert_text((85, top), f"{no}. 문제 본문", fontsize=11)
            page.insert_text((85, top + 20), "이어지는 본문 줄", fontsize=11)
        data: bytes = doc.tobytes()
        return data
    finally:
        doc.close()


def test_anchors_survive_when_content_rect_is_far_left_of_text() -> None:
    """본문 경계가 글자보다 훨씬 왼쪽으로 잡혀도 문항을 잃지 않는다(a.pdf 회귀)."""
    pdf_bytes = _build_wide_content_rect_pdf()
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        page = doc[0]
        content = ex.content_rect(page)
        col_x0, _ = ex.column_bounds(content, "left")
        # 재현 조건 확인: 절대 기준만으로는 전부 탈락하는 배치다.
        assert 85.0 - col_x0 > ex.DEFAULT_ANCHOR_INDENT_TOL
        assert [anchor.no for anchor in ex.find_anchors(doc)] == [1, 2, 3, 4, 5, 6]
    finally:
        doc.close()

    result = ex.extract_problems(pdf_bytes=pdf_bytes, render_images=False)
    assert [problem.no for problem in result.problems] == [1, 2, 3, 4, 5, 6]


# --- 페이지 표본 부족 → 문서 전역 정렬선 폴백 --------------------------------
# 실측(`69-134 고1 2학기 오리진1 한글.pdf`): 66문항 중 5개(81·82·84·87·90번)가
# 누락됐다. content_rect.x0=23.8 대 본문 x0=85.0 으로 절대 기준이 61.2pt 벌어져
# 탈락하고, 그 페이지들은 문항이 1개뿐이라 정렬선 표본이 4개(정상 페이지는 5~6)로
# `_BODY_X0_MIN_SAMPLES`(5)를 하나 못 채워 페이지 정렬선도 없었다.
# `_BODY_X0_MIN_SAMPLES` 를 낮추는 대신 문서 전역 표본으로 폴백한다.


def _build_sparse_sample_page_pdf() -> bytes:
    """정렬선 표본이 부족한 페이지가 섞인 PDF.

    괘선이 글자보다 훨씬 왼쪽까지 뻗어 `content_rect.x0` 가 22pt 로 잡히지만 본문
    글자는 85pt 에서 시작한다(차이 63pt > `DEFAULT_ANCHOR_INDENT_TOL`).
    p0 은 본문 줄이 6줄이라 페이지 정렬선이 잡히고, p1 은 문항이 1개뿐이라 2줄만
    있어 페이지 정렬선이 `None` 이다(위 실측의 표본 4 상황).
    """
    doc = fitz.open()
    try:
        for page_index in range(2):
            page = doc.new_page(width=595, height=841)
            for y in (30.0, 31.0, 810.0, 811.0):
                page.draw_line(fitz.Point(20, y), fitz.Point(575, y), width=0.5)
            numbers = (1, 2, 3) if page_index == 0 else (4,)
            for index, no in enumerate(numbers):
                top = 60.0 + index * 200.0
                page.insert_text((85, top), f"{no}. munje", fontsize=11)
                page.insert_text((85, top + 20), "next line", fontsize=11)
        data: bytes = doc.tobytes()
        return data
    finally:
        doc.close()


def test_page_with_too_few_samples_has_no_page_baseline() -> None:
    """재현 조건 고정: 문항 1개 페이지는 표본이 모자라 페이지 정렬선이 없다."""
    doc = fitz.open(stream=_build_sparse_sample_page_pdf(), filetype="pdf")
    try:
        sparse = doc[1]
        content = ex.content_rect(sparse)
        lines = ex._page_lines(sparse)
        col_x0, _ = ex.column_bounds(content, "left")
        # 절대 기준만으로는 탈락하는 배치다(실측 61.2pt 를 재현한 63pt).
        assert 85.0 - col_x0 > ex.DEFAULT_ANCHOR_INDENT_TOL
        buckets = ex._body_x0_buckets(lines, content, sparse)
        assert len(buckets["left"]) < ex._BODY_X0_MIN_SAMPLES
        assert ex._column_body_x0(lines, content, sparse)["left"] is None
    finally:
        doc.close()


def test_document_baseline_rescues_sparse_page_anchor() -> None:
    """페이지 정렬선이 없는 페이지의 앵커를 문서 전역 정렬선이 살린다.

    이 폴백이 없으면 4번이 통째로 빠진다(수정 전 코드로 실측: [1, 2, 3]).
    """
    pdf_bytes = _build_sparse_sample_page_pdf()
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        _, doc_baseline = ex._scan_anchor_candidates(doc)
        assert doc_baseline["left"] == 85.0
        assert [anchor.no for anchor in ex.find_anchors(doc)] == [1, 2, 3, 4]
    finally:
        doc.close()

    result = ex.extract_problems(pdf_bytes=pdf_bytes, render_images=False)
    assert [problem.no for problem in result.problems] == [1, 2, 3, 4]


def _build_stray_element_pdf(pages: int) -> bytes:
    """칼럼 안이지만 본문 정렬선보다 왼쪽으로 튀어나온 요소가 섞인 PDF.

    페이지마다 좌/우 칼럼에 그런 요소를 **1개씩** 둔다(실측 a.pdf 의 오염 표본은
    칼럼당 최대 3개였다). 본문은 좌 85pt / 우 353pt 에서 시작한다.
    """
    doc = fitz.open()
    try:
        for page_index in range(pages):
            page = doc.new_page(width=595, height=841)
            for y in (30.0, 31.0, 810.0, 811.0):
                page.draw_line(fitz.Point(20, y), fitz.Point(575, y), width=0.5)
            page.insert_text((30, 300), "stray", fontsize=9)
            page.insert_text((300, 300), "stray", fontsize=9)
            for index in range(2):
                page.insert_text((85, 60 + index * 40), "left body", fontsize=11)
                page.insert_text((353, 60 + index * 40), "right body", fontsize=11)
            page.insert_text((85, 500), f"{page_index + 1}. munje", fontsize=11)
        data: bytes = doc.tobytes()
        return data
    finally:
        doc.close()


def test_document_baseline_is_not_dragged_left_by_stray_elements() -> None:
    """오염 요소가 여러 페이지에 흩어져 있어도 전역 정렬선이 왼쪽으로 끌리지 않는다.

    전역 표본은 페이지 표본보다 훨씬 많아 `_BODY_X0_MIN_SAMPLES` 를 쉽게 넘기지만,
    "표본이 충분한 정렬선 중 가장 왼쪽" 규칙은 그대로다. 페이지마다 1개씩 흩어진
    오염(총 4개 < 5)은 정렬선으로 인정되지 않는다.

    한계도 함께 적어 둔다(실측 스윕): 같은 x 의 오염이 문서 전체에서 5개 이상
    모이면 전역 정렬선은 그쪽으로 간다. 그래도 판정은 `_is_anchor_indent_ok` 의
    OR 이라 **기준이 느슨해지기만** 하고 기존 앵커가 빠지지는 않는다
    (실물 24종 전수 스윕에서 앵커 수 변화 없음).
    """
    doc = fitz.open(stream=_build_stray_element_pdf(4), filetype="pdf")
    try:
        # 재현 조건: 페이지 정렬선은 좌/우 모두 표본 부족이라 없다.
        for page_no in range(doc.page_count):
            page = doc[page_no]
            content = ex.content_rect(page)
            lines = ex._page_lines(page)
            assert ex._column_body_x0(lines, content, page) == {
                "left": None,
                "right": None,
            }
        _, doc_baseline = ex._scan_anchor_candidates(doc)
        assert doc_baseline == {"left": 85.0, "right": 353.0}
        assert [anchor.no for anchor in ex.find_anchors(doc)] == [1, 2, 3, 4]
    finally:
        doc.close()


# --- 머리말/꼬리말 판정은 줄 중심으로 ----------------------------------------
# 실측(`오리진1.pdf` p61, 1~434번 중 61번만 누락): 문항 첫 줄에 큰 수식이 있어
# 줄 bbox 가 위로 17.9pt 늘어 y0=51.9 < content.y0=62.2 로 머리말 취급됐다.
# 앞뒤 페이지(p60·p62)는 줄 높이 11.7pt 로 y0=71.x 라 통과했다.


def test_is_inside_content_keeps_tall_line_measured_on_origin_pdf() -> None:
    """실측값 그대로: 상단 기준으로는 탈락, 중심 기준으로는 통과한다."""
    content = fitz.Rect(52.0, 62.2, 542.7, 788.4)
    # 61번 문항 첫 줄(수식 때문에 키가 29.6pt).
    assert content.y0 > 51.9  # 옛 기준(줄 상단)으로는 머리말로 오판된다
    assert ex._is_inside_content(51.9, 81.5, content)
    # 앞뒤 페이지의 보통 줄은 어느 기준으로도 통과한다.
    assert ex._is_inside_content(71.5, 83.2, content)
    assert ex._is_inside_content(71.0, 82.7, content)


def test_is_inside_content_still_rejects_real_header_and_footer() -> None:
    """줄 전체가 본문 밖이면(중심도 밖) 여전히 머리말·꼬리말이다.

    이 변경의 안전선이다. 중심 판정으로 바꾸면서 머리말이 앵커로 새면 페이지마다
    오탐이 하나씩 생긴다.
    """
    content = fitz.Rect(52.0, 62.2, 542.7, 788.4)
    assert not ex._is_inside_content(30.0, 42.0, content)  # 머리말
    assert not ex._is_inside_content(800.0, 812.0, content)  # 꼬리말
    # 경계에 걸친 줄도 중심이 밖이면 배제한다(절반 이상이 본문 밖).
    assert not ex._is_inside_content(20.0, 62.0, content)
    assert not ex._is_inside_content(789.0, 830.0, content)


def _build_tall_line_pdf() -> bytes:
    """키 큰 줄(수식)과 진짜 머리말·꼬리말이 함께 있는 PDF.

    번호를 위에서 아래로 1~5 로 매겨 두면 머리말·꼬리말이 앵커로 새는지가 결과
    번호 목록에 그대로 드러난다(1~5 가 이미 순증가라 사슬 필터가 가려 주지 않는다).
    """
    doc = fitz.open()
    try:
        page = doc.new_page(width=595, height=841)
        for y in (30.0, 31.0, 810.0, 811.0):
            page.draw_line(fitz.Point(40, y), fitz.Point(555, y), width=0.5)
        page.insert_text((50, 20), "1. header", fontsize=9)
        # 같은 베이스라인의 큰 글리프가 줄 bbox 를 위로 늘린다(수식 대역).
        page.insert_text((50, 60), "2. ", fontsize=11)
        page.insert_text((70, 60), "K", fontsize=34)
        page.insert_text((50, 400), "3. normal", fontsize=11)
        page.insert_text((50, 800), "4. ", fontsize=11)
        page.insert_text((70, 800), "K", fontsize=34)
        page.insert_text((50, 832), "5. footer", fontsize=9)
        data: bytes = doc.tobytes()
        return data
    finally:
        doc.close()


def test_tall_lines_survive_and_real_header_footer_still_dropped() -> None:
    """키 큰 줄의 앵커는 살고, 진짜 머리말·꼬리말은 그대로 걸러진다.

    수정 전 코드로는 [3] 하나만 잡혔다(2·4번이 줄 높이 때문에 탈락).
    """
    pdf_bytes = _build_tall_line_pdf()
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        page = doc[0]
        content = ex.content_rect(page)
        spans = {
            line.text.split(".")[0]: (line.bbox[1], line.bbox[3])
            for line in ex._page_lines(page)
        }
        # 재현 조건: 2·4번 줄은 상단/하단 기준으로는 본문 밖이다.
        assert spans["2"][0] < content.y0
        assert spans["4"][1] > content.y1
        assert [anchor.no for anchor in ex.find_anchors(doc)] == [2, 3, 4]
    finally:
        doc.close()

    result = ex.extract_problems(pdf_bytes=pdf_bytes, render_images=False)
    assert [problem.label for problem in result.problems] == ["2", "3", "4"]


# --- 스캔본 감지 -------------------------------------------------------------


def test_looks_scanned_uses_per_page_threshold() -> None:
    """임계는 페이지당 50자다(docs/scanned-pdf-extraction.md 3-1)."""
    limit = ex.SCANNED_MAX_CHARS_PER_PAGE
    assert ex.looks_scanned(0, 54)  # 풍문고 부교재.pdf: 54쪽 0자
    assert ex.looks_scanned(0, 20)  # 2027 강대X 시즌2 6회 문제.pdf: 20쪽 0자
    assert ex.looks_scanned(limit * 10 - 1, 10)
    assert not ex.looks_scanned(limit * 10, 10)
    assert not ex.looks_scanned(100_000, 7)  # 보통 시험지


def test_looks_scanned_does_not_judge_empty_document() -> None:
    """페이지가 0장이면 스캔본이라고 단정하지 않는다(다른 실패다)."""
    assert not ex.looks_scanned(0, 0)


def test_extract_result_reports_text_chars() -> None:
    """`text_chars` 는 스캔본 판정의 유일한 근거다 — 결과에 실어 보낸다."""
    doc = fitz.open()
    try:
        page = doc.new_page(width=595, height=841)
        page.insert_text((50, 60), "1. munje", fontsize=11)
        for index in range(12):
            page.insert_text(
                (50, 90 + index * 20), "body line with plenty of text", fontsize=11
            )
        text_layer: bytes = doc.tobytes()
    finally:
        doc.close()
    text_pdf = ex.extract_problems(pdf_bytes=text_layer, render_images=False)
    assert text_pdf.text_chars > ex.SCANNED_MAX_CHARS_PER_PAGE
    assert not ex.looks_scanned(text_pdf.text_chars, text_pdf.page_count)

    doc = fitz.open()
    try:
        doc.new_page(width=595, height=841)
        doc.new_page(width=595, height=841)
        blank: bytes = doc.tobytes()
    finally:
        doc.close()
    scanned = ex.extract_problems(pdf_bytes=blank, render_images=False)
    assert scanned.text_chars == 0
    assert scanned.pua_ratio == 0.0  # 분모가 0이라 PUA 비율로는 알 수 없다
    assert scanned.mode == "text"  # `mode` 는 '판정 성공' 을 뜻하지 않는다
    assert ex.looks_scanned(scanned.text_chars, scanned.page_count)
    assert scanned.to_dict()["text_chars"] == 0
