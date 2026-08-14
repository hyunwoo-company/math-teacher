r"""마크다운 + LaTeX 원문을 "한글/워드에 붙여도 읽히는" 유니코드 평문으로 바꾼다.

`app/web/src/lib/to-plain-text.ts` 의 파이썬 포팅이다. **같은 입력에 같은 출력**이
나와야 한다(`tests/test_to_plain_text.py` 가 TS 테스트 케이스를 그대로 옮겨 검증한다).

포팅한 이유: 문서(.docx/.hwpx)를 만드는 주체가 서버다. 서버가 `\(x^2\)` 를 그대로
넣으면 한글에서 깨진 채 보인다. 프론트가 변환해 보내는 대안은 "시험지 전체 변형
내보내기"처럼 화면에 없는 데이터를 내보낼 때 성립하지 않는다.

수식 구간 분리(`splitMath`, `lib/math-text.ts`)도 이 모듈 안에 함께 옮겼다.
서버에 필요한 것은 구간 분리뿐이고 KaTeX 렌더는 서버와 무관하기 때문이다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final, NamedTuple

# ── 유니코드 위/아래 첨자 ────────────────────────────────────────────
SUPERSCRIPT: Final[dict[str, str]] = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
    "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
    "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
    "a": "ᵃ", "b": "ᵇ", "c": "ᶜ", "d": "ᵈ", "e": "ᵉ", "f": "ᶠ", "g": "ᵍ", "h": "ʰ",
    "i": "ⁱ", "j": "ʲ", "k": "ᵏ", "l": "ˡ", "m": "ᵐ", "n": "ⁿ", "o": "ᵒ", "p": "ᵖ",
    "r": "ʳ", "s": "ˢ", "t": "ᵗ", "u": "ᵘ", "v": "ᵛ", "w": "ʷ", "x": "ˣ", "y": "ʸ",
    "z": "ᶻ",
}

SUBSCRIPT: Final[dict[str, str]] = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
    "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
    "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
    "a": "ₐ", "e": "ₑ", "h": "ₕ", "i": "ᵢ", "j": "ⱼ", "k": "ₖ", "l": "ₗ", "m": "ₘ",
    "n": "ₙ", "o": "ₒ", "p": "ₚ", "r": "ᵣ", "s": "ₛ", "t": "ₜ", "u": "ᵤ", "v": "ᵥ",
    "x": "ₓ",
}


def _to_script(value: str, sup: bool) -> str:
    """전부 첨자로 바꿀 수 있으면 유니코드 첨자로, 하나라도 없으면 폴백한다.

    Args:
        value: 첨자로 만들 문자열(이미 평문화된 상태).
        sup: True 면 위첨자, False 면 아래첨자.

    Returns:
        유니코드 첨자 문자열, 또는 `^(...)` / `_(...)` 폴백.
    """
    if value == "":
        return "^" if sup else "_"
    table = SUPERSCRIPT if sup else SUBSCRIPT
    mapped: list[str] = []
    for char in value:
        replacement = table.get(char)
        if replacement is None:
            return f"^({value})" if sup else f"_({value})"
        mapped.append(replacement)
    return "".join(mapped)


# ── LaTeX 명령 매핑 ──────────────────────────────────────────────────
# 인자 없는 기호(그리스 문자, 연산자, 관계, 화살표, 집합/논리 등).
SYMBOLS: Final[dict[str, str]] = {
    # 그리스 소문자
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε",
    "varepsilon": "ε", "zeta": "ζ", "eta": "η", "theta": "θ", "vartheta": "ϑ",
    "iota": "ι", "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ",
    "omicron": "ο", "pi": "π", "varpi": "ϖ", "rho": "ρ", "varrho": "ϱ",
    "sigma": "σ", "varsigma": "ς", "tau": "τ", "upsilon": "υ", "phi": "φ",
    "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω",
    # 그리스 대문자
    "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ", "Pi": "Π",
    "Sigma": "Σ", "Upsilon": "Υ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
    # 연산자
    "times": "×", "div": "÷", "pm": "±", "mp": "∓", "cdot": "·", "ast": "∗",
    "star": "⋆", "circ": "∘", "bullet": "•", "oplus": "⊕", "otimes": "⊗",
    # 관계
    "le": "≤", "leq": "≤", "ge": "≥", "geq": "≥", "neq": "≠", "ne": "≠",
    "equiv": "≡", "approx": "≈", "cong": "≅", "sim": "∼", "simeq": "≃",
    "propto": "∝", "ll": "≪", "gg": "≫", "doteq": "≐",
    # 화살표
    "to": "→", "rightarrow": "→", "Rightarrow": "⇒", "leftarrow": "←",
    "Leftarrow": "⇐", "leftrightarrow": "↔", "Leftrightarrow": "⇔", "mapsto": "↦",
    "uparrow": "↑", "downarrow": "↓", "implies": "⇒", "iff": "⇔",
    # 집합/논리
    "in": "∈", "notin": "∉", "ni": "∋", "subset": "⊂", "subseteq": "⊆",
    "supset": "⊃", "supseteq": "⊇", "cup": "∪", "cap": "∩", "emptyset": "∅",
    "varnothing": "∅", "setminus": "∖", "forall": "∀", "exists": "∃",
    "nexists": "∄", "neg": "¬", "land": "∧", "lor": "∨", "wedge": "∧", "vee": "∨",
    # 기타
    "infty": "∞", "partial": "∂", "nabla": "∇", "sum": "∑", "prod": "∏",
    "int": "∫", "oint": "∮", "angle": "∠", "measuredangle": "∡", "perp": "⊥",
    "parallel": "∥", "nparallel": "∦", "cdots": "⋯", "ldots": "…", "dots": "…",
    "vdots": "⋮", "ddots": "⋱", "prime": "′", "degree": "°", "deg": "°",
    "therefore": "∴", "because": "∵", "hbar": "ℏ", "ell": "ℓ", "Re": "ℜ",
    "Im": "ℑ", "aleph": "ℵ", "lfloor": "⌊", "rfloor": "⌋", "lceil": "⌈",
    "rceil": "⌉", "langle": "⟨", "rangle": "⟩", "vert": "|", "lvert": "|",
    "rvert": "|", "Vert": "‖", "mid": "|",
    # 공백 명령
    "quad": " ", "qquad": " ",
}

# 인자 1개를 받아 서식만 벗기고 내용은 그대로 통과시키는 명령.
ONE_ARG_PASS: Final[frozenset[str]] = frozenset(
    {
        "mathbf", "mathrm", "mathit", "mathcal", "mathbb", "mathsf", "mathtt",
        "boldsymbol", "bm", "vec", "hat", "bar", "overline", "underline",
        "tilde", "dot", "ddot", "overrightarrow", "overleftarrow", "widehat",
        "widetilde",
    }
)

# 인자를 "리터럴 텍스트"로 그대로 내보내는 명령(수식 변환하지 않음).
TEXT_ARG: Final[frozenset[str]] = frozenset(
    {"text", "textrm", "textbf", "textit", "textsf", "texttt", "mbox", "operatorname"}
)

# 서식 전용이라 통째로 버리는 명령.
DROP: Final[frozenset[str]] = frozenset(
    {"displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle", "limits",
     "nolimits"}
)

NON_LETTER_ESCAPE: Final[dict[str, str]] = {
    "{": "{", "}": "}", "%": "%", "#": "#", "&": "&", "_": "_", "$": "$",
}

_FRACTIONS: Final[frozenset[str]] = frozenset({"frac", "dfrac", "tfrac", "cfrac"})


class _Piece(NamedTuple):
    """읽어낸 조각과 그 다음 인덱스."""

    text: str
    end: int


def _is_letter(source: str, index: int) -> bool:
    """`source[index]` 가 ASCII 알파벳인지(TS 의 `/[a-zA-Z]/` 와 동일)."""
    if index < 0 or index >= len(source):
        return False
    char = source[index]
    return ("a" <= char <= "z") or ("A" <= char <= "Z")


# ── LaTeX 본문 파서 ──────────────────────────────────────────────────
def _read_braced(source: str, index: int) -> _Piece:
    """`{...}` 균형 그룹을 읽는다. `index` 는 여는 중괄호 위치."""
    depth = 0
    for cursor in range(index, len(source)):
        if source[cursor] == "{":
            depth += 1
        elif source[cursor] == "}":
            depth -= 1
            if depth == 0:
                return _Piece(source[index + 1 : cursor], cursor + 1)
    return _Piece(source[index + 1 :], len(source))


def _read_arg(source: str, index: int) -> _Piece:
    r"""첨자/명령의 인자 하나를 읽는다: `{...}`, `\cmd`, 또는 한 글자."""
    cursor = index
    while cursor < len(source) and source[cursor] == " ":
        cursor += 1
    if cursor >= len(source):
        return _Piece("", cursor)
    if source[cursor] == "{":
        return _read_braced(source, cursor)
    if source[cursor] == "\\":
        end = cursor + 1
        if _is_letter(source, end):
            while _is_letter(source, end):
                end += 1
        else:
            end += 1
        return _Piece(source[cursor:end], end)
    return _Piece(source[cursor], cursor + 1)


def _read_command(source: str, index: int) -> _Piece:
    r"""`\` 로 시작하는 명령을 해석해 치환 문자열과 다음 인덱스를 돌려준다."""
    if index + 1 >= len(source):
        return _Piece("", index + 1)
    following = source[index + 1]

    if not _is_letter(source, index + 1):
        if following in NON_LETTER_ESCAPE:
            return _Piece(NON_LETTER_ESCAPE[following], index + 2)
        # `\,` `\;` `\:` `\ ` `\\`(줄바꿈) 는 공백, `\!`(음수 공백)은 제거.
        if following == "!":
            return _Piece("", index + 2)
        if following in (",", ";", ":", " ", "\\"):
            return _Piece(" ", index + 2)
        return _Piece(following, index + 2)

    end = index + 1
    while _is_letter(source, end):
        end += 1
    name = source[index + 1 : end]

    if name in _FRACTIONS:
        numerator = _read_arg(source, end)
        denominator = _read_arg(source, numerator.end)
        return _Piece(
            f"({_convert(numerator.text)})/({_convert(denominator.text)})",
            denominator.end,
        )
    if name == "sqrt":
        cursor = end
        while cursor < len(source) and source[cursor] == " ":
            cursor += 1
        degree = ""
        if cursor < len(source) and source[cursor] == "[":
            close = source.find("]", cursor)
            if close != -1:
                degree = source[cursor + 1 : close]
                cursor = close + 1
        radicand = _read_arg(source, cursor)
        root = "" if degree == "" else _to_script(_convert(degree), True)
        return _Piece(f"{root}√({_convert(radicand.text)})", radicand.end)
    if name in TEXT_ARG:
        argument = _read_arg(source, end)
        return _Piece(argument.text, argument.end)
    if name in ONE_ARG_PASS:
        argument = _read_arg(source, end)
        return _Piece(_convert(argument.text), argument.end)
    if name in ("begin", "end"):
        argument = _read_arg(source, end)
        return _Piece("", argument.end)
    if name in ("left", "right"):
        # 뒤따르는 구분자 문자는 그대로 살린다. `\left.`/`\right.` 의 점은 버린다.
        cursor = end
        while cursor < len(source) and source[cursor] == " ":
            cursor += 1
        if cursor < len(source) and source[cursor] == ".":
            return _Piece("", cursor + 1)
        return _Piece("", end)
    symbol = SYMBOLS.get(name)
    if symbol is not None:
        return _Piece(symbol, end)
    if name in DROP:
        return _Piece("", end)

    # 매핑에 없는 명령: 백슬래시만 떼고 이름을 남겨 읽히게 둔다(예: \sin -> sin).
    return _Piece(name, end)


def _convert(source: str) -> str:
    """LaTeX 본문을 유니코드 평문으로 바꾼다(재귀)."""
    out: list[str] = []
    index = 0
    while index < len(source):
        char = source[index]
        if char == "\\":
            piece = _read_command(source, index)
            out.append(piece.text)
            index = piece.end
            continue
        if char == "^":
            argument = _read_arg(source, index + 1)
            out.append(_to_script(_convert(argument.text), True))
            index = argument.end
            continue
        if char == "_":
            argument = _read_arg(source, index + 1)
            out.append(_to_script(_convert(argument.text), False))
            index = argument.end
            continue
        if char == "{":
            group = _read_braced(source, index)
            out.append(_convert(group.text))
            index = group.end
            continue
        if char == "}":
            index += 1
            continue
        if char in ("&", "~"):
            out.append(" ")
            index += 1
            continue
        out.append(char)
        index += 1
    return "".join(out)


def _convert_math(body: str) -> str:
    """수식 본문(구분자는 이미 제거됨)을 한 줄 유니코드로 변환한다."""
    return re.sub(r"\s+", " ", _convert(body)).strip()


# ── 수식 구간 분리 (math-text.ts 의 splitMath) ───────────────────────
# 긴 구분자를 먼저 검사해야 `$$` 가 `$` 로 오인되지 않는다.
_DELIMITERS: Final[tuple[tuple[str, str], ...]] = (
    ("$$", "$$"),
    ("\\[", "\\]"),
    ("\\(", "\\)"),
    ("$", "$"),
)

_BLANK_LINE_RE: Final[re.Pattern[str]] = re.compile(r"\n[ \t]*\n")


class _Segment(NamedTuple):
    """텍스트/수식 구간. `is_math` 면 `value` 는 구분자를 벗긴 수식 본문."""

    is_math: bool
    value: str


def _looks_like_math(body: str) -> bool:
    """수식 안이 비었거나 빈 줄을 포함하면 수식으로 보지 않는다(오탐 방지)."""
    if body.strip() == "":
        return False
    return _BLANK_LINE_RE.search(body) is None


def split_math(source: str) -> list[_Segment]:
    r"""텍스트를 텍스트/수식 구간으로 나눈다.

    `\$` 처럼 이스케이프된 달러는 수식 시작으로 보지 않고 리터럴 `$` 로 되돌린다.
    닫는 구분자를 못 찾거나 수식처럼 보이지 않으면 여는 구분자를 리터럴로 남긴다.
    """
    segments: list[_Segment] = []
    text = ""
    index = 0

    while index < len(source):
        char = source[index]

        if char == "\\" and source[index + 1 : index + 2] == "$":
            text += "$"
            index += 2
            continue

        delimiter = next(
            (pair for pair in _DELIMITERS if source.startswith(pair[0], index)), None
        )
        if delimiter is None:
            text += char
            index += 1
            continue

        opening, closing = delimiter
        body_start = index + len(opening)
        close_index = source.find(closing, body_start)
        if close_index == -1:
            # 닫히지 않았다 -> 리터럴로 취급
            text += opening
            index = body_start
            continue

        body = source[body_start:close_index]
        if not _looks_like_math(body):
            text += opening
            index = body_start
            continue

        if text != "":
            segments.append(_Segment(False, text))
            text = ""
        segments.append(_Segment(True, body))
        index = close_index + len(closing)

    if text != "":
        segments.append(_Segment(False, text))
    return segments


# ── 마크다운 평문화 ──────────────────────────────────────────────────
_HEADING_RE: Final[re.Pattern[str]] = re.compile(r"^\s{0,3}#{1,6}\s+")
_BULLET_RE: Final[re.Pattern[str]] = re.compile(r"^(\s{0,3})[-*+]\s+")
_BOLD_RE: Final[re.Pattern[str]] = re.compile(r"\*\*([^*]+)\*\*")
_CODE_RE: Final[re.Pattern[str]] = re.compile(r"`([^`]+)`")
_MATH_DELIMITER_RE: Final[re.Pattern[str]] = re.compile(r"\\[()\[\]]")
_INNER_SPACES_RE: Final[re.Pattern[str]] = re.compile(r"[ \t]{2,}")
_TRAILING_SPACES_RE: Final[re.Pattern[str]] = re.compile(r"[ \t]+$", re.MULTILINE)
_BLANK_LINES_RE: Final[re.Pattern[str]] = re.compile(r"\n{3,}")


def _strip_markdown(text: str) -> str:
    """마크다운 기호를 걷어낸다(수식이 이미 유니코드로 바뀐 뒤에 호출)."""
    lines: list[str] = []
    for line in text.split("\n"):
        stripped = _HEADING_RE.sub("", line)  # 제목 -> 줄
        stripped = _BULLET_RE.sub(r"\1• ", stripped)  # 순서 없는 목록 -> •
        lines.append(stripped)
    out = "\n".join(lines)
    # 수식이 유니코드로 바뀐 뒤라 굵게/코드 마커가 다시 인접해 있다.
    out = _BOLD_RE.sub(r"\1", out)
    out = out.replace("**", "")
    out = _CODE_RE.sub(r"\1", out)
    out = out.replace("`", "")
    # 파싱되지 못한 LaTeX 구분자 잔재 제거(깨진 \( \) \[ \] 방지).
    out = _MATH_DELIMITER_RE.sub("", out)
    # 공백 정리
    out = _INNER_SPACES_RE.sub(" ", out)
    out = _TRAILING_SPACES_RE.sub("", out)
    out = _BLANK_LINES_RE.sub("\n\n", out)
    return out.strip()


def to_plain_text(source: str) -> str:
    """마크다운 + LaTeX 원문을 유니코드 평문으로 변환한다.

    수식은 유니코드 기호/첨자로, 마크다운 기호는 평문으로 바꾼다.

    Args:
        source: AI 응답 등 마크다운+LaTeX 원문.

    Returns:
        한글/워드에 그대로 넣어도 읽히는 평문.
    """
    assembled = "".join(
        _convert_math(segment.value) if segment.is_math else segment.value
        for segment in split_math(source)
    )
    return _strip_markdown(assembled)


# ── 평문화 + LaTeX 원문 보존 ─────────────────────────────────────────
# 수식 자리표. 유니코드 사용자 영역(U+E000~)이라 실제 원고에 나올 일이 없고,
# `_strip_markdown` 의 어떤 정규식도 건드리지 않는다(공백도 마크다운 기호도 아님).
_PLACEHOLDER_OPEN: Final[str] = "\ue000"
_PLACEHOLDER_CLOSE: Final[str] = "\ue001"
_PLACEHOLDER_RE: Final[re.Pattern[str]] = re.compile(
    f"{_PLACEHOLDER_OPEN}(\\d+){_PLACEHOLDER_CLOSE}"
)


@dataclass(frozen=True)
class PlainSegment:
    """평문화 결과의 한 조각.

    Attributes:
        text: 이 조각의 평문. 수식이면 `to_plain_text` 와 같은 유니코드 폴백이다.
        latex: 수식 조각이면 구분자를 벗긴 LaTeX 본문, 텍스트면 빈 문자열.
    """

    text: str
    latex: str = ""

    @property
    def is_math(self) -> bool:
        """수식 조각인지."""
        return self.latex != ""


def to_plain_segments(source: str) -> list[PlainSegment]:
    r"""평문화하면서 수식 구간의 LaTeX 원문을 함께 남긴다.

    `to_plain_text` 는 문자열 하나를 돌려주므로 렌더러가 LaTeX 를 볼 수 없고,
    평문으로는 분수·근호의 2차원 조판이 원리상 불가능하다. 그래서 수식을
    자리표로 바꿔 **기존 평문화 파이프라인을 그대로** 통과시킨 뒤 다시 잘라낸다.
    수식 밖 텍스트가 `to_plain_text` 와 한 글자도 다르지 않은 것이 이 방식의
    목적이다.

    불변식: ``"".join(s.text for s in to_plain_segments(x)) == to_plain_text(x)``
    (`tests/test_to_plain_text.py` 가 기존 케이스 전체로 검증한다.)

    Args:
        source: AI 응답 등 마크다운+LaTeX 원문.

    Returns:
        텍스트/수식 조각 목록. 인접한 텍스트 조각은 합쳐져 있다.
    """
    if _PLACEHOLDER_OPEN in source or _PLACEHOLDER_CLOSE in source:
        # 자리표와 충돌하는 입력. 수식 분리를 포기하고 평문만 돌려준다.
        return [PlainSegment(to_plain_text(source))]

    pieces: list[str] = []
    latexes: list[str] = []
    plains: list[str] = []
    for segment in split_math(source):
        if not segment.is_math:
            pieces.append(segment.value)
            continue
        plain = _convert_math(segment.value)
        if plain == "":
            # 평문이 비는 수식(예: `\(\displaystyle\)`). 자리표를 만들지 않는다 —
            # `to_plain_text` 도 아무것도 남기지 않으므로 불변식이 유지된다.
            continue
        pieces.append(f"{_PLACEHOLDER_OPEN}{len(latexes)}{_PLACEHOLDER_CLOSE}")
        latexes.append(segment.value)
        plains.append(plain)

    stripped = _strip_markdown("".join(pieces))
    out: list[PlainSegment] = []
    cursor = 0
    for match in _PLACEHOLDER_RE.finditer(stripped):
        if match.start() > cursor:
            out.append(PlainSegment(stripped[cursor : match.start()]))
        index = int(match.group(1))
        out.append(PlainSegment(plains[index], latexes[index]))
        cursor = match.end()
    if cursor < len(stripped):
        out.append(PlainSegment(stripped[cursor:]))
    return out


__all__ = ["PlainSegment", "split_math", "to_plain_segments", "to_plain_text"]
