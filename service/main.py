"""시험지 PDF 문제 추출 + AI 풀이 비용 실측 테스트 서버.

핵심 설계
---------
* **추출은 코드로**: `/api/extract` 는 AI 를 전혀 호출하지 않는다 (비용 0원).
* **풀이만 AI로**: `/api/solve` 는 선택한 문항만 1문항 1호출로 처리한다.
* 비용은 추정하지 않고 `response.usage` 실측값으로만 계산한다.

실행:
    uvicorn main:app --reload
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any, Final, Literal

from fastapi import FastAPI, File, HTTPException, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import extractor
import pricing
import solver

BASE_DIR: Final[Path] = Path(__file__).resolve().parent
STATIC_DIR: Final[Path] = BASE_DIR / "static"
INDEX_FILE: Final[Path] = STATIC_DIR / "index.html"

MAX_UPLOAD_BYTES: Final[int] = 30 * 1024 * 1024  # 30MB

app = FastAPI(
    title="시험지 문제 추출 + AI 풀이 비용 실측",
    description=(
        "추출은 코드로(비용 0원), 풀이만 AI로. "
        "토큰/비용은 Anthropic 응답의 usage 실측값을 사용합니다."
    ),
    version="0.1.0",
)


@dataclass
class JobRecord:
    """업로드 1건의 추출 결과 (메모리 보관, 영속화 없음)."""

    job_id: str
    filename: str
    pdf_bytes: bytes
    result: extractor.ExtractResult
    problems_by_no: dict[int, dict[str, Any]] = field(default_factory=dict)


JOBS: dict[str, JobRecord] = {}


# --------------------------------------------------------------------------
# 스키마
# --------------------------------------------------------------------------
class ErrorBody(BaseModel):
    """에러 응답 본문 (HTTPException.detail 에 담긴다)."""

    error_code: str
    message: str
    hint: str | None = None


class ErrorResponse(BaseModel):
    detail: ErrorBody


class ProblemOut(BaseModel):
    """추출된 문제 하나."""

    no: int
    page: int
    bbox: list[float]
    text: str
    image_b64: str | None = None
    image_w: int
    image_h: int


class ExtractResponse(BaseModel):
    """`/api/extract` 응답. AI 호출이 없으므로 비용은 항상 0."""

    job_id: str
    filename: str
    page_count: int
    problem_count: int
    problem_numbers: list[int]
    pua_ratio: float
    pua_threshold: float
    mode: Literal["text", "image"]
    mode_reason: str
    dpi: int
    ai_calls: int = 0
    cost_note: str
    cost: dict[str, Any]
    problems: list[ProblemOut]


class SolveRequest(BaseModel):
    """`/api/solve` 요청."""

    job_id: str
    problem_numbers: list[int] = Field(min_length=1)
    model: str = pricing.DEFAULT_MODEL
    effort: Literal["low", "medium", "high", "xhigh", "max"] = solver.DEFAULT_EFFORT
    max_tokens: int = Field(default=solver.DEFAULT_MAX_TOKENS, ge=256, le=64000)


class SolveResultOut(BaseModel):
    """문제 하나의 풀이 + 실측 usage/비용."""

    no: int
    ok: bool
    mode: str
    model: str
    effort: str
    solution: str
    stop_reason: str | None = None
    truncated: bool = False
    refusal: bool = False
    error: str | None = None
    usage: dict[str, Any]
    cost: dict[str, Any]


class TotalsOut(BaseModel):
    """선택 문항 합계 + 전체 문항 환산 예상치."""

    solved_count: int
    ok_count: int
    input_tokens: int
    output_tokens: int
    cache_write_tokens: int
    cache_read_tokens: int
    total_tokens: int
    total_usd: float
    total_krw: float
    avg_usd_per_problem: float
    total_problem_count: int
    projected_all_usd: float
    projected_all_krw: float
    usd_krw: float


class SolveResponse(BaseModel):
    job_id: str
    model: str
    effort: str
    mode: str
    results: list[SolveResultOut]
    totals: TotalsOut


# --------------------------------------------------------------------------
# 헬퍼
# --------------------------------------------------------------------------
def _error(
    status_code: int, error_code: str, message: str, hint: str | None = None
) -> HTTPException:
    """일관된 형태의 친절한 에러를 만든다."""
    return HTTPException(
        status_code=status_code,
        detail=ErrorBody(
            error_code=error_code, message=message, hint=hint
        ).model_dump(),
    )


def _get_job(job_id: str) -> JobRecord:
    job = JOBS.get(job_id)
    if job is None:
        raise _error(
            status.HTTP_404_NOT_FOUND,
            "job_not_found",
            f"job_id 를 찾을 수 없습니다: {job_id}",
            "서버를 재시작하면 메모리의 작업 기록이 사라집니다. PDF 를 다시 업로드하세요.",
        )
    return job


def _mode_reason(result: extractor.ExtractResult) -> str:
    if result.mode == "image":
        return (
            f"PUA(사설영역) 문자 비율 {result.pua_ratio:.1%} 가 임계값 "
            f"{result.pua_threshold:.1%} 이상 → 텍스트 레이어의 수식이 깨져 있어 "
            "문제별 크롭 이미지를 전송합니다."
        )
    return (
        f"PUA(사설영역) 문자 비율 {result.pua_ratio:.1%} 가 임계값 "
        f"{result.pua_threshold:.1%} 미만 → 텍스트만 전송합니다 (가장 저렴)."
    )


def _solve_batch(
    job: JobRecord, request: SolveRequest, numbers: list[int]
) -> list[solver.SolveOutcome]:
    """블로킹 SDK 호출. 스레드풀에서 실행된다.

    캐시 히트를 만들려면 순차 호출이어야 한다(첫 호출이 캐시를 쓰고,
    이후 호출이 읽는다). 병렬로 쏘면 전부 캐시 미스가 날 수 있다.
    """
    client = solver.build_client()
    outcomes: list[solver.SolveOutcome] = []
    for number in numbers:
        outcomes.append(
            solver.solve_problem(
                job.problems_by_no[number],
                client=client,
                mode=job.result.mode,
                model=request.model,
                effort=request.effort,
                max_tokens=request.max_tokens,
            )
        )
    return outcomes


def _build_totals(
    outcomes: list[solver.SolveOutcome], total_problem_count: int
) -> TotalsOut:
    """실측 usage 합계와 전체 문항 환산 예상 비용."""
    tokens = {"input": 0, "output": 0, "cache_write": 0, "cache_read": 0}
    total_usd = 0.0
    ok_count = 0
    for outcome in outcomes:
        cost = outcome.cost or {}
        counts = cost.get("tokens", {}) if isinstance(cost, dict) else {}
        for key in tokens:
            tokens[key] += int(counts.get(key, 0) or 0)
        total_usd += float(cost.get("total_usd", 0.0) or 0.0)
        if outcome.ok:
            ok_count += 1

    # 환산은 '실제로 과금된 호출' 기준. 전부 실패했으면 0.
    billed = sum(1 for o in outcomes if (o.cost or {}).get("total_usd", 0.0))
    avg_usd = total_usd / billed if billed else 0.0
    projected_usd = avg_usd * total_problem_count

    return TotalsOut(
        solved_count=len(outcomes),
        ok_count=ok_count,
        input_tokens=tokens["input"],
        output_tokens=tokens["output"],
        cache_write_tokens=tokens["cache_write"],
        cache_read_tokens=tokens["cache_read"],
        total_tokens=sum(tokens.values()),
        total_usd=round(total_usd, 8),
        total_krw=round(total_usd * pricing.USD_KRW, 4),
        avg_usd_per_problem=round(avg_usd, 8),
        total_problem_count=total_problem_count,
        projected_all_usd=round(projected_usd, 8),
        projected_all_krw=round(projected_usd * pricing.USD_KRW, 4),
        usd_krw=pricing.USD_KRW,
    )


# --------------------------------------------------------------------------
# 라우트
# --------------------------------------------------------------------------
@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    """단일 페이지 UI."""
    if not INDEX_FILE.is_file():
        raise _error(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "index_missing",
            f"static/index.html 이 없습니다: {INDEX_FILE}",
        )
    return FileResponse(INDEX_FILE, media_type="text/html; charset=utf-8")


@app.get("/api/health", status_code=status.HTTP_200_OK)
async def health() -> dict[str, Any]:
    """서버 상태와 API 키 설정 여부."""
    return {
        "status": "ok",
        "api_key_configured": solver.has_api_key(),
        "models": sorted(pricing.MODEL_RATES),
        "usd_krw": pricing.USD_KRW,
        "jobs": len(JOBS),
    }


@app.post(
    "/api/extract",
    response_model=ExtractResponse,
    status_code=status.HTTP_200_OK,
    responses={400: {"model": ErrorResponse}},
)
async def extract(
    file: Annotated[UploadFile, File(description="시험지 PDF")],
) -> ExtractResponse:
    """PDF 를 문제 단위로 분리한다. **AI 호출 없음 / 비용 0원.**"""
    raw = await file.read()
    if not raw:
        raise _error(status.HTTP_400_BAD_REQUEST, "empty_file", "빈 파일입니다.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise _error(
            status.HTTP_400_BAD_REQUEST,
            "file_too_large",
            f"파일이 너무 큽니다 ({len(raw) / 1_048_576:.1f}MB). "
            f"상한은 {MAX_UPLOAD_BYTES // 1_048_576}MB 입니다.",
        )
    if not raw.startswith(b"%PDF"):
        raise _error(
            status.HTTP_400_BAD_REQUEST,
            "not_a_pdf",
            "PDF 파일이 아닙니다. (헤더가 %PDF 로 시작하지 않음)",
        )

    try:
        # fitz 파싱 + 렌더링은 블로킹 CPU 작업이므로 스레드풀로 뺀다.
        result = await run_in_threadpool(extractor.extract_problems, pdf_bytes=raw)
    except extractor.ExtractionError as exc:
        raise _error(status.HTTP_400_BAD_REQUEST, "extract_failed", str(exc)) from exc

    if not result.problems:
        raise _error(
            status.HTTP_400_BAD_REQUEST,
            "no_problems_found",
            "문제 번호 앵커를 찾지 못했습니다. "
            "'1.' '2.' 형태의 문항 번호가 있는 시험지인지 확인하세요.",
        )

    job_id = uuid.uuid4().hex[:12]
    problems = [p.to_dict() for p in result.problems]
    JOBS[job_id] = JobRecord(
        job_id=job_id,
        filename=file.filename or "upload.pdf",
        pdf_bytes=raw,
        result=result,
        problems_by_no={p["no"]: p for p in problems},
    )

    return ExtractResponse(
        job_id=job_id,
        filename=file.filename or "upload.pdf",
        page_count=result.page_count,
        problem_count=len(result.problems),
        problem_numbers=[p.no for p in result.problems],
        pua_ratio=result.pua_ratio,
        pua_threshold=result.pua_threshold,
        mode=result.mode,
        mode_reason=_mode_reason(result),
        dpi=result.dpi,
        ai_calls=0,
        cost_note="추출은 코드(PyMuPDF)로만 수행했습니다. AI 호출 0회, 비용 0원.",
        cost=pricing.zero_cost(),
        problems=[ProblemOut(**p) for p in problems],
    )


@app.post(
    "/api/solve",
    response_model=SolveResponse,
    status_code=status.HTTP_200_OK,
    responses={400: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
)
async def solve(request: SolveRequest) -> SolveResponse:
    """선택한 문항만 AI 로 풀고 문항별 실측 usage/비용을 돌려준다."""
    job = _get_job(request.job_id)

    try:
        pricing.resolve_model(request.model)
    except pricing.UnknownModelError as exc:
        raise _error(
            status.HTTP_400_BAD_REQUEST,
            "unknown_model",
            str(exc),
            "pricing.MODEL_RATES 에 단가를 추가하면 사용할 수 있습니다.",
        ) from exc

    numbers = sorted(dict.fromkeys(request.problem_numbers))
    missing = [n for n in numbers if n not in job.problems_by_no]
    if missing:
        raise _error(
            status.HTTP_400_BAD_REQUEST,
            "problem_not_found",
            f"이 작업에 없는 문항 번호입니다: {missing}",
            f"사용 가능한 번호: {sorted(job.problems_by_no)}",
        )

    # 키가 없으면 SDK 호출 전에 400 + 친절한 안내로 끝낸다 (500 아님).
    if not solver.has_api_key():
        raise _error(
            status.HTTP_400_BAD_REQUEST,
            "missing_api_key",
            "ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않아 AI 풀이를 실행할 수 없습니다.",
            "Windows CMD: set ANTHROPIC_API_KEY=sk-ant-...  /  "
            'PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."  '
            "설정 후 서버를 재시작하세요. (추출 기능은 키 없이도 동작합니다.)",
        )

    try:
        outcomes = await run_in_threadpool(_solve_batch, job, request, numbers)
    except solver.SolverConfigError as exc:
        raise _error(status.HTTP_400_BAD_REQUEST, "missing_api_key", str(exc)) from exc

    return SolveResponse(
        job_id=job.job_id,
        model=request.model,
        effort=request.effort,
        mode=job.result.mode,
        results=[SolveResultOut(**o.to_dict()) for o in outcomes],
        totals=_build_totals(outcomes, len(job.result.problems)),
    )


if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
