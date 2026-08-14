"""내보내기 지면 치수 (형식 공통).

`docx.py` 와 `hwpx.py` 는 같은 크롭 이미지를 같은 A4 지면 위에 앉힌다. 두 렌더러가
폭을 따로 하드코딩하면 한쪽만 고쳐졌을 때 조용히 어긋난다 — 실제로 docx 를 A4
(본문 폭 150mm)로 맞춘 뒤에도 hwpx 상한이 6인치(152.4mm)로 남아 넓은 크롭이
오른쪽 여백을 2.4mm 침범했다. 그래서 치수는 이 모듈에서만 정의한다.

`model.py` 와 나누는 기준: `model.py` 는 문서의 **내용 표현**(제목·블록)이고,
이 모듈은 그것을 종이에 앉힐 때의 **치수**다.

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

#: 본문 폭(150mm). 이미지 폭 상한도 이 값이다 — 넘으면 여백을 침범한다.
BODY_WIDTH_MM: Final[int] = PAGE_WIDTH_MM - 2 * MARGIN_SIDE_MM

__all__ = [
    "BODY_WIDTH_MM",
    "MARGIN_BOTTOM_MM",
    "MARGIN_SIDE_MM",
    "MARGIN_TOP_MM",
    "MM_PER_INCH",
    "PAGE_HEIGHT_MM",
    "PAGE_WIDTH_MM",
]
