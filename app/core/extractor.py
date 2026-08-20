"""시험지 PDF에서 문제를 코드로만 분리한다 (AI 호출 없음, 비용 0원).

전략
----
1. `page.get_text("dict")` 로 라인/스팬 좌표를 얻는다.
2. 텍스트의 사설영역(PUA, U+E000~U+F8FF) 비율로 모드를 자동 결정한다.
   한글 수식편집기(HyhwpEQ 계열) 폰트는 ToUnicode 를 PUA 로 매핑해서
   수식이 `\\ue0fc\\ue035` 처럼 깨져 나온다. 이 경우 텍스트를 믿을 수 없으므로
   문제 영역을 잘라낸 이미지를 보낸다.
3. 문제 번호(`^\\s*(\\d{1,3})\\s*[.)]`)를 앵커로 삼아 2단 조판을 좌/우 칼럼으로
   나눠 분할한다. 정석 계열(`기본 문제 1-1` / `유제 1-1`)은 번호 형식이 달라
   별도 패턴(`JEONGSEOK_ANCHOR_RE`)으로 잡고, 두 경로 중 더 많이 살리는 쪽을 쓴다.
4. 크롭 이미지의 흰 여백을 잘라내 토큰을 아낀다.

CLI:
    python extractor.py <pdf경로> --outdir tmp_crops
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import re
import sys
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Final, Literal

import fitz
from PIL import Image

Mode = Literal["text", "image"]
Column = Literal["left", "right"]

# 문제 번호 앵커: 줄 맨 앞의 "1." "22." "137." 또는 "1)" "15)" "137)" 형태.
# 그룹 2 는 구분자다. 한 문서 안에서는 둘 중 **우세한 쪽만** 앵커로 인정한다
# (`_dominant_delimiter` 참고). 객관식 선택지 "1) 2) 3)" 이 문제 번호로
# 오인되는 것을 막기 위해서다.
#
# 자릿수는 3 이다. 예전엔 `\d{1,2}` 라 100 번부터가 통째로 앵커에서 빠졌다
# (실측: 유형 문제집 12종이 전부 정확히 99 번에서 잘렸다 — 150문항 중 99개).
# 4자리는 계속 배제한다. `\d{1,3}` 는 "2025." 같은 연도에 매치되지 않는다
# ("202" 뒤에 구분자가 없어 백트래킹해도 전부 실패한다).
#
# 3자리로 넓히면 오탐 표면이 커지지만, 뒤따르는 세 장치가 그대로 걸러낸다.
#   * `DEFAULT_ANCHOR_INDENT_TOL` — 칼럼 왼쪽 끝에 붙은 줄만 앵커로 본다.
#   * `_dominant_delimiter` — 한 문서에서 우세한 구분자 하나만 인정한다.
#   * `_pick_anchor_chain` / `_longest_increasing` — 번호가 증가하는 사슬만 남긴다.
# 실측으로도 기존 시험지 8종의 문항 수·번호가 한 건도 바뀌지 않았다
# (tests/test_extractor.py 의 회귀 테스트가 이를 고정한다).
ANCHOR_RE: Final[re.Pattern[str]] = re.compile(r"^\s*(\d{1,3})\s*([.)])")

# --- 정석 계열 문항 번호 ------------------------------------------------------
# 실측 회귀: `수학의 정석` PDF 는 업로드 결과가 **0문항**이었다. 문항 번호가
# `1.` 이 아니라 `기본 문제 1-1` / `유제 1-1` 처럼 **계열 이름 + 장-문항** 형태라
# `ANCHOR_RE` 에 하나도 걸리지 않기 때문이다.
#
# 표기 흔들림을 모두 허용한다.
#   * `기본 문제` / `기본문제` — 실제 지면에는 사이에 공백이 있다(노션 본문의
#     "기본문제" 는 붙여 쓴 것). 한글 조판은 제목을 자간 벌림으로 찍는 일이
#     잦아(같은 레포의 `< 기 본 >` 사례) 음절 사이 공백도 열어 둔다.
#   * 하이픈은 폰트/조판에 따라 U+002D 외에 en dash·마이너스로 찍힐 수 있어
#     함께 받는다. 어떤 글리프인지는 실물에서 확인하지 못했다(방어적 허용).
#
# 뒤에 `(?!\d)` 를 두어 4자리 이상은 배제한다(`ANCHOR_RE` 가 "2025." 를 거르는
# 것과 같은 이유 — 백트래킹해도 전부 실패한다).
#
# `label` 그룹은 지면 원문 그대로다. 저장용 `no` 는 통짜로 다시 매기고
# (`_renumber_duplicates`) 이 표기는 `Problem.label` 에 남긴다.
JEONGSEOK_ANCHOR_RE: Final[re.Pattern[str]] = re.compile(
    r"^\s*(?P<label>(?P<series>기\s*본\s*문\s*제|유\s*제)"
    # 하이픈류: U+002D, U+2010~U+2015(하이픈/대시류), U+2212(마이너스).
    # 리터럴 글리프 대신 이스케이프로 적는다 — 눈으로 구분이 안 되고
    # ruff RUF001(모호한 유니코드)에도 걸린다.
    r"\s*(?P<chapter>\d{1,3})\s*[-\u2010-\u2015\u2212]\s*"
    r"(?P<item>\d{1,3}))(?!\d)"
)

# 정석 계열의 번호 계열 이름(공백 제거 후 비교). 지면에서 `기본 문제 1-1` 뒤에
# 그에 딸린 `유제 1-1`, `유제 1-2` 가 오는 식으로 **두 계열이 교대로** 나오므로,
# 한 사슬로 묶어 단조증가를 요구하면 절반이 오탐으로 버려진다. 계열별로 따로
# 사슬을 고른 뒤(`_jeongseok_anchor_chain`) 읽는 순서로 합친다.
_JEONGSEOK_SERIES: Final[tuple[str, ...]] = ("기본문제", "유제")

# `N-M` 을 단조증가 판정이 가능한 정수 하나로 평탄화하는 자리수.
# `_pick_anchor_chain` / `_longest_increasing` 이 `list[int]` 를 받으므로 튜플
# 비교를 새로 만들지 않고 `N*1000 + M` 로 접는다. 정규식이 M 을 3자리로
# 제한하므로(<=999) 장이 넘어갈 때 자리올림이 겹치는 일이 없다
# (예: 1-1 -> 1001, 1-12 -> 1012, 2-1 -> 2001 이 그대로 오름차순).
_JEONGSEOK_CHAPTER_STRIDE: Final[int] = 1000

PUA_START: Final[int] = 0xE000
PUA_END: Final[int] = 0xF8FF

DEFAULT_PUA_THRESHOLD: Final[float] = 0.02
DEFAULT_DPI: Final[int] = 150
DEFAULT_MAX_EDGE_PX: Final[int] = 1568  # Anthropic 이미지 장변 상한

# 앵커는 칼럼 왼쪽 끝에 붙어 있다. 본문 속 "1." 오탐을 걸러내는 들여쓰기 허용치(pt).
DEFAULT_ANCHOR_INDENT_TOL: Final[float] = 30.0

# --- 유형 문제집 폴백 (additive) ---------------------------------------------
# 유형 문제집은 문제 번호가 "1." 이 아니라 "001" "002" 처럼 3자리 zero-padded 로,
# 본문(9~11pt)보다 훨씬 큰 볼드 글리프(관측: DINCondensed-Bold, size≈21)로 찍힌다.
# 게다가 한 번호가 "00"+"1" 두 스팬으로 쪼개져 같은 줄(같은 y0)에 인접해 나온다.
# 시험지 경로(`find_anchors`)에서 앵커를 못 찾을 때만(회귀 방지) 이 글리프를
# 병합해 앵커를 만든다. 유형 헤더(작은 "01"/"02")·꼬리말 페이지번호는 폰트/크기가
# 달라 자연 배제된다.
TYPE_ANCHOR_FONT_HINT: Final[str] = "DINCondensed"
# 본문 텍스트(≈9~11pt)·작은 참조 글리프(≈10pt)와 확실히 구분되는 크기 하한.
TYPE_ANCHOR_MIN_SIZE: Final[float] = 15.0
# 같은 번호로 볼 "같은 줄" 판정 허용 y 오차(pt).
TYPE_ANCHOR_Y_TOL: Final[float] = 3.0
# 같은 번호로 병합할 인접 글리프 최대 가로 간격(pt). 넘으면(칼럼 경계 등) 끊는다.
TYPE_ANCHOR_X_GAP: Final[float] = 6.0
# 시험지 앵커가 이 개수 미만일 때만 유형 문제집 폴백을 시도한다.
TYPE_FALLBACK_MIN_ANCHORS: Final[int] = 2
# 병합 결과를 유형 번호(001~999)로 인정하는 패턴.
_TYPE_NO_RE: Final[re.Pattern[str]] = re.compile(r"^\d{1,3}$")

_WHITE_LEVEL: Final[int] = 250  # 이 이상 밝으면 여백으로 본다
_TRIM_PAD_PX: Final[int] = 6

# 본문 괘선 자체가 크롭에 딸려 들어가면 여백 트림이 무력화된다(선이 있는 행은
# 흰색이 아니므로). 괘선 안쪽으로 이만큼 물러난다.
_RULE_INSET_PT: Final[float] = 2.0

# 다음 문제 앵커 글리프의 윗부분이 몇 px 씩 딸려 들어오면 역시 트림이 막힌다.
_ANCHOR_GAP_PT: Final[float] = 3.0

# 괘선으로 잡은 본문 영역이 페이지 높이의 이 비율 미만이면 검출 실패로 본다.
# 첫 장 머리글 표(성명·일자 칸)의 가로선만 괘선으로 걸리면 높이가 0 이하인
# 사각형이 나오고, 그러면 그 페이지 문항이 통째로 버려진다(실측: 높이 -4pt).
_MIN_CONTENT_HEIGHT_RATIO: Final[float] = 0.5


@dataclass(frozen=True)
class TextLine:
    """페이지 안의 텍스트 한 줄."""

    text: str
    bbox: tuple[float, float, float, float]


@dataclass(frozen=True)
class Anchor:
    """문제 번호가 발견된 위치."""

    no: int
    page: int
    column: Column
    x0: float
    y0: float
    #: 지면 원문 표기. 정석 계열(`기본 문제 1-1`)처럼 번호가 정수가 아닐 때만
    #: 채운다. 비어 있으면 `str(no)` 가 곧 원문 표기다.
    #: 이 값이 채워졌다는 것은 `no` 가 정렬용 합성 키(`N*1000+M`)라는 뜻이라,
    #: 호출부는 저장용 번호를 반드시 다시 매긴다(`_renumber_duplicates`).
    label: str = ""


@dataclass
class Problem:
    """분리된 문제 하나.

    `no` 는 **문서 안에서 유일한 통짜 순번**이다. 부교재·문제집은 구획마다
    (`< 기 본 >` / `< 심 화 >`) 번호를 1 부터 다시 매기는데, 그대로 두면
    `problems` 의 기본키 `(node_id, no)` 가 충돌해 뒤 문항이 앞 문항을 덮어쓴다.
    그래서 저장용 번호는 통짜로 다시 매기고, 원문 표기는 `label` 에 남긴다
    (번호가 겹치지 않는 보통 시험지에서는 둘이 같다).
    """

    no: int
    page: int
    bbox: list[float]
    text: str
    image_b64: str | None = None
    image_w: int = 0
    image_h: int = 0
    #: 원문에 찍힌 번호 표기. 보통 `str(no)` 와 같다.
    label: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ExtractResult:
    """PDF 한 건의 추출 결과."""

    page_count: int
    pua_ratio: float
    pua_threshold: float
    mode: Mode
    dpi: int
    problems: list[Problem] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "page_count": self.page_count,
            "pua_ratio": self.pua_ratio,
            "pua_threshold": self.pua_threshold,
            "mode": self.mode,
            "dpi": self.dpi,
            "problem_count": len(self.problems),
            "problems": [p.to_dict() for p in self.problems],
        }


class ExtractionError(RuntimeError):
    """PDF 파싱/분할 실패."""


def pua_ratio(text: str) -> float:
    """전체 문자 중 사설영역(PUA) 문자 비율.

    공백은 분모에서 제외한다(여백이 많으면 비율이 희석되므로).
    """
    meaningful = [ch for ch in text if not ch.isspace()]
    if not meaningful:
        return 0.0
    pua = sum(1 for ch in meaningful if PUA_START <= ord(ch) <= PUA_END)
    return pua / len(meaningful)


def _page_lines(page: fitz.Page) -> list[TextLine]:
    """페이지의 텍스트 라인을 좌표와 함께 뽑는다."""
    data = page.get_text("dict")
    lines: list[TextLine] = []
    for block in data.get("blocks", []):
        if block.get("type") != 0:  # 0 = 텍스트 블록
            continue
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            text = "".join(span.get("text", "") for span in spans)
            if not text.strip():
                continue
            bbox = tuple(float(v) for v in line["bbox"])
            lines.append(TextLine(text=text, bbox=bbox))  # type: ignore[arg-type]
    return lines


def content_rect(page: fitz.Page) -> fitz.Rect:
    """머리말/꼬리말을 뺀 본문 영역.

    시험지는 보통 본문 위/아래에 페이지 폭에 가까운 수평 괘선이 있다.
    그 괘선을 찾아 본문 영역으로 쓰고, 없으면 비율 기반 여백으로 대체한다.
    """
    page_rect = page.rect
    min_width = page_rect.width * 0.7

    rules: list[fitz.Rect] = []
    for drawing in page.get_drawings():
        rect = drawing["rect"]
        # 높이가 거의 0 인 가로 선분
        if rect.width >= min_width and rect.height <= 2.0:
            rules.append(rect)

    if len(rules) >= 2:
        rules.sort(key=lambda r: r.y0)
        top, bottom = rules[0], rules[-1]
        x0 = min(top.x0, bottom.x0)
        x1 = max(top.x1, bottom.x1)
        found = fitz.Rect(
            x0 + _RULE_INSET_PT,
            top.y1 + _RULE_INSET_PT,
            x1 - _RULE_INSET_PT,
            bottom.y0 - _RULE_INSET_PT,
        )
        # 머리글 표의 가로선들만 걸리면 위/아래 괘선이 사실상 같은 높이라
        # 본문이 없는(심지어 뒤집힌) 사각형이 나온다. 그럴 땐 비율 폴백을 쓴다.
        if found.height >= page_rect.height * _MIN_CONTENT_HEIGHT_RATIO:
            return found

    # 괘선이 없어 물리적 경계를 못 찾은 폴백. 상/하 여백은 머리말·꼬리말을
    # 크롭 밖으로 밀어내려는 휴리스틱일 뿐이다.
    #
    # 상단 6% 는 과하다. 2단 조판 시험지는 각 칼럼 맨 위 문제가 인쇄 여백 바로
    # 아래(841pt 페이지에서 y0≈47pt, 약 5.6%)에서 시작하는데, 6%(≈50.5pt) 컷오프가
    # 이 정상 문제 앵커를 머리말로 오판해 통째로 버렸다(홀수 문제 누락 버그).
    # 3%(≈25pt, A4 기준 약 0.35인치) 로 낮추면 이런 상단 시작 문제를 살리면서도,
    # 페이지 최상단 밴드의 진짜 머리말은 계속 배제한다. 문제 번호 오탐은 어차피
    # ANCHOR_RE(`\d{1,3}[.)]` 형태), _dominant_delimiter(구분자 통일),
    # _longest_increasing(번호 단조증가) 필터가 잡는다.
    #
    # 하단은 6% 를 유지한다. 시험지 꼬리말(가운데 정렬 페이지 번호 "- N -")이
    # 하단에서 약 2.4%(841pt 페이지에서 y≈811pt) 지점에 오는 사례가 있어, 하단을
    # 3% 로 낮추면 이 꼬리말이 마지막 문제 크롭·본문에 딸려 들어가 회귀가 난다.
    return fitz.Rect(
        page_rect.x0 + page_rect.width * 0.04,
        page_rect.y0 + page_rect.height * 0.03,
        page_rect.x1 - page_rect.width * 0.04,
        page_rect.y1 - page_rect.height * 0.06,
    )


def column_bounds(
    content: fitz.Rect, column: Column, gutter: float = 6.0
) -> tuple[float, float]:
    """2단 조판에서 칼럼의 좌우 경계(x0, x1)."""
    center = (content.x0 + content.x1) / 2.0
    if column == "left":
        return content.x0, center - gutter / 2.0
    return center + gutter / 2.0, content.x1


def _classify_column(x0: float, page: fitz.Page) -> Column:
    """스팬 x0 가 페이지 폭 절반보다 작으면 좌측 칼럼."""
    return "left" if x0 < (page.rect.x0 + page.rect.width / 2.0) else "right"


def _longest_increasing(numbers: list[int]) -> list[int]:
    """읽는 순서 리스트에서 가장 긴 '순증가' 부분수열의 인덱스를 돌려준다.

    본문 속 "1." 같은 오탐 앵커를 버리기 위한 필터. 그리디(직전보다 크면 채택)와
    달리 큰 오탐값(예: 3 다음에 나온 9) 때문에 이후 정상 앵커가 줄줄이 버려지는
    문제가 없다.
    """
    if not numbers:
        return []
    size = len(numbers)
    best = [1] * size
    prev = [-1] * size
    for i in range(size):
        for j in range(i):
            if numbers[j] < numbers[i] and best[j] + 1 > best[i]:
                best[i] = best[j] + 1
                prev[i] = j
    end = max(range(size), key=lambda i: best[i])
    chain: list[int] = []
    while end != -1:
        chain.append(end)
        end = prev[end]
    return list(reversed(chain))


def _renumber_duplicates(problems: list[Problem], *, force: bool = False) -> None:
    """번호가 겹치면 읽는 순서대로 1..N 을 다시 매긴다 (제자리 수정).

    구획마다 번호를 되돌리는 교재(`< 기 본 >` 1~5, `< 심 화 >` 1~2)를 그대로
    저장하면 `problems` 의 기본키 `(node_id, no)` 가 충돌해 뒤 문항이 앞 문항을
    덮어쓴다. 겹칠 때만 다시 매기므로 보통 시험지는 번호가 그대로다.

    원문 표기는 이미 `label` 에 들어 있어 화면에서 "문제지 표기: 1번" 으로
    보여줄 수 있다.

    Args:
        problems: 읽는 순서대로 정렬된 문제 목록.
        force: 번호가 겹치지 않아도 다시 매긴다. 정석 계열(`기본 문제 1-1`)은
            `no` 가 정렬용 합성 키(`N*1000+M`)여서 겹치지 않아도 그대로 쓸 수
            없다(1001 번 문항으로 저장·표시된다).
    """
    numbers = [problem.no for problem in problems]
    if not force and len(numbers) == len(set(numbers)):
        return
    for index, problem in enumerate(problems, start=1):
        problem.no = index


def _pick_anchor_chain(numbers: list[int]) -> list[int]:
    """오탐을 버리되 **구획마다 번호가 1부터 다시 시작하는 교재**를 지원한다.

    시험지는 1..N 이 한 번만 흐르지만, 부교재·문제집은 `< 기 본 >` / `< 심 화 >`
    처럼 구획마다 번호를 되돌린다. 순증가만 인정하면 두 번째 구획이 통째로
    버려진다(실측: 풍문고 부교재).

    규칙은 둘뿐이다.
      * 직전보다 크면 같은 구획으로 이어간다.
      * `1` 이 다시 나오면 새 구획이 시작된 것으로 본다.
    그 외(작아지지만 1 이 아닌 값)는 오탐으로 버린다.

    구획이 하나뿐이면 결과가 `_longest_increasing` 과 같다. 다만 순증가 최장
    부분수열보다 짧아질 수 있어 **둘 중 더 많이 살리는 쪽**을 고른다.

    Args:
        numbers: 읽는 순서대로 나열한 앵커 번호.

    Returns:
        채택한 앵커의 인덱스 목록(읽는 순서).
    """
    if not numbers:
        return []

    reset_chain: list[int] = []
    previous: int | None = None
    for index, value in enumerate(numbers):
        if previous is None or value > previous or value == 1:
            reset_chain.append(index)
            previous = value
    increasing = _longest_increasing(numbers)
    return reset_chain if len(reset_chain) >= len(increasing) else increasing


def _parse_anchor_line(text: str) -> tuple[int, str, str] | None:
    """줄 텍스트에서 (정렬용 번호, 계열, 원문 표기) 를 뽑는다.

    계열은 뒤에서 "같은 번호 체계끼리만 비교" 하기 위한 꼬리표다. 보통 시험지는
    구분자(`.` / `)`) 가, 정석 계열은 계열 이름(`기본문제` / `유제`) 이 계열이 된다.

    정석 계열을 먼저 본다. `기본 문제 1-1` 은 `ANCHOR_RE` 에 아예 걸리지 않으므로
    순서가 결과를 바꾸지는 않지만, 판정 의도를 코드 순서로 남긴다.

    Args:
        text: 라인 텍스트(원문).

    Returns:
        `(no, series, label)`. 앵커가 아니면 `None`.
        `label` 은 정석 계열에서만 채운다(보통 시험지는 `str(no)` 와 같아 빈 문자열).
    """
    jeongseok = JEONGSEOK_ANCHOR_RE.match(text)
    if jeongseok is not None:
        chapter = int(jeongseok.group("chapter"))
        item = int(jeongseok.group("item"))
        series = re.sub(r"\s+", "", jeongseok.group("series"))
        return (
            chapter * _JEONGSEOK_CHAPTER_STRIDE + item,
            series,
            jeongseok.group("label").strip(),
        )

    match = ANCHOR_RE.match(text)
    if match is None:
        return None
    return int(match.group(1)), match.group(2), ""


def _plain_anchor_chain(candidates: Sequence[tuple[Anchor, str]]) -> list[Anchor]:
    """보통 시험지 경로: 우세한 구분자 하나만 남기고 번호 사슬을 고른다."""
    delimiter = _dominant_delimiter(candidates)
    kept = [anchor for anchor, series in candidates if series == delimiter]

    keep = _pick_anchor_chain([a.no for a in kept])
    return [kept[i] for i in keep]


def _jeongseok_anchor_chain(candidates: Sequence[tuple[Anchor, str]]) -> list[Anchor]:
    """정석 계열 경로: 계열(`기본문제`/`유제`)마다 따로 사슬을 고른 뒤 합친다.

    두 계열을 한 사슬로 보면 안 된다. 정석 지면은 `기본 문제 1-1` 다음에 그에
    딸린 `유제 1-1`, `유제 1-2` 가 오고 다시 `기본 문제 1-2` 로 돌아가므로,
    읽는 순서의 번호가 1001, 1001, 1002, 1002 … 처럼 계열끼리 교대한다.
    단조증가를 통째로 요구하면 한 계열이 절반 넘게 오탐으로 버려진다.
    (교대 순서는 지면 사진으로 확인한 정석 조판 기준이다. 계열별로 나눠 걸러 두면
    교대하든 계열이 몰려 나오든 결과가 같아 어느 쪽이든 안전하다.)

    계열 안에서는 `N*1000+M` 이 오름차순이므로 기존 사슬 필터를 그대로 쓴다.

    Args:
        candidates: `(앵커, 계열)` 후보 목록. 읽는 순서여야 한다.

    Returns:
        채택한 앵커 목록(읽는 순서로 재정렬).
    """
    kept: list[Anchor] = []
    for series in _JEONGSEOK_SERIES:
        group = [anchor for anchor, name in candidates if name == series]
        keep = _pick_anchor_chain([anchor.no for anchor in group])
        kept.extend(group[index] for index in keep)

    # 계열별로 나눠 걸렀으니 읽는 순서(페이지 → 좌 칼럼 → 우 칼럼)를 다시 세운다.
    kept.sort(key=lambda a: (a.page, 0 if a.column == "left" else 1, a.y0, a.x0))
    return kept


def find_anchors(
    doc: fitz.Document, *, indent_tol: float = DEFAULT_ANCHOR_INDENT_TOL
) -> list[Anchor]:
    """문서 전체에서 문제 번호 앵커를 읽는 순서대로 찾는다.

    읽는 순서는 페이지 → 좌측 칼럼 위에서 아래 → 우측 칼럼 위에서 아래.
    번호가 오름차순이 되도록 오탐 앵커는 버린다.

    두 경로(보통 시험지 / 정석 계열)를 각각 계산해 **더 많이 살리는 쪽**을 고른다.
    정석 지면에도 머리말성 `1. 다항식의 연산`(단원 제목) 같은 줄이 있어 보통 경로
    후보가 몇 개 잡히는데, 그 사슬은 정석 사슬보다 훨씬 짧아 밀린다. 반대로 정석
    표기가 없는 문서는 정석 후보가 0개라 항상 기존 경로가 그대로 선택된다
    (동수일 때도 검증된 기존 경로를 고른다).
    """
    candidates: list[tuple[Anchor, str]] = []
    for page_no in range(doc.page_count):
        page = doc[page_no]
        content = content_rect(page)
        page_candidates: list[tuple[Anchor, str]] = []
        for line in _page_lines(page):
            parsed = _parse_anchor_line(line.text)
            if parsed is None:
                continue
            no, series, label = parsed
            x0, y0, _, y1 = line.bbox
            # 머리말/꼬리말 제외
            if y0 < content.y0 or y1 > content.y1:
                continue
            column = _classify_column(x0, page)
            col_x0, col_x1 = column_bounds(content, column)
            # 칼럼 밖이거나 지나치게 들여쓰기된 줄은 앵커가 아니다
            if not (col_x0 - 1.0 <= x0 <= col_x1):
                continue
            if x0 - col_x0 > indent_tol:
                continue
            page_candidates.append(
                (
                    Anchor(
                        no=no,
                        page=page_no,
                        column=column,
                        x0=x0,
                        y0=y0,
                        label=label,
                    ),
                    series,
                )
            )
        page_candidates.sort(
            key=lambda item: (
                0 if item[0].column == "left" else 1,
                item[0].y0,
                item[0].x0,
            )
        )
        candidates.extend(page_candidates)

    plain = _plain_anchor_chain(candidates)
    jeongseok = _jeongseok_anchor_chain(candidates)
    return jeongseok if len(jeongseok) > len(plain) else plain


def _dominant_delimiter(candidates: Sequence[tuple[Anchor, str]]) -> str:
    """문서의 문제 번호 구분자(`.` 또는 `)`)를 고른다.

    한 시험지는 번호 형식이 하나다. 둘이 섞여 잡혔다면 한쪽은 오탐이다.

    **개수로 비교하면 안 된다.** 객관식 선택지 `1) 2) 3) 4) 5)` 는 문제마다
    반복되므로 문제 번호보다 항상 많다. 20문항 5지선다면 `.` 20개 대 `)` 100개라
    개수 기준은 선택지 쪽을 고르고 추출이 통째로 무너진다.

    대신 **번호가 단조증가하는 사슬의 길이**로 비교한다. 문제 번호는 문서 전체에서
    1,2,3… 으로 이어지지만 선택지는 문제마다 1 로 되돌아가므로 사슬이 선택지 개수
    (보통 5)를 넘지 못한다.

    사슬 길이가 같거나 후보가 없으면 `.` 을 고른다. 마침표가 기존 검증된 경로다.

    Args:
        candidates: (앵커, 계열) 후보 목록. 읽는 순서여야 한다. 정석 계열
            (`기본문제`/`유제`) 후보가 섞여 있어도 여기서는 무시된다 — 구분자
            `.`/`)` 를 가진 후보만 세기 때문이다.

    Returns:
        `"."` 또는 `")"`.
    """
    dot_chain = len(
        _longest_increasing([a.no for a, delim in candidates if delim == "."])
    )
    paren_chain = len(
        _longest_increasing([a.no for a, delim in candidates if delim == ")"])
    )
    return ")" if paren_chain > dot_chain else "."


def _merge_type_number_glyphs(
    glyphs: list[tuple[float, float, float, str]],
    *,
    y_tol: float = TYPE_ANCHOR_Y_TOL,
    x_gap: float = TYPE_ANCHOR_X_GAP,
) -> list[tuple[int, float, float]]:
    """같은 줄에 쪼개진 유형 번호 글리프를 병합해 (번호, x0, y0) 로 돌려준다.

    유형 문제집은 "001" 이 "00"+"1" 두 스팬으로 분리돼 같은 y0 에 인접해 나온다.
    y 가 거의 같고 가로로 붙은(간격 <= x_gap) 글리프만 한 번호로 잇는다. 가로
    간격이 크면(칼럼 경계 등) 다른 번호로 끊어, 같은 줄 다른 칼럼의 두 번호가
    엉키지 않게 한다. 병합 텍스트에서 숫자만 남겨 정수로 파싱한다("001"->1).
    """
    ordered = sorted(glyphs, key=lambda g: (round(g[1], 1), g[0]))
    groups: list[dict[str, Any]] = []
    for x0, y0, x1, text in ordered:
        if (
            groups
            and abs(groups[-1]["y0"] - y0) <= y_tol
            and (x0 - groups[-1]["x1"]) <= x_gap
        ):
            groups[-1]["text"] += text
            groups[-1]["x1"] = x1
        else:
            groups.append({"x0": x0, "y0": y0, "x1": x1, "text": text})

    result: list[tuple[int, float, float]] = []
    for group in groups:
        digits = re.sub(r"\D", "", group["text"])
        if not digits or _TYPE_NO_RE.match(digits) is None:
            continue
        result.append((int(digits), group["x0"], group["y0"]))
    return result


def find_type_workbook_anchors(doc: fitz.Document) -> list[Anchor]:
    """유형 문제집("001" 형식) 앵커를 읽는 순서대로 찾는다 (best-effort 폴백).

    시험지 앵커(`find_anchors`)를 못 찾을 때만 호출한다. 큰 볼드 번호 글리프를
    폰트명(`TYPE_ANCHOR_FONT_HINT`)·크기(`TYPE_ANCHOR_MIN_SIZE`)로 추려 같은 줄에서
    병합하고, 2단 조판을 좌/우로 나눠 번호가 오름차순이 되도록 정리한다. 본문이
    특수폰트라 텍스트를 믿을 수 없으므로 이 경로가 잡히면 호출부에서 mode 를
    image 로 강제한다.

    시험지 경로와 달리 들여쓰기(indent) 필터는 쓰지 않는다. 유형 번호 글리프는
    폰트·크기만으로 충분히 신뢰할 수 있고, 제본 여백 때문에 칼럼 시작 x 가
    페이지마다 흔들려(예: 42.5 vs 56.7pt) indent 임계에 걸리면 정상 번호가
    통째로 누락되기 때문이다.
    """
    candidates: list[Anchor] = []
    for page_no in range(doc.page_count):
        page = doc[page_no]
        content = content_rect(page)
        glyphs: list[tuple[float, float, float, str]] = []
        for block in page.get_text("dict").get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    if TYPE_ANCHOR_FONT_HINT not in span.get("font", ""):
                        continue
                    if float(span.get("size", 0.0)) < TYPE_ANCHOR_MIN_SIZE:
                        continue
                    x0, y0, x1, _ = span["bbox"]
                    glyphs.append(
                        (float(x0), float(y0), float(x1), span.get("text", ""))
                    )

        page_candidates: list[Anchor] = []
        for no, x0, y0 in _merge_type_number_glyphs(glyphs):
            # 머리말/꼬리말 밴드 밖 글리프는 문제 번호가 아니다.
            if y0 < content.y0 or y0 > content.y1:
                continue
            column = _classify_column(x0, page)
            page_candidates.append(
                Anchor(no=no, page=page_no, column=column, x0=x0, y0=y0)
            )
        page_candidates.sort(key=lambda a: (0 if a.column == "left" else 1, a.y0, a.x0))
        candidates.extend(page_candidates)

    keep = _longest_increasing([a.no for a in candidates])
    return [candidates[i] for i in keep]


def _lines_in_bbox(lines: list[TextLine], bbox: fitz.Rect) -> str:
    """bbox 안에 중심이 들어오는 라인들을 읽는 순서로 이어붙인다."""
    inside = [
        line
        for line in lines
        if bbox.x0 <= (line.bbox[0] + line.bbox[2]) / 2 <= bbox.x1
        and bbox.y0 <= (line.bbox[1] + line.bbox[3]) / 2 <= bbox.y1
    ]
    inside.sort(key=lambda line: (round(line.bbox[1], 1), line.bbox[0]))
    return "\n".join(line.text.rstrip() for line in inside).strip()


def _render_trimmed(
    page: fitz.Page,
    bbox: fitz.Rect,
    *,
    dpi: int,
    max_edge_px: int,
) -> tuple[str, int, int, fitz.Rect]:
    """bbox 를 렌더링하고 흰 여백을 잘라 PNG base64 로 돌려준다.

    Returns:
        (base64 PNG, 폭 px, 높이 px, 실제로 사용된 bbox)
    """
    pix = page.get_pixmap(dpi=dpi, clip=bbox)
    image = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")

    # _WHITE_LEVEL 이상은 여백(0), 나머지는 내용(255) 으로 이진화 후 내용 bbox 계산
    mask = image.convert("L").point(lambda v: 0 if v >= _WHITE_LEVEL else 255)
    content_box = mask.getbbox()

    scale = dpi / 72.0
    if content_box is None:
        # 완전히 빈 영역이면 원본 그대로 둔다
        used = fitz.Rect(bbox)
    else:
        left, top, right, bottom = content_box
        left = max(0, left - _TRIM_PAD_PX)
        top = max(0, top - _TRIM_PAD_PX)
        right = min(image.width, right + _TRIM_PAD_PX)
        bottom = min(image.height, bottom + _TRIM_PAD_PX)
        image = image.crop((left, top, right, bottom))
        used = fitz.Rect(
            bbox.x0 + left / scale,
            bbox.y0 + top / scale,
            bbox.x0 + right / scale,
            bbox.y0 + bottom / scale,
        )

    longest = max(image.width, image.height)
    if longest > max_edge_px:
        ratio = max_edge_px / longest
        image = image.resize(
            (max(1, round(image.width * ratio)), max(1, round(image.height * ratio))),
            Image.Resampling.LANCZOS,
        )

    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return encoded, image.width, image.height, used


def extract_problems(
    pdf_path: str | Path | None = None,
    *,
    pdf_bytes: bytes | None = None,
    dpi: int = DEFAULT_DPI,
    pua_threshold: float = DEFAULT_PUA_THRESHOLD,
    mode: Mode | Literal["auto"] = "auto",
    render_images: bool = True,
    max_edge_px: int = DEFAULT_MAX_EDGE_PX,
    indent_tol: float = DEFAULT_ANCHOR_INDENT_TOL,
) -> ExtractResult:
    """PDF 를 문제 단위로 분리한다. AI 호출 없음.

    Args:
        pdf_path: PDF 파일 경로. `pdf_bytes` 와 둘 중 하나는 필수.
        pdf_bytes: PDF 바이트열(업로드용).
        dpi: 크롭 렌더링 해상도.
        pua_threshold: 이 비율 이상이면 image 모드.
        mode: `auto` 면 PUA 비율로 자동 결정.
        render_images: False 면 크롭 이미지를 만들지 않는다(분할만 확인할 때).
        max_edge_px: 크롭 이미지 장변 상한.
        indent_tol: 앵커로 인정할 최대 들여쓰기(pt).

    Returns:
        추출 결과.

    Raises:
        ValueError: 입력이 없을 때.
        ExtractionError: PDF 를 열 수 없을 때.
    """
    if pdf_bytes is None and pdf_path is None:
        raise ValueError("pdf_path 또는 pdf_bytes 중 하나는 필요합니다.")

    try:
        if pdf_bytes is not None:
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        else:
            doc = fitz.open(str(pdf_path))
    except Exception as exc:  # fitz 는 다양한 예외를 던진다
        raise ExtractionError(f"PDF 를 열 수 없습니다: {exc}") from exc

    try:
        page_texts = [doc[i].get_text("text") for i in range(doc.page_count)]
        ratio = pua_ratio("".join(page_texts))
        resolved_mode: Mode = (
            ("image" if ratio >= pua_threshold else "text") if mode == "auto" else mode
        )

        anchors = find_anchors(doc, indent_tol=indent_tol)
        # 시험지 경로에서 앵커를 사실상 못 찾았을 때만 유형 문제집 폴백을 시도한다
        # (additive: 시험지 결과가 충분하면 이 블록은 아무것도 하지 않는다).
        if len(anchors) < TYPE_FALLBACK_MIN_ANCHORS:
            type_anchors = find_type_workbook_anchors(doc)
            if len(type_anchors) > len(anchors):
                anchors = type_anchors
                # 본문이 특수폰트라 텍스트 신뢰 불가 → 자동 모드일 때 이미지 강제.
                # (PUA 감지가 ASCII 코드점이라 과소평가해 'text' 로 오판하는 문제)
                if mode == "auto":
                    resolved_mode = "image"
        lines_cache: dict[int, list[TextLine]] = {}
        content_cache: dict[int, fitz.Rect] = {}

        problems: list[Problem] = []
        for index, anchor in enumerate(anchors):
            page = doc[anchor.page]
            if anchor.page not in content_cache:
                content_cache[anchor.page] = content_rect(page)
                lines_cache[anchor.page] = _page_lines(page)
            content = content_cache[anchor.page]

            col_x0, col_x1 = column_bounds(content, anchor.column)

            # 같은 페이지·같은 칼럼의 다음 앵커까지가 이 문제의 세로 범위
            y1 = content.y1
            for later in anchors[index + 1 :]:
                if later.page != anchor.page:
                    break
                if later.column == anchor.column and later.y0 > anchor.y0:
                    y1 = later.y0 - _ANCHOR_GAP_PT
                    break
                if later.column != anchor.column:
                    # 다른 칼럼으로 넘어갔으면 이 칼럼은 끝까지
                    break

            bbox = fitz.Rect(col_x0, max(content.y0, anchor.y0 - 2.0), col_x1, y1)
            text = _lines_in_bbox(lines_cache[anchor.page], bbox)

            image_b64: str | None = None
            width = height = 0
            used = bbox
            if render_images:
                image_b64, width, height, used = _render_trimmed(
                    page, bbox, dpi=dpi, max_edge_px=max_edge_px
                )

            problems.append(
                Problem(
                    no=anchor.no,
                    page=anchor.page + 1,
                    bbox=[round(v, 2) for v in (used.x0, used.y0, used.x1, used.y1)],
                    text=text,
                    image_b64=image_b64,
                    image_w=width,
                    image_h=height,
                    label=anchor.label or str(anchor.no),
                )
            )

        # 정석 계열 앵커는 `no` 가 정렬용 합성 키(`N*1000+M`)라 겹치지 않아도
        # 그대로 저장하면 "1001번 문항" 이 된다. 원문 표기(`label`)가 따로 있는
        # 경로였으면 저장용 번호를 무조건 통짜로 다시 매긴다.
        _renumber_duplicates(problems, force=any(a.label for a in anchors))

        return ExtractResult(
            page_count=doc.page_count,
            pua_ratio=round(ratio, 4),
            pua_threshold=pua_threshold,
            mode=resolved_mode,
            dpi=dpi,
            problems=problems,
        )
    finally:
        doc.close()


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="시험지 PDF 문제 분할 (AI 호출 없음, 비용 0원)"
    )
    parser.add_argument("pdf", help="PDF 경로 (대괄호/한글 포함 가능)")
    parser.add_argument("--outdir", default="tmp_crops", help="크롭 PNG 저장 폴더")
    parser.add_argument("--dpi", type=int, default=DEFAULT_DPI)
    parser.add_argument("--pua-threshold", type=float, default=DEFAULT_PUA_THRESHOLD)
    parser.add_argument("--mode", choices=("auto", "text", "image"), default="auto")
    parser.add_argument("--max-edge-px", type=int, default=DEFAULT_MAX_EDGE_PX)
    parser.add_argument("--indent-tol", type=float, default=DEFAULT_ANCHOR_INDENT_TOL)
    parser.add_argument(
        "--no-images", action="store_true", help="크롭 이미지를 만들지 않는다"
    )
    parser.add_argument("--json", action="store_true", help="JSON 요약도 출력")
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI 진입점."""
    args = _build_arg_parser().parse_args(argv)

    pdf_path = Path(args.pdf)  # glob 확장 없이 문자열 그대로 사용
    if not pdf_path.is_file():
        print(f"[error] 파일을 찾을 수 없습니다: {pdf_path}", file=sys.stderr)
        return 2

    result = extract_problems(
        pdf_path,
        dpi=args.dpi,
        pua_threshold=args.pua_threshold,
        mode=args.mode,
        render_images=not args.no_images,
        max_edge_px=args.max_edge_px,
        indent_tol=args.indent_tol,
    )

    outdir = Path(args.outdir)
    if not args.no_images:
        outdir.mkdir(parents=True, exist_ok=True)

    print(f"PDF          : {pdf_path}")
    print(f"페이지 수     : {result.page_count}")
    print(
        f"PUA 비율      : {result.pua_ratio:.4f} "
        f"(임계값 {result.pua_threshold}) -> 모드 '{result.mode}'"
    )
    print(f"문제 수       : {len(result.problems)}")
    print("AI 호출       : 0회 (비용 0원)")
    print("-" * 78)
    print(f"{'no':>3} {'page':>4}  {'bbox (x0,y0,x1,y1)':<32} {'crop px':>11}  file")
    print("-" * 78)

    for problem in result.problems:
        bbox_text = ",".join(f"{v:.0f}" for v in problem.bbox)
        filename = ""
        if problem.image_b64 is not None:
            filename = f"p{problem.page:02d}_q{problem.no:02d}.png"
            (outdir / filename).write_bytes(base64.b64decode(problem.image_b64))
        print(
            f"{problem.no:>3} {problem.page:>4}  {bbox_text:<32} "
            f"{problem.image_w:>4}x{problem.image_h:<6}  {filename}"
        )

    print("-" * 78)
    numbers = [p.no for p in result.problems]
    if numbers:
        expected = list(range(numbers[0], numbers[0] + len(numbers)))
        gaps = sorted(set(expected) - set(numbers))
        print(f"번호 범위     : {numbers[0]} ~ {numbers[-1]}")
        print(
            f"연속성        : {'OK (빠짐 없음)' if not gaps else f'빠진 번호 {gaps}'}"
        )
    if not args.no_images:
        print(f"크롭 저장     : {outdir.resolve()}")

    if args.json:
        summary = result.to_dict()
        for item in summary["problems"]:
            item.pop("image_b64", None)
        print(json.dumps(summary, ensure_ascii=False, indent=2))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
