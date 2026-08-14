"""공유 스킬 조립 검증.

풀이(SOLVE)와 변형(VARIANT)이 동일한 공유 스킬 블록(페르소나/범위, LaTeX 규칙,
풀이/정답 형식 규약)을 실제로 포함하는지, 조립 결과가 비지 않는지 확인한다.
"""

from __future__ import annotations

import prompts


def test_all_system_prompts_non_empty() -> None:
    for prompt in (
        prompts.SOLVE_SYSTEM_PROMPT,
        prompts.VARIANT_SYSTEM_PROMPT,
        prompts.CHAT_SYSTEM_PROMPT,
    ):
        assert prompt.strip()


def test_solve_and_variant_share_persona_scope() -> None:
    assert prompts._SKILL_PERSONA_SCOPE in prompts.SOLVE_SYSTEM_PROMPT
    assert prompts._SKILL_PERSONA_SCOPE in prompts.VARIANT_SYSTEM_PROMPT


def test_solve_and_variant_share_latex_rules() -> None:
    assert prompts._SKILL_LATEX_RULES in prompts.SOLVE_SYSTEM_PROMPT
    assert prompts._SKILL_LATEX_RULES in prompts.VARIANT_SYSTEM_PROMPT
    # 채팅도 같은 LaTeX 규칙을 재사용해 일관화한다.
    assert prompts._SKILL_LATEX_RULES in prompts.CHAT_SYSTEM_PROMPT


def test_solve_and_variant_share_solution_format() -> None:
    for block in (prompts._SKILL_SOLUTION_STEPS, prompts._SKILL_ANSWER_FORMAT):
        assert block in prompts.SOLVE_SYSTEM_PROMPT
        assert block in prompts.VARIANT_SYSTEM_PROMPT


def test_solve_core_instructions_preserved() -> None:
    """SOLVE 의 핵심 지시(페르소나·범위·출력형식·LaTeX 규칙)가 유지된다."""
    solve = prompts.SOLVE_SYSTEM_PROMPT
    assert "대한민국 고등학교 수학 교사입니다" in solve
    assert "'공통수학1'" in solve
    for header in (
        "## 문제 확인",
        "## 핵심 개념",
        "## 풀이",
        "## 정답",
        "## 오답 주의",
        "## 더 빠른 방법",
    ):
        assert header in solve
    assert "인라인 수식: `\\( ... \\)`" in solve
    assert "별도 줄 수식: `\\[ ... \\]`" in solve


def test_solve_prompt_forbids_printing_verification() -> None:
    """검산은 시키되 출력은 막는다(요청 4)."""
    assert "검산" in prompts.SOLVE_SYSTEM_PROMPT
    assert "검산 과정은 답변에 쓰지 마십시오" in prompts.SOLVE_SYSTEM_PROMPT
    # 옛 지시("✔ 를 붙이십시오")가 남아 있으면 모델이 혼란스러워한다.
    assert "✔ 를 붙이십시오" not in prompts.SOLVE_SYSTEM_PROMPT


def test_variant_prompt_shares_the_same_rule() -> None:
    """변형도 같은 공유 스킬을 쓰므로 같은 규약이 걸린다."""
    assert "검산 과정은 답변에 쓰지 마십시오" in prompts.VARIANT_SYSTEM_PROMPT


def test_variant_keeps_its_own_output_order_and_instructions() -> None:
    """변형은 고유 출력형식(## 문제 → ## 정답 → ## 풀이)과 지시를 유지한다."""
    variant = prompts.VARIANT_SYSTEM_PROMPT
    assert "## 문제" in variant
    assert variant.index("## 문제") < variant.index("## 정답") < variant.index("## 풀이")
    assert "변형 문제 하나를 출제" in variant
    assert "원본 문제 자체는 다시 적지 마십시오" in variant
