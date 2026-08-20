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
    """추출된 문항 1건.

    `no` 는 저장·조회에 쓰는 통짜 순번이고, `label` 은 문제지에 찍힌 표기다.
    구획마다 번호가 1 부터 다시 시작하는 교재에서만 둘이 다르다.

    판독본(문항 텍스트화)은 **본문을 싣지 않는다** — 풀이(`has_solution`)와 같은
    규칙이다. 여기에는 배지에 필요한 만큼(있는지 / 출처 / 실패 이유)만 담고,
    전문은 `GET /api/files/{id}/transcripts` 로 받는다.
    """

    no: int
    label: str = ""
    page: int
    bbox: list[float]
    image_w: int
    image_h: int
    has_solution: bool
    #: 판독본(`transcript`)이 저장돼 있는지. 없으면 내보낼 때 이미지로 폴백한다.
    has_transcript: bool = False
    #: 판독본 출처. `pua`(디코딩) / `ai`(AI 판독) / `manual`(직접 수정). 없으면 null.
    #: 나중에 값이 늘어도 조회가 깨지지 않도록 `str` 로 둔다(Literal 로 좁히지 않음).
    transcript_source: str | None = None
    #: 판독 실패·불가 이유(예: "불가 - 좌표평면 그래프"). 없으면 null.
    transcript_note: str | None = None


class FileDetailResponse(BaseModel):
    """`GET /api/files/{id}` 응답."""

    node: NodeOut
    problems: list[ProblemOut]


class ReextractResponse(BaseModel):
    """`POST /api/files/{id}/reextract` 응답.

    `extract_error` 는 추출이 실패했거나 문항을 못 찾았을 때의 사유다(성공이면 None).
    `deleted_solutions` 는 재추출로 지워진 기존 풀이 건수다.
    """

    node: NodeOut
    problems: list[ProblemOut]
    extract_error: str | None = None
    deleted_solutions: int = 0


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


class DownloadTokenIn(BaseModel):
    """`POST /api/download-tokens` 요청.

    앞으로 받아갈 바이너리 GET 경로를 그대로 준다(예: `/api/files/ab12/raw`).
    쿼리스트링이 붙어 있어도 되며 서버가 떼고 범위를 계산한다.
    """

    path: Annotated[str, Field(min_length=1, max_length=500, pattern=r"^/api/")]


class DownloadTokenResponse(BaseModel):
    """`POST /api/download-tokens` 응답.

    `token` 을 바이너리 GET 의 `?token=` 쿼리에 붙이면 접속 비밀번호를 URL 에
    싣지 않고도 통과한다. 같은 `scope`(노드 하나) 안의 다른 바이너리 경로에도
    재사용할 수 있으니 화면 단위로 한 번만 받아 캐시하면 된다.

    만료 시각 대신 `expires_in`(초)을 주는 이유: 클라이언트 시계가 서버와
    어긋나 있어도 "받은 지 N초" 는 항상 맞기 때문이다.

    인증이 꺼진 로컬(`auth_required=false`)에서는 `token`/`expires_in` 이 null
    이다. 붙일 토큰이 없다는 뜻이며, 그 환경에서는 쿼리 없이도 통과한다.
    """

    token: str | None = None
    scope: str
    expires_in: int | None = None


class SolveRequest(BaseModel):
    """`problem_numbers` 가 null 이면 전체 문항."""

    problem_numbers: list[int] | None = None
    provider: ProviderName = "auto"
    model: str | None = None
    effort: Effort = DEFAULT_EFFORT


VariantKind = Literal["number", "condition", "number_condition"]


class VariantRequest(BaseModel):
    """`POST /api/files/{id}/problems/{no}/variant` 요청.

    `mode` 는 무엇을 바꿀지다: `number`=수치만, `condition`=조건(설정·상황)만,
    `number_condition`=둘 다. 값이 셋 중 하나가 아니면 422 로 거부된다.
    """

    mode: VariantKind
    provider: ProviderName = "auto"
    model: str | None = None
    effort: Effort = DEFAULT_EFFORT


JobKind = Literal["solve", "variant", "transcribe"]
JobStatus = Literal["queued", "running", "done", "error", "canceled", "interrupted"]


class JobCreate(BaseModel):
    """`POST /api/jobs` 요청.

    `kind="solve"` 면 `problem_numbers`(null = 전체)를 쓴다.

    `kind="variant"` 는 대상 문항을 두 가지로 받는다. `problem_numbers` 가 오면
    그 문항들을, 없으면 `no` 하나를 대상으로 삼는다(문항별 `VariantPanel` 이
    계속 `no` 를 쓴다). 만들 조합은 (문항 x `modes`) 이며, `force` 가 아니면
    이미 만들어 둔 조합은 건너뛴다.

    `kind="transcribe"` 는 문항을 텍스트로 옮긴다. 대상은 solve 와 같은
    `problem_numbers`(null = 전체)이고, `force` 가 아니면 이미 판독본이 있는
    문항은 건너뛴다. 1차 경로(PDF 텍스트 레이어 디코딩)로 끝나는 문항은 AI 를
    호출하지 않으므로 대상 수가 곧 AI 호출 수는 아니다.
    """

    kind: JobKind
    #: 시험지 노드 id.
    node_id: str
    #: solve/transcribe: 대상 문항(null = 전체). variant: 대상 문항들(null 이면 `no`).
    problem_numbers: list[int] | None = None
    #: variant 전용. 소스 문항 번호(단일 경로, 하위호환).
    no: int | None = None
    #: variant 전용. 만들 변형 종류들.
    modes: list[VariantKind] | None = None
    #: 이미 결과가 있는 대상도 다시 실행할지.
    force: bool = False
    provider: ProviderName = "auto"
    model: str | None = None
    effort: Effort = DEFAULT_EFFORT


class JobOut(BaseModel):
    """작업 1건의 진행 상태."""

    id: str
    kind: JobKind
    node_id: str
    #: 표시용 시험지 이름 스냅샷(노드가 지워져도 배너에 이름이 남는다).
    node_name: str
    status: JobStatus
    total: int
    done_count: int
    current_no: int | None = None
    error: str | None = None
    created_at: str
    updated_at: str


class JobCreated(BaseModel):
    """`POST /api/jobs` 응답.

    `existing` 이 true 면 같은 대상의 작업이 이미 있어 새로 만들지 않고
    그것을 돌려준 것이다(버튼 두 번 눌러 쿼터를 두 배로 쓰는 것을 막는다).
    """

    job: JobOut
    existing: bool = False
    #: 큐에서 앞에 있는 작업 수(0이면 바로 시작).
    position: int = 0


class JobsResponse(BaseModel):
    """`GET /api/jobs` 응답. 진행 중 전부 + 최근 종료분."""

    active: list[JobOut]
    recent: list[JobOut]


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


class VariantOut(BaseModel):
    """저장된 변형 1건. `mode` 는 변형 종류, `text` 는 마크다운 원문."""

    no: int
    mode: VariantKind
    text: str
    usage: dict[str, Any] | None = None
    cost: dict[str, Any] | None = None
    created_at: str


class VariantsResponse(BaseModel):
    """`GET /api/files/{id}/variants` 응답 (문항 번호 → 변형 종류 순)."""

    variants: list[VariantOut]


class TranscriptOut(BaseModel):
    """문항 판독본 1건(문항 텍스트화).

    `transcript` 가 null 이고 `transcript_note` 만 있으면 판독하지 못한 문항이다
    (이유를 화면 배지로 보여주고, 내보낼 때는 이미지로 폴백한다).
    """

    no: int
    transcript: str | None = None
    #: `pua`(디코딩) / `ai`(AI 판독) / `manual`(직접 수정). 없으면 null.
    transcript_source: str | None = None
    transcript_note: str | None = None


class TranscriptsResponse(BaseModel):
    """`GET /api/files/{id}/transcripts` 응답 (문항 번호 순).

    판독본도 이유도 없는(= 아직 판독하지 않은) 문항은 빠진다.
    """

    transcripts: list[TranscriptOut]


class TranscriptSave(BaseModel):
    """`PATCH /api/files/{id}/problems/{no}/transcript` 요청.

    사용자가 대조 화면에서 고친 전문을 저장한다(`transcript_source='manual'`).
    **빈 문자열이면 판독본을 지운다** — 되돌리는 경로다.
    """

    text: Annotated[str, Field(max_length=config.MAX_TRANSCRIPT_LENGTH)]


class SolutionContentSave(BaseModel):
    """`POST /api/files/{id}/problems/{no}/solution` 요청.

    대화(채팅) 답변 등 이미 만들어진 풀이 내용을 그 문항의 풀이로 저장(upsert)한다.
    `source` 는 어디서 온 내용인지(예: "chat") 표시용이며 저장 대상은 아니다.
    """

    content: Annotated[str, Field(min_length=1)]
    usage: dict[str, Any] | None = None
    source: Annotated[str | None, Field(max_length=64)] = None


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


class ConversationOut(BaseModel):
    """전역(파일 무관) 자유 대화 1건. `preview` 는 마지막 메시지 앞부분."""

    id: str
    title: str
    created_at: str
    updated_at: str
    preview: str | None = None


class ConversationsResponse(BaseModel):
    """`GET /api/conversations` 응답 (updated_at 내림차순)."""

    conversations: list[ConversationOut]


class ConversationCreate(BaseModel):
    """`POST /api/conversations` 요청. `title` 생략 시 서버가 기본값을 넣는다."""

    title: NameStr | None = None


class ConversationRename(BaseModel):
    """`PATCH /api/conversations/{id}` 요청 (이름 변경)."""

    title: NameStr


class ConversationMessageOut(BaseModel):
    """전역 대화 메시지 1건.

    `file_id` / `problem_no` 는 그 메시지가 특정 시험지·문항을 첨부 컨텍스트로
    걸었을 때만 채워진다(자유 대화면 둘 다 null).
    """

    role: Literal["user", "assistant"]
    content: str
    file_id: str | None = None
    problem_no: int | None = None
    created_at: str
    usage: dict[str, Any] | None = None
    cost: dict[str, Any] | None = None


class ConversationMessagesResponse(BaseModel):
    """`GET /api/conversations/{id}/messages` 응답 (시간순)."""

    messages: list[ConversationMessageOut]


class ConversationChatRequest(BaseModel):
    """`POST /api/conversations/{id}/chat` 요청.

    `file_id`(+선택 `problem_no`)를 주면 그 시험지/문항을 첨부 컨텍스트로 건다.
    """

    message: Annotated[str, Field(min_length=1, max_length=8000)]
    file_id: str | None = None
    problem_no: Annotated[int | None, Field(ge=1)] = None
    provider: ProviderName = "auto"
    model: str | None = None
    effort: Effort = DEFAULT_EFFORT


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
    # 원본이 살아 있을 때 그 문항의 정리된 파싱 텍스트(PUA·제어문자 제거). 없으면 null.
    text: str | None = None
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


class UsageWindow(BaseModel):
    """한 시간 창의 토큰 합계와 호출(usage 있는 행) 수."""

    tokens: int
    calls: int


class UsageWindows(BaseModel):
    """사용량 바가 쓰는 세 시간 창(최근 24시간 / 7일 / 전체)."""

    last_24h: UsageWindow
    last_7_days: UsageWindow
    total: UsageWindow


class UsageSummaryResponse(BaseModel):
    """`GET /api/usage/summary` 응답."""

    windows: UsageWindows
