"""내보내기 지면 치수 (형식 공통).

`docx.py` 와 `hwpx.py` 는 같은 크롭 이미지를 같은 A4 지면 위에 앉힌다. 두 렌더러가
폭을 따로 하드코딩하면 한쪽만 고쳐졌을 때 조용히 어긋난다 — 실제로 docx 를 A4
(본문 폭 150mm)로 맞춘 뒤에도 hwpx 상한이 6인치(152.4mm)로 남아 넓은 크롭이
오른쪽 여백을 2.4mm 침범했다. 그래서 치수는 이 모듈에서만 정의한다.

`model.py` 와 나누는 기준: `model.py` 는 문서의 **내용 표현**(제목·블록)이고,
이 모듈은 그것을 종이에 앉힐 때의 **치수**다.

2단 조판 치수(단 수·단 간격·단 폭·문항 간격)도 여기에 둔다. 어느 문서가 2단인지는
`model.ExportDoc.two_column` 이 정하고(= 문서의 성격), 그때 쓸 **치수**는 이 모듈이
정한다 — 두 렌더러가 같은 폭으로 앉혀야 한 문서가 두 형식에서 같은 모양이 된다.

수치는 python-hwpx 가 만드는 hwpx 의 `Contents/section0.xml` 실측값이다
(HWPUNIT = 1/7200in): 용지 `59528x84186`(= A4 210x297mm), 좌우 여백 각 `8504`
(= 30mm), 위 `5668`(= 20mm), 아래 `4252`(= 15mm). hwpx 는 이 값이 기본이라
설정하지 않고, docx 는 python-docx 기본값이 Letter 라 여기에 맞춰 준다.
"""

from __future__ import annotations

from typing import Final

#: mm ↔ 인치 환산 상수.
MM_PER_INCH: Final[float] = 25.4

#: 용지(A4).
PAGE_WIDTH_MM: Final[int] = 210
PAGE_HEIGHT_MM: Final[int] = 297

#: 여백. hwpx 실측값과 같다. 머리말·꼬리말(각 15mm)은 두 렌더러 모두 쓰지 않는다.
MARGIN_SIDE_MM: Final[int] = 30
MARGIN_TOP_MM: Final[int] = 20
MARGIN_BOTTOM_MM: Final[int] = 15

#: 본문 폭(150mm). 1단 문서의 이미지 폭 상한도 이 값이다 — 넘으면 여백을 침범한다.
BODY_WIDTH_MM: Final[int] = PAGE_WIDTH_MM - 2 * MARGIN_SIDE_MM

#: HWPUNIT 환산 상수(1인치 = 7200 HWPUNIT). hwpx 의 단 간격·문단 여백이 이 단위다.
HWPUNIT_PER_INCH: Final[int] = 7200

#: 2단 조판의 단 수. 시험지·변형 문서의 **본문**(문항·해설)이 이 값이다.
COLUMN_COUNT: Final[int] = 2

#: 단을 걸치는 자리의 단 수. 제목·고지·해설부 표제·출처는 2단 문서에서도 좌우를
#: 가로지르는 한 덩이라(`model.full_width_flags`) 그 자리에서만 1단으로 되돌린다.
#: 상수로 두는 이유는 `1` 이 "단 수" 라는 것을 렌더러 두 곳에서 같이 읽게 하려는
#: 것이다 — docx 는 구역의 `w:cols/@w:num`, hwpx 는 `hp:colPr/@colCount` 로 쓴다.
FULL_WIDTH_COLUMN_COUNT: Final[int] = 1

#: 단 사이 간격(8mm). 시험지 조판의 관례 범위(4~8mm)에서 가장 넓은 쪽을 골랐다 —
#: 두 단 사이에 세로 구분선을 세우므로, 선이 양쪽 글자에 붙어 보이지 않으려면
#: 선 좌우로 각 4mm 는 비어 있어야 한다. 8mm 면 단 폭이 71.0mm 로 딱 떨어져
#: 실측한 크롭 폭(75.0~83.7mm)의 85~95% 가 남는다(그만큼만 축소된다).
COLUMN_GAP_MM: Final[int] = 8

#: 단 하나의 폭(71.0mm). **2단 문서의 이미지 폭 상한**이다. 2단에서 본문 폭
#: (150mm)을 상한으로 쓰면 크롭이 옆 단과 오른쪽 여백을 통째로 덮는다.
COLUMN_WIDTH_MM: Final[float] = (
    BODY_WIDTH_MM - COLUMN_GAP_MM * (COLUMN_COUNT - 1)
) / COLUMN_COUNT

#: 문항과 문항 사이에 넣는 간격(12pt). **문항 첫 문단 앞에만** 넣는다 —
#: 문항 안 문단 사이는 촘촘해야 한 문항이 한 덩이로 보인다.
#: 본문 10pt 짜리 한 줄 높이(10pt x 120% ≈ 12pt)와 같게 잡았다. 빈 줄 하나
#: 만큼이라 71mm 짜리 좁은 단에서도 문항 경계가 바로 읽히고, 빈 문단을
#: 넣지 않으므로 단·페이지 넘김 계산이 흐트러지지 않는다.
ITEM_GAP_PT: Final[int] = 12

__all__ = [
    "BODY_WIDTH_MM",
    "COLUMN_COUNT",
    "COLUMN_GAP_MM",
    "COLUMN_WIDTH_MM",
    "FULL_WIDTH_COLUMN_COUNT",
    "HWPUNIT_PER_INCH",
    "ITEM_GAP_PT",
    "MARGIN_BOTTOM_MM",
    "MARGIN_SIDE_MM",
    "MARGIN_TOP_MM",
    "MM_PER_INCH",
    "PAGE_HEIGHT_MM",
    "PAGE_WIDTH_MM",
]
