"""문항 하나를 무엇으로 풀지 고른다 (순수 함수).

풀이 입력은 셋 중 하나다 — 사용자가 고친 판독본, PDF 텍스트 레이어에서 뽑은
원문(`problems.text`), AI/디코더가 만든 판독본(`problems.transcript`), 그리고
아무 텍스트도 못 쓸 때의 크롭 이미지.

**파일의 `mode` 로 게이트를 걸면 안 된다.** `omega 5회.pdf` 가 그 반례다 —
수식과 발문이 그래픽으로 들어 있고 텍스트 레이어에는 문항 번호만 있는 PDF 인데,
PUA 문자가 없어 `extractor` 가 `text` 모드로 판정했다. 앵커(번호)는 텍스트라
문항 분할은 성공했고, 그래서 `problems.text` 가 `"1."` 한 줄뿐인 문항이 30개
만들어졌다. 판독본은 30문항 중 25개가 온전한데 `mode == "image"` 게이트가 그것을
막아, AI 에게 `"1."` 만 보내고 "그럴듯한 엉터리" 풀이를 저장했다.

그래서 판정을 **모드가 아니라 그 문항의 텍스트가 실제로 쓸 만한지**로 바꾼다
(`is_usable_problem_text`). 모드 판정 자체(`extractor.py`)는 건드리지 않는다 —
그건 파일 전체에 영향이 가는 별도 문제다.

`ai_service.solve_events` 한 곳에서 쓰지만 순수 함수로 떼어 두는 이유는 이 레포
관례대로 단위 테스트로 굳히기 위해서다(`tests/test_solve_input.py`).
"""

from __future__ import annotations

import re
import unicodedata
from typing import Final, NamedTuple

import figure_ref

# `transcript_source` 상수 하나를 위해서다. 문자열 리터럴을 복사하면 저장소 쪽
# 값이 바뀔 때 조용히 어긋나므로 상수를 그대로 참조한다(임포트 시 부수효과 없음).
import storage
from providers.base import Mode

#: 문항 본문으로 인정하는 최소 글자 수(공백·제어문자·PUA·앞머리 번호 제외).
#:
#: omega 사례의 `"1."` 은 앞머리 번호를 떼면 **0자**다. 반대로 가장 짧은 정상
#: 문항도 선택지만 세어도 `①1②2③4④8⑤16` = 12자로 이 값을 훌쩍 넘는다. 양쪽에서
#: 충분히 떨어진 값으로 5를 골랐다.
#:
#: **이 값을 올리면 정상 문항을 이미지로 돌려버릴 위험이 커진다.** 낮게 잡아
#: 오탐(정상 문항을 못 쓴다고 판정)을 0 으로 두는 쪽을 택했다.
MIN_BODY_CHARS: Final[int] = 5

# 앞머리 문항 번호(`1.` / `1)` / `1]`). `export/build.py` 의 같은 이름 정규식과
# 같은 모양이지만, **여기서는 번호가 그 문항 번호와 일치하는지 따지지 않는다** —
# 풀이 입력에서는 앞머리 번호가 무엇이든 본문이 아니다.
_LEADING_NO_RE: Final[re.Pattern[str]] = re.compile(r"^[ \t]*\d+[ \t]*[).\]][ \t]*")

# PUA(사용자 정의 영역). 한글 수식 PDF 의 글리프가 이 구간으로 들어와 그대로
# 두면 tofu(□) 로 보인다 — 본문 글자 수로 세면 안 된다.
# (`service._clean_problem_text` 와 같은 구간. `tests/test_solve_input.py` 가
#  두 곳이 어긋나지 않는지 확인한다.)
_PUA_START: Final[int] = 0xE000
_PUA_END: Final[int] = 0xF8FF


class SolveInput(NamedTuple):
    """이 문항을 무엇으로 풀지.

    Attributes:
        mode: `text` / `image`. **None 이면 보낼 것이 아무것도 없다** — 호출부가
            조용히 넘기지 말고 명확히 실패시켜야 한다.
        text: `mode == "text"` 일 때 보낼 문항 전문. 그 외에는 빈 문자열.
        reason: 왜 이것을 골랐는지 한 줄(로그용, 한국어).
    """

    mode: Mode | None
    text: str
    reason: str


def strip_leading_no(text: str) -> str:
    """앞머리 문항 번호(`1.` / `1)` / `1]`)를 한 번 뗀다."""
    return _LEADING_NO_RE.sub("", text, count=1)


def body_chars(text: str) -> str:
    """본문 글자만 남긴다 (앞머리 번호·공백·제어문자·PUA 제거).

    "쓸 만한 텍스트인가" 를 재는 자다. 사람이 읽을 문자열을 만드는 함수가 아니라
    **글자 수를 세기 위한** 함수라 공백을 전부 지운다.

    Args:
        text: 문항 텍스트(원문 또는 판독본).

    Returns:
        본문으로 볼 수 있는 글자만 이어 붙인 문자열.
    """
    kept: list[str] = []
    for ch in strip_leading_no(text):
        if _PUA_START <= ord(ch) <= _PUA_END:
            continue
        if ch.isspace():
            continue
        if unicodedata.category(ch).startswith("C"):
            # 제어/포맷/서로게이트. `\n` `\t` 는 위 `isspace()` 에서 이미 빠졌다.
            continue
        kept.append(ch)
    return "".join(kept)


def is_usable_problem_text(text: str | None) -> bool:
    """이 문자열을 문항 전문으로 AI 에 보낼 수 있는지.

    Args:
        text: 문항 텍스트(없으면 None).

    Returns:
        본문 글자가 `MIN_BODY_CHARS` 자 이상이면 True.
    """
    if not text:
        return False
    return len(body_chars(text)) >= MIN_BODY_CHARS


def pick_solve_input(
    *,
    mode: Mode,
    text: str | None,
    transcript: str | None,
    transcript_source: str | None,
    has_crop: bool,
) -> SolveInput:
    """문항 하나의 풀이 입력을 고른다.

    판정 순서와 근거:

    1. **판독본이 그림을 가리키면**(`figure_ref.needs_figure`) 크롭이 있으면
       이미지. 판독본은 글자·수식만 복원하므로 텍스트만 보내면 조건이 빠진다.
    2. **사용자가 직접 고친 판독본**(`transcript_source == "manual"`)이 쓸 만하면
       그것. 사람이 확인한 것이 언제나 최우선이다.
    3. **`mode == "text"` 이고 `problems.text` 가 쓸 만하면** 그것. 텍스트
       레이어가 정상인 파일에서는 원문이 AI 판독본보다 정확하다.
    4. **판독본이 쓸 만하면** 그것. (omega 가 여기로 온다 — `mode` 는 `text` 인데
       `problems.text` 가 번호뿐이라 3번을 통과하지 못한다.)
    5. **크롭이 있으면** 이미지.
    6. 아무것도 없으면 `mode=None`.

    `mode == "image"` 인 파일의 `problems.text` 는 후보에서 아예 뺀다(PUA 가 깨진
    문자열이다). 그래서 3번에 `mode == "text"` 조건이 붙어 있다.

    Args:
        mode: 파일의 추출 모드(`extractor` 판정. 그대로 신뢰하지는 않는다).
        text: `problems.text`(PDF 텍스트 레이어에서 뽑은 원문).
        transcript: `problems.transcript`(저장된 판독본. 새로 만들지 않는다).
        transcript_source: `pua` / `ai` / `manual`.
        has_crop: 이 문항의 크롭 PNG 가 실제로 있는지.

    Returns:
        고른 입력과 그 이유.
    """
    saved_transcript = (transcript or "").strip()
    saved_text = (text or "").strip()
    transcript_ok = is_usable_problem_text(saved_transcript)
    text_ok = is_usable_problem_text(saved_text)

    # 1. 그림을 가리키는 판독본 → 크롭 이미지.
    #    크롭이 없으면 조건이 빠진 텍스트라도 없는 것보다 나으니 아래로 흘린다.
    if has_crop and saved_transcript and figure_ref.needs_figure(saved_transcript):
        return SolveInput("image", "", "판독본이 그림을 가리킴 → 크롭 이미지로 푼다")

    # 2. 사용자가 고친 판독본이 최우선.
    if transcript_source == storage.TRANSCRIPT_MANUAL and transcript_ok:
        return SolveInput("text", saved_transcript, "사용자가 직접 고친 판독본")

    # 3. text 모드 파일의 원문. 판독본으로 갈아치우면 기존 정상 동작이 회귀한다.
    if mode == "text" and text_ok:
        return SolveInput("text", saved_text, "text 모드 파일의 problems.text(원문)")

    # 4. 판독본. omega 처럼 problems.text 가 번호뿐인 문항이 여기로 온다.
    if transcript_ok:
        detail = (
            "problems.text 가 문항으로 쓸 수 없음"
            if mode == "text"
            else "image 모드라 problems.text 를 쓰지 않음"
        )
        return SolveInput("text", saved_transcript, f"판독본; {detail}")

    # 5. 텍스트가 없으면 크롭 이미지.
    if has_crop:
        return SolveInput("image", "", "쓸 만한 텍스트가 없어 크롭 이미지로 푼다")

    # 6. 보낼 것이 없다. 호출부가 명확히 실패시킨다.
    return SolveInput(None, "", "쓸 만한 텍스트도 크롭 이미지도 없음")


def fallback_input(
    current: Mode,
    *,
    transcript: str | None,
    has_crop: bool,
) -> SolveInput:
    """1차가 실패했을 때 **반대 방향** 입력을 고른다 (방향당 1회).

    text 로 시작했으면 크롭 이미지로, image 로 시작했으면 저장된 판독본으로 한 번만
    바꿔 본다. 판독본은 **이미 저장된 것만** 쓰므로 추가 판독 비용은 0 이다.
    파일의 `mode` 는 보지 않는다 — 1차 선택이 이미 모드와 무관하게 결정됐다.

    Args:
        current: 1차에 쓴 방향.
        transcript: 저장된 판독본.
        has_crop: 크롭 PNG 가 있는지.

    Returns:
        재시도할 입력. 바꿀 방향이 없으면 `mode=None`.
    """
    if current == "text":
        if has_crop:
            return SolveInput("image", "", "텍스트 풀이 실패 → 크롭 이미지로 재시도")
        return SolveInput(None, "", "크롭 이미지가 없어 재시도할 방향이 없음")
    saved_transcript = (transcript or "").strip()
    if is_usable_problem_text(saved_transcript):
        return SolveInput(
            "text", saved_transcript, "이미지 풀이 실패 → 저장된 판독본으로 재시도"
        )
    return SolveInput(None, "", "쓸 만한 판독본이 없어 재시도할 방향이 없음")
