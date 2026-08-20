r"""LaTeX -> 한글 수식(EqEdit) 스크립트 변환.

`.hwpx` 의 수식은 한글 수식 편집기 문법(`{a} over {b}`, `sqrt {x}`)으로 된
`<hp:script>` 에 들어간다. LaTeX 와 문법이 다르므로 변환이 필요하다.

**변환 자체는 python-hwpx 의 `hwpx.equation.latex_to_eqedit` 에 맡긴다.**
그 함수는 실제 한컴 렌더 결과로 검증한 토큰 집합만 변환하고 나머지는
`UnsupportedLatexError` 로 거절한다(조용한 근사를 하지 않는다). 우리가 EqEdit
문법을 추측해 직접 만드는 것보다 이쪽이 확실하다.

이 모듈이 하는 일은 그 앞에 두는 **동등 변환 정규화**와, 그 뒤에 두는
**공백 정리**(`_tighten`)뿐이다. 변환기가 거절하는 문법 가운데 "같은 뜻의 지원
문법으로 바꿔치기가 확실한" 것만 손댄다. 그 밖은 그대로 거절되게 두고 호출부가
평문으로 폴백한다.
"""

from __future__ import annotations

import re
from typing import Final

from hwpx.equation import EquationConversionError, latex_to_eqedit

from to_plain_text import DROP, SYMBOLS

# 같은 뜻의 지원 명령으로 갈아끼운다. `\cfrac` 은 연분수 조판만 다른 분수이고
# 변환기는 `\frac`/`\dfrac`/`\tfrac` 만 받는다.
_RENAMED: Final[dict[str, str]] = {"cfrac": "frac"}

# 간격만 벌리는 명령. 한글 수식에는 대응 토큰이 없어 공백으로 눌러 버린다.
_SPACING_WORDS: Final[frozenset[str]] = frozenset({"quad", "qquad"})
_SPACING_TOKENS: Final[frozenset[str]] = frozenset({"\\,", "\\;", "\\:", "\\ "})

# 서체만 바꾸는 명령. 인자의 중괄호는 남겨 두면 EqEdit 그룹으로 그대로 읽힌다.
_FONT_COMMANDS: Final[frozenset[str]] = frozenset(
    {
        "mathbf", "mathrm", "mathit", "mathcal", "mathbb", "mathsf", "mathtt",
        "boldsymbol", "bm",
    }
)

# 명령 하나를 통째로 집는다. `\\`(줄바꿈)은 `[A-Za-z]+` 가 아니라 `.` 로 잡혀
# 원문 그대로 남고, 변환기가 거절한다(행렬 밖 줄바꿈은 옮길 수 없다).
_COMMAND_RE: Final[re.Pattern[str]] = re.compile(r"\\(?:[A-Za-z]+|.)", re.DOTALL)

# 이미 크기 조절 괄호가 붙은 중괄호와 맨몸 중괄호를 한 번에 훑는다. 앞쪽 대안이
# 먼저 맞아야 `\left\{` 를 `\left\left\{` 로 두 번 감싸지 않는다.
_BRACE_RE: Final[re.Pattern[str]] = re.compile(
    r"\\(?:left|right)\s*\\[{}]|\\[{}]"
)


def _sized_braces(latex: str) -> str:
    r"""맨몸 `\{ \}` 를 `\left\{ \right\}` 로 바꾼다(동등 변환).

    왜: 변환기는 리터럴 중괄호를 `LBRACE`/`RBRACE` 낱말로 낸다. 그런데 같은
    라이브러리의 읽기 방향(`eqedit_to_latex`)조차 그 낱말을 중괄호로 되읽지
    못하고 글자 그대로 돌려준다 — 렌더 검증을 거친 표기가 아니라는 뜻이다.
    반면 `LEFT { ... RIGHT }` 는 P0 계약에서 검증된 표기이고, 내용 높이에 맞춰
    커진다. 사용자 보고 "`\{ \}` 기울어짐" 도 리터럴 표기 쪽이라 이쪽으로 옮긴다.

    짝이 맞는지는 여기서 따지지 않는다. 짝이 어긋나면 변환기가 거절하고
    호출부(`latex_to_hwp_equation`)가 예전 표기로 되돌아간다.

    Args:
        latex: 정규화된 LaTeX 수식 본문.

    Returns:
        중괄호를 크기 조절 괄호로 바꾼 LaTeX. 뜻은 바뀌지 않는다.
    """
    return _BRACE_RE.sub(
        lambda match: {r"\{": r"\left\{", r"\}": r"\right\}"}.get(
            match.group(0), match.group(0)
        ),
        latex,
    )


def _supported_symbol_commands() -> dict[str, str]:
    r"""유니코드 수학 기호 -> 변환기가 받아 주는 LaTeX 명령.

    왜: 원고에는 `≤ ⊂ ∩ ⋯ ∠ ⇒` 와 곱셈기호(U+00D7)처럼 **이미 유니코드로 적힌**
    수학 기호가 그대로 들어온다(PUA 디코더 출력과 AI 가 쓴 풀이 양쪽 다).
    변환기의 렉서는 ASCII 밖 문자를 거절하므로 그 수식은 통째로 평문으로
    폴백했다 — 사용자 보고 "식을 수식으로 안하고 뽑아낸게 있음".

    실측 근거: `tmp/decode_*.txt`(디코더 출력) 454개 스팬 중 21개가 이 이유로
    거절됐고, 재현 파일 `2023 잠실여고 고2 2학기 중간_문제와해설.hwpx` 에서
    평문으로 떨어진 7곳 중 4곳이 `⇒` 하나 때문이었다(docx 는 같은 자리가 수식으로
    들어가 있다 — OMML 은 기호를 글자로 통과시키므로).

    표를 새로 적지 않는다. `to_plain_text.SYMBOLS`(명령->기호)를 뒤집고, 변환기가
    실제로 받는 명령만 남긴다(받는지는 여기서 직접 물어본다 — 133회 호출에
    0.5ms 라 수입 시간에 해도 된다). 같은 기호에 이름이 여럿이면 SYMBOLS 의
    선언 순서가 우선순위다(`le` 가 `leq` 보다 앞).

    Returns:
        기호 한 글자 -> 백슬래시가 붙은 LaTeX 명령.
    """
    table: dict[str, str] = {}
    for name, symbol in SYMBOLS.items():
        # ASCII 는 렉서가 이미 통과시킨다. 굳이 명령으로 바꿀 이유가 없다.
        if symbol.isascii() or symbol in table:
            continue
        command = "\\" + name
        try:
            latex_to_eqedit(command)
        except EquationConversionError:
            continue  # 검증된 토큰 집합 밖이다. 그대로 두고 폴백시킨다.
        table[symbol] = command
    return table


_UNICODE_SYMBOLS: Final[dict[str, str]] = _supported_symbol_commands()

# `str.translate` 용. 명령 뒤에 공백을 붙여야 뒤 글자가 이름에 먹히지 않는다
# (`2≤x` -> `2\le x`. 공백이 없으면 `\lex` 라는 없는 명령이 된다).
_SYMBOL_TRANSLATION: Final[dict[int, str]] = {
    ord(symbol): command + " " for symbol, command in _UNICODE_SYMBOLS.items()
}


# 한글 수식 편집기에서 앞뒤 공백 없이 붙여 써도 뜻이 그대로인 문자들.
# 낱말 키워드(`over`, `sqrt`, `cap` …)는 여기 없다. 그 공백이 구분자다.
_SAFE_SYMBOLS: Final[frozenset[str]] = frozenset("^_+-=(){},<>/|!*:;")


class HwpEquationError(ValueError):
    """한글 수식 스크립트로 확실히 옮길 수 없다는 신호.

    호출부는 이 예외를 잡아 기존 평문으로 폴백한다.
    """


def _rewrite_command(match: re.Match[str]) -> str:
    """명령 하나를 정규화한다(동등 변환만).

    Args:
        match: `_COMMAND_RE` 매치.

    Returns:
        갈아끼운 문자열. 손댈 이유가 없으면 원문 그대로.
    """
    token = match.group(0)
    name = token[1:]
    renamed = _RENAMED.get(name)
    if renamed is not None:
        return "\\" + renamed
    if name in DROP or name in _FONT_COMMANDS or name in _SPACING_WORDS:
        return " "
    if token == "\\!":
        return ""
    if token in _SPACING_TOKENS:
        return " "
    return token


def _normalize(latex: str) -> str:
    r"""변환기에 넘기기 전 LaTeX 를 동등 변환한다.

    유니코드 기호를 먼저 명령으로 되돌린다(`≤` -> `\le `). 그렇게 만든 명령도
    바로 뒤 `_rewrite_command` 를 지나가지만, 기호 명령은 손댈 대상이 아니라
    그대로 통과한다.

    Args:
        latex: 구분자를 벗긴 LaTeX 수식 본문.

    Returns:
        정규화된 LaTeX. 뜻은 바뀌지 않는다.
    """
    restored = latex.translate(_SYMBOL_TRANSLATION)
    return _COMMAND_RE.sub(_rewrite_command, restored).replace("~", " ")


def _is_safe_unit(unit: str) -> bool:
    """공백을 지워도 되는 쪽인지 본다.

    안전한 단위는 연산자·구분자 문자 하나, 숫자, 한 글자짜리 변수, 그리고 이들만
    모인 덩어리(`^{2}`, `{4}`)다. 낱말이 될 수 있는 알파벳은 **혼자 서 있을 때만**
    안전하다. 그래서 `over`·`sqrt` 같은 키워드는 물론 `_{x}` 처럼 글자를 품은
    덩어리도 안전하지 않다고 보고 공백을 남긴다(모르면 지금대로 두는 쪽).

    Args:
        unit: 공백 한쪽에 붙어 있는 단위 문자열.

    Returns:
        붙여 써도 되면 True.
    """
    if not unit:
        return False
    if len(unit) == 1:
        return unit in _SAFE_SYMBOLS or (unit.isascii() and unit.isalnum())
    return all(
        char in _SAFE_SYMBOLS or (char.isascii() and char.isdigit()) for char in unit
    )


def _left_unit(script: str, index: int) -> str:
    """`index` 의 공백 왼쪽 단위를 집는다.

    중괄호 그룹은 통째로 하나의 단위다(`{a ^{2} + 16}`). 감싸고 있는 그룹의 여는
    괄호를 만나면 거기서 멈춘다 — 그 안쪽이 지금 보는 층이다.

    Args:
        script: EqEdit 스크립트.
        index: 공백의 위치.

    Returns:
        공백 바로 왼쪽 단위. 없으면 빈 문자열.
    """
    depth = 0
    start = index
    while start > 0:
        char = script[start - 1]
        if char == "}":
            depth += 1
        elif char == "{":
            if depth == 0:
                break
            depth -= 1
        elif char == " " and depth == 0:
            break
        start -= 1
    return script[start:index]


def _right_unit(script: str, index: int) -> str:
    """`index` 의 공백 오른쪽 단위를 집는다(`_left_unit` 의 거울상).

    Args:
        script: EqEdit 스크립트.
        index: 공백의 위치.

    Returns:
        공백 바로 오른쪽 단위. 없으면 빈 문자열.
    """
    depth = 0
    start = index + 1
    end = start
    while end < len(script):
        char = script[end]
        if char == "{":
            depth += 1
        elif char == "}":
            if depth == 0:
                break
            depth -= 1
        elif char == " " and depth == 0:
            break
        end += 1
    return script[start:end]


def _tighten(script: str) -> str:
    """EqEdit 스크립트에서 렌더 간격으로 보이는 불필요한 공백만 지운다.

    변환기는 토큰마다 공백을 넣는데(`y = 2 x + 3`), 한글 수식 편집기는 그 공백을
    실제 간격으로 그린다. 양옆이 모두 안전한 공백만 지워 원래 조판을 되돌린다.
    낱말 키워드(`over`, `sqrt`, `cap` …)의 구분자 공백은 반드시 남긴다.

    Args:
        script: 변환기가 내놓은 EqEdit 스크립트.

    Returns:
        불필요한 공백을 지운 스크립트.
    """
    collapsed = " ".join(script.split())
    kept = [
        char
        for index, char in enumerate(collapsed)
        if char != " "
        or not (
            _is_safe_unit(_left_unit(collapsed, index))
            and _is_safe_unit(_right_unit(collapsed, index))
        )
    ]
    return "".join(kept)


def _convert(normalized: str) -> str:
    r"""정규화된 LaTeX 를 EqEdit 스크립트로 옮긴다.

    `_sized_braces` 로 손본 쪽을 **먼저** 시도한다. 중괄호 짝이 어긋난 원고
    (`A_{k}=\{x` 처럼 추출이 잘린 것)에서는 `\left\{` 에 짝이 없어 변환기가
    거절하므로, 그때는 손대지 않은 원문으로 한 번 더 시도한다. 둘 다 실패하면
    **원문 쪽 오류**를 올린다 — 우리가 끼워 넣은 `\left` 얘기를 하면 로그를 보고
    원인을 찾을 수 없다.

    Args:
        normalized: `_normalize` 를 지난 LaTeX 수식 본문.

    Returns:
        변환기가 내놓은 EqEdit 스크립트(공백 정리 전).

    Raises:
        HwpEquationError: 검증된 토큰 집합 밖의 문법이 있다.
    """
    candidates = [normalized]
    sized = _sized_braces(normalized)
    if sized != normalized:
        candidates.insert(0, sized)
    error: Exception | None = None
    for candidate in candidates:
        try:
            return latex_to_eqedit(candidate)
        except EquationConversionError as failure:
            error = failure
        except Exception as failure:  # 변환기 내부 오류가 문서 생성을 막지 않게
            raise HwpEquationError(f"변환기 내부 오류: {failure}") from failure
    raise HwpEquationError(str(error))


def latex_to_hwp_equation(latex: str) -> str:
    r"""LaTeX 수식 본문을 한글 수식(EqEdit) 스크립트로 바꾼다.

    Args:
        latex: 구분자(`\\( \\)` 등)를 벗긴 LaTeX 수식 본문.

    Returns:
        `hwpx` 의 `add_equation` 에 그대로 넘길 EqEdit 스크립트.

    Raises:
        HwpEquationError: 비었거나, 검증된 토큰 집합 밖의 문법이 있다.
    """
    normalized = _normalize(latex).strip()
    if not normalized:
        raise HwpEquationError("빈 수식")
    script = _convert(normalized)
    tightened = _tighten(script)
    if not tightened:
        raise HwpEquationError("변환 결과가 비었다")
    return tightened


__all__ = ["HwpEquationError", "latex_to_hwp_equation"]
