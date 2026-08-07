"""extractor 회귀 테스트 (AI 호출 없음, 합성 PDF 로만 검증).

실제 시험지 PDF 는 gitignore(tmp/) 라 커밋할 수 없으므로 fitz 로 최소 조판을
합성한다. 여기서 재현하는 버그: 괘선이 없어 content_rect 가 비율 마진으로
폴백하는 페이지에서, 각 칼럼 맨 위에서 시작하는 정상 문제 앵커가 상단 머리말
마진에 걸려 통째로 누락되던 문제.
"""

from __future__ import annotations

import fitz

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
