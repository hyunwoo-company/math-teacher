/**
 * ARCHITECTURE.md 5항 "API 계약" 을 그대로 옮긴 타입.
 * 경로/필드명은 임의로 바꾸지 않는다.
 */

export type AppMode = 'desktop' | 'web';
export type NodeType = 'folder' | 'file';
export type ExtractMode = 'text' | 'image';
/** 계약 3-C: provider 4종 (agy 추가). */
export type ProviderChoice = 'auto' | 'subscription' | 'apikey' | 'agy';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** 좌측 패널 섹션 (계약 6-A). */
export type Section = 'exam' | 'note';

export const EFFORT_OPTIONS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULT_EFFORT: Effort = 'medium';
export const DEFAULT_MODEL = 'claude-opus-5';

/** `GET /api/env` 의 models 원소. */
export interface ModelInfo {
  id: string;
  label: string;
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
}

/**
 * 구독을 쓸 수 없는 이유 (`GET /api/env` 의 `subscription.reason`).
 * 프론트가 안내 문구를 갈라 쓴다.
 */
export type SubscriptionReason =
  | 'ok'
  | 'cli_missing'
  | 'not_logged_in'
  | 'sdk_missing'
  | 'web_mode'
  | 'disabled';

export interface SubscriptionInfo {
  available: boolean;
  cli_path: string | null;
  /**
   * 나중에 추가된 필드다. 구버전 백엔드는 주지 않으므로 optional 로 두고,
   * 없을 때는 `lib/subscription-status.ts` 가 다른 필드로 추론한다.
   * 모르는 값이 올 수도 있으므로 union 으로 좁히지 않는다.
   */
  reason?: string;
}

/** 계약 3-C: provider 별 모델 원소. `default` 로 기본 모델 표시. */
export interface ProviderModel {
  id: string;
  label: string;
  default?: boolean;
  /** apikey 모델만 단가가 있다(예상 비용 계산용). */
  input_usd_per_mtok?: number;
  output_usd_per_mtok?: number;
}

/** 계약 3-C: `GET /api/env` 의 providers[key]. */
export interface ProviderInfo {
  available: boolean;
  reason?: string;
  cli_path?: string | null;
  models: ProviderModel[];
}

/** 계약 3-C: providers 맵. 백엔드가 agy 지원을 붙인 뒤에 온다(구버전은 없음). */
export interface ProvidersMap {
  agy?: ProviderInfo;
  subscription?: ProviderInfo;
  apikey?: ProviderInfo;
}

/** `GET /api/env` */
export interface EnvResponse {
  mode: AppMode;
  subscription: SubscriptionInfo;
  api_key_set: boolean;
  models: ModelInfo[];
  usd_krw: number;
  /**
   * 계약 3-C. agy provider 도입 후에 온다. 구버전 백엔드는 주지 않으므로 optional.
   * 없으면 최상위 `models`/`subscription` 으로 폴백한다(하위호환).
   */
  providers?: ProvidersMap;
  default_provider?: ProviderChoice;
  /**
   * 접속 비밀번호(공유 암호) 게이트가 필요한지.
   * 비번 미설정(로컬 개발)이면 false. 구버전 백엔드는 주지 않으므로 optional(없으면 false).
   * 이 값이 true 일 때만 프론트가 로그인 화면을 띄운다.
   */
  auth_required?: boolean;
}

/** 파일 노드에만 붙는 추출 메타데이터. */
export interface FileMeta {
  pages: number;
  problem_count: number;
  mode: ExtractMode;
  pua_ratio: number;
}

/** `GET /api/tree` 의 nodes 원소 (플랫 배열). */
export interface TreeNode {
  id: string;
  type: NodeType;
  name: string;
  parent_id: string | null;
  created_at: string;
  file?: FileMeta | null;
  /** 'exam' | 'note'. 구버전 백엔드는 안 줄 수 있으므로 optional. */
  section?: Section;
}

export interface TreeResponse {
  nodes: TreeNode[];
}

/**
 * 문제 하나.
 * `bbox` 는 PDF 좌표계(pt) `[x0, y0, x1, y1]`, `page` 는 1-base.
 * (service/extractor.py 의 Problem 을 따른다.)
 */
export interface Problem {
  /** 저장·조회에 쓰는 통짜 순번. 화면 조작은 전부 이 값을 쓴다. */
  no: number;
  /**
   * 문제지에 찍힌 번호 표기.
   *
   * 구획마다 번호가 1 부터 다시 시작하는 교재(부교재·문제집)에서만 `no` 와
   * 다르다. 보통 시험지는 둘이 같다.
   */
  label?: string;
  page: number;
  bbox: number[];
  image_w: number;
  image_h: number;
  has_solution: boolean;
  /**
   * 판독본(문항 텍스트화)이 저장돼 있는지. 전문은 싣지 않는다(풀이와 같은 규칙) —
   * 전문은 `GET /api/files/{id}/transcripts` 로 받는다.
   * 판독본 도입 전 백엔드는 주지 않으므로 optional 이다.
   */
  has_transcript?: boolean;
  /**
   * 판독본 출처. `pua`(디코딩) / `ai`(AI 판독) / `manual`(직접 수정).
   * 백엔드가 값을 늘려도 조회가 깨지지 않도록 union 으로 좁히지 않는다
   * (좁히기는 `lib/transcript.ts` 가 한다).
   */
  transcript_source?: string | null;
  /** 판독 실패·불가 이유(예: "불가 - 좌표평면 그래프"). */
  transcript_note?: string | null;
}

/** `GET /api/files/{id}` */
export interface FileDetail {
  node: TreeNode;
  problems: Problem[];
}

/** `POST /api/files/{id}/reextract` 응답. 원본 PDF 를 그대로 다시 추출한 결과. */
export interface ReextractResult extends FileDetail {
  /** 추출 실패/문항 미검출 사유. 성공이면 null. */
  extract_error: string | null;
  /** 재추출로 지워진 기존 풀이 건수. */
  deleted_solutions: number;
}

/**
 * Anthropic usage. 구독 모드에서는 null 이 올 수 있다.
 * 필드가 빠질 수 있으므로 전부 optional 로 둔다.
 */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * 비용 객체. service/pricing.py `calc_cost()` 의 반환 모양을 따른다.
 * 구독 모드에서는 null.
 */
export interface Cost {
  model?: string;
  resolved_model?: string;
  tokens?: { input: number; output: number; cache_write: number; cache_read: number; total: number };
  total_usd?: number;
  total_krw?: number;
  usd_krw?: number;
}

/** `GET /api/files/{id}/solutions` 의 원소. */
export interface Solution {
  no: number;
  solution: string;
  usage: Usage | null;
  cost: Cost | null;
  created_at: string;
  truncated?: boolean;
}

export interface SolutionsResponse {
  solutions: Solution[];
}

/* ── 문항 텍스트화(판독본) ───────────────────────────────────────── */

/**
 * `GET /api/files/{id}/transcripts` 의 원소.
 *
 * `transcript` 가 null 이고 `transcript_note` 만 있으면 판독하지 못한 문항이다
 * (화면은 이유를 배지로 보여주고, 내보낼 때는 이미지로 폴백한다).
 *
 * **여기는 긴 이름이 맞다.** 같은 값을 실어 오는 SSE `done` 이벤트는 짧은
 * 이름(`source`/`note`)을 쓴다 — `SolveDoneEvent` 참고.
 */
export interface Transcript {
  no: number;
  transcript: string | null;
  /** `pua` / `ai` / `manual`. 계약대로 좁히지 않는다. */
  transcript_source: string | null;
  transcript_note: string | null;
}

export interface TranscriptsResponse {
  transcripts: Transcript[];
}

/* ── 오답노트 (계약 6-A) ─────────────────────────────────────────── */

/** 노트 항목. 풀이는 저장하지 않고 "어느 시험지의 몇 번" 만 담는다. */
export interface NoteItem {
  id: string;
  /** 원본 시험지 노드 id. 원본이 지워지면 null. */
  source_node_id: string | null;
  /** 추가 시점 시험지 이름 스냅샷(원본이 지워져도 남는다). */
  source_name: string;
  problem_no: number;
  /** 크롭 스냅샷 PNG URL (백엔드가 절대/상대 경로로 준다). */
  crop_url: string;
  /**
   * 원본 시험지가 살아 있을 때 그 문항의 정리된 파싱 텍스트(PUA·제어문자 제거).
   * 원본이 삭제됐거나 본문을 못 뽑았으면 null.
   */
  text: string | null;
  memo: string | null;
  created_at: string;
  /** 원본 시험지가 아직 살아 있는지. false 면 바로가기 비활성 + "원본 삭제됨". */
  source_available: boolean;
}

/** `GET /api/notes/{id}` */
export interface NoteDetail {
  node: TreeNode;
  items: NoteItem[];
}

/** `POST /api/notes/{id}/items` 결과. skipped = 이미 있던 것(멱등). */
export interface AddNoteItemsResult {
  added: number[];
  skipped: number[];
}

/* ── 문항별 스레드 (계약 6-B) ────────────────────────────────────── */

/** `GET /api/files/{id}/chat/threads` 의 원소. */
export interface ChatThread {
  /** null = 시험지 전역 스레드. */
  problem_no: number | null;
  turns: number;
  updated_at: string;
}

export interface ThreadsResponse {
  threads: ChatThread[];
}

export type ChatRole = 'user' | 'assistant';

/** `GET /api/files/{id}/chat` 의 원소. */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  created_at: string;
  usage?: Usage | null;
  cost?: Cost | null;
}

export interface ChatHistoryResponse {
  messages: ChatMessage[];
}

/* ── 전역(파일 무관) 자유 대화 ───────────────────────────────────── */

/** `GET /api/conversations` 의 원소 / `POST`·`PATCH` 응답. */
export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  /** 마지막 메시지 앞부분(목록 미리보기). 없으면 null. */
  preview: string | null;
}

export interface ConversationsResponse {
  conversations: Conversation[];
}

/**
 * `GET /api/conversations/{id}/messages` 의 원소.
 * `file_id`/`problem_no` 는 그 메시지가 특정 시험지·문항을 컨텍스트로 걸었을 때만 채워진다.
 */
export interface ConversationMessage {
  role: ChatRole;
  content: string;
  file_id: string | null;
  problem_no: number | null;
  created_at: string;
  usage?: Usage | null;
  cost?: Cost | null;
}

export interface ConversationMessagesResponse {
  messages: ConversationMessage[];
}

/** `POST /api/conversations/{id}/chat` 요청 본문. */
export interface ConversationChatRequest {
  message: string;
  file_id?: string | null;
  problem_no?: number | null;
  provider: ProviderChoice;
  model?: string;
  effort?: string;
}

/* ── 사용량 요약 (agy 쿼터 기반) ─────────────────────────────────── */

/** 한 시간창의 사용량. agy 는 쿼터 기반이라 금액이 아니라 토큰/호출 수로 센다. */
export interface UsageWindow {
  tokens: number;
  calls: number;
}

/**
 * `GET /api/usage/summary`.
 * 아직 배포되지 않았을 수 있는 신규 엔드포인트다. 실패 시 세션 값만 표시하도록
 * 호출부에서 조용히 폴백한다.
 */
export interface UsageSummaryResponse {
  windows: {
    last_24h: UsageWindow;
    last_7_days: UsageWindow;
    total: UsageWindow;
  };
}

/** 모든 에러 응답의 공통 모양. */
export interface ApiErrorBody {
  error_code: string;
  message: string;
  hint: string | null;
}

/** `POST /api/files/{id}/solve` 요청 본문. */
export interface SolveRequest {
  problem_numbers?: number[] | null;
  provider: ProviderChoice;
  model?: string;
  effort?: string;
}

/** `POST /api/files/{id}/chat` 요청 본문. */
export interface ChatRequest {
  message: string;
  provider: ProviderChoice;
  model?: string;
  effort?: string;
  problem_no?: number | null;
}

/**
 * 변형 문제 생성 모드(곧 배포될 계약).
 *  - number            : 숫자만 바꾼 동일 유형
 *  - condition         : 조건(설정/상황)을 바꾼 동일 유형
 *  - number_condition  : 숫자·조건 모두 바꾼 동일 유형
 */
export type VariantMode = 'number' | 'condition' | 'number_condition';

/**
 * `POST /api/files/{id}/problems/{no}/variant` 요청 본문(계약).
 * provider/model/effort 는 서버 기본값을 쓸 수 있어 optional 이다.
 */
export interface VariantRequest {
  mode: VariantMode;
  provider?: ProviderChoice;
  model?: string;
  effort?: string;
}

/* ── 내보내기 ────────────────────────────────────────────────────── */

/** 무엇을 내보낼지. */
export type ExportTarget = 'exam' | 'variants' | 'note';
/** 파일 형식. hwpx 는 한글 네이티브, docx 는 한글·워드 모두에서 열린다. */
export type ExportFormat = 'docx' | 'hwpx';
/** 문서 구성: 문제만 / 문제+해설. */
export type ExportInclude = 'problems' | 'full';
/**
 * 문항 본문을 무엇으로 낼지.
 *  - `image` (기본): 지금까지와 완전히 같은 문서(크롭 이미지).
 *  - `text`        : 판독본이 있는 문항은 텍스트로 조판하고 없으면 이미지로 폴백한다.
 */
export type ExportBody = 'image' | 'text';

/** 저장된 변형 1건. */
export interface Variant {
  no: number;
  mode: VariantMode;
  text: string;
  usage: Usage | null;
  cost: Cost | null;
  created_at: string;
}

export interface VariantsResponse {
  variants: Variant[];
}

/* ── 작업 큐 ─────────────────────────────────────────────────────── */

/** `transcribe` = 문항 텍스트화(1차 PDF 디코딩 → 실패분만 AI 비전). */
export type JobKind = 'solve' | 'variant' | 'transcribe';
export type JobStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'error'
  | 'canceled'
  /** 서버가 재시작되어 끊긴 작업. 자동 재개하지 않는다. */
  | 'interrupted';

/** 작업 1건의 진행 상태. */
export interface Job {
  id: string;
  kind: JobKind;
  node_id: string;
  /** 표시용 시험지 이름 스냅샷(원본이 지워져도 배너에 남는다). */
  node_name: string;
  status: JobStatus;
  total: number;
  done_count: number;
  current_no: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** `POST /api/jobs` 요청. */
export interface JobCreateRequest {
  kind: JobKind;
  node_id: string;
  problem_numbers?: number[] | null;
  no?: number;
  modes?: VariantMode[];
  force?: boolean;
  provider?: ProviderChoice;
  model?: string;
  effort?: string;
}

/** `POST /api/jobs` 응답. `existing` 이면 이미 있던 작업을 돌려준 것이다. */
export interface JobCreated {
  job: Job;
  existing: boolean;
  position: number;
}

/** `GET /api/jobs` 응답. */
export interface JobsResponse {
  active: Job[];
  recent: Job[];
}

/* ── SSE 이벤트 (5항) ────────────────────────────────────────────── */

export interface SolveStartEvent {
  type: 'start';
  total: number;
}
export interface SolveProblemEvent {
  type: 'problem';
  no: number;
  status: string;
  /**
   * 판독 작업에서 이 문항이 어느 경로로 가는지(`pua` = 디코딩, `ai` = AI 비전).
   * 판독 작업의 이벤트에만 실린다.
   */
  route?: string;
}
export interface SolveDeltaEvent {
  type: 'delta';
  no: number | null;
  text: string;
  /** 변형 작업일 때 어떤 변형 종류인지(백엔드가 함께 실어 준다). */
  mode?: VariantMode;
}
export interface SolveDoneEvent {
  type: 'done';
  no: number | null;
  solution: string;
  usage: Usage | null;
  cost: Cost | null;
  truncated: boolean;
  /** 계약 6-B: 이 스레드 이력이 잘려서 보내졌는지, 몇 개 생략됐는지. 채팅에서만 온다. */
  history_truncated?: boolean;
  truncated_before?: number;
  /** 변형 작업일 때 어떤 변형 종류인지. */
  mode?: VariantMode;
  /*
   * 아래 세 필드는 판독(transcribe) 작업의 `done` 에만 실린다.
   *
   * **이름이 REST 응답(`Transcript`)과 다르다.** SSE 는 짧은 이름(`source`/`note`),
   * REST 는 긴 이름(`transcript_source`/`transcript_note`)을 쓴다. 백엔드가 계약의
   * 소스이며(`ai_service.transcribe_events` vs `service.transcripts`) 여기서는 SSE
   * 이름을 그대로 옮긴다.
   */
  /**
   * 판독 작업이 이번에 확정한 전문. **판독 불가면 null** 이다.
   *
   * 이 키가 아예 없으면 판독 작업의 이벤트가 아니다 — null 과 부재를 구분해야
   * 한다. 부재를 null 로 채우면 풀이 done 이 멀쩡한 판독본을 지운다.
   */
  transcript?: string | null;
  /** 이번 실행이 저장한 출처(`pua` / `ai`). 저장하지 않았으면 null. */
  source?: string | null;
  /** 판독 실패·불가 이유. */
  note?: string | null;
}
export interface SolveErrorEvent {
  type: 'error';
  no: number | null;
  error_code: string;
  message: string;
  /** 변형 작업일 때 어떤 변형 종류인지. */
  mode?: VariantMode;
}
export interface SolveEndEvent {
  type: 'end';
  total_usage: Usage | null;
  total_cost: Cost | null;
  /** 작업 큐가 내려주는 최종 상태(done/error/canceled). 채팅에는 없다. */
  status?: JobStatus;
}

/**
 * 작업 구독에 붙는 순간 한 번 오는 현재 상태.
 * 늦게 붙어도 진행률과 "지금 쓰고 있는 문항의 여기까지" 를 알 수 있다.
 */
export interface JobSnapshotEvent {
  type: 'snapshot';
  status: JobStatus;
  total: number;
  done_count: number;
  current_no: number | null;
  partial_text: string;
}

/** 알 수 없는 이벤트 이름이나 JSON 파싱 실패는 버리지 않고 이 형태로 넘긴다. */
export interface UnknownStreamEvent {
  type: 'unknown';
  event: string;
  raw: string;
}

export type StreamEvent =
  | JobSnapshotEvent
  | SolveStartEvent
  | SolveProblemEvent
  | SolveDeltaEvent
  | SolveDoneEvent
  | SolveErrorEvent
  | SolveEndEvent
  | UnknownStreamEvent;
