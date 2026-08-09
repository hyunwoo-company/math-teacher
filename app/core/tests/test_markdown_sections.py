"""`markdown_sections.split_sections` 테스트."""

from __future__ import annotations

from markdown_sections import FALLBACK_TITLE, split_sections

VARIANT_TEXT = """## 문제
곡선 y = x^2 위의 점 P 에서 ...

## 정답
12

## 풀이
1단계: 접선의 기울기를 구합니다.
2단계: 넓이를 계산합니다.
"""

SOLUTION_TEXT = """## 문제 확인
이차함수의 최댓값을 묻는 문제입니다.

## 풀이
### 1단계
꼭짓점을 구합니다.

## 정답
5
"""


def test_splits_three_sections() -> None:
    sections = split_sections(VARIANT_TEXT)
    assert list(sections) == ["문제", "정답", "풀이"]
    assert sections["정답"] == "12"
    assert sections["풀이"].startswith("1단계")
    assert sections["풀이"].endswith("계산합니다.")


def test_h3_is_not_a_section_boundary() -> None:
    sections = split_sections(SOLUTION_TEXT)
    assert list(sections) == ["문제 확인", "풀이", "정답"]
    # `### 1단계` 는 풀이 본문 안에 그대로 남는다.
    assert "### 1단계" in sections["풀이"]
    assert sections["정답"] == "5"


def test_no_sections_becomes_problem() -> None:
    sections = split_sections("  섹션 없이 그냥 본문만 있다.  ")
    assert sections == {FALLBACK_TITLE: "섹션 없이 그냥 본문만 있다."}


def test_empty_text_is_empty_dict() -> None:
    assert split_sections("") == {}
    assert split_sections("   \n  ") == {}


def test_preamble_before_first_section_is_dropped() -> None:
    sections = split_sections("머리말입니다.\n\n## 정답\n7")
    assert sections == {"정답": "7"}


def test_duplicate_titles_are_joined() -> None:
    sections = split_sections("## 풀이\n앞\n\n## 풀이\n뒤")
    assert sections == {"풀이": "앞\n\n뒤"}


def test_empty_section_body_is_empty_string() -> None:
    sections = split_sections("## 문제\n\n## 정답\n3")
    assert sections == {"문제": "", "정답": "3"}
