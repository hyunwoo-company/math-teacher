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
        prompts.TRANSCRIBE_SYSTEM_PROMPT,
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
    assert "대한민국 중·고등학교 수학 교사입니다" in solve
    # 특정 과목 대신 "문항이 속한 학년·과목의 범위를 넘지 말라"는 원칙이 걸린다.
    assert "학년·과목의 교과 범위" in solve
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


def test_transcribe_reuses_persona_and_latex_rules() -> None:
    """텍스트화도 같은 페르소나·LaTeX 규칙을 쓴다."""
    assert prompts._SKILL_PERSONA_SCOPE in prompts.TRANSCRIBE_SYSTEM_PROMPT
    assert prompts._SKILL_LATEX_RULES in prompts.TRANSCRIBE_SYSTEM_PROMPT


def test_transcribe_never_asks_for_a_solution() -> None:
    """텍스트화 산출물은 풀이가 아니라 원문이다.

    풀이/정답 서술 규약을 넣으면 그 텍스트가 그대로 시험지에 조판되어 나간다.
    """
    transcribe = prompts.TRANSCRIBE_SYSTEM_PROMPT
    assert prompts._SKILL_SOLUTION_STEPS not in transcribe
    assert prompts._SKILL_ANSWER_FORMAT not in transcribe
    assert "문제를 풀지 마십시오" in transcribe


def test_transcribe_output_format_and_conservative_verdict() -> None:
    """`## 판정` → `## 문제` 순서와 '애매하면 불가' 지시가 있다."""
    transcribe = prompts.TRANSCRIBE_SYSTEM_PROMPT
    verdict = f"## {prompts.TRANSCRIBE_VERDICT_TITLE}"
    problem = f"## {prompts.TRANSCRIBE_PROBLEM_TITLE}"
    assert verdict in transcribe
    assert problem in transcribe
    assert transcribe.index(verdict) < transcribe.index(problem)
    assert f"애매하면 `{prompts.TRANSCRIBE_VERDICT_FAIL}` 입니다" in transcribe


def test_transcribe_user_text_forbids_solving() -> None:
    text = prompts.transcribe_user_text(7)
    assert "7번 문항" in text
    assert "풀지 마십시오" in text


def _all_system_prompts() -> tuple[str, ...]:
    return (
        prompts.SOLVE_SYSTEM_PROMPT,
        prompts.VARIANT_SYSTEM_PROMPT,
        prompts.CHAT_SYSTEM_PROMPT,
        prompts.TRANSCRIBE_SYSTEM_PROMPT,
    )


def test_system_prompts_are_subject_neutral() -> None:
    """서비스 범위는 중·고등학교 수학 전반이다. 특정 과목·학년을 박지 않는다."""
    for prompt in _all_system_prompts():
        assert "공통수학1" not in prompt
        assert "고등학교 1학년" not in prompt


def test_system_prompts_are_constants_not_subject_dependent() -> None:
    """system 은 과목에 따라 달라지지 않는 **고정 상수**다(프롬프트 캐시 계약).

    캐시는 접두사 일치라 system 이 시험지마다 달라지면 매 호출이 미스가 난다.
    가변 정보는 `scope_line()` 으로 user 메시지에 실어야 한다.
    """
    before = _all_system_prompts()
    for prompt in before:
        assert isinstance(prompt, str)

    # 과목이 다른 요청을 여러 번 조립해도 system 은 같은 객체 그대로여야 한다.
    for scope in ("중학교 2학년 수학", "고등학교 3학년 미적분", None):
        prompts.solve_user_text(1, mode="text", text="x", scope=scope)
        prompts.variant_user_text(1, mode="text", text="x", kind="number", scope=scope)
        prompts.transcribe_user_text(1, scope)

    for first, second in zip(before, _all_system_prompts(), strict=True):
        assert first is second
    for prompt in _all_system_prompts():
        assert "미적분" not in prompt
        assert "중학교 2학년" not in prompt


def test_scope_line_is_empty_without_scope() -> None:
    assert prompts.scope_line(None) == ""
    assert prompts.scope_line("") == ""
    assert prompts.scope_line("   ") == ""


def test_scope_line_carries_the_given_scope() -> None:
    line = prompts.scope_line("중학교 3학년 수학")
    assert "중학교 3학년 수학" in line
    assert line.endswith("\n\n")


def test_solve_user_text_prepends_scope_only_when_given() -> None:
    """가변 범위는 system 이 아니라 user 텍스트 맨 앞에 붙는다."""
    plain = prompts.solve_user_text(1, mode="text", text="x")
    scoped = prompts.solve_user_text(
        1, mode="text", text="x", scope="중학교 3학년 수학"
    )
    assert plain != scoped
    assert scoped.startswith(prompts.scope_line("중학교 3학년 수학"))
    assert scoped.endswith(plain)
    # system 프롬프트는 그대로여야 한다(캐시 접두사 보호).
    assert "중학교 3학년 수학" not in prompts.SOLVE_SYSTEM_PROMPT


def test_variant_and_transcribe_user_text_take_scope_too() -> None:
    variant = prompts.variant_user_text(
        2, mode="text", text="x", kind="number", scope="고등학교 2학년 수학I"
    )
    assert variant.startswith(prompts.scope_line("고등학교 2학년 수학I"))
    assert prompts.variant_user_text(2, mode="text", text="x", kind="number") == (
        variant.removeprefix(prompts.scope_line("고등학교 2학년 수학I"))
    )

    transcribe = prompts.transcribe_user_text(3, "중학교 1학년 수학")
    assert transcribe.startswith(prompts.scope_line("중학교 1학년 수학"))
    assert prompts.transcribe_user_text(3) == (
        transcribe.removeprefix(prompts.scope_line("중학교 1학년 수학"))
    )


def test_variant_keeps_its_own_output_order_and_instructions() -> None:
    """변형은 고유 출력형식(## 문제 → ## 정답 → ## 풀이)과 지시를 유지한다."""
    variant = prompts.VARIANT_SYSTEM_PROMPT
    assert "## 문제" in variant
    assert variant.index("## 문제") < variant.index("## 정답") < variant.index("## 풀이")
    assert "변형 문제 하나를 출제" in variant
    assert "원본 문제 자체는 다시 적지 마십시오" in variant


def _squeezed(text: str) -> str:
    """줄바꿈으로 끊긴 문장을 한 줄로 이어 붙인다(문구 검사용).

    프롬프트는 가독성 때문에 문장 중간에서 줄을 바꾼다. 그 위치에 검사가 묶이면
    문구를 한 글자 옮길 때마다 테스트가 깨진다.
    """
    return " ".join(text.split())


def test_variant_forbids_pointing_at_a_figure() -> None:
    """변형 산출물에는 그림을 붙일 수 없다.

    AI 가 원본 문장 구조를 그대로 따라 "그림과 같이" 로 시작하는 발문을 만들면
    학생에게 **있지도 않은 그림**을 보라는 문항이 나간다. 원본 크롭을 대신 붙이는
    것도 오답이다 — 변형은 수치·조건이 원본과 다르다.
    """
    variant = _squeezed(prompts.VARIANT_SYSTEM_PROMPT)
    assert "그림과 같이" in variant
    assert "그림을 가리키는 표현을 쓰지 마십시오" in variant
    assert "그림 없이 발문 문장만으로 성립" in variant
    # 그림 정보를 발문에 서술해 그림 없이 풀 수 있게 만들라는 지시.
    assert "발문 문장 안에 빠짐없이 서술**해 그림 없이도 풀 수 있게" in variant
    # 서술이 불가능하면 억지로 변형하지 말라는 탈출구.
    assert "억지로 변형하지 마십시오" in variant


def test_figure_rule_is_variant_only() -> None:
    """도형 규칙은 **변형 전용**이다(공유 스킬 블록에 넣지 않는다).

    풀이·채팅·텍스트화는 원본 이미지를 그대로 보므로 이 규칙이 오히려 해롭다.
    """
    for prompt in (
        prompts.SOLVE_SYSTEM_PROMPT,
        prompts.CHAT_SYSTEM_PROMPT,
        prompts.TRANSCRIBE_SYSTEM_PROMPT,
    ):
        assert "그림을 가리키는 표현을 쓰지 마십시오" not in _squeezed(prompt)
        assert "억지로 변형하지 마십시오" not in _squeezed(prompt)
    for block in (
        prompts._SKILL_PERSONA_SCOPE,
        prompts._SKILL_CURRICULUM_RULE,
        prompts._SKILL_LATEX_RULES,
        prompts._SKILL_SOLUTION_STEPS,
        prompts._SKILL_ANSWER_FORMAT,
    ):
        assert "그림을 가리키는 표현을 쓰지 마십시오" not in _squeezed(block)
