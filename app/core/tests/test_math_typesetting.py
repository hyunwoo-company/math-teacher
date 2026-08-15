"""내보낸 문서의 수식이 실제 수학 기호로 조판되는지 검증.

이 PC 에 워드·한글이 없어 실제 렌더를 볼 수 없으므로 **생성된 XML 을 직접**
검증한다.

- `.docx`: `word/document.xml` 에 `m:oMath` 가 들어가고 분수는 `m:f`
  (`m:num`/`m:den`), 근호는 `m:rad`(`m:deg`/`m:e`), 극한은 `m:limLow`,
  큰 연산자는 `m:nary` 구조여야 한다(ECMA-376 Part 1 §22.1.2).
- `.hwpx`: `Contents/section0.xml` 에 `hp:equation` + `hp:script`(EqEdit).
- 변환할 수 없는 문법은 **평문으로 폴백**한다. 무엇이 폴백되는지 여기서 못박는다.
- 수식이 없는 문서는 예전과 똑같아야 한다.
"""

from __future__ import annotations

import io
import re
import xml.etree.ElementTree as ET
import zipfile

import pytest

from export import build as export_build
from export import docx as export_docx
from export import hwpx as export_hwpx
from export import model as export_model
from export.hwpeq import HwpEquationError, _tighten, latex_to_hwp_equation
from export.omml import UnsupportedLatexError, latex_to_omml

MATH_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
WORD_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


# ── 도우미 ───────────────────────────────────────────────────────────


def _local(tag: str) -> str:
    """네임스페이스를 뗀 요소 이름."""
    return tag.rsplit("}", 1)[-1]


def _parse(latex: str) -> ET.Element:
    """LaTeX 를 OMML 로 바꾸고 파싱한다(XML 이 well-formed 인지도 함께 검증)."""
    return ET.fromstring(latex_to_omml(latex))


def _first(element: ET.Element, name: str) -> ET.Element:
    """이름이 `name` 인 첫 자손을 찾는다(없으면 실패)."""
    found = element.find(f".//{MATH_NS}{name}")
    assert found is not None, f"{name} 요소가 없다"
    return found


def _children(element: ET.Element) -> list[str]:
    """자식 요소 이름 목록(순서 검증용). 스키마가 순서를 못박는다."""
    return [_local(child.tag) for child in element]


def _text_of(element: ET.Element) -> str:
    """`m:t` 들을 이어 붙인 글자."""
    return "".join(node.text or "" for node in element.iter(f"{MATH_NS}t"))


def _docx_body(payload: bytes) -> ET.Element:
    """`.docx` 바이트에서 `word/document.xml` 을 파싱한다."""
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return ET.fromstring(archive.read("word/document.xml"))


def _docx_texts(body: ET.Element) -> list[str]:
    """`.docx` 본문의 글자들(수식 밖 `w:t` + 수식 안 `m:t`)."""
    return [
        node.text or ""
        for node in body.iter()
        if node.tag in (f"{WORD_NS}t", f"{MATH_NS}t")
    ]


def _hwpx_section(payload: bytes) -> str:
    """`.hwpx` 바이트에서 `Contents/section0.xml` 을 읽는다."""
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return archive.read("Contents/section0.xml").decode("utf-8")


def _hwpx_scripts(payload: bytes) -> list[str]:
    """`.hwpx` 에 들어간 EqEdit 스크립트들(XML 이스케이프를 되돌린 값)."""
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        root = ET.fromstring(archive.read("Contents/section0.xml"))
    tag = "{http://www.hancom.co.kr/hwpml/2011/paragraph}script"
    return [node.text or "" for node in root.iter(tag)]


def _doc(*blocks: export_model.Block) -> export_model.ExportDoc:
    """블록들로 최소 문서를 만든다."""
    return export_model.ExportDoc(title="수식", blocks=list(blocks))


def _math_block(latex: str, plain: str = "폴백") -> export_model.Text:
    """수식 하나만 든 본문 블록."""
    return export_model.Text(
        plain, [[export_model.MathRun(latex=latex, plain=plain)]]
    )


# ── build: 수식 구간이 렌더러까지 간다 ───────────────────────────────


def test_build_keeps_latex_for_the_renderer() -> None:
    """`build` 는 수식을 평문화하지 않고 LaTeX 원문을 넘긴다."""
    doc = export_build.build_variants_doc(
        title="변형",
        items=[
            export_build.VariantItem(
                no=1, mode="number", text=r"## 문제" "\n" r"값 $\frac{a}{b}$ 를 구하라."
            )
        ],
        include_full=False,
    )
    texts = [block for block in doc.blocks if isinstance(block, export_model.Text)]
    assert len(texts) == 1
    assert texts[0].lines is not None
    runs = [run for line in texts[0].lines for run in line]
    maths = [run for run in runs if isinstance(run, export_model.MathRun)]
    assert [(run.latex, run.plain) for run in maths] == [(r"\frac{a}{b}", "(a)/(b)")]
    # 평문 필드는 예전과 같다(폴백·테스트용).
    assert texts[0].text == "값 (a)/(b) 를 구하라."


def test_build_leaves_math_free_bodies_alone() -> None:
    """수식이 없는 본문은 `lines` 가 None 이다 — 렌더러가 예전 경로를 탄다."""
    doc = export_build.build_variants_doc(
        title="변형",
        items=[
            export_build.VariantItem(no=1, mode="number", text="## 문제\n값을 구하라.")
        ],
        include_full=False,
    )
    texts = [block for block in doc.blocks if isinstance(block, export_model.Text)]
    assert [block.lines for block in texts] == [None]


def test_build_memo_keeps_math() -> None:
    """오답노트 메모의 수식도 살린다(접두어는 텍스트 런으로 붙는다)."""
    doc = export_build.build_note_doc(
        title="노트",
        items=[
            export_build.NoteItem(
                source_name="시험지", problem_no=3, memo=r"$\frac{1}{2}$ 실수"
            )
        ],
        include_full=False,
    )
    memo = next(block for block in doc.blocks if isinstance(block, export_model.Text))
    assert memo.text == "메모: (1)/(2) 실수"
    assert memo.lines is not None
    assert memo.lines[0][0] == export_model.TextRun("메모: ")
    assert isinstance(memo.lines[0][1], export_model.MathRun)


# ── OMML: 분수 ───────────────────────────────────────────────────────


@pytest.mark.parametrize("command", ["frac", "dfrac", "tfrac", "cfrac"])
def test_omml_fraction_has_numerator_over_denominator(command: str) -> None:
    """분수는 `m:f` + `m:num`/`m:den` 이다 — 숫자 위에 선, 그 위에 숫자."""
    fraction = _first(_parse(rf"\{command}{{x+1}}{{2}}"), "f")
    assert _children(fraction) == ["fPr", "num", "den"]
    properties = fraction.find(f"{MATH_NS}fPr/{MATH_NS}type")
    assert properties is not None
    assert properties.get(f"{MATH_NS}val") == "bar"
    assert _text_of(_first(fraction, "num")) == "x+1"
    assert _text_of(_first(fraction, "den")) == "2"


def test_omml_nested_fraction() -> None:
    """분자에 분수가 또 들어가도 구조가 유지된다."""
    outer = _first(_parse(r"\frac{\frac{a}{b}}{c}"), "f")
    inner = _first(_first(outer, "num"), "f")
    assert _text_of(_first(inner, "num")) == "a"
    assert _text_of(_first(inner, "den")) == "b"


# ── OMML: 제곱근 ─────────────────────────────────────────────────────


def test_omml_sqrt_hides_degree_and_covers_radicand() -> None:
    """근호는 `m:rad` 다. 지수가 없으면 `m:degHide="1"` 로 지수 자리를 감춘다.

    피근수 위를 끝까지 덮는 선은 워드가 `m:rad` 를 조판할 때 그린다.
    """
    radical = _first(_parse(r"\sqrt{x^2+1}"), "rad")
    assert _children(radical) == ["radPr", "deg", "e"]
    hide = radical.find(f"{MATH_NS}radPr/{MATH_NS}degHide")
    assert hide is not None
    assert hide.get(f"{MATH_NS}val") == "1"
    # 지수 자리는 스키마가 요구하므로 비어 있어야 한다.
    assert len(_first(radical, "deg")) == 0
    assert _text_of(_first(radical, "e")) == "x2+1"


def test_omml_nth_root_shows_degree() -> None:
    """`\\sqrt[3]{8}` 은 지수를 보여 준다(`m:deg` 채움 + `degHide="0"`)."""
    radical = _first(_parse(r"\sqrt[3]{8}"), "rad")
    hide = radical.find(f"{MATH_NS}radPr/{MATH_NS}degHide")
    assert hide is not None
    assert hide.get(f"{MATH_NS}val") == "0"
    assert _text_of(_first(radical, "deg")) == "3"
    assert _text_of(_first(radical, "e")) == "8"


# ── OMML: 극한과 큰 연산자 ───────────────────────────────────────────


def test_omml_limit_puts_condition_under_lim() -> None:
    """`\\lim_{x \\to 0}` 은 `m:limLow` 다 — lim 아래에 조건이 붙는다."""
    root = _parse(r"\lim_{x \to 0}\frac{\sin x}{x}")
    limit = _first(root, "limLow")
    assert _children(limit) == ["e", "lim"]
    assert _text_of(_first(limit, "e")) == "lim"
    assert _text_of(_first(limit, "lim")) == "x→0"
    # 뒤따르는 분수는 극한 밖에 그대로 남는다.
    assert root.find(f"{MATH_NS}f") is not None


def test_omml_limit_without_condition_is_plain_word() -> None:
    """아래첨자가 없는 `\\lim` 은 곧게 세운 낱말이다."""
    root = _parse(r"\lim x")
    assert root.find(f".//{MATH_NS}limLow") is None
    assert _text_of(root).startswith("lim")


@pytest.mark.parametrize(
    ("command", "character", "location"),
    [
        ("sum", "∑", "undOvr"),
        ("prod", "∏", "undOvr"),
        ("int", "∫", "subSup"),
    ],
)
def test_omml_nary_carries_bounds(
    command: str, character: str, location: str
) -> None:
    """`\\sum_{k=1}^{n}` 은 `m:nary` 로 위·아래 한계를 갖는다."""
    nary = _first(_parse(rf"\{command}_{{k=1}}^{{n}} k"), "nary")
    assert _children(nary) == ["naryPr", "sub", "sup", "e"]
    chr_element = nary.find(f"{MATH_NS}naryPr/{MATH_NS}chr")
    loc_element = nary.find(f"{MATH_NS}naryPr/{MATH_NS}limLoc")
    assert chr_element is not None
    assert loc_element is not None
    assert chr_element.get(f"{MATH_NS}val") == character
    assert loc_element.get(f"{MATH_NS}val") == location
    assert _text_of(_first(nary, "sub")) == "k=1"
    assert _text_of(_first(nary, "sup")) == "n"


def test_omml_nary_hides_missing_bounds() -> None:
    """한계가 없는 큰 연산자는 `subHide`/`supHide` 로 자리를 감춘다."""
    nary = _first(_parse(r"\sum a_k"), "nary")
    for name in ("subHide", "supHide"):
        flag = nary.find(f"{MATH_NS}naryPr/{MATH_NS}{name}")
        assert flag is not None
        assert flag.get(f"{MATH_NS}val") == "1"


# ── OMML: 첨자 ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("latex", "expected"),
    [
        (r"x^{2n}", "sSup"),
        (r"y_{ij}", "sSub"),
        (r"a_1^2", "sSubSup"),
        (r"a^2_1", "sSubSup"),
    ],
)
def test_omml_scripts(latex: str, expected: str) -> None:
    """위/아래첨자는 `m:sSup`/`m:sSub`/`m:sSubSup` 이다."""
    root = _parse(latex)
    assert root.find(f".//{MATH_NS}{expected}") is not None


def test_omml_script_binds_only_the_preceding_character() -> None:
    """`12^2` 의 지수는 `2` 에만 붙는다(LaTeX 규칙)."""
    root = _parse("12^2")
    assert _children(root) == ["r", "sSup"]
    assert _text_of(root[0]) == "1"


# ── OMML: 괄호·선·기호 ───────────────────────────────────────────────


def test_omml_sized_delimiters() -> None:
    """`\\left( ... \\right)` 은 `m:d` 로 내용 높이에 맞춰 커진다."""
    delimiter = _first(_parse(r"\left( \frac{a}{b} \right)"), "d")
    assert _children(delimiter) == ["dPr", "e"]
    beginning = delimiter.find(f"{MATH_NS}dPr/{MATH_NS}begChr")
    ending = delimiter.find(f"{MATH_NS}dPr/{MATH_NS}endChr")
    assert beginning is not None
    assert ending is not None
    assert beginning.get(f"{MATH_NS}val") == "("
    assert ending.get(f"{MATH_NS}val") == ")"
    assert delimiter.find(f".//{MATH_NS}f") is not None


def test_omml_set_builder_separator() -> None:
    """`\\middle|` 은 `m:sepChr` 로 낸다 — 조건제시법 집합의 세로 막대.

    회귀 방지: 예전에는 `\\middle` 이 매핑에 없어 낱말 "middle" 이 그대로
    찍혔다(`A_k = x middle | ...`).
    """
    latex = (
        r"A_k=\left\{ x \middle| \log x-[\log x]=\frac{1}{k},"
        r"\ 1 \le x \le 10^5 \right\}"
    )
    xml = latex_to_omml(latex)
    assert "middle" not in xml
    assert '<m:sepChr m:val="|"/>' in xml
    delimiter = _first(ET.fromstring(xml), "d")
    assert _children(delimiter) == ["dPr", "e", "e"]
    beginning = delimiter.find(f"{MATH_NS}dPr/{MATH_NS}begChr")
    ending = delimiter.find(f"{MATH_NS}dPr/{MATH_NS}endChr")
    assert beginning is not None
    assert ending is not None
    assert beginning.get(f"{MATH_NS}val") == "{"
    assert ending.get(f"{MATH_NS}val") == "}"
    assert _text_of(delimiter[1]) == "x"


def test_omml_delimiters_without_middle_keep_one_part() -> None:
    """`\\middle` 이 없으면 예전 그대로 `m:e` 하나 + 빈 `m:sepChr` 다."""
    xml = latex_to_omml(r"\left( a+b \right)")
    assert '<m:sepChr m:val=""/>' in xml
    delimiter = _first(ET.fromstring(xml), "d")
    assert _children(delimiter) == ["dPr", "e"]


def test_omml_unpaired_middle_keeps_the_separator() -> None:
    """짝 없는 `\\middle` 은 거절하지 않고 구분자만 남긴다.

    거절하면 수식 전체가 평문으로 되돌아가 지금보다 나빠진다.
    """
    root = _parse(r"a \middle| b")
    assert "middle" not in latex_to_omml(r"a \middle| b")
    assert _text_of(root) == "a|b"


def test_omml_overline_is_a_bar() -> None:
    """`\\overline{AB}` 은 `m:bar`(위 선)다."""
    bar = _first(_parse(r"\overline{AB}"), "bar")
    position = bar.find(f"{MATH_NS}barPr/{MATH_NS}pos")
    assert position is not None
    assert position.get(f"{MATH_NS}val") == "top"


def test_omml_accent() -> None:
    """`\\vec{v}` 는 `m:acc` + 결합 화살표(U+20D7)다."""
    accent = _first(_parse(r"\vec{v}"), "acc")
    character = accent.find(f"{MATH_NS}accPr/{MATH_NS}chr")
    assert character is not None
    assert character.get(f"{MATH_NS}val") == "⃗"


def test_omml_reuses_the_plain_text_symbol_table() -> None:
    """기호는 `to_plain_text.SYMBOLS` 를 그대로 쓴다(표를 두 벌 두지 않는다)."""
    text = _text_of(
        _parse(r"\alpha+\beta \le \gamma \ne \delta \to \Rightarrow \in \angle")
    )
    for symbol in "αβ≤γ≠δ→⇒∈∠":
        assert symbol in text


def test_omml_text_command_is_literal() -> None:
    """`\\text{...}` 는 수식이 아닌 리터럴이라 `m:nor` 로 곧게 넣는다."""
    root = _parse(r"\text{정답}")
    assert root.find(f".//{MATH_NS}nor") is not None
    assert _text_of(root) == "정답"


def test_omml_escapes_xml_special_characters() -> None:
    """`<` `&` 가 들어와도 XML 이 깨지지 않는다."""
    assert _text_of(_parse("a<b")) == "a<b"


# ── OMML: 폴백 ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "latex",
    [
        # 행렬/조건 환경 — `m:m`/`m:eqArr` 매핑을 확실히 검증하지 못해 거절한다.
        r"\begin{cases} x+1 & x>0 \\ 0 & x \le 0 \end{cases}",
        r"\begin{pmatrix} a & b \\ c & d \end{pmatrix}",
        # 정렬(&)과 줄바꿈(\\)은 한 수식 안에서 다룰 수 없다.
        r"a & b",
        r"a \\ b",
        # 짝이 맞지 않는 크기 조절 괄호.
        r"\left( \frac{a}{b}",
        r"x \right)",
        # 확실하지 않은 구분자.
        r"\left\uparrow x \right\uparrow",
        # 빈 수식.
        "",
        "   ",
    ],
)
def test_omml_refuses_what_it_cannot_map(latex: str) -> None:
    """확실하지 않은 문법은 근사하지 않고 거절한다(호출부가 평문으로 폴백)."""
    with pytest.raises(UnsupportedLatexError):
        latex_to_omml(latex)


def test_omml_unknown_command_stays_readable() -> None:
    """매핑에 없는 명령은 낱말로 남긴다 — 분수선은 살린다.

    `to_plain_text` 의 폴백(백슬래시만 뗀다)과 같은 결과다. 수식 전체를 평문으로
    되돌리면 `\\frac` 의 가로선까지 잃으므로 이쪽이 낫다.
    """
    root = _parse(r"\frac{\triangle ABC}{2}")
    assert root.find(f".//{MATH_NS}f") is not None
    assert "triangle ABC" in _text_of(root)


def test_omml_rejects_overlong_input() -> None:
    """길이 상한을 넘으면 거절한다(깨진 원고 방어)."""
    with pytest.raises(UnsupportedLatexError):
        latex_to_omml("x" * 20_000)


# ── docx 렌더러 통합 ─────────────────────────────────────────────────


def test_docx_embeds_omml_for_math_runs() -> None:
    """`.docx` 의 `word/document.xml` 에 `m:oMath` 가 들어간다."""
    payload = export_docx.build_docx(_doc(_math_block(r"\frac{x+1}{2}")))
    body = _docx_body(payload)
    maths = list(body.iter(f"{MATH_NS}oMath"))
    assert len(maths) == 1
    assert maths[0].find(f"{MATH_NS}f") is not None
    # 폴백 평문은 들어가지 않았다.
    assert "폴백" not in _docx_texts(body)


def test_docx_math_sits_in_the_same_paragraph_as_its_text() -> None:
    """수식 앞뒤 글자는 같은 문단에 남는다(줄이 쪼개지지 않는다)."""
    block = export_model.Text(
        "앞 (a)/(b) 뒤",
        [
            [
                export_model.TextRun("앞 "),
                export_model.MathRun(latex=r"\frac{a}{b}", plain="(a)/(b)"),
                export_model.TextRun(" 뒤"),
            ]
        ],
    )
    body = _docx_body(export_docx.build_docx(_doc(block)))
    paragraphs = [
        paragraph
        for paragraph in body.iter(
            "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p"
        )
        if paragraph.find(f"{MATH_NS}oMath") is not None
    ]
    assert len(paragraphs) == 1
    assert _children(paragraphs[0]) == ["r", "oMath", "r"]


@pytest.mark.parametrize(
    ("latex", "structure"),
    [
        (r"\frac{a}{b}", "f"),
        (r"\sqrt{x}", "rad"),
        (r"\lim_{n \to \infty} a_n", "limLow"),
        (r"\sum_{k=1}^{n} k", "nary"),
        (r"\left( x \right)", "d"),
    ],
)
def test_docx_carries_each_required_structure(latex: str, structure: str) -> None:
    """반드시 지원할 문법이 모두 실제 문서까지 살아서 간다."""
    body = _docx_body(export_docx.build_docx(_doc(_math_block(latex))))
    assert body.find(f".//{MATH_NS}{structure}") is not None


def test_docx_falls_back_to_plain_text_for_unsupported_math() -> None:
    """변환 실패 시 문서가 깨지는 대신 기존 평문이 들어간다."""
    latex = r"\begin{cases} 1 & x>0 \\ 0 & x \le 0 \end{cases}"
    payload = export_docx.build_docx(_doc(_math_block(latex, plain="1 (x>0)")))
    body = _docx_body(payload)
    assert body.find(f".//{MATH_NS}oMath") is None
    assert "1 (x>0)" in _docx_texts(body)


def test_docx_logs_the_fallback(caplog: pytest.LogCaptureFixture) -> None:
    """폴백했다는 사실을 로그로 남긴다."""
    with caplog.at_level("INFO", logger="export.docx"):
        export_docx.build_docx(_doc(_math_block(r"a & b")))
    assert any("폴백" in record.getMessage() for record in caplog.records)


def test_docx_without_math_is_unchanged() -> None:
    """수식이 없는 블록은 예전 경로 그대로다(문단 = 줄)."""
    plain = export_docx.build_docx(_doc(export_model.Text("가\n나\n다")))
    body = _docx_body(plain)
    assert body.find(f".//{MATH_NS}oMath") is None
    texts = [
        node.text
        for node in body.iter(
            "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"
        )
    ]
    assert texts == ["수식", "가", "나", "다"]


# ── 한글 수식(EqEdit) ────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("latex", "expected"),
    [
        # 분수: `over` 가 위/아래로 나눈다.
        (r"\frac{x+1}{2}", "{x+1} over {2}"),
        (r"\dfrac{x+1}{2}", "{x+1} over {2}"),
        # `\cfrac` 은 변환기가 모르는 이름이라 `\frac` 으로 정규화해 넘긴다.
        (r"\cfrac{1}{2}", "{1} over {2}"),
        # 제곱근: 근호가 피근수를 덮는다.
        (r"\sqrt{x^2+1}", "sqrt {x^{2}+1}"),
        (r"\sqrt[3]{8}", "root {3} of {8}"),
        # 극한.
        (r"\lim_{x \to 0}", "lim _{x->0}"),
        # 큰 연산자의 위아래 한계.
        (r"\sum_{k=1}^{n} k^2", "sum _{k=1} ^{n} k^{2}"),
        (r"\prod_{i=1}^{n} a_i", "prod _{i=1} ^{n} a _{i}"),
        # 크기 조절 괄호.
        (r"\left( \frac{a}{b} \right)", "LEFT ( {a} over {b} RIGHT )"),
        # 기호.
        (r"\alpha \le \beta \ne \gamma \to \angle", "alpha leq beta neq gamma -> angle"),
        # 선 덮개·악센트.
        (r"\overline{AB}", "overline {AB}"),
        (r"\vec{v}", "vec {v}"),
        # 도(°) 는 `circ` 위첨자로 나간다.
        (r"90^\circ", "90 ^{circ}"),
        # 간격 명령은 공백으로 눌러 통과시킨다(변환기가 거절하던 문법).
        (r"\int_0^1 x\,dx", "int _{0}^{1}x dx"),
        # 서체 명령은 벗기고 내용만 통과시킨다.
        (r"\mathbb{R}", "{R}"),
        # 근의 공식(사용자가 지목한 조합).
        (
            r"\frac{-b \pm \sqrt{b^2-4ac}}{2a}",
            "{-b+- sqrt {b^{2}-4 ac}} over {2a}",
        ),
    ],
)
def test_hwp_equation_script(latex: str, expected: str) -> None:
    """한글 수식 스크립트는 변환기 결과에서 군더더기 공백만 지운 것이다."""
    assert latex_to_hwp_equation(latex) == expected


@pytest.mark.parametrize(
    ("script", "expected"),
    [
        # 위첨자·연산자·괄호는 모두 붙는다.
        ("x ^{2} + y ^{2} = a ^{2} + 16", "x^{2}+y^{2}=a^{2}+16"),
        ("( 4 , a )", "(4,a)"),
        ("y = 2 x + 3", "y=2x+3"),
        # `over` 는 낱말 키워드라 양옆 공백이 구분자다. 지우면 깨진다.
        ("{a ^{2} + 16} over {4} = 5", "{a^{2}+16} over {4}=5"),
        ("sqrt {3}", "sqrt {3}"),
        ("A cap B", "A cap B"),
        ("2 sqrt {3}", "2 sqrt {3}"),
        # `lim` 뒤 공백은 남고, `f ( x )` 는 붙는다.
        ("lim _{x} f ( x )", "lim _{x} f(x)"),
    ],
)
def test_tighten_removes_only_render_gaps(script: str, expected: str) -> None:
    """한글이 간격으로 그리는 군더더기 공백만 지운다."""
    assert _tighten(script) == expected


@pytest.mark.parametrize(
    "word",
    ["over", "sqrt", "cap", "cup", "times", "div", "sum", "lim", "int", "rm"],
)
def test_tighten_keeps_keyword_separators(word: str) -> None:
    """낱말 키워드의 앞뒤 공백은 절대 지우지 않는다(붙이면 파싱이 깨진다)."""
    assert _tighten(f"a {word} b") == f"a {word} b"
    assert _tighten(f"{{1}} {word} {{2}}") == f"{{1}} {word} {{2}}"


def test_tighten_collapses_and_strips_whitespace() -> None:
    """연속 공백은 하나로, 양끝은 없앤다."""
    assert _tighten("  x   +    1  ") == "x+1"
    assert _tighten("  a   over   b  ") == "a over b"


def test_hwp_equation_tightens_the_converter_output() -> None:
    """실제 변환 경로 끝에서 공백 정리가 적용된다."""
    script = latex_to_hwp_equation(r"\frac{a^{2}+16}{4}=5")
    assert " over " in script
    assert "a^{2}" in script
    assert script == "{a^{2}+16} over {4}=5"


@pytest.mark.parametrize(
    "latex",
    [
        # python-hwpx 가 실한컴 렌더로 검증하지 못한 문법들.
        r"\triangle ABC",
        r"\therefore x = 1",
        r"\widehat{AB}",
        r"\begin{Bmatrix} a & b \\ c & d \end{Bmatrix}",
        r"\left( x",
        "",
        "   ",
    ],
)
def test_hwp_equation_refuses_unverified_syntax(latex: str) -> None:
    """검증된 토큰 집합 밖은 거절한다(호출부가 평문으로 폴백)."""
    with pytest.raises(HwpEquationError):
        latex_to_hwp_equation(latex)


# ── hwpx 렌더러 통합 ─────────────────────────────────────────────────


def test_hwpx_embeds_equation_objects() -> None:
    """`.hwpx` 의 `Contents/section0.xml` 에 `hp:equation` + EqEdit 스크립트."""
    payload = export_hwpx.build_hwpx(_doc(_math_block(r"\frac{x+1}{2}")))
    assert "<hp:equation" in _hwpx_section(payload)
    assert _hwpx_scripts(payload) == ["{x+1} over {2}"]
    assert "폴백" not in _hwpx_section(payload)


@pytest.mark.parametrize(
    ("latex", "script"),
    [
        (r"\frac{a}{b}", "{a} over {b}"),
        (r"\sqrt{x}", "sqrt {x}"),
        (r"\sqrt[3]{8}", "root {3} of {8}"),
        (r"\lim_{n \to \infty} a_n", "lim _{n-> infty} a _{n}"),
        (r"\sum_{k=1}^{n} k", "sum _{k=1} ^{n} k"),
        (r"\left( x \right)", "LEFT (x RIGHT )"),
    ],
)
def test_hwpx_carries_each_required_structure(latex: str, script: str) -> None:
    """반드시 지원할 문법이 모두 실제 문서까지 살아서 간다."""
    payload = export_hwpx.build_hwpx(_doc(_math_block(latex)))
    assert _hwpx_scripts(payload) == [script]


def test_hwpx_math_sits_in_the_same_paragraph_as_its_text() -> None:
    """수식 앞뒤 글자는 같은 문단에 남는다."""
    block = export_model.Text(
        "앞 (a)/(b) 뒤",
        [
            [
                export_model.TextRun("앞 "),
                export_model.MathRun(latex=r"\frac{a}{b}", plain="(a)/(b)"),
                export_model.TextRun(" 뒤"),
            ]
        ],
    )
    section = _hwpx_section(export_hwpx.build_hwpx(_doc(block)))
    paragraph = re.findall(r"<hp:p [^>]*>.*?</hp:p>", section, re.DOTALL)[-1]
    assert "앞 " in paragraph
    assert " 뒤" in paragraph
    assert "<hp:equation" in paragraph


def test_hwpx_falls_back_to_plain_text_for_unsupported_math() -> None:
    """변환 실패 시 기존 평문 유니코드가 들어간다."""
    section = _hwpx_section(
        export_hwpx.build_hwpx(_doc(_math_block(r"\triangle ABC", plain="triangle ABC")))
    )
    assert "<hp:equation" not in section
    assert "triangle ABC" in section


def test_hwpx_logs_the_fallback(caplog: pytest.LogCaptureFixture) -> None:
    """폴백했다는 사실을 로그로 남긴다."""
    with caplog.at_level("INFO", logger="export.hwpx"):
        export_hwpx.build_hwpx(_doc(_math_block(r"\triangle ABC")))
    assert any("폴백" in record.getMessage() for record in caplog.records)


def test_hwpx_without_math_is_unchanged() -> None:
    """수식이 없는 블록은 예전 경로 그대로다."""
    section = _hwpx_section(
        export_hwpx.build_hwpx(_doc(export_model.Text("가\n나\n다")))
    )
    assert "<hp:equation" not in section
    for line in ("가", "나", "다"):
        assert f"<hp:t>{line}</hp:t>" in section


