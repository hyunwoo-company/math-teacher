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

from to_plain_text import DROP

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
    """변환기에 넘기기 전 LaTeX 를 동등 변환한다.

    Args:
        latex: 구분자를 벗긴 LaTeX 수식 본문.

    Returns:
        정규화된 LaTeX. 뜻은 바뀌지 않는다.
    """
    return _COMMAND_RE.sub(_rewrite_command, latex).replace("~", " ")


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
    try:
        script = latex_to_eqedit(normalized)
    except EquationConversionError as error:
        raise HwpEquationError(str(error)) from error
    except Exception as error:  # 변환기 내부 오류가 문서 생성을 막지 않게 한다
        raise HwpEquationError(f"변환기 내부 오류: {error}") from error
    tightened = _tighten(script)
    if not tightened:
        raise HwpEquationError("변환 결과가 비었다")
    return tightened


__all__ = ["HwpEquationError", "latex_to_hwp_equation"]
