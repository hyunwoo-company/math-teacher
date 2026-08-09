"""extractor 회귀 테스트 (AI 호출 없음, 합성 PDF 로만 검증).

실제 시험지 PDF 는 gitignore(tmp/) 라 커밋할 수 없으므로 fitz 로 최소 조판을
합성한다. 여기서 재현하는 버그: 괘선이 없어 content_rect 가 비율 마진으로
폴백하는 페이지에서, 각 칼럼 맨 위에서 시작하는 정상 문제 앵커가 상단 머리말
마진에 걸려 통째로 누락되던 문제.
"""

from __future__ import annotations

import fitz
import pytest

import extractor as ex


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
