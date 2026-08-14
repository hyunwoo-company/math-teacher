"""PUA 매핑표 + 디코더 테스트.

두 층으로 나눠 검증한다.

1. **가짜 페이지**: `rawdict` 를 손으로 조립해 구조 판정(지수·첨자·분수·근호·벡터·
   윗줄)과 신뢰도 판정을 좌표 단위로 못박는다. 실측에서 얻은 기하 관계를 그대로
   재현하므로 임계값이 흔들리면 여기서 깨진다.
2. **실제 시험지 PDF**: 저장소 루트의 풍문고 시험지(`conftest.TEST_PDF`, 기존
   업로드 테스트가 이미 쓰는 파일)로 문항을 분할해 디코딩하고, **크롭 이미지를
   눈으로 읽어 확인한 기대 LaTeX** 를 못박는다.
"""

from __future__ import annotations

from typing import Any

import fitz
import pytest
from conftest import TEST_PDF

import extractor
import pua_decode
import pua_table

EQ_FONT = "INPILL+HyhwpEQ"
TEXT_FONT = "BatangChe"


# ── 가짜 rawdict 조립 도구 ───────────────────────────────────────────


def _glyph(
    text: str, x0: float, baseline: float, size: float, width: float
) -> dict[str, Any]:
    """rawdict 의 글자 한 항목을 만든다 (ascender 0.8 / descender 0.2 가정)."""
    return {
        "c": text,
        "bbox": (x0, baseline - size * 0.8, x0 + width, baseline + size * 0.2),
        "origin": (x0, baseline),
    }


def _pua(offset: int) -> str:
    """오프셋에 해당하는 PUA 문자."""
    return chr(pua_table.PUA_START + offset)


def _span(font: str, size: float, glyphs: list[dict[str, Any]]) -> dict[str, Any]:
    return {"font": font, "size": size, "chars": glyphs}


class _FakePage:
    """`decode_region` 이 쓰는 두 메서드만 흉내내는 페이지."""

    def __init__(
        self,
        spans: list[dict[str, Any]],
        *,
        drawings: list[fitz.Rect] | None = None,
        images: list[tuple[float, float, float, float]] | None = None,
    ) -> None:
        blocks: list[dict[str, Any]] = [
            {"type": 0, "lines": [{"spans": spans}]},
        ]
        for box in images or []:
            blocks.append({"type": 1, "bbox": box})
        self._blocks = blocks
        self._drawings = drawings or []

    def get_text(self, kind: str) -> dict[str, Any]:
        assert kind == "rawdict"
        return {"blocks": self._blocks}

    def get_drawings(self) -> list[dict[str, Any]]:
        return [{"rect": rect} for rect in self._drawings]


WIDE = (0.0, 0.0, 1000.0, 1000.0)


def _decode(spans: list[dict[str, Any]], **kwargs: Any) -> pua_decode.DecodeResult:
    return pua_decode.decode_region(_FakePage(spans, **kwargs), WIDE)


# ── 매핑표 ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("offset", "latex"),
    [
        (0, "A"),
        (2, "C"),
        (23, "X"),
        (25, "Z"),
        (52, "1"),  # 0 부터가 아니라 1 부터 시작한다
        (53, "2"),
        (61, "0"),  # 0 이 맨 끝
        (68, "("),
        (69, ")"),
        (70, "-"),
        (71, "="),
        (72, "+"),
        (75, r"\{"),
        (76, r"\}"),
        (79, ":"),
        (82, ","),
        (83, "."),
        (84, "/"),
        (85, "<"),
        (86, ">"),
        (157, r"\alpha"),
        (158, r"\beta"),
        (200, "°"),
        (229, "a"),
        (252, "x"),
        (253, "y"),
        (254, "z"),
        (257, "|"),
    ],
)
def test_confirmed_entries(offset: int, latex: str) -> None:
    """크롭 이미지 대조로 확정한 오프셋은 값과 `certain` 이 함께 고정된다."""
    entry = pua_table.lookup(offset)
    assert entry is not None
    assert entry.latex == latex
    assert entry.certain is True


@pytest.mark.parametrize("offset", [26, 51, 159, 180])
def test_guessed_entries_are_marked_uncertain(offset: int) -> None:
    """대조 표본이 없어 배열 규칙으로만 채운 구간은 `certain=False` 여야 한다."""
    entry = pua_table.lookup(offset)
    assert entry is not None
    assert entry.certain is False


def test_structural_offsets_are_not_characters() -> None:
    """가로선·화살촉·근호는 문자가 아니라 구조 부품이라 문자 표에 없다."""
    for offset in pua_table.STRUCTURAL:
        assert pua_table.lookup(offset) is None


def test_offset_of() -> None:
    """PUA 밖 문자는 오프셋이 없다."""
    assert pua_table.offset_of(_pua(252)) == 252
    assert pua_table.offset_of("x") is None
    assert pua_table.offset_of("가") is None
    assert pua_table.offset_of("") is None


# ── 문자 치환 + 지수/아래첨자 (1단계) ────────────────────────────────


def test_plain_substitution_and_korean_passthrough() -> None:
    """수식은 `\\( \\)` 로 감싸고 한글 본문은 그대로 흐른다."""
    result = _decode(
        [
            _span(TEXT_FONT, 10.0, [_glyph("값", 0.0, 100.0, 10.0, 10.0)]),
            _span(
                EQ_FONT,
                10.0,
                [
                    _glyph(_pua(0), 12.0, 100.0, 10.0, 6.0),
                    _glyph(_pua(71), 19.0, 100.0, 10.0, 6.0),
                    _glyph(_pua(53), 26.0, 100.0, 10.0, 6.0),
                ],
            ),
        ]
    )
    assert result.ok is True
    assert result.latex == r"값\(A=2\)"


def test_superscript_from_size_and_baseline() -> None:
    """크기 0.6배 + baseline 상승은 지수다 (실측: 6.0/8.9, 상승 0.45배)."""
    result = _decode(
        [
            _span(EQ_FONT, 10.0, [_glyph(_pua(252), 10.0, 100.0, 10.0, 6.0)]),
            _span(EQ_FONT, 6.0, [_glyph(_pua(53), 17.0, 95.5, 6.0, 3.0)]),
        ]
    )
    assert result.ok is True
    assert result.latex == r"\(x^{2}\)"


def test_subscript_from_size_and_baseline() -> None:
    """크기가 작고 baseline 이 내려가면 아래첨자다."""
    result = _decode(
        [
            _span(EQ_FONT, 10.0, [_glyph(_pua(18), 10.0, 100.0, 10.0, 6.0)]),
            _span(EQ_FONT, 6.0, [_glyph(_pua(52), 17.0, 103.5, 6.0, 3.0)]),
        ]
    )
    assert result.ok is True
    assert result.latex == r"\(S_{1}\)"


def test_same_size_digit_is_a_coefficient_not_an_exponent() -> None:
    """크기·baseline 이 같은 숫자는 계수다. 지수로 오판하면 안 된다."""
    result = _decode(
        [
            _span(
                EQ_FONT,
                10.0,
                [
                    _glyph(_pua(53), 10.0, 100.0, 10.0, 6.0),
                    _glyph(_pua(252), 17.0, 100.0, 10.0, 6.0),
                ],
            )
        ]
    )
    assert result.latex == r"\(2x\)"


def test_invisible_watermark_text_is_dropped() -> None:
    """`size` 가 1pt 미만인 글자는 보이지 않는 워터마크라 버린다.

    실측: 일일테스트 PDF 에 `size=0.12` 짜리 base64 잡문이 본문 사이에 깔려 있다.
    """
    result = _decode(
        [
            _span(
                "Gulim",
                0.12,
                [_glyph("Z", 0.0, 100.0, 0.12, 0.1), _glyph("X", 0.2, 100.0, 0.12, 0.1)],
            ),
            _span(EQ_FONT, 10.0, [_glyph(_pua(252), 10.0, 100.0, 10.0, 6.0)]),
        ]
    )
    assert result.ok is True
    assert result.latex == r"\(x\)"


# ── 가로선 구조: 분수·근호·벡터·윗줄 (2단계) ────────────────────────


def _bar(x0: float, x1: float, baseline: float, size: float) -> dict[str, Any]:
    """가로 막대 글리프 스팬. `size` 는 실제로는 가로 폭에 따라 커진다."""
    return _span(
        EQ_FONT, size, [_glyph(_pua(pua_table.BAR), x0, baseline, size, x1 - x0)]
    )


def test_fraction_from_bar_with_content_above_and_below() -> None:
    """막대 위·아래에 가운데 정렬된 내용이 있으면 분수다."""
    result = _decode(
        [
            _bar(20.0, 28.0, 100.0, 12.0),
            _span(EQ_FONT, 10.0, [_glyph(_pua(54), 22.0, 90.0, 10.0, 4.0)]),
            _span(EQ_FONT, 10.0, [_glyph(_pua(53), 22.0, 103.0, 10.0, 4.0)]),
        ]
    )
    assert result.ok is True
    assert result.latex == r"\(\frac{3}{2}\)"


def test_overline_when_only_below_has_content() -> None:
    """아래에만 내용이 있으면 윗줄(`\\overline`)이다 — 켤레복소수·선분 표기."""
    result = _decode(
        [
            _bar(20.0, 28.0, 100.0, 9.0),
            _span(EQ_FONT, 10.0, [_glyph(_pua(254), 22.0, 103.0, 10.0, 4.0)]),
        ]
    )
    assert result.ok is True
    assert result.latex == r"\(\overline{z}\)"


def test_offcenter_content_above_is_not_a_numerator() -> None:
    r"""가운데 정렬이 아닌 위쪽 글자는 분자가 아니라 **다른 줄에서 새어 든 글자**다.

    실측(개포고 11번): `\overline{AG}` 가 윗줄 숫자를 분자로 집어 `\frac{2}{AG}` 가
    됐다. 그 글자는 분자로 쓰지도, 조용히 삭제하지도 않아야 한다.
    """
    result = _decode(
        [
            _bar(20.0, 40.0, 100.0, 14.0),
            # 막대 왼쪽 끝에 치우친 위쪽 글자(중심 어긋남 0.35 > 0.15)
            _span(EQ_FONT, 10.0, [_glyph(_pua(53), 20.0, 88.0, 10.0, 4.0)]),
            _span(
                EQ_FONT,
                10.0,
                [
                    _glyph(_pua(0), 22.0, 103.0, 10.0, 8.0),
                    _glyph(_pua(6), 30.0, 103.0, 10.0, 8.0),
                ],
            ),
        ]
    )
    assert r"\overline{AG}" in (result.latex or "")
    assert r"\frac" not in (result.latex or "")
    # 새어 든 `2` 는 사라지지 않고 본문에 남는다
    assert "2" in (result.latex or "")


def test_radical_from_hook_plus_bar() -> None:
    """근호 갈고리 오른쪽에 붙은 막대는 덮개이고, 그 아래가 근호 안 내용이다."""
    result = _decode(
        [
            _span(
                EQ_FONT,
                10.0,
                [_glyph(_pua(pua_table.RADICAL_HOOK), 12.0, 100.0, 10.0, 8.0)],
            ),
            _bar(20.0, 28.0, 100.0, 15.0),
            _span(EQ_FONT, 10.0, [_glyph(_pua(53), 22.0, 103.0, 10.0, 4.0)]),
        ]
    )
    assert result.ok is True
    assert result.latex == r"\(\sqrt{2}\)"


def test_vector_from_bar_plus_arrow_head() -> None:
    """막대 + 화살촉은 벡터 표시다 (실측: 둘의 baseline 이 정확히 같다)."""
    result = _decode(
        [
            _bar(20.0, 28.0, 100.0, 11.0),
            _span(
                EQ_FONT,
                11.0,
                [_glyph(_pua(pua_table.ARROW_HEAD), 22.0, 100.0, 11.0, 6.0)],
            ),
            _span(EQ_FONT, 10.0, [_glyph(_pua(229), 21.0, 105.0, 10.0, 6.0)]),
        ]
    )
    assert result.ok is True
    assert result.latex == r"\(\vec{a}\)"


def test_bar_without_content_is_reported() -> None:
    """내용을 못 묶은 가로선은 조용히 넘기지 않고 `ok=False` 로 내린다."""
    result = _decode([_bar(20.0, 28.0, 100.0, 12.0)])
    assert result.ok is False
    assert result.reason is not None
    assert result.unknown_offsets == []  # 매핑표 문제가 아니다


# ── 괄호 (2단계) ─────────────────────────────────────────────────────


def test_balanced_parens_become_left_right() -> None:
    """짝이 맞는 소괄호는 내용 높이에 맞춰 커지도록 `\\left(`/`\\right)` 로 낸다."""
    result = _decode(
        [
            _span(
                EQ_FONT,
                10.0,
                [
                    _glyph(_pua(68), 10.0, 100.0, 10.0, 4.0),
                    _glyph(_pua(252), 15.0, 100.0, 10.0, 6.0),
                    _glyph(_pua(69), 22.0, 100.0, 10.0, 4.0),
                ],
            )
        ]
    )
    assert result.ok is True
    assert result.latex == r"\(\left(x\right)\)"


def test_unbalanced_parens_fail() -> None:
    """괄호 짝이 안 맞으면 `\\left` 를 쓰지 않고 `ok=False` 로 내린다."""
    result = _decode(
        [
            _span(
                EQ_FONT,
                10.0,
                [
                    _glyph(_pua(68), 10.0, 100.0, 10.0, 4.0),
                    _glyph(_pua(252), 15.0, 100.0, 10.0, 6.0),
                ],
            )
        ]
    )
    assert result.ok is False
    assert "소괄호" in (result.reason or "")
    assert r"\left" not in (result.latex or "")


def test_unbalanced_braces_fail() -> None:
    """중괄호 짝 불일치(조각함수 `{` 표기)도 폴백 사유다."""
    result = _decode(
        [
            _span(
                EQ_FONT,
                10.0,
                [
                    _glyph(_pua(75), 10.0, 100.0, 10.0, 4.0),
                    _glyph(_pua(252), 15.0, 100.0, 10.0, 6.0),
                ],
            )
        ]
    )
    assert result.ok is False
    assert "중괄호" in (result.reason or "")


# ── 신뢰도 판정 (2단계) ──────────────────────────────────────────────


def test_unknown_offset_lowers_confidence_and_is_reported() -> None:
    """매핑표에 없는 오프셋은 `ok=False` + `unknown_offsets` 로 남긴다(표 확장 단서)."""
    result = _decode(
        [_span(EQ_FONT, 10.0, [_glyph(_pua(500), 10.0, 100.0, 10.0, 6.0)])]
    )
    assert result.ok is False
    assert result.unknown_offsets == [500]
    assert "500" in (result.reason or "")


def test_guessed_offset_lowers_confidence() -> None:
    """추측으로 채운 매핑을 쓰면 값이 그럴듯해도 `ok=False` 다."""
    result = _decode([_span(EQ_FONT, 10.0, [_glyph(_pua(26), 10.0, 100.0, 10.0, 6.0)])])
    assert result.ok is False
    assert "추측" in (result.reason or "")
    assert result.unknown_offsets == []  # 표에는 있으므로 확장 단서가 아니다


def test_image_block_forces_fallback() -> None:
    """영역에 그림이 걸리면 텍스트로 내보내지 않는다."""
    result = _decode(
        [_span(EQ_FONT, 10.0, [_glyph(_pua(252), 10.0, 100.0, 10.0, 6.0)])],
        images=[(50.0, 50.0, 200.0, 200.0)],
    )
    assert result.ok is False
    assert "그림" in (result.reason or "")


def test_many_shapes_force_fallback() -> None:
    """도형처럼 보이는 그래픽 요소가 많으면(좌표평면·도형) 폴백한다."""
    shapes = [fitz.Rect(i * 10.0, 50.0, i * 10.0 + 8.0, 80.0) for i in range(9)]
    result = _decode(
        [_span(EQ_FONT, 10.0, [_glyph(_pua(252), 10.0, 100.0, 10.0, 6.0)])],
        drawings=shapes,
    )
    assert result.ok is False
    assert "그래픽" in (result.reason or "")


def test_thin_rules_do_not_force_fallback() -> None:
    """답란 괘선 같은 얇은 가로선은 도형으로 세지 않는다 (실측: 일일테스트 답란)."""
    rules = [fitz.Rect(0.0, 50.0 + i * 10.0, 500.0, 51.0 + i * 10.0) for i in range(20)]
    result = _decode(
        [_span(EQ_FONT, 10.0, [_glyph(_pua(252), 10.0, 100.0, 10.0, 6.0)])],
        drawings=rules,
    )
    assert result.ok is True


def test_empty_region_fails() -> None:
    """글자가 없으면 복원할 것이 없다."""
    result = _decode([])
    assert result.ok is False
    assert result.latex is None


def test_bbox_must_have_four_values() -> None:
    """bbox 는 네 값이어야 한다."""
    with pytest.raises(ValueError, match="네 값"):
        pua_decode.decode_region(_FakePage([]), (0.0, 0.0, 1.0))


# ── 실제 시험지 PDF ──────────────────────────────────────────────────
#
# 기대값은 크롭 이미지를 직접 읽어 원문과 대조해 확정한 것이다.
# 크롭은 `python tmp/verify_decode.py 풍문고` 로 다시 만들 수 있다.

_EXPECTED: dict[int, str] = {
    # 1번: 다항식 계산. 지수 + 괄호 + 마이너스.
    1: (
        "1. 두 다항식 \\(A=4x^{2}+2x-1\\), \\(B=x^{2}+x-3\\)에 대하여 \n"
        "\\(2\\left(A-3B\\right)-\\left(A-4B\\right)\\)를 간단히 하면? [\\(2.7\\)점]\n"
        "① \\(x^{2}+2\\)② \\(x^{2}+5\\)③ \\(2x^{2}+5\\)\n"
        "④ \\(x^{2}-x+4\\)⑤ \\(2x^{2}-x+4\\)"
    ),
    # 5번: 중첩 괄호 + 지수. 발문 상자(사각형 1개)는 폴백 사유가 아니다.
    5: (
        "5. 다음 식을 인수분해 했을 때의 인수가 아닌 것은? [\\(3.1\\)점]\n"
        "\\(\\left(x^{2}+x\\right)^{2}-8\\left(x^{2}+x\\right)+12\\)\n"
        "① \\(x+1\\)② \\(x-1\\)③ \\(x+2\\)\n"
        "④ \\(x-2\\)⑤ \\(x+3\\)"
    ),
    # 17번: 분수 + 근호 + 지수가 한 식에 겹친 경우.
    17: (
        "17. [단답형 2]\n"
        "복소수 \\(z=\\frac{-1+\\sqrt{3}i}{2i}\\)에 대하여 "
        "\\(z^{1}+z^{2}+z^{3}+⋯+z^{2027}\\)의 값을 \n"
        "구하시오. (단, \\(i=\\sqrt{-1}\\)) [\\(4\\)점]"
    ),
}


@pytest.fixture(scope="module")
def real_problems() -> dict[int, tuple[int, list[float]]]:
    """풍문고 시험지를 문항 단위로 분할해 (페이지, bbox) 를 돌려준다."""
    assert TEST_PDF.is_file(), f"테스트 PDF 가 없습니다: {TEST_PDF}"
    result = extractor.extract_problems(TEST_PDF, render_images=False)
    return {p.no: (p.page, p.bbox) for p in result.problems}


@pytest.mark.parametrize("number", sorted(_EXPECTED))
def test_real_exam_problem_matches_original(
    number: int, real_problems: dict[int, tuple[int, list[float]]]
) -> None:
    """실제 시험지 문항이 원문(크롭 이미지로 확인)대로 복원되는지 못박는다."""
    page_no, bbox = real_problems[number]
    doc = fitz.open(str(TEST_PDF))
    try:
        result = pua_decode.decode_region(doc[page_no - 1], bbox)
    finally:
        doc.close()
    assert result.reason is None
    assert result.ok is True
    assert result.latex == _EXPECTED[number]


def test_real_exam_figure_problem_falls_back(
    real_problems: dict[int, tuple[int, list[float]]]
) -> None:
    """그림이 있는 문항(풍문고 11번)은 텍스트로 내보내지 않는다."""
    page_no, bbox = real_problems[11]
    doc = fitz.open(str(TEST_PDF))
    try:
        result = pua_decode.decode_region(doc[page_no - 1], bbox)
    finally:
        doc.close()
    assert result.ok is False
    assert "그림" in (result.reason or "")
