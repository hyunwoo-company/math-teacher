"""수학 문제풀이 워크스페이스 공용 백엔드 (FastAPI).

실행:
    cd app/core
    uvicorn main:app --port 8100

* 데스크톱(Tauri)에서는 sidecar 로, 웹앱에서는 서버로 같은 코드를 쓴다.
* 배포 모드는 환경변수 `MATH_TEACHER_MODE=desktop|web` (기본 desktop).
* 모든 에러는 `{error_code, message, hint}` (message 는 한국어).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any, Final, Literal

from fastapi import FastAPI, File, Form, Header, Path, Query, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

import ai_service
import config
import pricing
import service
import sse
import storage
from errors import register_error_handlers
from providers import agy, subscription
from schemas import (
    AgyProviderInfo,
    ApiKeyIn,
    ApiKeyProviderInfo,
    ChatHistoryResponse,
    ChatRequest,
    ChatThreadsResponse,
    EnvResponse,
    ErrorBody,
    FileDetailResponse,
    FolderCreate,
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
    Section,
    SolutionsResponse,
    SolveRequest,
    SubscriptionInfo,
    SubscriptionProviderInfo,
    TreeResponse,
)

# 프론트엔드(Next.js dev) 와 Tauri 로컬 웹뷰에서 호출한다.
ALLOWED_ORIGINS: Final[list[str]] = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    "tauri://localhost",
]

_ERRORS: Final[dict[int | str, dict[str, Any]]] = {
    400: {"model": ErrorBody, "description": "잘못된 요청"},
    404: {"model": ErrorBody, "description": "대상을 찾을 수 없음"},
    409: {"model": ErrorBody, "description": "사용할 수 있는 AI 연결이 없음"},
}

NodeId = Annotated[str, Path(min_length=1, max_length=64)]
SectionQuery = Annotated[Section, Query(description="exam=시험지, note=오답노트")]
ProblemNoQuery = Annotated[
    int | None,
    Query(ge=1, description="문항별 스레드. 생략하면 시험지 전역 스레드"),
]


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """시작 시 데이터 디렉터리와 DB 스키마를 준비한다."""
    config.ensure_dirs()
    await run_in_threadpool(storage.init_db)
    yield


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
)
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
    detected = subscription.availability()
    subscription_available = bool(detected["available"])
    agy_detected = agy.availability()
    agy_available = bool(agy_detected["available"])
    api_key_set = config.stored_api_key() is not None

    claude_models = _claude_provider_models()
    agy_models = [ProviderModelInfo.model_validate(item) for item in agy.agy_models()]

    default_provider: Literal["agy", "subscription", "apikey"]
    if agy_available:
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
    )


@app.post(
    "/api/settings/apikey", response_model=OkResponse, status_code=status.HTTP_200_OK
)
def save_api_key(payload: ApiKeyIn) -> OkResponse:
    """API 키를 `data/settings.json` 에 평문 저장한다 (README 경고 참조)."""
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
    return NodeResponse(
        node=NodeOut.model_validate(node), extract_error=extract_error
    )


@app.get(
    "/api/files/{node_id}",
    response_model=FileDetailResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def read_file(node_id: NodeId) -> FileDetailResponse:
    """파일 노드와 문항 목록(풀이 존재 여부 포함)."""
    return FileDetailResponse.model_validate(service.file_detail(node_id))


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


# ------------------------------------------------------------------- 풀이
@app.post(
    "/api/files/{node_id}/solve",
    response_class=StreamingResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
async def solve_file(
    node_id: NodeId,
    payload: SolveRequest,
    x_api_key: ApiKeyHeader = None,
) -> StreamingResponse:
    """선택 문항(또는 전체)을 순차로 풀어 SSE 로 스트리밍한다."""
    provider = ai_service.resolve_provider(payload.provider, _api_key(x_api_key))
    model = ai_service.resolve_model(payload.model, provider.name)
    mode, targets = await run_in_threadpool(
        ai_service.load_solve_targets, node_id, payload.problem_numbers
    )
    stream = ai_service.solve_stream(
        node_id=node_id,
        provider=provider,
        mode=mode,
        targets=targets,
        model=model,
        effort=payload.effort,
    )
    return StreamingResponse(
        stream, media_type=sse.SSE_MEDIA_TYPE, headers=sse.SSE_HEADERS
    )


@app.get(
    "/api/files/{node_id}/solutions",
    response_model=SolutionsResponse,
    status_code=status.HTTP_200_OK,
    responses=_ERRORS,
)
def read_solutions(node_id: NodeId) -> SolutionsResponse:
    """저장된 풀이 목록."""
    return SolutionsResponse.model_validate({"solutions": service.solutions(node_id)})


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
async def create_note_items(
    note_id: NodeId, payload: NoteItemsCreate
) -> NoteItemsResult:
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
    return FileResponse(
        service.note_crop_path(note_id, item_id), media_type="image/png"
    )


@app.get("/api/health", response_model=OkResponse, status_code=status.HTTP_200_OK)
def health() -> OkResponse:
    """헬스체크 (sidecar 기동 확인용)."""
    return OkResponse()
