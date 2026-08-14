r"""LaTeX -> OMML(`m:oMath`) 변환. 워드 네이티브 수식 조판.

평문(`to_plain_text`)으로는 분수의 가로선이나 근호의 덮는 선을 만들 수 없다.
1차원 문자열에 2차원 조판을 담을 방법이 없기 때문이다. 그래서 `.docx` 는
워드가 직접 조판하는 수식 개체(OMML, ECMA-376 Part 1 §22.1.2)를 넣는다.

방침: **확실한 것만 만든다.** 매핑이 확실하지 않은 문법은 조용히 근사하지 않고
`UnsupportedLatexError` 로 거절한다. 호출부(`export/docx.py`)가 그때 기존 평문으로
폴백한다 — 문서가 깨지는 것보다 낫다.

기호 표는 `to_plain_text` 의 `SYMBOLS` / `TEXT_ARG` / `DROP` /
`NON_LETTER_ESCAPE` 를 그대로 재사용한다. 한 벌만 유지해야 형식별로 기호가
갈리지 않는다.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final
from xml.sax.saxutils import escape, quoteattr

from to_plain_text import DROP, NON_LETTER_ESCAPE, SYMBOLS, TEXT_ARG

# OMML/WordprocessingML 네임스페이스. 스펙이 못박은 고정 URI 다.
MATH_NAMESPACE: Final[str] = (
    "http://schemas.openxmlformats.org/officeDocument/2006/math"
)
WORD_NAMESPACE: Final[str] = (
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
)

# 입력 길이·중첩 상한. 깨진 원고가 파서를 폭주시키는 것을 막는다.
_MAX_LENGTH: Final[int] = 10_000
_MAX_DEPTH: Final[int] = 32

# ── 문법 표 ──────────────────────────────────────────────────────────
_FRACTIONS: Final[frozenset[str]] = frozenset({"frac", "dfrac", "tfrac", "cfrac"})

# 큰 연산자 -> (기호, 한계 위치). `undOvr` 는 위·아래, `subSup` 는 오른쪽 첨자.
# 적분은 LaTeX 도 기본이 오른쪽이라 `subSup` 로 맞춘다.
_NARY: Final[dict[str, tuple[str, str]]] = {
    "sum": ("∑", "undOvr"),
    "prod": ("∏", "undOvr"),
    "coprod": ("∐", "undOvr"),
    "bigcup": ("⋃", "undOvr"),
    "bigcap": ("⋂", "undOvr"),
    "int": ("∫", "subSup"),
    "iint": ("∬", "subSup"),
    "iiint": ("∭", "subSup"),
    "oint": ("∮", "subSup"),
}

# 아래첨자를 "아래 한계"로 조판하는 연산자(`m:limLow`). 사용자가 지목한 극한이
# 여기 있다: `\lim_{x \to 0}` 은 lim 아래에 조건이 붙어야 한다.
_LIMIT_OPERATORS: Final[dict[str, str]] = {
    "lim": "lim",
    "limsup": "lim sup",
    "liminf": "lim inf",
    "max": "max",
    "min": "min",
    "sup": "sup",
    "inf": "inf",
}

# 악센트 명령 -> 결합 문자(U+0300 블록 / U+20D0 블록). 워드가 `m:acc` 의
# `m:chr` 에 쓰는 값과 같다.
_ACCENTS: Final[dict[str, str]] = {
    "hat": "̂",
    "widehat": "̂",
    "tilde": "̃",
    "widetilde": "̃",
    "bar": "̄",
    "dot": "̇",
    "ddot": "̈",
    "acute": "́",
    "grave": "̀",
    "check": "̌",
    "breve": "̆",
    "vec": "⃗",
    "overrightarrow": "⃗",
    "overleftarrow": "⃖",
}

# 선 덮개 -> `m:bar` 의 위치. 근호와 달리 글자 위/아래에 선만 긋는다.
_BARS: Final[dict[str, str]] = {"overline": "top", "underline": "bot"}

# 서체만 바꾸는 명령. 굵기·서체는 버리고 내용만 통과시킨다
# (`to_plain_text.ONE_ARG_PASS` 와 같은 방침).
_PASS_THROUGH: Final[frozenset[str]] = frozenset(
    {
        "mathbf", "mathrm", "mathit", "mathcal", "mathbb", "mathsf", "mathtt",
        "boldsymbol", "bm",
    }
)

# 곧게 세워 쓰는 함수 이름. LaTeX 도 이들을 이탤릭으로 쓰지 않는다.
_FUNCTIONS: Final[frozenset[str]] = frozenset(
    {
        "sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh",
        "arcsin", "arccos", "arctan", "arccot", "log", "ln", "lg", "exp",
        # `\deg` 는 `SYMBOLS` 가 `°` 로 먼저 잡으므로 여기 넣지 않는다.
        "det", "dim", "gcd", "arg", "ker", "hom", "bmod", "pmod",
    }
)

# `\left` / `\right` 뒤에 올 수 있는 구분자.
_DELIMITER_CHARS: Final[frozenset[str]] = frozenset("()[]|/")
_DELIMITER_COMMANDS: Final[dict[str, str]] = {
    "{": "{",
    "}": "}",
    "|": "‖",
    "langle": "⟨",
    "rangle": "⟩",
    "lfloor": "⌊",
    "rfloor": "⌋",
    "lceil": "⌈",
    "rceil": "⌉",
    "vert": "|",
    "lvert": "|",
    "rvert": "|",
    "Vert": "‖",
}

# 런 스타일 -> `m:rPr`. `p` 는 곧게(plain), `nor` 는 수식이 아닌 리터럴 텍스트다.
# `m:rPr` 의 자식 순서는 스펙이 못박고 있어(lit, nor, scr, sty, brk, aln) 둘을
# 동시에 넣지 않는다.
_RUN_PROPERTIES: Final[dict[str, str]] = {
    "": "",
    "p": '<m:rPr><m:sty m:val="p"/></m:rPr>',
    "nor": "<m:rPr><m:nor/></m:rPr>",
}

# 수식 안의 공백은 조판에 영향이 없다(LaTeX 와 같다).
_SPACE_CHARS: Final[frozenset[str]] = frozenset(" \t\r\n")


class UnsupportedLatexError(ValueError):
    """OMML 로 확실히 옮길 수 없는 LaTeX 를 만났다는 신호.

    호출부는 이 예외를 잡아 기존 평문으로 폴백한다.
    """


@dataclass(frozen=True)
class _Item:
    """수식 조각 하나.

    Attributes:
        xml: 이 조각의 OMML.
        text: 텍스트 런이면 그 내용(인접한 것끼리 합칠 수 있다). 구조 요소는 None.
        style: 텍스트 런의 스타일 키(`_RUN_PROPERTIES` 의 키). 병합 조건이 된다.
    """

    xml: str
    text: str | None = None
    style: str = ""


@dataclass(frozen=True)
class _Stop:
    r"""현재 시퀀스를 어디서 멈춰야 하는지.

    Attributes:
        at_brace: True 면 `}` 에서 멈춘다(중괄호 그룹 안).
        at_right: True 면 `\\right` 에서 멈춘다(`\\left ... \\right` 안).
    """

    at_brace: bool = False
    at_right: bool = False


def _is_letter(char: str) -> bool:
    """ASCII 알파벳인지(`to_plain_text._is_letter` 와 같은 기준)."""
    return ("a" <= char <= "z") or ("A" <= char <= "Z")


def _run_xml(text: str, style: str) -> str:
    """텍스트 런 하나를 OMML 로.

    Args:
        text: 런에 넣을 문자열.
        style: `_RUN_PROPERTIES` 의 키.

    Returns:
        `m:r` 요소 XML. 공백이 뭉개지지 않게 `xml:space="preserve"` 를 붙인다.
    """
    return (
        f"<m:r>{_RUN_PROPERTIES[style]}"
        f'<m:t xml:space="preserve">{escape(text)}</m:t></m:r>'
    )


def _text_item(text: str, style: str = "") -> _Item:
    """병합 가능한 텍스트 조각을 만든다."""
    return _Item(_run_xml(text, style), text, style)


def _serialize(items: Sequence[_Item]) -> str:
    """조각 목록을 OMML 로 이어 붙인다(인접한 같은 스타일 텍스트는 한 런으로).

    한 글자마다 런을 만들면 워드가 열기는 하지만 XML 이 몇 배로 불어난다.
    첨자는 "바로 앞 한 글자"에만 붙어야 하므로(LaTeX 규칙) 파싱은 글자 단위로
    하고 합치기는 여기서 한다.

    Args:
        items: 파서가 만든 조각 목록.

    Returns:
        이어 붙인 OMML 문자열.
    """
    out: list[str] = []
    pending: list[str] = []
    pending_style = ""

    def flush() -> None:
        nonlocal pending_style
        if pending:
            out.append(_run_xml("".join(pending), pending_style))
            pending.clear()
            pending_style = ""

    for item in items:
        if item.text is None:
            flush()
            out.append(item.xml)
            continue
        if pending and item.style != pending_style:
            flush()
        pending_style = item.style
        pending.append(item.text)
    flush()
    return "".join(out)


def _arg(tag: str, xml: str) -> str:
    """`m:num` / `m:sup` 처럼 인자 하나를 감싼다. 비면 빈 요소로 둔다."""
    return f"<m:{tag}>{xml}</m:{tag}>" if xml else f"<m:{tag}/>"


class _Parser:
    """LaTeX 본문을 OMML 로 바꾸는 재귀 하강 파서."""

    def __init__(self, source: str) -> None:
        """파서를 만든다.

        Args:
            source: 구분자를 벗긴 LaTeX 수식 본문.
        """
        self._source = source
        self._index = 0

    # ── 진입점 ──────────────────────────────────────────────────────
    def parse(self) -> str:
        """전체를 변환한다.

        Returns:
            `m:oMath` 의 자식들이 될 OMML 문자열.
        """
        return _serialize(self._sequence(0, _Stop()))

    # ── 커서 ────────────────────────────────────────────────────────
    def _peek(self) -> str | None:
        """현재 문자(끝이면 None)."""
        return self._source[self._index] if self._index < len(self._source) else None

    def _skip_spaces(self) -> None:
        """공백을 건너뛴다."""
        while (char := self._peek()) is not None and char in _SPACE_CHARS:
            self._index += 1

    def _at_command(self, name: str) -> bool:
        r"""현재 위치가 `\name` 인지(뒤에 알파벳이 더 붙지 않은 정확한 일치)."""
        token = "\\" + name
        if not self._source.startswith(token, self._index):
            return False
        end = self._index + len(token)
        return end >= len(self._source) or not _is_letter(self._source[end])

    # ── 시퀀스 ──────────────────────────────────────────────────────
    def _sequence(self, depth: int, stop: _Stop) -> list[_Item]:
        """조각들을 멈춤 조건까지 읽는다.

        Args:
            depth: 현재 중첩 깊이.
            stop: 멈춤 조건.

        Returns:
            읽어낸 조각 목록. 멈춤 토큰은 소비하지 않는다.

        Raises:
            UnsupportedLatexError: 중첩이 너무 깊거나 지원하지 않는 문법.
        """
        if depth > _MAX_DEPTH:
            raise UnsupportedLatexError("수식 중첩이 너무 깊다")
        items: list[_Item] = []
        while (char := self._peek()) is not None:
            if char == "}":
                if stop.at_brace:
                    return items
                # 짝 없는 닫는 중괄호는 버린다(`to_plain_text` 와 같은 처리).
                self._index += 1
                continue
            if char in ("^", "_"):
                self._apply_script(items, depth)
                continue
            if char == "\\":
                if self._at_command("right"):
                    if stop.at_right:
                        return items
                    raise UnsupportedLatexError(r"\right 에 짝이 되는 \left 가 없다")
                if self._command(items, depth, stop):
                    return items
                continue
            if char == "{":
                self._index += 1
                items.extend(self._sequence(depth + 1, _Stop(at_brace=True)))
                self._expect_brace_close()
                continue
            if char == "&":
                raise UnsupportedLatexError("정렬(&)은 지원하지 않는다")
            if char == "~":
                items.append(_text_item(" "))
                self._index += 1
                continue
            if char in _SPACE_CHARS:
                self._index += 1
                continue
            items.append(_text_item(char))
            self._index += 1
        return items

    def _expect_brace_close(self) -> None:
        """중괄호 그룹의 `}` 를 소비한다. 없으면 그냥 넘어간다(관대하게)."""
        if self._peek() == "}":
            self._index += 1

    # ── 인자 ────────────────────────────────────────────────────────
    def _read_group(self, depth: int) -> str:
        r"""인자 하나를 읽어 OMML 로 돌려준다: `{...}`, `\cmd`, 또는 한 글자."""
        self._skip_spaces()
        char = self._peek()
        if char is None:
            return ""
        if char == "{":
            self._index += 1
            items = self._sequence(depth + 1, _Stop(at_brace=True))
            self._expect_brace_close()
            return _serialize(items)
        if char == "\\":
            single: list[_Item] = []
            self._command(single, depth + 1, _Stop())
            return _serialize(single)
        self._index += 1
        return _serialize([_text_item(char)])

    def _read_bracketed(self, depth: int) -> str:
        r"""`\sqrt[n]` 의 `[n]` 을 읽는다. 대괄호가 없으면 빈 문자열."""
        self._skip_spaces()
        if self._peek() != "[":
            return ""
        close = self._source.find("]", self._index)
        if close == -1:
            return ""
        inner = _Parser(self._source[self._index + 1 : close]).parse()
        self._index = close + 1
        return inner

    # ── 첨자 ────────────────────────────────────────────────────────
    def _read_scripts(self, depth: int) -> tuple[str, str]:
        r"""`^`/`_` 를 한 벌 읽는다(순서 무관).

        Args:
            depth: 현재 중첩 깊이.

        Returns:
            `(아래첨자 OMML, 위첨자 OMML)`. 없는 쪽은 빈 문자열.
        """
        sub = ""
        sup = ""
        for _ in range(2):
            self._skip_spaces()
            char = self._peek()
            if char == "^" and not sup:
                self._index += 1
                sup = self._read_group(depth)
                continue
            if char == "_" and not sub:
                self._index += 1
                sub = self._read_group(depth)
                continue
            break
        return sub, sup

    def _apply_script(self, items: list[_Item], depth: int) -> None:
        """바로 앞 조각에 첨자를 씌운다(`m:sSub` / `m:sSup` / `m:sSubSup`)."""
        sub, sup = self._read_scripts(depth)
        base = items.pop().xml if items else ""
        if sub and sup:
            xml = (
                f"<m:sSubSup><m:e>{base}</m:e>"
                f"{_arg('sub', sub)}{_arg('sup', sup)}</m:sSubSup>"
            )
        elif sup:
            xml = f"<m:sSup><m:e>{base}</m:e>{_arg('sup', sup)}</m:sSup>"
        else:
            xml = f"<m:sSub><m:e>{base}</m:e>{_arg('sub', sub)}</m:sSub>"
        items.append(_Item(xml))

    # ── 명령 ────────────────────────────────────────────────────────
    def _command(self, items: list[_Item], depth: int, stop: _Stop) -> bool:
        r"""`\` 로 시작하는 명령 하나를 처리한다.

        Args:
            items: 결과를 덧붙일 조각 목록.
            depth: 현재 중첩 깊이.
            stop: 큰 연산자가 뒤를 다 먹을 때 물려줄 멈춤 조건.

        Returns:
            True 면 이 명령이 현재 시퀀스의 나머지를 모두 소비했다(큰 연산자).

        Raises:
            UnsupportedLatexError: 지원하지 않는 명령.
        """
        self._index += 1  # `\`
        following = self._peek()
        if following is None:
            return False
        if not _is_letter(following):
            self._non_letter_command(items, following)
            return False

        end = self._index
        while end < len(self._source) and _is_letter(self._source[end]):
            end += 1
        name = self._source[self._index : end]
        self._index = end
        return self._named_command(items, depth, stop, name)

    def _non_letter_command(self, items: list[_Item], following: str) -> None:
        r"""`\{` `\,` `\!` 처럼 알파벳이 아닌 명령을 처리한다.

        Raises:
            UnsupportedLatexError: 줄바꿈(`\\`)은 한 수식 안에서 다룰 수 없다.
        """
        self._index += 1
        if following == "\\":
            raise UnsupportedLatexError(r"줄바꿈(\\)은 지원하지 않는다")
        if following in NON_LETTER_ESCAPE:
            items.append(_text_item(NON_LETTER_ESCAPE[following]))
            return
        if following == "!":
            return  # 음수 공백은 버린다
        if following in (",", ";", ":", " "):
            items.append(_text_item(" "))
            return
        items.append(_text_item(following))

    def _named_command(
        self, items: list[_Item], depth: int, stop: _Stop, name: str
    ) -> bool:
        r"""`\frac` 처럼 이름이 있는 명령을 처리한다.

        Args:
            items: 결과를 덧붙일 조각 목록.
            depth: 현재 중첩 깊이.
            stop: 큰 연산자가 물려받을 멈춤 조건.
            name: 백슬래시를 뗀 명령 이름.

        Returns:
            True 면 현재 시퀀스의 나머지를 모두 소비했다.

        Raises:
            UnsupportedLatexError: 확실히 옮길 수 없는 명령.
        """
        if name in _FRACTIONS:
            numerator = self._read_group(depth)
            denominator = self._read_group(depth)
            items.append(
                _Item(
                    '<m:f><m:fPr><m:type m:val="bar"/></m:fPr>'
                    f"{_arg('num', numerator)}{_arg('den', denominator)}</m:f>"
                )
            )
            return False
        if name == "sqrt":
            items.append(_Item(self._radical(depth)))
            return False
        if name in _NARY:
            items.append(_Item(self._nary(depth, stop, name)))
            return True
        if name in _LIMIT_OPERATORS:
            items.extend(self._limit(depth, name))
            return False
        if name in _ACCENTS:
            items.append(
                _Item(
                    f'<m:acc><m:accPr><m:chr m:val={quoteattr(_ACCENTS[name])}/>'
                    f"</m:accPr>{_arg('e', self._read_group(depth))}</m:acc>"
                )
            )
            return False
        if name in _BARS:
            items.append(
                _Item(
                    f'<m:bar><m:barPr><m:pos m:val="{_BARS[name]}"/></m:barPr>'
                    f"{_arg('e', self._read_group(depth))}</m:bar>"
                )
            )
            return False
        if name in TEXT_ARG:
            literal = self._read_literal()
            if literal:
                items.append(_text_item(literal, "nor"))
            return False
        if name in _PASS_THROUGH:
            items.append(_Item(self._read_group(depth), None))
            return False
        if name == "left":
            items.append(_Item(self._delimited(depth)))
            return False
        if name in ("begin", "end"):
            raise UnsupportedLatexError(f"환경(\\{name})은 지원하지 않는다")
        if name in DROP:
            return False
        symbol = SYMBOLS.get(name)
        if symbol is not None:
            items.append(_text_item(symbol))
            return False
        if name in _FUNCTIONS:
            items.extend(self._upright(name))
            return False
        # 매핑에 없는 명령: 백슬래시만 떼고 곧게 남긴다. `to_plain_text` 의 폴백과
        # 같은 결과이므로 수식 전체를 평문으로 되돌리는 것보다 낫다
        # (`\frac{\triangle ABC}{2}` 의 분수선은 살아남는다).
        items.extend(self._upright(name))
        return False

    def _upright(self, word: str) -> list[_Item]:
        """함수 이름처럼 곧게 세운 낱말 + 뒤 공백."""
        return [_text_item(word, "p"), _text_item(" ")]

    def _read_literal(self) -> str:
        r"""`\text{...}` 의 인자를 변환 없이 그대로 읽는다."""
        self._skip_spaces()
        if self._peek() != "{":
            char = self._peek()
            if char is None:
                return ""
            self._index += 1
            return char
        depth = 0
        start = self._index + 1
        cursor = self._index
        while cursor < len(self._source):
            if self._source[cursor] == "{":
                depth += 1
            elif self._source[cursor] == "}":
                depth -= 1
                if depth == 0:
                    self._index = cursor + 1
                    return self._source[start:cursor]
            cursor += 1
        self._index = len(self._source)
        return self._source[start:]

    def _radical(self, depth: int) -> str:
        r"""`\sqrt{...}` / `\sqrt[n]{...}` 를 `m:rad` 로.

        근호가 피근수 위를 끝까지 덮는 선은 워드가 `m:rad` 를 조판할 때 그린다.
        지수가 없으면 `m:degHide` 로 지수 자리를 감춘다(`m:deg` 자체는 스키마가
        요구하므로 빈 요소로 남긴다).
        """
        degree = self._read_bracketed(depth)
        radicand = self._read_group(depth)
        hide = "0" if degree else "1"
        return (
            f'<m:rad><m:radPr><m:degHide m:val="{hide}"/></m:radPr>'
            f"{_arg('deg', degree)}{_arg('e', radicand)}</m:rad>"
        )

    def _nary(self, depth: int, stop: _Stop, name: str) -> str:
        r"""`\sum` `\int` 등을 `m:nary` 로. 뒤따르는 나머지가 피연산자다.

        워드가 수식을 입력받을 때와 같은 규칙이다. `m:e` 는 연산자 오른쪽에
        놓이므로 어디까지를 피연산자로 보든 화면상 결과는 같다.
        """
        character, limit_location = _NARY[name]
        sub, sup = self._read_scripts(depth)
        body = _serialize(self._sequence(depth + 1, stop))
        properties = (
            f"<m:naryPr><m:chr m:val={quoteattr(character)}/>"
            f'<m:limLoc m:val="{limit_location}"/>'
            f'<m:subHide m:val="{"0" if sub else "1"}"/>'
            f'<m:supHide m:val="{"0" if sup else "1"}"/></m:naryPr>'
        )
        return (
            f"<m:nary>{properties}{_arg('sub', sub)}{_arg('sup', sup)}"
            f"{_arg('e', body)}</m:nary>"
        )

    def _limit(self, depth: int, name: str) -> list[_Item]:
        r"""`\lim_{x \to 0}` 을 `m:limLow` 로(조건이 lim 아래에 붙는다).

        아래첨자가 없으면 그냥 곧게 세운 낱말이다.
        """
        label = _LIMIT_OPERATORS[name]
        self._skip_spaces()
        if self._peek() != "_":
            return self._upright(label)
        self._index += 1
        condition = self._read_group(depth)
        base = _run_xml(label, "p")
        return [
            _Item(
                f"<m:limLow><m:e>{base}</m:e>{_arg('lim', condition)}</m:limLow>"
            )
        ]

    def _delimited(self, depth: int) -> str:
        r"""`\left( ... \right)` 를 `m:d` 로(괄호가 내용 높이에 맞춰 커진다).

        Raises:
            UnsupportedLatexError: 짝이 되는 `\right` 가 없다.
        """
        opening = self._read_delimiter()
        body = _serialize(self._sequence(depth + 1, _Stop(at_right=True)))
        if not self._at_command("right"):
            raise UnsupportedLatexError(r"\left 에 짝이 되는 \right 가 없다")
        self._index += len(r"\right")
        closing = self._read_delimiter()
        return (
            f"<m:d><m:dPr><m:begChr m:val={quoteattr(opening)}/>"
            f'<m:sepChr m:val=""/>'
            f"<m:endChr m:val={quoteattr(closing)}/></m:dPr>"
            f"{_arg('e', body)}</m:d>"
        )

    def _read_delimiter(self) -> str:
        r"""`\left` / `\right` 뒤의 구분자 문자를 읽는다.

        Returns:
            구분자 문자. `.`(구분자 없음)은 빈 문자열.

        Raises:
            UnsupportedLatexError: 확실하지 않은 구분자.
        """
        self._skip_spaces()
        char = self._peek()
        if char is None:
            raise UnsupportedLatexError(r"\left/\right 뒤에 구분자가 없다")
        if char == ".":
            self._index += 1
            return ""
        if char in _DELIMITER_CHARS:
            self._index += 1
            return char
        if char == "\\":
            self._index += 1
            following = self._peek()
            if following is None:
                raise UnsupportedLatexError(r"\left/\right 뒤에 구분자가 없다")
            if not _is_letter(following):
                self._index += 1
                mapped = _DELIMITER_COMMANDS.get(following)
                if mapped is None:
                    raise UnsupportedLatexError(f"지원하지 않는 구분자: \\{following}")
                return mapped
            end = self._index
            while end < len(self._source) and _is_letter(self._source[end]):
                end += 1
            name = self._source[self._index : end]
            self._index = end
            mapped = _DELIMITER_COMMANDS.get(name)
            if mapped is None:
                raise UnsupportedLatexError(f"지원하지 않는 구분자: \\{name}")
            return mapped
        raise UnsupportedLatexError(f"지원하지 않는 구분자: {char}")


def latex_to_omml(latex: str) -> str:
    r"""LaTeX 수식 본문을 `m:oMath` XML 문자열로 바꾼다.

    Args:
        latex: 구분자(`\\( \\)` 등)를 벗긴 LaTeX 수식 본문.

    Returns:
        네임스페이스가 선언된 `<m:oMath>...</m:oMath>` XML 문자열.
        `w:p` 에 그대로 붙일 수 있다.

    Raises:
        UnsupportedLatexError: 비었거나 너무 길거나, 확실히 옮길 수 없는 문법.
    """
    if len(latex) > _MAX_LENGTH:
        raise UnsupportedLatexError("수식이 너무 길다")
    body = latex.strip()
    if not body:
        raise UnsupportedLatexError("빈 수식")
    try:
        inner = _Parser(body).parse()
    except UnsupportedLatexError:
        raise
    except Exception as error:  # 파서 버그가 문서 생성을 막지 않게 한다
        raise UnsupportedLatexError(f"변환기 내부 오류: {error}") from error
    if not inner:
        raise UnsupportedLatexError("변환 결과가 비었다")
    return (
        f'<m:oMath xmlns:m="{MATH_NAMESPACE}" xmlns:w="{WORD_NAMESPACE}">'
        f"{inner}</m:oMath>"
    )


__all__ = [
    "MATH_NAMESPACE",
    "WORD_NAMESPACE",
    "UnsupportedLatexError",
    "latex_to_omml",
]
