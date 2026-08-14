"""내보낸 문서의 수식이 실제 수학 기호로 조판되는지 검증.

수식은 평문화하지 않고 LaTeX 원문이 렌더러까지 살아서 가야 한다. 1차원 문자열로는
분수의 가로선도 근호가 덮는 선도 만들 수 없기 때문이다. 여기서는 그 배선을 본다.
"""

from __future__ import annotations

from export import build as export_build
from export import model as export_model


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
