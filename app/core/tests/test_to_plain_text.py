"""`to_plain_text` 포팅 검증.

`app/web/src/lib/to-plain-text.test.ts` 의 케이스를 그대로 옮긴 것이다.
같은 입력에 **같은 출력**이 나오는 것이 포팅의 완료 기준이다.

`to_plain_segments`(수식 LaTeX 원문 보존)도 여기서 검증한다. 같은 케이스로
"조각을 이어 붙이면 `to_plain_text` 와 같다"는 불변식을 지켜야 하기 때문이다.
"""

from __future__ import annotations

import pytest

from to_plain_text import to_plain_segments, to_plain_text

# ── 수식 유니코드 변환 ───────────────────────────────────────────────

MATH_CASES = [
    # 위첨자를 유니코드로 바꾼다
    ("$x^2$", "x²"),
    ("$x^{n+1}$", "xⁿ⁺¹"),
    ("$10^{-3}$", "10⁻³"),
    # 유니코드 위첨자가 없는 경우 ^(...) 로 폴백한다 (q 는 위첨자가 없다)
    ("$x^{pq}$", "x^(pq)"),
    # 아래첨자를 유니코드로 바꾼다
    ("$a_n$", "aₙ"),
    ("$a_1$", "a₁"),
    # 유니코드 아래첨자가 없는 경우 _(...) 로 폴백한다 (b 는 아래첨자가 없다)
    ("$a_{b}$", "a_(b)"),
    # 분수는 (a)/(b) 로 바꾼다
    (r"$\frac{a}{b}$", "(a)/(b)"),
    (r"$\frac{x+1}{2}$", "(x+1)/(2)"),
    # 제곱근은 √(...) 로 바꾼다
    (r"$\sqrt{x}$", "√(x)"),
    (r"$\sqrt[3]{x}$", "³√(x)"),
    # 연산자/관계 기호를 유니코드로 바꾼다
    (r"$3 \times 4 \div 2$", "3 × 4 ÷ 2"),
    (r"$x \le 1$", "x ≤ 1"),
    (r"$y \ge 2$", "y ≥ 2"),
    (r"$z \neq 3$", "z ≠ 3"),
    (r"$\pm 5$", "± 5"),
    (r"$a \cdot b$", "a · b"),
    # 그리스 문자와 특수 기호를 바꾼다
    (r"$\alpha + \beta$", "α + β"),
    (r"$\pi$", "π"),
    (r"$\infty$", "∞"),
    (r"$\Delta = 0$", "Δ = 0"),
    # 알려진 함수 명령은 백슬래시만 떼어 읽히게 둔다
    (r"$\sin(x)$", "sin(x)"),
    # 디스플레이 수식 구분자도 벗긴다
    (r"결과: $$\frac{a}{b}$$", "결과: (a)/(b)"),
    (r"값 \(x^2\) 끝", "값 x² 끝"),
    # 깨진 LaTeX 구분자를 남기지 않는다
    (r"설명 \( 깨짐", "설명 깨짐"),
]


@pytest.mark.parametrize(("source", "expected"), MATH_CASES)
def test_math_to_unicode(source: str, expected: str) -> None:
    assert to_plain_text(source) == expected


# ── 마크다운 평문화 ──────────────────────────────────────────────────

MARKDOWN_CASES = [
    # 제목 기호를 제거한다
    ("## 정답", "정답"),
    ("# 제목", "제목"),
    # 굵게/코드 마커를 제거한다
    ("**굵게**", "굵게"),
    ("`code`", "code"),
    # 굵게가 인라인 수식을 감싸도 평문으로 만든다
    ("**높이 $y$의 최댓값**", "높이 y의 최댓값"),
    # 순서 없는 목록은 • 로, 순서 있는 목록은 번호를 유지한다
    ("- 하나\n- 둘", "• 하나\n• 둘"),
    ("1. 처음\n2. 다음", "1. 처음\n2. 다음"),
    # 제목 안의 굵게와 수식을 함께 평문화한다
    (r"## **4단계:** 넓이 $\frac{1}{2}$", "4단계: 넓이 (1)/(2)"),
    # 여러 줄과 수식이 섞인 실제 케이스를 읽히게 만든다
    (
        "**4단계: 높이 $y$의 최댓값을 구하고 삼각형 $PAB$의 넓이를 계산합니다.**",
        "4단계: 높이 y의 최댓값을 구하고 삼각형 PAB의 넓이를 계산합니다.",
    ),
]


@pytest.mark.parametrize(("source", "expected"), MARKDOWN_CASES)
def test_markdown_to_plain(source: str, expected: str) -> None:
    assert to_plain_text(source) == expected


# ── 수식 원문 보존 (to_plain_segments) ───────────────────────────────


@pytest.mark.parametrize("source", [case[0] for case in MATH_CASES + MARKDOWN_CASES])
def test_segments_join_back_to_plain_text(source: str) -> None:
    """조각을 이어 붙이면 `to_plain_text` 와 한 글자도 다르지 않다.

    이 불변식이 깨지면 수식을 2차원으로 조판하는 대가로 수식 밖 텍스트가
    바뀐다는 뜻이다. 기존 케이스 전부로 지킨다.
    """
    assert "".join(s.text for s in to_plain_segments(source)) == to_plain_text(source)


def test_segments_keep_latex_source() -> None:
    """수식 조각은 LaTeX 원문을 그대로 들고 있다(렌더러가 조판할 재료)."""
    segments = to_plain_segments(r"값 \(\frac{a}{b}\) 끝")
    assert [(s.text, s.latex) for s in segments] == [
        ("값 ", ""),
        ("(a)/(b)", r"\frac{a}{b}"),
        (" 끝", ""),
    ]


def test_segments_without_math_are_one_text_piece() -> None:
    """수식이 없으면 조각이 하나뿐이다(렌더러가 예전 경로를 타야 한다)."""
    segments = to_plain_segments("## 정답\n**42**")
    assert [(s.text, s.latex) for s in segments] == [("정답\n42", "")]


def test_segments_drop_math_that_plainifies_to_nothing() -> None:
    """평문이 비는 수식은 조각을 만들지 않는다(불변식 유지)."""
    source = r"앞 \(\displaystyle\) 뒤"
    assert not any(s.is_math for s in to_plain_segments(source))
    assert "".join(s.text for s in to_plain_segments(source)) == to_plain_text(source)
