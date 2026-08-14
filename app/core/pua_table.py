r"""한글 수식편집기 폰트(`HyhwpEQ`)의 PUA 오프셋 -> LaTeX 매핑표.

## 왜 이 표가 성립하는가

`HyhwpEQ` 는 `cmap`/`post` 가 없는 서브셋 폰트라 폰트 자체에는 "이 글리프가 어떤
문자인가"라는 단서가 없다. 그러나 PDF 의 `ToUnicode` 가 사설영역(U+E000~)으로
매핑하는 코드값이 **원본 글리프 순서를 보존**한다. 그래서

    오프셋 = ord(문자) - 0xE000

으로 보면 값이 규칙적이고(로만 대문자 / 기호 / 이탤릭 소문자 …), 서로 다른 시험지
PDF 4개에서 같은 오프셋이 같은 문자를 가리킨다. 근거는
`docs/superpowers/specs/2026-08-14-text-transcription-design.md` §2 와 아래 표의
`확인` 주석이다.

## 확정 방법

각 오프셋이 실제로 찍힌 자리를 PDF 에서 고해상도로 잘라 **그림으로 직접 읽고**,
같은 자리의 오프셋 시퀀스와 1:1 로 대조했다. 대조에 쓴 PDF 는 넷이다.

* `개포고`  = `tmp/[2026-1-1-M][공수1][개포고].pdf`
* `풍문고`  = `[2026-1-1-M][공수1][풍문고].pdf` (저장소 루트)
* `반배치`  = `tmp/고1 반배치고사(편집본)_2026_2학기.pdf`
* `일일`    = `tmp/0809 일일테스트.pdf`

## 추측 항목 규칙

배열 규칙(등차)으로만 채운 항목은 `certain=False` 다. 디코더는 이런 오프셋이
하나라도 쓰이면 `ok=False` 로 내린다 — **틀린 복원보다 이미지 폴백이 낫다.**
"""

from __future__ import annotations

import string
from dataclasses import dataclass
from typing import Final

#: 사설 사용 영역(Private Use Area) 시작. 오프셋의 기준점.
PUA_START: Final[int] = 0xE000

#: 수식 폰트 이름에 들어 있는 표식. 서브셋 접두사(`INPILL+`)는 시험지마다 다르다.
EQ_FONT_HINT: Final[str] = "HyhwpEQ"


@dataclass(frozen=True)
class Entry:
    """오프셋 하나의 뜻.

    Attributes:
        latex: 수식 모드에서 그대로 쓸 LaTeX 조각.
        certain: 크롭 이미지 대조로 확인했으면 True. 배열 규칙으로만 채운
            추측이면 False(디코더가 `ok=False` 로 내린다).
    """

    latex: str
    certain: bool = True


# ── 구조 글리프 (문자가 아니라 2차원 조판의 부품) ──────────────────────
#
# 확인: 네 PDF 모두. `109` 는 **늘어나는 가로 막대 한 종류**가 분수선·근호 덮개·
# 벡터 화살표 몸통 세 역할을 겸한다는 것이 실측 결론이다. 스펙 §2-4 는 이 선이
# `page.get_drawings()` 의 그래픽으로 올 것이라고 적었는데 **틀렸다.** 선은
# 텍스트 레이어의 글리프이고, 같은 자리에 그래픽 요소는 없다
# (`get_drawings()` 조회 결과 0건).
#
#   * 풍문고 p0 `<109|11> <53>` -> `3/2` (분자 3 은 다른 줄 레코드에 있다)
#   * 풍문고 p0 `<92> <109|16>` -> `√-1`  (근호 덮개)
#   * 일일  p0 `<109> <110> <244>` -> `p⃗`  (화살표 몸통 + 화살촉 + 밑글자)
#   * 풍문고 p0 `<254> <109|8.8> <254>` -> `z z̄` (덮개만, 아래에만 내용)

#: 늘어나는 가로 막대. 역할은 주변 구조로 판정한다(분수/근호/벡터/윗줄).
BAR: Final[int] = 109

#: 오른쪽 화살촉. `BAR` 와 짝지어 벡터 표시가 된다.
ARROW_HEAD: Final[int] = 110

#: 근호의 갈고리(`√`). 오른쪽에 붙는 `BAR` 가 덮개다.
RADICAL_HOOK: Final[int] = 92

#: 여는/닫는 소괄호. 네 PDF 전부에서 빈도가 정확히 같은 쌍이다.
PAREN_OPEN: Final[int] = 68
PAREN_CLOSE: Final[int] = 69

#: 여는/닫는 중괄호(집합 기호). 확인: 반배치 p0 `A={1,2,a+6}`.
BRACE_OPEN: Final[int] = 75
BRACE_CLOSE: Final[int] = 76

#: 절댓값 막대. 확인: 반배치 p7 `y=3|x-1|-7`, `|a|+|b|`.
ABS_BAR: Final[int] = 257

#: 구조 부품이라 문자 표에 없는 오프셋들. 문자 치환 대상이 아니다.
STRUCTURAL: Final[frozenset[int]] = frozenset({BAR, ARROW_HEAD, RADICAL_HOOK})


def _run(start: int, letters: str, *, certain: bool) -> dict[int, Entry]:
    """`start` 부터 한 칸씩 늘어나는 연속 구간을 만든다.

    Args:
        start: 첫 글자의 오프셋.
        letters: 순서대로 대응시킬 문자열.
        certain: 구간 전체의 확정 여부.

    Returns:
        오프셋 -> `Entry` 사전.
    """
    return {
        start + index: Entry(latex=letter, certain=certain)
        for index, letter in enumerate(letters)
    }


#: 오프셋 -> LaTeX 조각. 없는 오프셋은 '미확인'이고 디코더가 `ok=False` 로 내린다.
TABLE: Final[dict[int, Entry]] = {
    # ── 0~25: 대문자 A~Z ─────────────────────────────────────────────
    # 확인(직접 대조): 0=A, 1=B (개포고 1번 `A=3x²-xy+y²`, 반배치 p0 `A={1,2,a+6}`),
    # 2=C (반배치 `C₁`), 15=P·16=Q·17=R·18=S (개포고/풍문고 `P(x)` 다항식 표기),
    # 23=X (반배치 `X`). 여섯 지점이 등차 배열과 모두 일치해 구간 전체를 확정한다.
    **_run(0, string.ascii_uppercase, certain=True),
    #
    # ── 26~51: 소문자 a~z (로만체) ───────────────────────────────────
    # 추측: 네 PDF 어디에서도 쓰이지 않아 대조 표본이 없다. leesj.me 의 HYHWPEQ
    # 글리프 구성 분석("로만체 알파벳 / 기호 / 다시 로만체 / 이탤릭 소문자")과
    # 대문자 구간 길이(26)로 미루어 채웠다. 쓰이면 `ok=False`.
    **_run(26, string.ascii_lowercase, certain=False),
    #
    # ── 52~61: 숫자 1~9, 0 ───────────────────────────────────────────
    # 확인: 열 칸 전부를 글리프 크롭으로 직접 읽었다(개포고·일일·반배치).
    # **0 부터가 아니라 1 부터 시작하고 0 이 맨 끝**이다.
    **_run(52, "1234567890", certain=True),
    #
    # ── 68~72: 괄호와 사칙 기호 ──────────────────────────────────────
    # 확인: 반배치 p0 `A(3,-1)`, `f:(x,y)→(x+m,y+n)`; 개포고 1번 `A=3x²-xy+y²`.
    PAREN_OPEN: Entry(r"("),
    PAREN_CLOSE: Entry(r")"),
    # U+2212 가 원문이지만 LaTeX 에는 ASCII 하이픈을 낸다(수식 모드에서 마이너스).
    70: Entry("-"),
    71: Entry("="),
    72: Entry("+"),
    #
    # ── 75, 76: 중괄호 ──────────────────────────────────────────────
    # 확인: 반배치 p0 `A={1,2,a+6}`, `B={a,2a+4}`.
    BRACE_OPEN: Entry(r"\{"),
    BRACE_CLOSE: Entry(r"\}"),
    #
    # ── 79, 82~86: 구두점·비교 기호 ─────────────────────────────────
    # 확인(반배치 p0/p2): 79=`:` (`f:(x,y)`, `1:2`, `3:1`),
    #                     82=`,` (`A(3,-1)`, `{1,2,a+6}`).
    79: Entry(":"),
    82: Entry(","),
    # 확인: 개포고 배점 표기 `[3.4점]` `[3.5점]` `[3.6점]` `[3.7점]`.
    83: Entry("."),
    # 확인: 일일 p0 단위 표기 `(cm², km/h 등)`.
    84: Entry("/"),
    # 확인: 개포고/반배치 `<`, 일일 p0 `(단, b>a)`.
    85: Entry("<"),
    86: Entry(">"),
    #
    # ── 157~180: 그리스 소문자 ──────────────────────────────────────
    # 확인: 157=α, 158=β (개포고·풍문고·반배치의 글리프 크롭에서 직접 읽었다).
    # 추측: 159 이후는 표본이 없다. 그리스 자모 순서로 채웠고 쓰이면 `ok=False`.
    157: Entry(r"\alpha"),
    158: Entry(r"\beta"),
    **{
        offset: Entry(command, certain=False)
        for offset, command in enumerate(
            (
                r"\gamma",
                r"\delta",
                r"\epsilon",
                r"\zeta",
                r"\eta",
                r"\theta",
                r"\iota",
                r"\kappa",
                r"\lambda",
                r"\mu",
                r"\nu",
                r"\xi",
                r"\omicron",
                r"\pi",
                r"\rho",
                r"\sigma",
                r"\tau",
                r"\upsilon",
                r"\phi",
                r"\chi",
                r"\psi",
                r"\omega",
            ),
            start=159,
        )
    },
    #
    # ── 200: 도(degree) ─────────────────────────────────────────────
    # 확인: 일일 p0 `예각의 크기가 x°`, `cos x° = ?/7`.
    # `\circ` 는 링 연산자라 뜻이 다르다. 유니코드 도 기호를 그대로 낸다.
    200: Entry("°"),
    #
    # ── 229~254: 이탤릭 소문자 a~z ──────────────────────────────────
    # 확인(직접 대조): a,b,c,d,f,g,h,i,k,l,m,n,p,q,r,t,x,y,z 19자를 글리프
    # 크롭으로 읽었고 전부 `229+ord(ch)-ord('a')` 와 일치한다(예: 252=x, 253=y,
    # 254=z). 최다 빈도 오프셋 252 가 최다 사용 문자 x 와 맞는 것도 같은 근거다.
    # 표본이 없는 e,j,o,s,u,v,w 도 같은 등차 안이라 구간 전체를 확정한다.
    **_run(229, string.ascii_lowercase, certain=True),
    #
    # ── 257: 절댓값 막대 ────────────────────────────────────────────
    # 확인: 반배치 p7 `y=3|x-1|-7`, `|a|+|b|`.
    ABS_BAR: Entry("|"),
}


def offset_of(char: str) -> int | None:
    """문자가 PUA 안이면 오프셋을, 아니면 None 을 돌려준다.

    Args:
        char: 검사할 문자 하나.

    Returns:
        `ord(char) - PUA_START`, 또는 PUA 밖이면 None.
    """
    if len(char) != 1:
        return None
    code = ord(char)
    if code < PUA_START:
        return None
    return code - PUA_START


def lookup(offset: int) -> Entry | None:
    """오프셋의 뜻을 찾는다.

    Args:
        offset: PUA 오프셋.

    Returns:
        `Entry`, 또는 표에 없으면 None(미확인 오프셋).
    """
    return TABLE.get(offset)
