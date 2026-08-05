"""요청/응답 Pydantic 모델 (ARCHITECTURE.md 5항 계약)."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field

import config
from providers.base import DEFAULT_EFFORT, Effort

NodeType = Literal["folder", "file"]
ProviderName = Literal["auto", "subscription", "apikey", "agy"]
Mode = Literal["text", "image"]
# 좌측 패널 2섹션: 시험지 트리 / 오답노트 트리 (ARCHITECTURE 6-A).
Section = Literal["exam", "note"]

NameStr = Annotated[str, Field(min_length=1, max_length=config.MAX_NAME_LENGTH)]


class ErrorBody(BaseModel):
    """모든 에러 응답의 형태."""

    error_code: str
    message: str
    hint: str | None = None


class OkResponse(BaseModel):
    """성공 여부만 돌려주는 응답."""

    ok: Literal[True] = True


class FileMeta(BaseModel):
    """파일 노드의 추출 요약."""

    pages: int
    problem_count: int
    mode: Mode
    pua_ratio: float


class NodeOut(BaseModel):
    """폴더/파일 노드. 오답노트 노드는 `section="note"` 인 `type="file"` 이다."""

    id: str
    type: NodeType
    name: str
    parent_id: str | None = None
    section: Section = "exam"
    created_at: str
    file: FileMeta | None = None


class TreeResponse(BaseModel):
    """`GET /api/tree` 응답 (플랫 배열)."""

    nodes: list[NodeOut]


class FolderCreate(BaseModel):
    """폴더 생성 요청. `section` 기본값은 기존 호환을 위해 `exam`."""

    name: NameStr
    parent_id: str | None = None
    section: Section = "exam"


class NoteCreate(BaseModel):
    """오답노트 생성 요청(`section='note'` 인 파일형 노드)."""

    name: NameStr
    parent_id: str | None = None


class NodeUpdate(BaseModel):
    """이름변경/이동. `parent_id: null` 은 루트로 이동을 뜻한다."""

    name: NameStr | None = None
    parent_id: str | None = None


class NodeResponse(BaseModel):
    """노드 1건 응답."""

    node: NodeOut
    # 업로드 시 추출이 실패해도 파일은 등록한다. 그 사유를 여기에 담는다.
    extract_error: str | None = None


class ProblemOut(BaseModel):
    """추출된 문항 1건."""

    no: int
    page: int
    bbox: list[float]
    image_w: int
    image_h: int
    has_solution: bool


class FileDetailResponse(BaseModel):
    """`GET /api/files/{id}` 응답."""

    node: NodeOut
    problems: list[ProblemOut]


class ModelInfo(BaseModel):
    """모델 목록 항목(단가 포함)."""

    id: str
    label: str
    input_usd_per_mtok: float
    output_usd_per_mtok: float


class SubscriptionInfo(BaseModel):
    """구독 모드 사용 가능 여부와 그 사유.

    `reason` 값은 `providers.subscription.unavailable_reason()` 참조
    (ok / cli_missing / not_logged_in / sdk_missing / web_mode / disabled).
    """

    available: bool
    cli_path: str | None = None
    reason: str = "ok"


class ProviderModelInfo(BaseModel):
    """프로바이더별 모델 목록 항목(ARCHITECTURE 3-C)."""

    id: str
    label: str
    default: bool = False


class AgyProviderInfo(BaseModel):
    """`env.providers.agy`. `reason` 은 `ok` 또는 `agy_missing`."""

    available: bool
    reason: str
    models: list[ProviderModelInfo]


class SubscriptionProviderInfo(BaseModel):
    """`env.providers.subscription`. 기존 subscription 감지 로직을 재사용한다."""

    available: bool
    cli_path: str | None = None
    reason: str
    models: list[ProviderModelInfo]


class ApiKeyProviderInfo(BaseModel):
    """`env.providers.apikey`. `available` 은 저장된 API 키 존재 여부."""

    available: bool
    models: list[ProviderModelInfo]


class ProvidersInfo(BaseModel):
    """`env.providers` (프로바이더 3종 + 동적 모델 목록)."""

    agy: AgyProviderInfo
    subscription: SubscriptionProviderInfo
    apikey: ApiKeyProviderInfo


class EnvResponse(BaseModel):
    """`GET /api/env` 응답.

    최상위 `models` / `subscription` 은 하위호환으로 유지한다(agy 미도입 프론트용).
    새 프론트는 `providers` / `default_provider` 를 쓴다(ARCHITECTURE 3-C).
    """

    mode: Literal["desktop", "web"]
    subscription: SubscriptionInfo
    api_key_set: bool
    models: list[ModelInfo]
    usd_krw: float
    providers: ProvidersInfo
    default_provider: Literal["agy", "subscription", "apikey"]
    # 배포 시 접속 비밀번호 인증이 켜져 있으면 true. 프론트가 로그인 게이트 표시.
    auth_required: bool = False


class ApiKeyIn(BaseModel):
    """API 키 저장 요청."""

    key: Annotated[str, Field(min_length=8, max_length=500)]


class SolveRequest(BaseModel):
    """`problem_numbers` 가 null 이면 전체 문항."""

    problem_numbers: list[int] | None = None
    provider: ProviderName = "auto"
    model: str | None = None
    effort: Effort = DEFAULT_EFFORT


class ChatRequest(BaseModel):
    """채팅 요청. `problem_no` 가 있으면 그 문항을 컨텍스트로 건다."""

    message: Annotated[str, Field(min_length=1, max_length=8000)]
    provider: ProviderName = "auto"
    model: str | None = None
    effort: Effort = DEFAULT_EFFORT
    problem_no: int | None = None


class SolutionOut(BaseModel):
    """저장된 풀이 1건."""

    no: int
    solution: str
    usage: dict[str, Any] | None = None
    cost: dict[str, Any] | None = None
    truncated: bool = False
    created_at: str


class SolutionsResponse(BaseModel):
    """`GET /api/files/{id}/solutions` 응답."""

    solutions: list[SolutionOut]


class ChatMessageOut(BaseModel):
    """채팅 메시지 1건. `problem_no=null` 이면 시험지 전역 스레드."""

    role: Literal["user", "assistant"]
    content: str
    problem_no: int | None = None
    created_at: str
    usage: dict[str, Any] | None = None
    cost: dict[str, Any] | None = None


class ChatHistoryResponse(BaseModel):
    """`GET /api/files/{id}/chat` 응답 (한 스레드)."""

    problem_no: int | None = None
    messages: list[ChatMessageOut]
    # AI 컨텍스트에서 **잘려나가는**(truncation, 요약 아님) 앞쪽 메시지 수.
    # 0 보다 크면 프론트가 "이전 대화 일부가 생략됩니다" 를 띄운다.
    truncated_before: int = 0


class ChatThreadOut(BaseModel):
    """스레드 1건 요약."""

    problem_no: int | None = None
    turns: int
    updated_at: str


class ChatThreadsResponse(BaseModel):
    """`GET /api/files/{id}/chat/threads` 응답."""

    threads: list[ChatThreadOut]


class NoteItemOut(BaseModel):
    """오답노트 항목 1건.

    `source_node_id` 가 null 이면 원본 시험지가 삭제된 것이다. 이때도 항목은 남고
    `source_name` / `crop_url` 스냅샷으로 계속 보인다(바로가기만 비활성).
    """

    id: str
    source_node_id: str | None = None
    source_name: str
    problem_no: int
    crop_url: str | None = None
    memo: str | None = None
    created_at: str
    source_available: bool


class NoteDetailResponse(BaseModel):
    """`GET /api/notes/{note_id}` 응답."""

    node: NodeOut
    items: list[NoteItemOut]


class NoteItemsCreate(BaseModel):
    """`POST /api/notes/{note_id}/items` 요청. 여러 문항을 한 번에 담는다."""

    source_node_id: Annotated[str, Field(min_length=1, max_length=64)]
    problem_numbers: Annotated[list[Annotated[int, Field(ge=1)]], Field(min_length=1)]
    memo: Annotated[str | None, Field(max_length=2000)] = None


class NoteItemsResult(BaseModel):
    """`POST /api/notes/{note_id}/items` 응답. `skipped` 는 이미 있던 문항."""

    added: list[int]
    skipped: list[int]
