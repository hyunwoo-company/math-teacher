r"""PDF 텍스트 레이어의 PUA 수식을 LaTeX 로 복원한다 (AI 호출 없음, 비용 0원).

## 무엇을 하는가

입력은 **PDF 페이지 + 문항 bbox**, 출력은 **LaTeX 문자열 + 신뢰도 판정**이다.
한글 수식편집기로 조판된 시험지는 수식이 사설영역(PUA) 문자로 나오는데,
`pua_table` 의 매핑표로 글자를 되돌리고 글자마다 딸려오는 좌표·크기로 2차원
구조(지수·첨자·분수·근호·벡터)를 재구성한다.

## 어떻게 2차원을 복원하는가

`page.get_text("rawdict")` 는 글자마다 `bbox` 와 원점(baseline), 스팬의 `size` 를
준다. 이 셋만으로 다음이 갈린다.

* **지수/아래첨자**: 크기가 본문의 0.8배 미만이고 baseline 이 위/아래로 밀렸다.
  실측(개포고 1번): 본문 `size=8.9`, 지수 `size=6.0`(0.67배) + baseline 상승.
* **분수·근호·벡터·윗줄**: 늘어나는 가로 막대 글리프(`pua_table.BAR`, 오프셋 109)가
  기준점이다. 막대의 x 범위 안에 있는 글자를 baseline 으로 뭉쳐서

  | 주변 조건 | 뜻 |
  |---|---|
  | 오른쪽에 화살촉(`ARROW_HEAD`) | `\vec{아래}` |
  | 왼쪽에 근호 갈고리(`RADICAL_HOOK`) | `\sqrt{아래}` |
  | 막대 위·아래에 모두 내용 | `\frac{위}{아래}` |
  | 아래에만 내용 | `\overline{아래}` |

  스펙(§2-4)은 이 가로선이 `page.get_drawings()` 의 그래픽으로 올 것이라고 적었지만
  **실측 결과 틀렸다.** 선은 텍스트 레이어의 글리프이고 같은 자리에 그래픽 요소는
  없다. 오히려 이게 더 안전하다 — 선의 x 범위가 곧 내용의 x 범위라 묶을 대상이
  명확하다.

## 보수적으로 판정한다

잘못 복원한 문항을 내보내는 것은 이미지로 내보내는 것보다 **나쁘다.** 그래서
미확인 오프셋, 추측 매핑, 구조 판정 실패, 괄호 짝 불일치, 그래픽 요소 다수 중
하나라도 있으면 `ok=False` 로 내린다. 호출부는 그때 2차 경로(AI 비전)나 크롭
이미지로 폴백한다.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from statistics import median
from typing import Final, Literal

import fitz

import pua_table as table

# ── 임계값 (전부 4개 시험지 PDF 실측에서 나왔다) ──────────────────────

#: 이보다 작은 글자는 눈에 보이지 않는 워터마크다. 실측: 일일테스트에 `size=0.12`
#: 짜리 base64 잡문(`ZXI9TJt9cFoD...`)이 본문 사이에 깔려 있고, 반배치에는
#: `size=0.12` 짜리 무의미한 라틴 글자가 글자마다 끼어 있다. 걸러야 한다.
MIN_GLYPH_SIZE: Final[float] = 1.0

#: 본문 대비 이 배율 미만이면 첨자 후보. 실측 지수/본문 = 6.0/8.9 = 0.67.
SCRIPT_SIZE_RATIO: Final[float] = 0.8

#: 첨자로 인정할 최소 baseline 이동(본문 크기 대비). 실측 이동량은 0.45배였다.
SCRIPT_SHIFT_RATIO: Final[float] = 0.15

#: 막대 내용을 한 덩어리로 이을 baseline 간격(본문 크기 대비).
#: 분모 안의 지수까지 한 덩어리로 묶어야 한다. 실측: `2^{m+n}` 의 밑과 지수
#: baseline 차이가 0.42배(개포고 p3), 근호 안 `x^2` 는 0.45배(반배치 p1).
CONTENT_CLUSTER_GAP: Final[float] = 0.55

#: 막대의 원점에서 이만큼 위를 '위/아래' 경계로 본다(본문 크기 대비).
#: 실측 분자 delta <= -0.62, 분모 delta >= +0.05 이라 그 사이면 된다.
BAR_SPLIT_SHIFT: Final[float] = 0.30

#: 막대에서 분자/분모까지 허용 거리(본문 크기 대비). 넘으면 다른 줄로 본다.
#: 실측 최대: 분자 1.53배, 분모 0.46배. 인접 선택지 줄은 2.0배 이상이었다.
ABOVE_MAX_DISTANCE: Final[float] = 1.9
BELOW_MAX_DISTANCE: Final[float] = 1.4

#: 막대 내용 후보를 훑는 세로 창(본문 크기 대비). 이 밖은 아예 보지 않는다.
CONTENT_WINDOW: Final[float] = 3.0

#: 막대 x 범위 판정 여유(pt).
BAR_X_TOLERANCE: Final[float] = 0.5

#: 근호 갈고리가 막대에 붙었다고 볼 가로 여유(pt)와 세로 여유(본문 크기 대비).
#: 실측(반배치 p1): 갈고리 x1=50.49, 막대 x0=49.77 로 살짝 겹친다.
HOOK_X_TOLERANCE: Final[float] = 3.0
HOOK_Y_TOLERANCE: Final[float] = 1.2

#: 화살촉이 막대와 짝이라고 볼 여유. 실측(일일 p0) baseline 차이는 정확히 0 이었다.
HEAD_X_TOLERANCE: Final[float] = 3.0
HEAD_Y_TOLERANCE: Final[float] = 0.5

#: 분수 전체의 '줄 baseline' 을 막대 원점에서 되돌리는 보정(내용 크기 대비).
#: 실측: 주변 본문 baseline = 막대 원점 - 0.33 x 본문크기 (0.324~0.338, 표본 9).
FRAC_AXIS_SHIFT: Final[float] = 0.33

#: 분수로 인정할 분자의 최대 중심 어긋남(막대 폭 대비).
#:
#: 분수와 윗줄(`\overline`)은 둘 다 '막대 + 아래 내용' 모양이라 위 내용의 유무만으로는
#: 갈리지 않는다. 윗줄인데 위쪽 다른 줄의 글자가 막대 x 범위에 겹쳐 '분자'로 새어
#: 들어오는 일이 실제로 있다(실측: 개포고 11번의 `\overline{AG}` 가 윗줄 숫자를
#: 분자로 집어 `\frac{2}{AG}` 가 됐다).
#:
#: 막대 **크기**로는 못 가른다 — `size` 는 막대의 세로 높이가 아니라 **가로 폭**에
#: 따라 커진다(실측: 폭 4.3pt->size 8.75, 폭 108.9pt->size 44.3). 대신 분수는 분자를
#: 막대 폭 안에서 **가운데 정렬**한다는 성질을 쓴다.
#: 실측: 진짜 분자 16개는 어긋남 <= 0.03, 새어 들어온 것 2개는 0.32/0.45.
FRAC_CENTER_TOLERANCE: Final[float] = 0.15

#: baseline 차이가 본문 크기의 이 배율을 넘으면 다른 줄로 본다.
#: 첨자 이동(0.45배)보다 크고 실측 줄간격(1.4배 이상)보다 작아야 한다.
LINE_BREAK_GAP: Final[float] = 0.75

#: bbox 안의 '도형처럼 보이는' 그래픽 요소를 이 개수 넘게 만나면 이미지로 폴백한다.
#: 조건 상자(가)(나)나 밑줄 몇 개는 통과하고, 좌표평면·도형은 걸린다.
MAX_SHAPES: Final[int] = 6

_Kind = Literal["char", "frac", "sqrt", "overline", "vec"]


@dataclass(frozen=True)
class DecodeResult:
    r"""디코딩 결과.

    Attributes:
        latex: 복원한 본문. 수식 구간은 `\\( ... \\)` 로 감싼다. 실패면 None.
        ok: 신뢰할 수 있는가. False 면 호출부가 폴백해야 한다.
        reason: 실패/저신뢰 이유(로그·UI 표시용). 신뢰할 수 있으면 None.
        unknown_offsets: 매핑표에 없던 오프셋. 표를 넓힐 단서다.
    """

    latex: str | None
    ok: bool
    reason: str | None
    unknown_offsets: list[int]


@dataclass(frozen=True)
class _Glyph:
    """PDF 글자 하나. `rawdict` 한 항목에서 뽑은 것."""

    text: str
    offset: int | None
    is_eq: bool
    size: float
    x0: float
    y0: float
    x1: float
    y1: float
    baseline: float


@dataclass(eq=False)
class _Atom:
    """조판 단위. 글자 하나이거나, 막대로 묶인 2차원 구조 하나다.

    `eq=False` 로 두어 동일성 비교가 **신원 기준**이 되게 한다. 같은 문자·같은
    좌표의 원자가 둘 있어도 서로 다른 원자로 다뤄야 풀(pool)에서 정확히 하나만
    빠진다.
    """

    kind: _Kind
    x0: float
    x1: float
    baseline: float
    size: float
    is_math: bool
    glyph: _Glyph | None = None
    #: 구조 원자의 하위 내용. frac 은 (위, 아래), 그 외는 (아래,).
    parts: tuple[list[_Atom], ...] = ()


@dataclass
class _Notes:
    """디코딩 중 모은 신뢰도 흠집."""

    unknown: set[int] = field(default_factory=set)
    uncertain: set[int] = field(default_factory=set)
    reasons: list[str] = field(default_factory=list)

    def add_reason(self, reason: str) -> None:
        """같은 이유를 중복 없이 쌓는다.

        Args:
            reason: 사람이 읽을 이유 한 줄.
        """
        if reason not in self.reasons:
            self.reasons.append(reason)


# ── 1단계: 글자 수집 ─────────────────────────────────────────────────


def _collect_glyphs(page: fitz.Page, rect: fitz.Rect) -> list[_Glyph]:
    """영역(bbox) 안에 중심이 들어오는 글자를 좌표·크기와 함께 모은다.

    Args:
        page: 대상 페이지.
        rect: 문항 영역.

    Returns:
        읽는 순서와 무관한 글자 목록(순서는 뒤에서 좌표로 다시 잡는다).
    """
    glyphs: list[_Glyph] = []
    for block in page.get_text("rawdict").get("blocks", []):
        if block.get("type") != 0:  # 0 = 텍스트
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                size = float(span.get("size", 0.0))
                if size < MIN_GLYPH_SIZE:
                    continue  # 보이지 않는 워터마크
                is_eq = table.EQ_FONT_HINT in str(span.get("font", ""))
                for char in span.get("chars", []):
                    text = str(char["c"])
                    x0, y0, x1, y1 = (float(v) for v in char["bbox"])
                    if not (
                        rect.x0 <= (x0 + x1) / 2 <= rect.x1
                        and rect.y0 <= (y0 + y1) / 2 <= rect.y1
                    ):
                        continue
                    glyphs.append(
                        _Glyph(
                            text=text,
                            offset=table.offset_of(text),
                            is_eq=is_eq,
                            size=size,
                            x0=x0,
                            y0=y0,
                            x1=x1,
                            y1=y1,
                            baseline=float(char["origin"][1]),
                        )
                    )
    return glyphs


def _body_size(glyphs: Iterable[_Glyph]) -> float:
    """본문 글자 크기를 다수결로 잡는다.

    막대 글리프는 늘어나면서 크기가 부풀기 때문에(실측 최대 44pt) 구조 글리프는
    빼고 센다. 같은 표수면 큰 쪽을 고른다.

    Args:
        glyphs: 대상 글자들.

    Returns:
        본문 크기(pt). 셀 것이 없으면 0.0.
    """
    counter: Counter[float] = Counter()
    for glyph in glyphs:
        if glyph.offset is not None and glyph.offset in table.STRUCTURAL:
            continue
        if not glyph.text.strip():
            continue
        counter[round(glyph.size, 1)] += 1
    if not counter:
        return 0.0
    best = max(counter.items(), key=lambda item: (item[1], item[0]))
    return best[0]


# ── 2·4단계: 문자 치환과 구조 묶기 ──────────────────────────────────


def _char_atom(glyph: _Glyph) -> _Atom:
    """글자 하나를 원자로 감싼다.

    Args:
        glyph: 원본 글자.

    Returns:
        `kind="char"` 원자.
    """
    return _Atom(
        kind="char",
        x0=glyph.x0,
        x1=glyph.x1,
        baseline=glyph.baseline,
        size=glyph.size,
        is_math=glyph.is_eq,
        glyph=glyph,
    )


def _offset_of(atom: _Atom) -> int | None:
    """수식 폰트 글자 원자의 오프셋. 그 외는 None.

    Args:
        atom: 검사할 원자.

    Returns:
        오프셋, 또는 해당 없으면 None.
    """
    if atom.kind != "char" or atom.glyph is None or not atom.glyph.is_eq:
        return None
    return atom.glyph.offset


def _cluster_by_baseline(atoms: Sequence[_Atom], body: float) -> list[list[_Atom]]:
    """기준선(baseline)이 가까운 원자끼리 뭉친다.

    첨자까지 한 덩어리로 묶으려고 간격 기준을 `CONTENT_CLUSTER_GAP` 로 넉넉히
    잡는다.

    Args:
        atoms: 대상 원자들(비어 있지 않아야 한다).
        body: 본문 크기.

    Returns:
        baseline 오름차순으로 정렬된 덩어리 목록.
    """
    ordered = sorted(atoms, key=lambda atom: atom.baseline)
    groups: list[list[_Atom]] = [[ordered[0]]]
    limit = CONTENT_CLUSTER_GAP * body
    for atom in ordered[1:]:
        if atom.baseline - groups[-1][-1].baseline <= limit:
            groups[-1].append(atom)
        else:
            groups.append([atom])
    return groups


def _representative(atoms: Sequence[_Atom]) -> _Atom:
    """덩어리를 대표하는 원자(가장 큰 글자)를 고른다.

    Args:
        atoms: 한 덩어리(비어 있지 않아야 한다).

    Returns:
        크기가 가장 큰 원자. 같으면 가장 왼쪽.
    """
    return max(atoms, key=lambda atom: (atom.size, -atom.x0))


def _find_partner(
    pool: Sequence[_Atom], bar: _Atom, wanted: int, body: float
) -> _Atom | None:
    """막대의 짝(근호 갈고리 / 화살촉)을 찾는다.

    Args:
        pool: 아직 소비되지 않은 원자들.
        bar: 막대 원자.
        wanted: 찾을 오프셋(`RADICAL_HOOK` 또는 `ARROW_HEAD`).
        body: 본문 크기.

    Returns:
        짝 원자, 또는 없으면 None.
    """
    for atom in pool:
        if _offset_of(atom) != wanted:
            continue
        if wanted == table.RADICAL_HOOK:
            close_x = abs(atom.x1 - bar.x0) <= HOOK_X_TOLERANCE
            close_y = abs(atom.baseline - bar.baseline) <= HOOK_Y_TOLERANCE * body
        else:
            close_x = bar.x0 - HEAD_X_TOLERANCE <= atom.x0 <= bar.x1 + HEAD_X_TOLERANCE
            close_y = abs(atom.baseline - bar.baseline) <= HEAD_Y_TOLERANCE * body
        if close_x and close_y:
            return atom
    return None


def _bar_content(
    pool: Sequence[_Atom], bar: _Atom, body: float
) -> tuple[list[_Atom] | None, list[_Atom] | None, bool]:
    """막대 위/아래의 내용 덩어리를 고른다.

    막대의 x 범위 안에 중심이 있는 **수식 원자만** 후보로 본다. 한글 본문을 후보에서
    빼는 것이 중요하다 — 늘어난 막대의 em 상자는 최대 44pt 라 위/아래 줄의 한글까지
    삼킬 수 있다(실측: 개포고 p3 의 "복소수").

    Args:
        pool: 아직 소비되지 않은 원자들.
        bar: 막대 원자.
        body: 본문 크기.

    Returns:
        (위 덩어리, 아래 덩어리, 모호함 여부). 덩어리가 없으면 None,
        경계에 걸친 덩어리가 있으면 세 번째 값이 True.
    """
    candidates = [
        atom
        for atom in pool
        if atom is not bar
        and atom.is_math
        and _offset_of(atom) not in (table.ARROW_HEAD, table.RADICAL_HOOK)
        and bar.x0 - BAR_X_TOLERANCE
        <= (atom.x0 + atom.x1) / 2
        <= bar.x1 + BAR_X_TOLERANCE
        and abs(atom.baseline - bar.baseline) <= CONTENT_WINDOW * body
    ]
    if not candidates:
        return None, None, False

    split = bar.baseline - BAR_SPLIT_SHIFT * body
    above: list[list[_Atom]] = []
    below: list[list[_Atom]] = []
    ambiguous = False
    for group in _cluster_by_baseline(candidates, body):
        highest = min(atom.baseline for atom in group)
        lowest = max(atom.baseline for atom in group)
        if lowest < split:
            above.append(group)
        elif highest >= split:
            below.append(group)
        else:
            ambiguous = True  # 경계를 걸친 덩어리 -> 구조를 믿을 수 없다

    chosen_above = above[-1] if above else None
    if chosen_above is not None:
        distance = bar.baseline - max(atom.baseline for atom in chosen_above)
        if distance > ABOVE_MAX_DISTANCE * body:
            chosen_above = None
    chosen_below = below[0] if below else None
    if chosen_below is not None:
        distance = min(atom.baseline for atom in chosen_below) - bar.baseline
        if distance > BELOW_MAX_DISTANCE * body:
            chosen_below = None
    return chosen_above, chosen_below, ambiguous


def _classify_bar(
    bar: _Atom,
    hook: _Atom | None,
    head: _Atom | None,
    above: list[_Atom] | None,
    below: list[_Atom] | None,
    notes: _Notes,
) -> tuple[_Kind, list[_Atom] | None, list[_Atom]] | None:
    """막대의 역할과 **실제로 쓸** 내용을 정한다.

    쓰지 않을 내용은 돌려주지 않는다. 안 쓸 내용을 소비해 버리면 그 글자가 결과에서
    조용히 사라진다(실측 버그: 다음 줄 근호가 윗줄의 `)` 를 분자로 집어삼켰다).

    분수와 윗줄(overline)은 둘 다 '막대 + 아래 내용' 모양이라 위 내용의 유무만으로는
    가릴 수 없다. 분자가 막대 폭 안에서 **가운데 정렬**되는지를 함께 본다
    (`FRAC_CENTER_TOLERANCE`).

    Args:
        bar: 막대 원자.
        hook: 근호 갈고리(없으면 None).
        head: 화살촉(없으면 None).
        above: 막대 위 내용(없으면 None).
        below: 막대 아래 내용(없으면 None).
        notes: 신뢰도 흠집을 쌓을 곳.

    Returns:
        (역할, 위 내용, 아래 내용). 접을 수 없으면 None.
    """
    if head is not None or hook is not None:
        kind: _Kind = "vec" if head is not None else "sqrt"
        if below is None:
            notes.add_reason("근호/벡터 안의 내용을 찾지 못했다")
            return None
        return kind, None, below

    if below is None:
        notes.add_reason("가로선 아래 내용이 없다")
        return None
    if above is None:
        return "overline", None, below

    width = bar.x1 - bar.x0
    center = (bar.x0 + bar.x1) / 2
    above_center = (min(a.x0 for a in above) + max(a.x1 for a in above)) / 2
    if width <= 0 or abs(above_center - center) > FRAC_CENTER_TOLERANCE * width:
        # 가운데 정렬이 아니다 -> 위쪽 다른 줄에서 새어 들어온 글자다. 윗줄로 보고
        # 그 글자는 소비하지 않는다(소비하면 결과에서 조용히 사라진다).
        return "overline", None, below
    return "frac", above, below


def _make_composite(
    bar: _Atom,
    hook: _Atom | None,
    head: _Atom | None,
    kind: _Kind,
    above: list[_Atom] | None,
    below: list[_Atom],
) -> _Atom:
    """막대와 그 내용으로 구조 원자를 만든다.

    Args:
        bar: 막대 원자.
        hook: 근호 갈고리(없으면 None).
        head: 화살촉(없으면 None).
        kind: `_classify_bar` 가 정한 역할.
        above: 분수의 분자(그 외 역할이면 None).
        below: 막대 아래 내용.

    Returns:
        `frac`/`sqrt`/`vec`/`overline` 중 하나의 원자.
    """
    content = [*(above or []), *below]
    members = [bar, *([hook] if hook else []), *([head] if head else []), *content]
    x0 = min(atom.x0 for atom in members)
    x1 = max(atom.x1 for atom in members)
    size = max((atom.size for atom in content), default=bar.size)

    if kind == "frac":
        baseline = bar.baseline - FRAC_AXIS_SHIFT * size
        parts: tuple[list[_Atom], ...] = (above or [], below)
    else:
        # 근호·벡터·윗줄은 아래 내용의 baseline 이 그 줄의 baseline 자체다.
        baseline = _representative(below).baseline if below else bar.baseline
        parts = (below,)

    return _Atom(
        kind=kind,
        x0=x0,
        x1=x1,
        baseline=baseline,
        size=size,
        is_math=True,
        parts=parts,
    )


def _build_atoms(glyphs: Sequence[_Glyph], body: float, notes: _Notes) -> list[_Atom]:
    """글자 목록을 조판 원자 목록으로 바꾼다.

    막대를 **좁은 것부터** 처리한다. 중첩 구조는 안쪽이 항상 더 좁으므로, 안쪽이
    먼저 구조 원자로 접히고 밖쪽 막대는 그 접힌 원자를 내용으로 집는다.

    Args:
        glyphs: bbox 안의 글자들.
        body: 본문 크기.
        notes: 신뢰도 흠집을 쌓을 곳.

    Returns:
        최상위 원자 목록(순서 없음).
    """
    pool: list[_Atom] = [_char_atom(glyph) for glyph in glyphs]
    bars = sorted(
        (atom for atom in pool if _offset_of(atom) == table.BAR),
        key=lambda atom: atom.x1 - atom.x0,
    )

    for bar in bars:
        if bar not in pool:
            continue  # 더 넓은 막대의 내용으로 이미 먹혔다
        head = _find_partner(pool, bar, table.ARROW_HEAD, body)
        hook = (
            None if head else _find_partner(pool, bar, table.RADICAL_HOOK, body)
        )
        above, below, ambiguous = _bar_content(pool, bar, body)
        if ambiguous:
            notes.add_reason("가로선 위/아래 경계가 모호하다")
        role = _classify_bar(bar, hook, head, above, below, notes)
        if role is None:
            # 접지 않고 남겨 두면 `_render_atom` 이 흠집을 남긴다.
            continue
        kind, numerator, denominator = role
        composite = _make_composite(bar, hook, head, kind, numerator, denominator)

        consumed = {
            id(atom)
            for atom in (bar, hook, head, *(numerator or []), *denominator)
            if atom is not None
        }
        pool = [atom for atom in pool if id(atom) not in consumed]
        pool.append(composite)

    return pool


# ── 3·5단계: 첨자와 괄호, 그리고 LaTeX 출력 ─────────────────────────


def _render_atom(atom: _Atom, notes: _Notes, *, wrap_parens: bool) -> str:
    r"""원자 하나를 LaTeX 조각으로 만든다.

    Args:
        atom: 대상 원자.
        notes: 신뢰도 흠집을 쌓을 곳.
        wrap_parens: True 면 소괄호를 `\\left(`/`\\right)` 로 낸다.

    Returns:
        LaTeX 조각.
    """
    if atom.kind == "frac":
        above = _render_sequence(atom.parts[0], notes)
        below = _render_sequence(atom.parts[1], notes)
        return rf"\frac{{{above}}}{{{below}}}"
    if atom.kind in ("sqrt", "overline", "vec"):
        inner = _render_sequence(atom.parts[0], notes)
        command = {"sqrt": r"\sqrt", "overline": r"\overline", "vec": r"\vec"}[
            atom.kind
        ]
        return f"{command}{{{inner}}}"

    glyph = atom.glyph
    if glyph is None:  # 방어적: char 원자는 항상 글자를 갖는다
        return ""
    if not glyph.is_eq:
        return glyph.text
    if glyph.offset is None:
        return glyph.text
    if glyph.offset in table.STRUCTURAL:
        # 구조로 접히지 못하고 남은 가로선/화살촉/근호. 매핑표 문제가 아니므로
        # `unknown_offsets`(표 확장 단서) 를 더럽히지 않고 흠집만 남긴다.
        notes.add_reason("가로선·근호·화살촉을 구조로 묶지 못했다")
        return r"\sqrt{}" if glyph.offset == table.RADICAL_HOOK else "?"

    entry = table.lookup(glyph.offset)
    if entry is None:
        notes.unknown.add(glyph.offset)
        return "?"
    if not entry.certain:
        notes.uncertain.add(glyph.offset)
    if wrap_parens and glyph.offset == table.PAREN_OPEN:
        return r"\left("
    if wrap_parens and glyph.offset == table.PAREN_CLOSE:
        return r"\right)"
    return entry.latex


def _parens_balanced(atoms: Sequence[_Atom]) -> bool:
    """이 층의 소괄호가 순서까지 맞는지 본다.

    Args:
        atoms: x 순으로 정렬된 원자들.

    Returns:
        짝이 맞으면 True.
    """
    depth = 0
    for atom in atoms:
        offset = _offset_of(atom)
        if offset == table.PAREN_OPEN:
            depth += 1
        elif offset == table.PAREN_CLOSE:
            depth -= 1
            if depth < 0:
                return False
    return depth == 0


def _script_of(atom: _Atom, body: float, base_line: float) -> Literal["", "^", "_"]:
    """원자가 지수인지 아래첨자인지 본문인지 가린다.

    Args:
        atom: 대상 원자.
        body: 이 층의 본문 크기.
        base_line: 이 층의 본문 baseline.

    Returns:
        `"^"`(지수), `"_"`(아래첨자), 또는 `""`(본문).
    """
    if not atom.is_math or atom.kind != "char":
        return ""
    if atom.size >= SCRIPT_SIZE_RATIO * body:
        return ""
    shift = atom.baseline - base_line
    if shift < -SCRIPT_SHIFT_RATIO * body:
        return "^"
    if shift > SCRIPT_SHIFT_RATIO * body:
        return "_"
    return ""


def _render_sequence(atoms: Sequence[_Atom], notes: _Notes) -> str:
    r"""한 층의 원자들을 x 순으로 이어 LaTeX 로 만든다.

    같은 층 안에서 크기·baseline 으로 지수/아래첨자를 가려 `^{}` / `_{}` 로 묶고,
    소괄호 짝이 맞으면 `\\left( \\right)` 로 감싼다.

    Args:
        atoms: 같은 층의 원자들.
        notes: 신뢰도 흠집을 쌓을 곳.

    Returns:
        LaTeX 조각. 원자가 없으면 빈 문자열.
    """
    if not atoms:
        return ""
    ordered = sorted(atoms, key=lambda atom: atom.x0)
    # 이 층의 본문 크기는 **가장 큰 글자**다. 첨자는 본문보다 작기만 하고 크지 않으므로
    # 최댓값이 곧 기준선 그룹의 크기다.
    #
    # 다수결로 잡으면 안 된다: `S_1^2+S_2^2+S_3^2` 처럼 첨자가 본문보다 많은 층에서
    # 첨자 크기가 본문으로 뽑혀 첨자가 전부 본문으로 내려앉는다(실측 버그: 개포고
    # 11번이 `S12+S22+S32` 로 나왔다).
    sizes = [atom.size for atom in ordered if atom.is_math and atom.kind == "char"]
    body = max(sizes) if sizes else max(atom.size for atom in ordered)
    main = [
        atom.baseline
        for atom in ordered
        if atom.is_math and atom.size >= SCRIPT_SIZE_RATIO * body
    ]
    base_line = median(main) if main else median([atom.baseline for atom in ordered])
    wrap = _parens_balanced(ordered)

    pieces: list[str] = []
    run: list[str] = []
    run_script: Literal["", "^", "_"] = ""

    def flush() -> None:
        """모아 둔 첨자 묶음을 내보낸다."""
        if not run:
            return
        body_text = "".join(run)
        pieces.append(body_text if run_script == "" else f"{run_script}{{{body_text}}}")
        run.clear()

    for atom in ordered:
        script = _script_of(atom, body, base_line)
        if script != run_script:
            flush()
            run_script = script
        run.append(_render_atom(atom, notes, wrap_parens=wrap))
    flush()
    return "".join(pieces).strip()


def _group_lines(atoms: Sequence[_Atom], body: float) -> list[list[_Atom]]:
    """최상위 원자를 시각적인 줄로 묶는다.

    Args:
        atoms: 최상위 원자들.
        body: 본문 크기.

    Returns:
        위에서 아래로 정렬된 줄 목록. 각 줄은 x 순으로 정렬돼 있다.
    """
    if not atoms:
        return []
    ordered = sorted(atoms, key=lambda atom: atom.baseline)
    lines: list[list[_Atom]] = [[ordered[0]]]
    limit = LINE_BREAK_GAP * body
    for atom in ordered[1:]:
        # 아래첨자(baseline 이 내려간 작은 글자)가 기준을 끌어내려 다음 줄을
        # 삼키지 않도록, 본문 크기 글자만 기준으로 삼는다.
        main = [
            item.baseline
            for item in lines[-1]
            if item.size >= SCRIPT_SIZE_RATIO * body
        ]
        reference = max(main) if main else max(item.baseline for item in lines[-1])
        if atom.baseline - reference <= limit:
            lines[-1].append(atom)
        else:
            lines.append([atom])
    return [sorted(line, key=lambda atom: atom.x0) for line in lines]


def _render_line(atoms: Sequence[_Atom], notes: _Notes) -> str:
    r"""한 줄을 '본문 + `\( 수식 \)`' 섞인 문자열로 만든다.

    수식 원자가 이어지는 구간만 수식으로 감싼다. 수식 사이에 낀 **공백**은 구간을
    끊지 않는다(한글 폰트의 공백이 수식 중간에 들어오는 조판이 흔하다).

    Args:
        atoms: x 순으로 정렬된 한 줄의 원자들.
        notes: 신뢰도 흠집을 쌓을 곳.

    Returns:
        줄 문자열.
    """
    out: list[str] = []
    index = 0
    while index < len(atoms):
        atom = atoms[index]
        if not atom.is_math:
            glyph = atom.glyph
            out.append(glyph.text if glyph is not None else "")
            index += 1
            continue

        # 수식이 마지막으로 나온 자리까지를 한 구간으로 삼는다. 중간에 낀 공백은
        # 구간 안에 남기고, 구간 뒤에 남은 공백은 본문으로 되돌린다.
        cursor = index
        last_math = index
        while cursor < len(atoms):
            current = atoms[cursor]
            if current.is_math:
                last_math = cursor
                cursor += 1
                continue
            glyph = current.glyph
            if glyph is not None and not glyph.text.strip():
                cursor += 1
                continue
            break
        body = _render_sequence(atoms[index : last_math + 1], notes)
        out.append(rf"\({body}\)" if body else "")
        index = last_math + 1
    return "".join(out)


# ── 6단계: 신뢰도 판정 ──────────────────────────────────────────────


def _graphics_reason(page: fitz.Page, rect: fitz.Rect) -> str | None:
    """영역(bbox) 안에 그림·도형이 있으면 이유를, 없으면 None 을 돌려준다.

    Args:
        page: 대상 페이지.
        rect: 문항 영역.

    Returns:
        폴백 이유, 또는 문제 없으면 None.
    """
    for block in page.get_text("rawdict").get("blocks", []):
        if block.get("type") != 1:  # 1 = 이미지
            continue
        if rect.intersects(fitz.Rect(*(float(v) for v in block["bbox"]))):
            return "그림(이미지)이 들어 있다"

    shapes = 0
    for drawing in page.get_drawings():
        box = drawing["rect"]
        if not rect.intersects(box):
            continue
        if box.width > 3.0 and box.height > 3.0:
            shapes += 1
    if shapes > MAX_SHAPES:
        return f"도형처럼 보이는 그래픽 요소가 많다({shapes}개)"
    return None


def _pair_reason(glyphs: Sequence[_Glyph]) -> str | None:
    """괄호 짝이 맞는지 본다.

    Args:
        glyphs: bbox 안의 글자들.

    Returns:
        불일치 이유, 또는 문제 없으면 None.
    """
    counter = Counter(
        glyph.offset for glyph in glyphs if glyph.is_eq and glyph.offset is not None
    )
    pairs = (
        ("소괄호", table.PAREN_OPEN, table.PAREN_CLOSE),
        ("중괄호", table.BRACE_OPEN, table.BRACE_CLOSE),
    )
    for name, open_off, close_off in pairs:
        if counter[open_off] != counter[close_off]:
            return f"{name} 짝이 맞지 않는다({counter[open_off]}:{counter[close_off]})"
    if counter[table.ABS_BAR] % 2 != 0:
        return f"절댓값 막대가 홀수 개다({counter[table.ABS_BAR]}개)"
    return None


def decode_region(page: fitz.Page, bbox: Sequence[float]) -> DecodeResult:
    """문항 영역의 텍스트 레이어를 LaTeX 로 복원한다.

    Args:
        page: 문항이 있는 PDF 페이지.
        bbox: 문항 영역 `(x0, y0, x1, y1)`.

    Returns:
        복원 결과. `ok=False` 면 값을 믿지 말고 폴백해야 한다.

    Raises:
        ValueError: `bbox` 가 네 값이 아닐 때.
    """
    if len(bbox) != 4:
        raise ValueError("bbox 는 (x0, y0, x1, y1) 네 값이어야 합니다.")
    rect = fitz.Rect(*bbox)

    glyphs = _collect_glyphs(page, rect)
    if not glyphs:
        return DecodeResult(
            latex=None, ok=False, reason="영역에 글자가 없다", unknown_offsets=[]
        )

    notes = _Notes()
    body = _body_size(glyphs)
    if body <= 0.0:
        return DecodeResult(
            latex=None,
            ok=False,
            reason="본문 글자 크기를 잡지 못했다",
            unknown_offsets=[],
        )

    atoms = _build_atoms(glyphs, body, notes)
    lines = _group_lines(atoms, body)
    latex = "\n".join(
        text for text in (_render_line(line, notes) for line in lines) if text.strip()
    ).strip()

    if not latex:
        return DecodeResult(
            latex=None, ok=False, reason="복원할 내용이 없다", unknown_offsets=[]
        )

    reasons = list(notes.reasons)
    if notes.unknown:
        listed = ", ".join(str(value) for value in sorted(notes.unknown))
        reasons.insert(0, f"매핑표에 없는 오프셋({listed})")
    if notes.uncertain:
        listed = ", ".join(str(value) for value in sorted(notes.uncertain))
        reasons.insert(0, f"매핑이 추측인 오프셋({listed})")
    graphics = _graphics_reason(page, rect)
    if graphics is not None:
        reasons.append(graphics)
    pairs = _pair_reason(glyphs)
    if pairs is not None:
        reasons.append(pairs)

    return DecodeResult(
        latex=latex,
        ok=not reasons,
        reason=" / ".join(reasons) if reasons else None,
        unknown_offsets=sorted(notes.unknown),
    )
