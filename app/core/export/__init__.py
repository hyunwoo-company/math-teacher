"""문서 내보내기 패키지.

공통 문서 모델(`model.ExportDoc`) 하나를 형식별 렌더러가 받는다.
문서 구성(대상별 블록 조립)은 `build.py` 에 모여 있다.

    build.build_exam_doc(...) -> ExportDoc -> build_docx(doc) / build_hwpx(doc)
"""

from __future__ import annotations

from export.docx import build_docx
from export.hwpx import build_hwpx

__all__ = ["build_docx", "build_hwpx"]
