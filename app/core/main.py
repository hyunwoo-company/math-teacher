"""수학 문제풀이 워크스페이스 공용 백엔드 (FastAPI).

실행:
    cd app/core
    uvicorn main:app --port 8100

* 데스크톱(Tauri)에서는 sidecar 로, 웹앱에서는 서버로 같은 코드를 쓴다.
* 배포 모드는 환경변수 `MATH_TEACHER_MODE=desktop|web` (기본 desktop).
* 모든 에러는 `{error_code, message, hint}` (message 는 한국어).
"""

from __future__ import annotations

import logging
import os
import secrets
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from functools import partial
from typing import Annotated, Any, Final, Literal
from urllib.parse import quote

from fastapi import (
    Body,
    FastAPI,
    File,
    Form,
    Header,
    Path,
    Query,
    Request,
    UploadFile,
    status,
)
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    Response,
    StreamingResponse,
)

import ai_service
import config
import download_token
import jobs
import pricing
import service
import sse
import storage
from errors import ApiError, bad_request, not_found, register_error_handlers
from providers import agy, subscription
from schemas import (
    AgyProviderInfo,
    ApiKeyIn,
    ApiKeyProviderInfo,
    ChatHistoryResponse,
    ChatRequest,
    ChatThreadsResponse,
    ConversationChatRequest,
    ConversationCreate,
    ConversationMessagesResponse,
    ConversationOut,
    ConversationRename,
    ConversationsResponse,
    DownloadTokenIn,
    DownloadTokenResponse,
    EnvResponse,
    ErrorBody,
    FileDetailResponse,
    FolderCreate,
    JobCreate,
    JobCreated,
    JobOut,
    JobsResponse,
    ModelInfo,
    NodeOut,
    NodeResponse,
    NodeUpdate,
    NoteCreate,
    NoteDetailResponse,
    NoteItemsCreate,
    NoteItemsResult,
    OkResponse,
    ProviderModelInfo,
    ProvidersInfo,
    ReextractResponse,
    Section,
    SolutionContentSave,
    SolutionOut,
    SolutionsResponse,
    SubscriptionInfo,
    SubscriptionProviderInfo,
    TranscriptOut,
    TranscriptSave,
    TranscriptsResponse,
    TreeResponse,
    UsageSummaryResponse,
    VariantsResponse,
)

# 프론트엔드(Next.js dev) 와 Tauri 로컬 웹뷰에서 호출한다.
# 로컬/데스크톱 기본 origin. 배포 시 Vercel 도메인은 env 로 추가한다:
#   MATH_TEACHER_CORS_ORIGINS="https://math-teacher.vercel.app,https://..."
_DEFAULT_ORIGINS: Final[list[str]] = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    "tauri://localhost",
]
ALLOWED_ORIGINS: Final[list[str]] = _DEFAULT_ORIGINS + [
    origin.strip()
    for origin in os.environ.get("MATH_TEACHER_CORS_ORIGINS", "").split(",")
    if origin.strip()
]

_ERRORS: Final[dict[int | str, dict[str, Any]]] = {
    400: {"model": ErrorBody, "description": "잘못된 요청"},
    404: {"model": ErrorBody, "description": "대상을 찾을 수 없음"},
    409: {"model": ErrorBody, "description": "사용할 수 있는 AI 연결이 없음"},
}

logger: Final[logging.Logger] = logging.getLogger("math_teacher.core.api")

NodeId = Annotated[str, Path(min_length=1, max_length=64)]
SectionQuery = Annotated[Section, Query(description="exam=시험지, note=오답노트")]
ProblemNoQuery = Annotated[
    int | None,
    Query(ge=1, description="문항별 스레드. 생략하면 시험지 전역 스레드"),
]
# 내보내기 구성. 기본값 `problems` 로 기존 `export.docx` 호출자가 그대로 동작한다.
IncludeQuery = Annotated[
    service.ExportInclude,
    Query(description="problems=문제만, full=문제+해설"),
]
# 내보내기 출처(선택). 문서 맨 끝에 한 줄로 들어간다. 생략하면 지금과 같은 문서다.
SourceQuery = Annotated[
    str | None,
    Query(max_length=100, description="문서 끝에 넣을 출처(예: HY EDU). 최대 100자"),
]
# 문항 본문. 기본값 `image` 라 생략하면 지금까지와 **같은 문서**가 나온다.
BodyQuery = Annotated[
    service.ExportBody,
    Query(description="image=크롭 이미지(기본), text=판독본 텍스트(없으면 이미지)"),
]


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """시작 시 데이터 디렉터리·DB 를 준비하고 작업 큐 워커를 띄운다.

    프로세스가 죽으면 인메모리 큐도 사라지므로, 남아 있던 대기·실행 작업은
    `interrupted` 로 표시한다. 자동 재개는 하지 않는다(중복 과금 위험).
    """
    config.ensure_dirs()
    await run_in_threadpool(storage.init_db)
    # 다운로드 토큰 서명키는 PBKDF2 라 첫 파생이 수십 ms 걸린다(그 뒤로는 캐시).
    # 미들웨어는 async 라 그 한 번이 이벤트 루프를 멈추므로 기동 때 미리 데운다.
    await run_in_threadpool(download_token.warm_up)
    interrupted = await run_in_threadpool(_interrupt_stale_jobs)
    if interrupted:
        logger.info("이전 실행에서 남은 작업 %d건을 중단 처리했습니다.", interrupted)
    jobs.runner.start()
    try:
        yield
    finally:
        await jobs.runner.stop()


def _interrupt_stale_jobs() -> int:
    with storage.transaction() as conn:
        return storage.interrupt_unfinished_jobs(conn)


app = FastAPI(
    title="수학 문제풀이 워크스페이스 API",
    description="시험지 PDF 를 폴더/파일로 정리하고 AI 로 풀이를 만든다.",
    version="0.1.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # 다운로드 파일명을 프런트가 읽을 수 있게 노출한다(교차 오리진 배포 대비).
    expose_headers=["Content-Disposition"],
)

# 내보내기 응답 MIME. `.hwpx` 는 컨테이너 안 `mimetype` 파일과 같은 값을 쓴다.
DOCX_MEDIA_TYPE: Final[str] = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)
HWPX_MEDIA_TYPE: Final[str] = "application/hwp+zip"
_EXPORT_MEDIA_TYPES: Final[dict[str, str]] = {
    "docx": DOCX_MEDIA_TYPE,
    "hwpx": HWPX_MEDIA_TYPE,
}

# 접속 비밀번호가 필요 없는 경로(게이트 표시 판단·헬스체크·로그인 자체).
_AUTH_EXEMPT: Final[frozenset[str]] = frozenset({"/api/health", "/api/env", "/api/login"})


def _is_binary_asset(path: str) -> bool:
    """브라우저가 헤더 없이 직접 로드/다운로드하는 바이너리 GET 경로인지.

    `/api/files/{id}/raw`, `/api/files/{id}/problems/{no}/crop`,
    `/api/notes/{id}/items/{item_id}/crop`, 그리고 `.docx`/`.hwpx` 내보내기가
    해당한다. 내보내기는 시험지/변형/오답노트 3종이지만 모두 `/export.<확장자>`
    로 끝나므로 별도 분기가 필요 없다.
    이 경로들만 쿼리 인증(`?token=` 서명 토큰 · 하위호환 `?access=<비번>`)을
    허용한다(그 외는 헤더 전용).
    """
    return (
        path.endswith("/raw")
        or path.endswith("/crop")
        or path.endswith("/export.docx")
        or path.endswith("/export.hwpx")
    )


@app.middleware("http")
async def _access_password_gate(request: Request, call_next: Any) -> Any:
    """배포 시 친구 전용 접속 비밀번호 검사.

    `MATH_TEACHER_ACCESS_PASSWORD` 가 설정된 경우에만 동작한다(로컬은 통과).
    `/api/*` 요청은 `X-Access-Password` 헤더가 비밀번호와 일치해야 한다.

    크롭 이미지(`<img>`)·원본 PDF(pdf.js)는 브라우저가 직접 GET 으로 로드해
    커스텀 헤더를 못 붙인다. 이 GET 요청들만 예외로 쿼리 인증을 허용한다
    (그 외 경로·메서드는 헤더만 허용).

    쿼리 인증은 두 가지를 받는다:
      1. `?token=` — `POST /api/download-tokens` 로 받은 단기 서명 토큰(권장).
         비밀번호가 URL 에 남지 않고, 만료·범위가 서명에 묶여 있다.
      2. `?access=<비번>` — 기존 방식. 비밀번호가 URL(방문 기록·액세스 로그)에
         평문으로 남는 문제 때문에 1번으로 대체할 예정이지만, 아직 프론트가
         이 방식을 쓰므로 **지우면 배포된 앱이 즉시 깨진다.** 제거는 프론트
         전환이 배포된 뒤 별도 작업으로 한다.

    비교는 `secrets.compare_digest` 로 타이밍 공격을 피한다.
    CORS preflight(OPTIONS)는 통과시킨다(브라우저가 헤더를 안 실음).
    """
    expected = config.access_password()
    path = request.url.path
    if (
        expected is None
        or request.method == "OPTIONS"
        or path in _AUTH_EXEMPT
        or not path.startswith("/api/")
    ):
        return await call_next(request)
    supplied = request.headers.get("X-Access-Password", "")
    # 헤더를 못 붙이는 바이너리 GET(raw/crop)만 쿼리 파라미터 허용.
    if not supplied and request.method == "GET" and _is_binary_asset(path):
        token = request.query_params.get(download_token.QUERY_PARAM, "")
        if token and download_token.verify(token, path, expected):
            return await call_next(request)
        # 토큰이 없거나 틀리면 기존 `?access=` 로 내려간다(하위호환).
        supplied = request.query_params.get("access", "")
    if not supplied or not secrets.compare_digest(supplied, expected):
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={
                "error_code": "unauthorized",
                "message": "접속 비밀번호가 필요합니다.",
                "hint": None,
            },
        )
    return await call_next(request)


register_error_handlers(app)

ApiKeyHeader = Annotated[str | None, Header(alias="X-Api-Key")]


def _api_key(header_value: str | None) -> str | None:
    """요청 헤더가 있으면 그 키를, 없으면 저장된 키를 쓴다."""
    if header_value and header_value.strip():
        return header_value.strip()
    return config.stored_api_key()


# ------------------------------------------------------------------- 환경
def _claude_provider_models() -> list[ProviderModelInfo]:
    """구독/API 키 프로바이더가 쓰는 Claude 모델 목록(기본은 단가표 기본 모델)."""
    return [
        ProviderModelInfo(
            id=model_id,
            label=config.MODEL_LABELS.get(model_id, model_id),
            default=model_id == pricing.DEFAULT_MODEL,
        )
        for model_id in pricing.MODEL_RATES
    ]


@app.get("/api/env", response_model=EnvResponse, status_code=status.HTTP_200_OK)
def read_env() -> EnvResponse:
    """현재 배포 모드와 사용 가능한 프로바이더/모델을 알려준다.

    최상위 `models`/`subscription` 은 하위호환으로 유지하고, 새 프론트가 쓰는
    `providers`/`default_provider` 를 함께 내려준다(ARCHITECTURE 3-C).
    """
    # 배포판 agy 전용: API 키·구독을 아예 노출하지 않는다(과금 사고 방지).
    agy_only = config.agy_only()
    detected = subscription.availability()
    subscription_available = (not agy_only) and bool(detected["available"])
    agy_detected = agy.availability()
    agy_available = bool(agy_detected["available"])
    api_key_set = (not agy_only) and config.stored_api_key() is not None

    claude_models = _claude_provider_models()
    agy_models = [ProviderModelInfo.model_validate(item) for item in agy.agy_models()]

    default_provider: Literal["agy", "subscription", "apikey"]
    if agy_only or agy_available:
        # agy 전용 배포에서는 agy 만 노출하므로 항상 agy 를 기본으로 한다.
        default_provider = "agy"
    elif subscription_available:
        default_provider = "subscription"
    else:
        default_provider = "apikey"

    return EnvResponse(
        mode=config.deploy_mode(),
        subscription=SubscriptionInfo(
            available=subscription_available,
            cli_path=detected["cli_path"],
            reason=str(detected["reason"]),
        ),
        api_key_set=api_key_set,
        models=[
            ModelInfo(
                id=model_id,
                label=config.MODEL_LABELS.get(model_id, model_id),
                input_usd_per_mtok=rates["input"],
                output_usd_per_mtok=rates["output"],
            )
            for model_id, rates in pricing.MODEL_RATES.items()
        ],
        usd_krw=pricing.USD_KRW,
        providers=ProvidersInfo(
            agy=AgyProviderInfo(
                available=agy_available,
                reason=str(agy_detected["reason"]),
                models=agy_models,
            ),
            subscription=SubscriptionProviderInfo(
                available=subscription_available,
                cli_path=detected["cli_path"],
                reason=str(detected["reason"]),
                models=claude_models,
            ),
            apikey=ApiKeyProviderInfo(
                available=api_key_set,
                models=claude_models,
            ),
        ),
        default_provider=default_provider,
        auth_required=config.auth_required(),
    )


@app.post(
    "/api/settings/apikey", response_model=OkResponse, status_code=status.HTTP_200_OK
)
def save_api_key(payload: ApiKeyIn) -> OkResponse:
    """API 키를 `data/settings.json` 에 평문 저장한다 (README 경고 참조).

    배포판(agy 전용)에서는 키 저장 자체를 거부한다 — 키가 디스크에 남지 않게 한다.
    """
    if config.agy_only():
        raise ApiError(
            status.HTTP_409_CONFLICT,
            "provider_disabled",
            "이 서비스에서는 API 키를 사용할 수 없습니다.",
            None,
        )
    config.save_api_key(payload.key)
    return OkResponse()


@app.delete(
    "/api/settings/apikey", response_model=OkResponse, status_code=status.HTTP_200_OK
)
def delete_api_key() -> OkResponse:
    """저장된 API 키를 지운다."""
    config.clear_api_key()
    return OkResponse()


# ------------------------------------------------------------------- 트리
@app.get("/api/tree", response_model=TreeResponse, status_code=status.HTTP_200_OK)
def read_tree(section: SectionQuery = "exam") -> TreeResponse:
    """한 섹션의 노드를 플랫 배열로 돌려준다 (`parent_id=null` 이 루트).

    `section` 을 생략하면 기존 호환을 위해 시험지(`exam`) 트리를 돌려준다.
    """
    return TreeResponse(
        nodes=[NodeOut.model_validate(node) for node in service.list_tree(section)]
    )


@app.post(
    "/api/folders",
    response_model=NodeResponse,
    status_code=status.HTTP_201_CREATED,
    responses=_ERRORS,
)
def create_folder(payload: FolderCreate) -> NodeResponse:
    """폴더를 만든다. 중첩 깊이 제한은 없다.

    `parent_id` 가 있으면 그 부모와 같은 섹션이어야 한다(다르면 400).
    """
    node = service.create_folder(payload.name, payload.parent_id, payload.section)
    return NodeResponse(node=NodeOut.model_validate(node))


@app.patch(
    "/api/nodes/{node_id}",
    response_model=NodeResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def patch_node(node_id: NodeId, payload: NodeUpdate) -> NodeResponse:
    """이름변경/이동(시험지·오답노트 공통).

    순환 참조가 되는 이동과 **섹션을 넘나드는 이동**은 400 으로 거부한다.
    """
    node = service.update_node(
        node_id,
        name=payload.name,
        parent_id=payload.parent_id,
        move="parent_id" in payload.model_fields_set,
    )
    return NodeResponse(node=NodeOut.model_validate(node))


@app.delete(
    "/api/nodes/{node_id}",
    response_model=OkResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def delete_node(node_id: NodeId) -> OkResponse:
    """노드를 삭제한다(시험지·오답노트 공통).

    폴더면 하위 노드/파일/크롭/풀이/채팅/노트항목까지 재귀 삭제한다.
    단 **시험지 파일을 지워도 그 시험지를 참조하는 오답노트 항목은 남는다**
    (`source_node_id` 만 NULL 이 되고 스냅샷으로 계속 보인다).
    """
    service.delete_node(node_id)
    return OkResponse()


# ------------------------------------------------------------------- 파일
@app.post(
    "/api/files",
    response_model=NodeResponse,
    status_code=status.HTTP_201_CREATED,
    responses=_ERRORS,
)
async def upload_file(
    file: Annotated[UploadFile, File(description="시험지 PDF")],
    parent_id: Annotated[str | None, Form()] = None,
) -> NodeResponse:
    """PDF 를 업로드하고 즉시 추출한다 (AI 호출 0회).

    추출이 실패해도 파일은 등록되고 `extract_error` 에 사유가 담긴다.
    """
    raw = await file.read()
    filename = file.filename or "upload.pdf"
    service.validate_pdf(filename, raw)
    node, extract_error = await run_in_threadpool(
        service.register_pdf, filename, raw, parent_id or None
    )
    return NodeResponse(node=NodeOut.model_validate(node), extract_error=extract_error)


@app.get(
    "/api/files/{node_id}",
    response_model=FileDetailResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def read_file(node_id: NodeId) -> FileDetailResponse:
    """파일 노드와 문항 목록(풀이 존재 여부 포함).

    문항이 0개인 파일은 `extract_error` 에 마지막 추출의 사유가 담긴다(화면의
    0문항 안내를 고정 문구가 아니라 실제 사유로 그리기 위한 것).
    """
    return FileDetailResponse.model_validate(service.file_detail(node_id))


@app.post(
    "/api/files/{node_id}/reextract",
    response_model=ReextractResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
async def reextract_file(node_id: NodeId) -> ReextractResponse:
    """등록된 PDF 를 원본 그대로 다시 추출한다 (AI 호출 0회).

    extractor 를 고친 뒤 기존 업로드분에 반영할 때 쓴다. 파일을 지우고 다시
    올릴 필요가 없다. **기존 풀이는 지워진다**(문항 번호가 달라질 수 있어서).
    오답노트 항목은 스냅샷을 갖고 있으므로 그대로 남는다.
    """
    detail, extract_error, deleted = await run_in_threadpool(
        service.reextract_pdf, node_id
    )
    return ReextractResponse.model_validate(
        {**detail, "extract_error": extract_error, "deleted_solutions": deleted}
    )


@app.get(
    "/api/files/{node_id}/raw",
    response_class=FileResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def read_file_raw(node_id: NodeId) -> FileResponse:
    """뷰어용 원본 PDF."""
    return FileResponse(
        service.raw_pdf_path(node_id),
        media_type="application/pdf",
        filename=f"{node_id}.pdf",
        content_disposition_type="inline",
    )


@app.get(
    "/api/files/{node_id}/problems/{no}/crop",
    response_class=FileResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def read_problem_crop(node_id: NodeId, no: Annotated[int, Path(ge=1)]) -> FileResponse:
    """문항별 크롭 PNG."""
    return FileResponse(service.crop_path(node_id, no), media_type="image/png")


# --------------------------------------------------------------- 판독본
# 조회를 파일 상세(`GET /api/files/{id}`)에 합치지 않는다. 판독본 전문은 문항당
# 최대 2만 자라 시험지를 열 때마다 수백 KB 를 내려보내게 된다. 풀이도 같은 이유로
# `has_solution`(목록) + `GET .../solutions`(전문)로 나뉘어 있으므로 그 규칙을 따른다.
# 파일 상세에는 배지에 필요한 `has_transcript` / `transcript_source` /
# `transcript_note` 만 들어간다(`ProblemOut`).


@app.get(
    "/api/files/{node_id}/transcripts",
    response_model=TranscriptsResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
async def read_transcripts(node_id: NodeId) -> TranscriptsResponse:
    """저장된 판독본 목록(문항 번호 순).

    아직 판독하지 않은 문항은 빠진다. 판독하지 못한 문항은 `transcript=null` +
    `transcript_note`(이유)로 들어온다.
    """
    items = await run_in_threadpool(service.transcripts, node_id)
    return TranscriptsResponse.model_validate({"transcripts": items})


@app.patch(
    "/api/files/{node_id}/problems/{no}/transcript",
    response_model=TranscriptOut,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
async def save_transcript(
    node_id: NodeId, no: Annotated[int, Path(ge=1)], payload: TranscriptSave
) -> TranscriptOut:
    """대조 화면에서 고친 판독본을 저장한다(`transcript_source='manual'`).

    빈 문자열을 보내면 판독본을 지운다(되돌리기). 지운 문항은 다음 텍스트화
    재실행이 다시 판독한다. `manual` 판독본은 `force` 없는 재실행이 덮지 않는다.
    """
    saved = await run_in_threadpool(service.save_transcript, node_id, no, payload.text)
    return TranscriptOut.model_validate(saved)


def _attachment_disposition(filename: str) -> str:
    """RFC5987(UTF-8)로 인코딩한 첨부 `Content-Disposition` 헤더 값.

    한글 파일명이 헤더에서 깨지지 않게 `filename*=UTF-8''<pct-encoded>` 형식을 쓴다.
    """
    encoded = quote(filename, safe="")
    return f"attachment; filename*=UTF-8''{encoded}"


def _clean_source(value: str | None) -> str | None:
    """내보내기 출처 문자열을 정리한다.

    개행이 들어오면 문서에 빈 줄이 생기므로 공백류를 한 칸으로 접는다.

    Args:
        value: 쿼리로 받은 출처. 없으면 None.

    Returns:
        정리된 출처. 비었거나 공백뿐이면 None(=출처를 넣지 않는다).
    """
    if value is None:
        return None
    return " ".join(value.split()) or None


async def _export_response(
    exporter: Callable[..., tuple[bytes, str]],
    node_id: str,
    *,
    fmt: service.ExportFormat,
    include: service.ExportInclude,
    source: str | None = None,
    body: service.ExportBody = "image",
) -> Response:
    """내보내기 서비스를 스레드풀에서 돌려 첨부 응답으로 감싼다.

    문서 조립은 이미지 인코딩을 포함한 블로킹 작업이라 `run_in_threadpool` 이
    필수다(이벤트 루프를 막으면 다른 요청이 멈춘다).

    Args:
        exporter: `service.export_exam` / `export_variants` / `export_note`.
        node_id: 시험지 또는 오답노트 노드 id.
        fmt: `docx` 또는 `hwpx`.
        include: `problems` 또는 `full`.
        source: 문서 끝에 넣을 출처(정리 전 원문). 없으면 넣지 않는다.
        body: `image`(기본) 또는 `text`. 세 exporter 가 모두 받는다(변형은 본문이
            이미 텍스트라 값을 쓰지 않는다).

    Returns:
        첨부 다운로드 응답(Content-Disposition 은 RFC5987 인코딩).
    """
    content, filename = await run_in_threadpool(
        exporter,
        node_id,
        fmt=fmt,
        include=include,
        source=_clean_source(source),
        body=body,
    )
    return Response(
        content=content,
        media_type=_EXPORT_MEDIA_TYPES[fmt],
        headers={"Content-Disposition": _attachment_disposition(filename)},
    )


@app.get(
    "/api/files/{node_id}/export.docx",
    response_class=Response,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
async def export_file_docx(
    node_id: NodeId,
    include: IncludeQuery = "problems",
    source: SourceQuery = None,
    body: BodyQuery = "image",
) -> Response:
    """시험지 DOCX. 기본은 '문제만'(크롭 이미지), `include=full` 이면 풀이도 넣는다.

    `body=text` 면 판독본이 있는 문항을 텍스트로 조판하고(없는 문항은 이미지),
    첫 페이지에 복원 고지를 넣는다. 생략하면 지금까지와 같은 문서다.

    브라우저가 직접 GET 으로 내려받는 바이너리 라우트라, 미들웨어에서 `?access=`
    쿼리 인증도 허용한다(`_is_binary_asset`). 문항이 없으면 400 이다.
    """
    return await _export_response(
        service.export_exam,
        node_id,
        fmt="docx",
        include=include,
        source=source,
        body=body,
    )


@app.get(
    "/api/files/{node_id}/export.hwpx",
    response_class=Response,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
async def export_file_hwpx(
    node_id: NodeId,
    include: IncludeQuery = "problems",
    source: SourceQuery = None,
    body: BodyQuery = "image",
) -> Response:
    """시험지 HWPX(한글). 구성은 DOCX 와 같다(`body=text` 도 같게 동작한다)."""
    return await _export_response(
        service.export_exam,
        node_id,
        fmt="hwpx",
        include=include,
        source=source,
        body=body,
    )


@app.get(
    "/api/files/{node_id}/variants/export.docx",
    response_class=Response,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
async def export_variants_docx(
    node_id: NodeId,
    include: IncludeQuery = "problems",
    source: SourceQuery = None,
    body: BodyQuery = "image",
) -> Response:
    """저장된 변형 문제 DOCX. 원본 크롭은 넣지 않는다. 변형이 없으면 400 이다.

    `body` 는 받기만 한다 — 변형 문서에는 크롭 이미지가 없고 본문이 이미 텍스트다.
    """
    return await _export_response(
        service.export_variants,
        node_id,
        fmt="docx",
        include=include,
        source=source,
        body=body,
    )


@app.get(
    "/api/files/{node_id}/variants/export.hwpx",
    response_class=Response,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
async def export_variants_hwpx(
    node_id: NodeId,
    include: IncludeQuery = "problems",
    source: SourceQuery = None,
    body: BodyQuery = "image",
) -> Response:
    """저장된 변형 문제 HWPX(한글). 구성은 DOCX 와 같다."""
    return await _export_response(
        service.export_variants,
        node_id,
        fmt="hwpx",
        include=include,
        source=source,
        body=body,
    )


@app.get(
    "/api/files/{node_id}/variants",
    response_model=VariantsResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def read_variants(node_id: NodeId) -> VariantsResponse:
    """저장된 변형 목록(문항 번호 → 변형 종류 순).

    프론트가 시험지를 열 때 받아 스토어를 채운다 — 새로고침해도 남고, 이미 만든
    변형을 다시 생성해 쿼터를 낭비하지 않는다.
    """
    return VariantsResponse.model_validate({"variants": service.variants(node_id)})


# --------------------------------------------------------------- 작업 큐
# 풀이·변형은 여기로만 들어온다. 예전 `/solve`·`/variant` 는 HTTP 응답 자체가
# 작업이라 브라우저가 끊으면 작업도 멈췄다. 이제 작업은 큐에서 돌고 연결과
# 무관하게 끝까지 진행된다. (채팅은 즉답이 필요하므로 큐에 넣지 않는다.)


@app.post(
    "/api/jobs",
    response_model=JobCreated,
    status_code=status.HTTP_201_CREATED,
    responses=_ERRORS,
)
async def create_job(
    payload: JobCreate,
    x_api_key: ApiKeyHeader = None,
) -> JobCreated:
    """풀이·변형·텍스트화 작업을 큐에 넣고 **즉시** 돌려준다.

    응답은 스트림을 기다리지 않는다. 진행 상황은
    `GET /api/jobs/{id}/events` 로 구독하며, 구독하지 않아도 작업은 진행된다.

    같은 시험지에 대해 같은 종류의 작업이 이미 대기·실행 중이면 새로 만들지 않고
    그것을 돌려준다(`existing=true`). 버튼을 두 번 눌러 쿼터를 두 배로 쓰는 것을
    막는다.
    """
    # 프로바이더 해석 시점이 kind 마다 다르다.
    #   solve / variant : AI 없이는 할 일이 없다 -> 지금 해석하고 없으면 409.
    #   transcribe      : 1차(PDF 디코딩)만으로도 유효하다 -> 지연 해석. 여기서
    #                     막으면 AI 호출 0회로 끝나는 시험지도 시작조차 못 한다.
    resolver = ai_service.make_provider_resolver(payload.provider, _api_key(x_api_key))
    if payload.kind == "transcribe":
        model = ai_service.resolve_model_optional(payload.model, resolver)
    else:
        model = ai_service.resolve_model(payload.model, resolver().name)

    existing = await run_in_threadpool(_find_overlapping_job, payload)
    if existing is not None:
        return JobCreated(job=JobOut.model_validate(existing), existing=True)

    params = {
        "provider": payload.provider,
        "model": model,
        "effort": payload.effort,
    }

    if payload.kind == "solve":
        mode, targets, node_name = await run_in_threadpool(
            ai_service.plan_solve_job,
            payload.node_id,
            payload.problem_numbers,
            force=payload.force,
        )
        numbers = [int(item["no"]) for item in targets]
        record = await run_in_threadpool(
            _insert_job,
            kind="solve",
            node_id=payload.node_id,
            node_name=node_name,
            targets=numbers,
            params=params,
            total=len(numbers),
        )
        jobs.runner.submit(
            job_id=record["id"],
            total=len(numbers),
            factory=jobs.solve_factory(
                node_id=payload.node_id,
                provider=resolver(),
                mode=mode,
                targets=targets,
                model=model,
                effort=payload.effort,
            ),
        )
    elif payload.kind == "transcribe":
        # 대상 수 == AI 호출 수가 **아니다.** 1차 디코딩으로 끝나는 문항은
        # 프로바이더를 건드리지 않는다(집계는 진행 이벤트가 알려준다).
        # 그래서 프로바이더가 아니라 **지연 해석 함수**를 넘긴다.
        transcribe_targets, node_name = await run_in_threadpool(
            partial(
                ai_service.plan_transcribe_job,
                payload.node_id,
                payload.problem_numbers,
                force=payload.force,
            )
        )
        numbers = [int(item["no"]) for item in transcribe_targets]
        record = await run_in_threadpool(
            _insert_job,
            kind="transcribe",
            node_id=payload.node_id,
            node_name=node_name,
            targets=numbers,
            params=params,
            total=len(numbers),
        )
        jobs.runner.submit(
            job_id=record["id"],
            total=len(numbers),
            factory=jobs.transcribe_factory(
                node_id=payload.node_id,
                provider_resolver=resolver,
                targets=transcribe_targets,
                model=model,
                effort=payload.effort,
                force=payload.force,
            ),
        )
    else:
        numbers = _variant_numbers(payload)
        if not numbers:
            raise bad_request(
                "no_required",
                "변형 작업에는 문항 번호가 필요합니다.",
                "problem_numbers 또는 no 를 넣어 주세요.",
            )
        kinds = list(dict.fromkeys(payload.modes or ["number"]))
        mode, variant_targets, node_name = await run_in_threadpool(
            partial(
                ai_service.plan_variant_batch,
                payload.node_id,
                numbers,
                kinds,
                force=payload.force,
            )
        )
        record = await run_in_threadpool(
            _insert_job,
            kind="variant",
            node_id=payload.node_id,
            node_name=node_name,
            # 실제로 만들 대상만 남긴다(건너뛴 문항은 numbers 에도 없다).
            targets={
                "numbers": sorted(
                    {int(target.problem["no"]) for target in variant_targets}
                ),
                "modes": kinds,
            },
            params=params,
            total=len(variant_targets),
        )
        jobs.runner.submit(
            job_id=record["id"],
            total=len(variant_targets),
            factory=jobs.variant_batch_factory(
                node_id=payload.node_id,
                provider=resolver(),
                mode=mode,
                targets=variant_targets,
                model=model,
                effort=payload.effort,
            ),
        )

    return JobCreated(
        job=JobOut.model_validate(record),
        existing=False,
        position=max(0, jobs.runner.queued_count - 1),
    )


def _variant_numbers(payload: JobCreate) -> list[int]:
    """변형 작업의 대상 문항 번호들(중복 제거, 요청 순서 유지).

    다중 선택은 `problem_numbers` 로 온다. 없으면 기존 단일 경로(`no`)를 쓴다 —
    문항별 `VariantPanel` 이 계속 그 형태로 보낸다.

    Args:
        payload: 작업 요청.

    Returns:
        대상 문항 번호들. 둘 다 비었으면 빈 목록.
    """
    if payload.problem_numbers:
        return list(dict.fromkeys(int(no) for no in payload.problem_numbers))
    return [] if payload.no is None else [int(payload.no)]


def _find_overlapping_job(payload: JobCreate) -> dict[str, Any] | None:
    """같은 **대상**을 이미 처리 중인 작업(중복 요청 판정).

    시험지 단위로만 보면 안 된다. 같은 시험지의 다른 문항을 풀거나 다른 변형을
    만드는 것은 별개 작업이다. 겹치는 대상이 있을 때만 기존 작업을 돌려준다
    (버튼 두 번 눌러 쿼터를 두 배로 쓰는 것을 막는 것이 목적이다).

    Args:
        payload: 만들려는 작업 요청.

    Returns:
        대상이 겹치는 진행 중 작업. 없으면 None.
    """
    with storage.transaction() as conn:
        active = storage.find_active_job_for(conn, payload.node_id, payload.kind)
    if not active:
        return None

    if payload.kind in ("solve", "transcribe"):
        # 둘 다 targets 가 문항 번호 배열이라 겹침 판정이 같다.
        # 전체 대상(problem_numbers=None)은 어떤 진행 중 작업과도 겹친다고 본다.
        if payload.problem_numbers is None:
            return active[0]
        wanted = set(payload.problem_numbers)
        for job in active:
            targets = job["targets"]
            if isinstance(targets, list) and wanted & {int(no) for no in targets}:
                return job
        return None

    wanted_modes = set(payload.modes or ["number"])
    wanted_numbers = set(_variant_numbers(payload))
    for job in active:
        targets = job["targets"]
        if not isinstance(targets, dict):
            continue
        if not wanted_numbers & _job_variant_numbers(targets):
            continue
        if wanted_modes & set(targets.get("modes") or []):
            return job
    return None


def _job_variant_numbers(targets: dict[str, Any]) -> set[int]:
    """변형 작업 targets 에서 문항 번호 집합을 꺼낸다.

    다중 선택 이전에 만들어진 작업은 `{"no": 3, ...}` 형태다. 서버를 새로
    띄우면 남은 작업은 `interrupted` 가 되지만, 무중단 배포 중 겹치는 순간이
    있으므로 옛 형태도 읽어 준다.

    Args:
        targets: 작업 행의 targets(JSON 파싱된 dict).

    Returns:
        그 작업이 다루는 문항 번호 집합.
    """
    numbers = targets.get("numbers")
    if isinstance(numbers, list):
        return {int(no) for no in numbers}
    single = targets.get("no")
    return set() if single is None else {int(single)}


def _insert_job(**kwargs: Any) -> dict[str, Any]:
    with storage.transaction() as conn:
        return storage.insert_job(conn, job_id=storage.new_id(), **kwargs)


@app.get(
    "/api/jobs",
    response_model=JobsResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
async def list_jobs() -> JobsResponse:
    """진행 중인 작업 전부 + 최근 종료된 10건."""
    active, recent = await run_in_threadpool(_read_jobs)
    return JobsResponse(
        active=[JobOut.model_validate(item) for item in active],
        recent=[JobOut.model_validate(item) for item in recent],
    )


def _read_jobs() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    with storage.transaction() as conn:
        return storage.list_active_jobs(conn), storage.list_recent_jobs(conn)


@app.get(
    "/api/jobs/{job_id}/events",
    response_class=StreamingResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
async def job_events(job_id: str) -> StreamingResponse:
    """작업 진행을 SSE 로 구독한다. 붙는 즉시 `snapshot` 을 한 번 받는다.

    끊었다 다시 붙어도 되고, 구독자가 없어도 작업은 계속된다.
    """
    record = await run_in_threadpool(_get_job, job_id)
    if record is None:
        raise not_found("작업을 찾을 수 없습니다.", "목록을 새로고침해 주세요.")

    async def stream() -> AsyncIterator[str]:
        async for name, data in jobs.runner.subscribe(job_id):
            yield sse.event(name, data)

    return StreamingResponse(
        stream(), media_type=sse.SSE_MEDIA_TYPE, headers=sse.SSE_HEADERS
    )


@app.delete(
    "/api/jobs/{job_id}",
    response_model=OkResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
async def cancel_job(job_id: str) -> OkResponse:
    """작업을 취소한다. 대기 중이면 큐에서 빠지고, 실행 중이면 현재 문항 뒤 멈춘다."""
    record = await run_in_threadpool(_get_job, job_id)
    if record is None:
        raise not_found("작업을 찾을 수 없습니다.", "목록을 새로고침해 주세요.")
    # 러너가 모르는 작업 = 이미 끝났거나 서버가 재시작된 것. DB 상태만 정리한다.
    if not jobs.runner.cancel(job_id) and record["status"] in ("queued", "running"):
        await run_in_threadpool(_mark_canceled, job_id)
    return OkResponse()


def _get_job(job_id: str) -> dict[str, Any] | None:
    with storage.transaction() as conn:
        return storage.get_job(conn, job_id)


def _mark_canceled(job_id: str) -> None:
    with storage.transaction() as conn:
        storage.update_job(conn, job_id, status="canceled", current_no=None)


@app.get(
    "/api/files/{node_id}/solutions",
    response_model=SolutionsResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def read_solutions(node_id: NodeId) -> SolutionsResponse:
    """저장된 풀이 목록."""
    return SolutionsResponse.model_validate({"solutions": service.solutions(node_id)})


@app.post(
    "/api/files/{node_id}/problems/{no}/solution",
    response_model=SolutionOut,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
async def save_problem_solution(
    node_id: NodeId,
    no: Annotated[int, Path(ge=1)],
    payload: SolutionContentSave,
) -> SolutionOut:
    """대화 답변 등 주어진 내용을 그 문항의 풀이로 저장한다(upsert).

    "풀이" 탭에 완료로 반영하기 위한 용도. 이미 풀이가 있으면 덮어쓴다.
    """
    saved = await run_in_threadpool(
        service.save_solution_content,
        node_id,
        no,
        content=payload.content,
        usage=payload.usage,
    )
    return SolutionOut.model_validate(saved)


# ------------------------------------------------------------------- 채팅
@app.post(
    "/api/files/{node_id}/chat",
    response_class=StreamingResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
async def chat_with_file(
    node_id: NodeId,
    payload: ChatRequest,
    x_api_key: ApiKeyHeader = None,
) -> StreamingResponse:
    """파일(또는 특정 문항)을 컨텍스트로 대화한다. SSE 스트리밍.

    `problem_no` 로 스레드가 갈린다(생략하면 시험지 전역 스레드). 이력이 상한을
    넘어 잘리면 done 이벤트에 `history_truncated: true` 가 실린다.
    """
    provider = ai_service.resolve_provider(payload.provider, _api_key(x_api_key))
    model = ai_service.resolve_model(payload.model, provider.name)
    context = await run_in_threadpool(
        ai_service.load_chat_context, node_id, payload.message, payload.problem_no
    )
    stream = ai_service.chat_stream(
        node_id=node_id,
        provider=provider,
        turns=context.turns,
        message=payload.message,
        model=model,
        effort=payload.effort,
        problem_no=payload.problem_no,
        truncated_before=context.truncated_before,
    )
    return StreamingResponse(
        stream, media_type=sse.SSE_MEDIA_TYPE, headers=sse.SSE_HEADERS
    )


@app.get(
    "/api/files/{node_id}/chat",
    response_model=ChatHistoryResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def read_chat(node_id: NodeId, problem_no: ProblemNoQuery = None) -> ChatHistoryResponse:
    """한 스레드의 대화 이력. `problem_no` 생략 = 시험지 전역 스레드.

    `truncated_before > 0` 이면 AI 컨텍스트에서 앞쪽 메시지가 잘려나간다
    (요약이 아니라 truncation). 프론트가 안내를 띄우는 데 쓴다.
    """
    return ChatHistoryResponse.model_validate(service.chat_history(node_id, problem_no))


@app.get(
    "/api/files/{node_id}/chat/threads",
    response_model=ChatThreadsResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def read_chat_threads(node_id: NodeId) -> ChatThreadsResponse:
    """스레드 목록(전역 스레드 먼저, 그 뒤 문항 번호 순)."""
    return ChatThreadsResponse.model_validate({"threads": service.chat_threads(node_id)})


@app.delete(
    "/api/files/{node_id}/chat",
    response_model=OkResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def delete_chat(node_id: NodeId, problem_no: ProblemNoQuery = None) -> OkResponse:
    """해당 스레드의 대화 이력만 지운다."""
    service.clear_chat(node_id, problem_no)
    return OkResponse()


# ----------------------------------------------------------- 전역(자유) 대화
@app.post(
    "/api/conversations",
    response_model=ConversationOut,
    status_code=status.HTTP_201_CREATED,
    responses=_ERRORS,
)
def create_conversation(payload: ConversationCreate) -> ConversationOut:
    """ChatGPT 식 전역(파일 무관) 대화를 만든다. 제목 생략 시 "새 대화"."""
    conversation = service.create_conversation(payload.title)
    return ConversationOut.model_validate(conversation)


@app.get(
    "/api/conversations",
    response_model=ConversationsResponse,
    status_code=status.HTTP_200_OK,
)
def read_conversations() -> ConversationsResponse:
    """대화 목록(최근 활동 순). 각 항목에 마지막 메시지 preview 를 담는다."""
    return ConversationsResponse.model_validate(
        {"conversations": service.list_conversations()}
    )


@app.patch(
    "/api/conversations/{conversation_id}",
    response_model=ConversationOut,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def rename_conversation(
    conversation_id: NodeId, payload: ConversationRename
) -> ConversationOut:
    """대화 이름을 바꾼다."""
    conversation = service.rename_conversation(conversation_id, payload.title)
    return ConversationOut.model_validate(conversation)


@app.delete(
    "/api/conversations/{conversation_id}",
    response_model=OkResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def delete_conversation(conversation_id: NodeId) -> OkResponse:
    """대화를 삭제한다(딸린 메시지도 함께)."""
    service.delete_conversation(conversation_id)
    return OkResponse()


@app.get(
    "/api/conversations/{conversation_id}/messages",
    response_model=ConversationMessagesResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def read_conversation_messages(
    conversation_id: NodeId,
) -> ConversationMessagesResponse:
    """대화 메시지 목록(시간순)."""
    return ConversationMessagesResponse.model_validate(
        {"messages": service.conversation_messages(conversation_id)}
    )


@app.post(
    "/api/conversations/{conversation_id}/chat",
    response_class=StreamingResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
async def chat_in_conversation(
    conversation_id: NodeId,
    payload: ConversationChatRequest,
    x_api_key: ApiKeyHeader = None,
) -> StreamingResponse:
    """전역 대화에 메시지를 보낸다. SSE 스트리밍(이벤트 형식은 파일 채팅과 동일).

    `file_id`(+선택 `problem_no`)를 주면 그 시험지/문항을 첨부 컨텍스트로 건다.
    """
    provider = ai_service.resolve_provider(payload.provider, _api_key(x_api_key))
    model = ai_service.resolve_model(payload.model, provider.name)
    context = await run_in_threadpool(
        ai_service.load_conversation_context,
        conversation_id,
        payload.message,
        file_id=payload.file_id,
        problem_no=payload.problem_no,
    )
    stream = ai_service.conversation_chat_stream(
        conversation_id=conversation_id,
        provider=provider,
        turns=context.turns,
        message=payload.message,
        model=model,
        effort=payload.effort,
        file_id=payload.file_id,
        problem_no=payload.problem_no,
        truncated_before=context.truncated_before,
    )
    return StreamingResponse(
        stream, media_type=sse.SSE_MEDIA_TYPE, headers=sse.SSE_HEADERS
    )


# --------------------------------------------------------------- 오답노트
@app.post(
    "/api/notes",
    response_model=NodeResponse,
    status_code=status.HTTP_201_CREATED,
    responses=_ERRORS,
)
def create_note(payload: NoteCreate) -> NodeResponse:
    """오답노트를 만든다(`section='note'` 인 파일형 노드)."""
    node = service.create_note(payload.name, payload.parent_id)
    return NodeResponse(node=NodeOut.model_validate(node))


@app.get(
    "/api/notes/{note_id}",
    response_model=NoteDetailResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def read_note(note_id: NodeId) -> NoteDetailResponse:
    """오답노트 항목 목록. 원본이 지워진 항목은 `source_available=false`."""
    return NoteDetailResponse.model_validate(service.note_detail(note_id))


@app.post(
    "/api/notes/{note_id}/items",
    response_model=NoteItemsResult,
    status_code=status.HTTP_201_CREATED,
    responses=_ERRORS,
)
async def create_note_items(note_id: NodeId, payload: NoteItemsCreate) -> NoteItemsResult:
    """문항 여러 개를 한 번에 담는다. 이미 있는 문항은 `skipped` (멱등)."""
    result = await run_in_threadpool(
        service.add_note_items,
        note_id,
        source_node_id=payload.source_node_id,
        problem_numbers=payload.problem_numbers,
        memo=payload.memo,
    )
    return NoteItemsResult.model_validate(result)


@app.delete(
    "/api/notes/{note_id}/items/{item_id}",
    response_model=OkResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def delete_note_item(note_id: NodeId, item_id: NodeId) -> OkResponse:
    """오답노트 항목 1건을 지운다(크롭 스냅샷도 함께)."""
    service.delete_note_item(note_id, item_id)
    return OkResponse()


@app.get(
    "/api/notes/{note_id}/items/{item_id}/crop",
    response_class=FileResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def read_note_item_crop(note_id: NodeId, item_id: NodeId) -> FileResponse:
    """항목의 크롭 **스냅샷** PNG (`NoteItemOut.crop_url` 이 가리키는 경로).

    원본 시험지가 지워져도 이 스냅샷은 남는다.
    """
    return FileResponse(service.note_crop_path(note_id, item_id), media_type="image/png")


@app.get(
    "/api/notes/{note_id}/export.docx",
    response_class=Response,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
async def export_note_docx(
    note_id: NodeId,
    include: IncludeQuery = "problems",
    source: SourceQuery = None,
    body: BodyQuery = "image",
) -> Response:
    """오답노트 DOCX. 스냅샷 크롭을 담고, `include=full` 이면 원본 풀이도 넣는다.

    원본 시험지가 지워진 항목도 스냅샷으로 들어간다(풀이만 빠진다).
    `body=text` 면 담을 때 복사한 판독본 스냅샷을 텍스트로 낸다.
    항목이 없으면 400 이다.
    """
    return await _export_response(
        service.export_note,
        note_id,
        fmt="docx",
        include=include,
        source=source,
        body=body,
    )


@app.get(
    "/api/notes/{note_id}/export.hwpx",
    response_class=Response,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
async def export_note_hwpx(
    note_id: NodeId,
    include: IncludeQuery = "problems",
    source: SourceQuery = None,
    body: BodyQuery = "image",
) -> Response:
    """오답노트 HWPX(한글). 구성은 DOCX 와 같다."""
    return await _export_response(
        service.export_note,
        note_id,
        fmt="hwpx",
        include=include,
        source=source,
        body=body,
    )


# --------------------------------------------------------------- 사용량
@app.get(
    "/api/usage/summary",
    response_model=UsageSummaryResponse,
    status_code=status.HTTP_200_OK,
)
async def read_usage_summary() -> UsageSummaryResponse:
    """토큰 사용량 집계(사용량 바용). 최근 24시간 / 7일 / 전체 창의 토큰·호출 수."""
    summary = await run_in_threadpool(service.usage_summary)
    return UsageSummaryResponse.model_validate(summary)


@app.get("/api/health", response_model=OkResponse, status_code=status.HTTP_200_OK)
def health() -> OkResponse:
    """헬스체크 (sidecar 기동 확인용)."""
    return OkResponse()


@app.post("/api/login", response_model=OkResponse, status_code=status.HTTP_200_OK)
def login(password: Annotated[str, Body(embed=True)]) -> OkResponse:
    """접속 비밀번호 검증(프론트가 저장 전에 확인).

    인증이 꺼진 로컬에서는 항상 성공. 켜져 있으면 일치해야 200, 아니면 401.
    """
    expected = config.access_password()
    if expected is None:
        return OkResponse()
    if not secrets.compare_digest(password.strip(), expected):
        raise ApiError(
            status.HTTP_401_UNAUTHORIZED,
            "unauthorized",
            "접속 비밀번호가 올바르지 않습니다.",
        )
    return OkResponse()


@app.post(
    "/api/download-tokens",
    response_model=DownloadTokenResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def create_download_token(payload: DownloadTokenIn) -> DownloadTokenResponse:
    """바이너리 GET 용 단기 서명 토큰을 발급한다.

    이 라우트는 `_AUTH_EXEMPT` 가 아니고 POST 라 게이트가 **헤더 인증만** 받는다.
    즉 비밀번호를 아는 요청만 토큰을 받을 수 있다(토큰으로 토큰을 못 만든다).

    토큰은 노드 하나(`/api/files/{id}` 또는 `/api/notes/{id}`) 범위로 묶이므로,
    한 번 받아 그 노드의 원본 PDF·크롭·내보내기에 모두 쓰면 된다.

    인증이 꺼진 로컬에서는 `token=null` 을 준다. 그 환경에는 서명할 비밀번호가
    없고, 억지로 고정 키를 만들면 보호되는 척만 하는 가짜 경계가 된다. 프론트는
    null 이면 쿼리를 붙이지 않으면 되고(어차피 게이트가 통과시킨다), 401/501 로
    막는 것보다 분기가 단순하다.
    """
    scope = download_token.scope_for(payload.path)
    # `?include=full` 같은 쿼리가 붙어 와도 되게 경로만 떼어 판정한다.
    bare_path = payload.path.split("?", 1)[0].split("#", 1)[0]
    if scope is None or not _is_binary_asset(bare_path):
        raise bad_request(
            "invalid_download_path",
            "토큰을 발급할 수 있는 다운로드 경로가 아닙니다.",
            "`/api/files/{id}/...` 또는 `/api/notes/{id}/...` 의 "
            "raw·crop·export.docx·export.hwpx 경로만 가능합니다.",
        )
    expected = config.access_password()
    if expected is None:
        return DownloadTokenResponse(token=None, scope=scope, expires_in=None)
    return DownloadTokenResponse(
        token=download_token.sign(scope, expected),
        scope=scope,
        expires_in=download_token.TTL_SECONDS,
    )
