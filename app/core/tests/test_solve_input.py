"""풀이 입력 선택 순수 함수 (`solve_input`).

이 파일이 지키는 것은 하나다 — **문항을 무엇으로 풀지는 파일 `mode` 가 아니라 그
문항의 텍스트가 실제로 쓸 만한지로 정한다.** `omega 5회.pdf` 가 그 반례였다:
수식·발문이 그래픽인데 PUA 가 없어 `mode` 는 `text` 로 판정됐고, 텍스트 레이어에
남은 것은 번호뿐이라 `problems.text` 가 `"1."` 이었다. 판독본은 온전했는데
`mode == "image"` 게이트가 그것을 막아 `"1."` 만 AI 로 갔다.
"""

from __future__ import annotations

import pytest

import service
import solve_input
import storage

# 정상 판독본(그림 참조 없음).
TRANSCRIPT = r"\(4^{\sqrt{3}+1} \times (\frac{1}{2})^{2\sqrt{2}-1}\) 의 값은?"
# omega 의 `problems.text`. 앞머리 번호를 떼면 남는 것이 없다.
OMEGA_TEXT = "1."
# 텍스트 레이어가 정상인 파일의 `problems.text`.
GOOD_TEXT = r"1. \(x^{2}+1\) 의 값을 구하시오. [3점]"
# 그림을 가리키는 판독본. 글자만 보내면 조건이 빠진다.
FIGURE_TRANSCRIPT = "다음 그림과 같이 놓인 삼각형의 넓이를 구하시오."

# PUA(U+E000~U+F8FF). 한글 수식 PDF 의 글리프가 이 구간으로 들어온다.
PUA = "".join(chr(code) for code in (0xE000, 0xE001, 0xE002, 0xE003))
# 제어/포맷 문자(ZERO WIDTH SPACE, category Cf).
ZWSP = chr(0x200B)


# ------------------------------------------------------------- 판정 순서
def test_text_mode_with_number_only_text_uses_transcript() -> None:
    """**omega 회귀 테스트.**

    `mode` 가 `text` 여도 `problems.text` 가 번호뿐이면 판독본으로 푼다. 예전에는
    `mode == "image"` 게이트 때문에 `"1."` 이 그대로 AI 로 갔다.
    """
    chosen = solve_input.pick_solve_input(
        mode="text",
        text=OMEGA_TEXT,
        transcript=TRANSCRIPT,
        transcript_source=storage.TRANSCRIPT_AI,
        has_crop=True,
    )
    assert chosen.mode == "text"
    assert chosen.text == TRANSCRIPT
    assert chosen.reason  # 왜 그렇게 골랐는지 로그로 남길 한 줄이 있다


def test_text_mode_prefers_original_text_over_transcript() -> None:
    """텍스트 레이어가 정상인 파일은 **원문**을 쓴다 (기존 동작 불변).

    AI 판독본은 복원이고 원문은 원본이다. 여기서 판독본으로 갈아치우면 지금 잘
    도는 시험지들이 회귀한다.
    """
    chosen = solve_input.pick_solve_input(
        mode="text",
        text=GOOD_TEXT,
        transcript=TRANSCRIPT,
        transcript_source=storage.TRANSCRIPT_AI,
        has_crop=True,
    )
    assert chosen.mode == "text"
    assert chosen.text == GOOD_TEXT


def test_manual_transcript_beats_original_text() -> None:
    """사용자가 직접 고친 판독본은 원문이 정상이어도 최우선이다."""
    chosen = solve_input.pick_solve_input(
        mode="text",
        text=GOOD_TEXT,
        transcript=TRANSCRIPT,
        transcript_source=storage.TRANSCRIPT_MANUAL,
        has_crop=True,
    )
    assert chosen.mode == "text"
    assert chosen.text == TRANSCRIPT


def test_manual_transcript_is_ignored_when_unusable() -> None:
    """`manual` 이라도 내용이 없으면 우선권이 없다 (빈 판독본으로 풀지 않는다)."""
    chosen = solve_input.pick_solve_input(
        mode="text",
        text=GOOD_TEXT,
        transcript="1.",
        transcript_source=storage.TRANSCRIPT_MANUAL,
        has_crop=True,
    )
    assert chosen.mode == "text"
    assert chosen.text == GOOD_TEXT


def test_figure_transcript_goes_to_image() -> None:
    """판독본이 그림을 가리키면 크롭 이미지로 푼다 (글자만 보내면 조건이 빠진다)."""
    chosen = solve_input.pick_solve_input(
        mode="text",
        text=OMEGA_TEXT,
        transcript=FIGURE_TRANSCRIPT,
        transcript_source=storage.TRANSCRIPT_AI,
        has_crop=True,
    )
    assert chosen.mode == "image"
    assert chosen.text == ""


def test_figure_transcript_without_crop_falls_back_to_text() -> None:
    """그림을 가리켜도 크롭이 없으면 텍스트라도 보낸다.

    아무것도 보내지 않는 것보다는 조건이 빠진 텍스트가 낫다(사용자가 화면에서
    판독본을 보고 판단할 수 있다).
    """
    chosen = solve_input.pick_solve_input(
        mode="image",
        text=None,
        transcript=FIGURE_TRANSCRIPT,
        transcript_source=storage.TRANSCRIPT_AI,
        has_crop=False,
    )
    assert chosen.mode == "text"
    assert chosen.text == FIGURE_TRANSCRIPT


def test_image_mode_uses_transcript_when_available() -> None:
    """image 모드 + 판독본 → 판독본으로 푼다 (직전 커밋의 동작 유지)."""
    chosen = solve_input.pick_solve_input(
        mode="image",
        text="",
        transcript=TRANSCRIPT,
        transcript_source=storage.TRANSCRIPT_PUA,
        has_crop=True,
    )
    assert chosen.mode == "text"
    assert chosen.text == TRANSCRIPT


def test_image_mode_never_uses_problem_text() -> None:
    """image 모드의 `problems.text` 는 후보에서 아예 뺀다 (PUA 가 깨진 문자열).

    글자 수만 보면 "쓸 만하다" 로 판정될 수 있으므로, 3번 갈래가 `mode == "text"`
    조건에 묶여 있는지 못박는다.
    """
    chosen = solve_input.pick_solve_input(
        mode="image",
        text=GOOD_TEXT,  # 내용이 있어도 image 모드면 쓰지 않는다
        transcript=None,
        transcript_source=None,
        has_crop=True,
    )
    assert chosen.mode == "image"
    assert chosen.text == ""


def test_image_mode_without_transcript_uses_crop() -> None:
    """image 모드 + 판독본 없음 → 크롭 이미지."""
    chosen = solve_input.pick_solve_input(
        mode="image",
        text=None,
        transcript=None,
        transcript_source=None,
        has_crop=True,
    )
    assert chosen.mode == "image"


def test_nothing_to_send() -> None:
    """번호뿐인 텍스트 + 판독본 없음 + 크롭 없음 → 보낼 것이 없다.

    예전에는 이 상태에서 `"1."` 을 그대로 AI 에 보내 "그럴듯한 엉터리" 풀이를
    저장했다. 호출부가 명확히 실패시킬 수 있도록 `mode=None` 을 돌려준다.
    """
    chosen = solve_input.pick_solve_input(
        mode="text",
        text=OMEGA_TEXT,
        transcript=None,
        transcript_source=None,
        has_crop=False,
    )
    assert chosen.mode is None
    assert chosen.text == ""
    assert chosen.reason


# ------------------------------------------- "쓸 만한 텍스트인가" 경계
@pytest.mark.parametrize(
    ("text", "usable"),
    [
        (None, False),
        ("", False),
        ("1.", False),  # 번호만 (omega)
        ("12)", False),  # 번호만 (다른 구분자)
        ("3]", False),
        ("  7.  \n\t ", False),  # 번호 + 공백
        ("1. abcd", False),  # 번호를 떼면 4자
        ("1. abcde", True),  # 번호를 떼면 5자
        ("abcd", False),  # 4자
        ("abcde", True),  # 5자
        ("a b c d\n", False),  # 공백은 세지 않는다 → 4자
        ("a b c d e", True),  # 5자
        (PUA, False),  # PUA 만
        ("1. " + PUA[:2] + "ab", False),  # PUA 를 빼면 2자
        ("ab" + ZWSP + "cd", False),  # 제어/포맷 문자를 빼면 4자
        ("ab" + ZWSP + "cde", True),  # 5자
        ("①1②2③4④8⑤16", True),  # 선택지만 세도 넉넉히 넘는다
    ],
)
def test_is_usable_problem_text_boundaries(text: str | None, usable: bool) -> None:
    """임계(5자)의 양쪽 경계를 못박는다.

    이 값을 올리면 정상 문항을 이미지로 돌려버릴 위험이 커진다 — 오탐(정상 문항을
    못 쓴다고 판정)을 0 으로 두려고 낮게 잡은 값이다.
    """
    assert solve_input.is_usable_problem_text(text) is usable


def test_min_body_chars_is_five() -> None:
    """임계 값이 조용히 바뀌지 않게 못박는다 (바꾸려면 이 테스트를 먼저 본다)."""
    assert solve_input.MIN_BODY_CHARS == 5


def test_strip_leading_no_removes_only_the_head() -> None:
    """앞머리 번호는 **한 번만** 뗀다. 본문 속 번호는 건드리지 않는다.

    `export/build.py` 와 달리 여기서는 그 문항 번호와 일치하는지 따지지 않는다 —
    풀이 입력에서는 앞머리 번호가 무엇이든 본문이 아니다.
    """
    assert solve_input.strip_leading_no("5. 3. 남는다") == "3. 남는다"
    assert solve_input.strip_leading_no("31) 본문") == "본문"
    assert solve_input.strip_leading_no("본문 1.") == "본문 1."


# --------------------------------- `service._clean_problem_text` 와의 일치
@pytest.mark.parametrize(
    "text",
    [
        "1.",
        "  7.  \n\t ",
        PUA,
        ZWSP + "\n",
        "12. " + PUA + "\n\t",
    ],
)
def test_agrees_with_service_clean_problem_text_on_empty(text: str) -> None:
    """오답노트 표시용 정리가 "남는 것 없음" 으로 보는 문자열은 여기서도 못 쓴다.

    두 곳이 PUA(U+E000~U+F8FF)·제어문자·앞머리 번호(`N.`)를 같은 규칙으로 본다는
    것을 못박는다. 규칙을 한쪽만 고치면 이 테스트가 깨진다.

    **의도된 차이 하나**: 여기서는 `N)` / `N]` 도 앞머리 번호로 떼고 자릿수 제한이
    없다(`export/build.py` 규칙). `service._clean_problem_text` 는 `N.`(1~2자리)만
    뗀다 — 그쪽은 표시용이라 더 보수적이다. 그래서 겹치는 형태만 비교한다.
    """
    assert service._clean_problem_text(text) is None
    assert solve_input.body_chars(text) == ""
    assert solve_input.is_usable_problem_text(text) is False


def test_pua_range_matches_service() -> None:
    """PUA 구간 상수가 `service` 쪽과 어긋나지 않는다."""
    assert solve_input._PUA_START == service._PUA_START
    assert solve_input._PUA_END == service._PUA_END


# --------------------------------------------------------------- 폴백 방향
def test_fallback_from_text_goes_to_image() -> None:
    """텍스트로 실패하면 크롭 이미지로 (파일 `mode` 와 무관)."""
    retry = solve_input.fallback_input("text", transcript=TRANSCRIPT, has_crop=True)
    assert retry.mode == "image"


def test_fallback_from_text_without_crop_has_nowhere_to_go() -> None:
    """크롭이 없으면 재시도하지 않는다 (쿼터 낭비 방지)."""
    retry = solve_input.fallback_input("text", transcript=TRANSCRIPT, has_crop=False)
    assert retry.mode is None


def test_fallback_from_image_uses_saved_transcript() -> None:
    """이미지로 실패하면 **이미 저장된** 판독본으로 (추가 판독 비용 0)."""
    retry = solve_input.fallback_input("image", transcript=TRANSCRIPT, has_crop=True)
    assert retry.mode == "text"
    assert retry.text == TRANSCRIPT


def test_fallback_from_image_without_transcript_has_nowhere_to_go() -> None:
    """쓸 만한 판독본이 없으면 재시도하지 않는다."""
    assert (
        solve_input.fallback_input("image", transcript=None, has_crop=True).mode is None
    )
    assert (
        solve_input.fallback_input("image", transcript="1.", has_crop=True).mode is None
    )
