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
  no: number;
  page: number;
  bbox: number[];
  image_w: number;
  image_h: number;
  has_solution: boolean;
}

/** `GET /api/files/{id}` */
export interface FileDetail {
  node: TreeNode;
  problems: Problem[];
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

/* ── SSE 이벤트 (5항) ────────────────────────────────────────────── */

export interface SolveStartEvent {
  type: 'start';
  total: number;
}
export interface SolveProblemEvent {
  type: 'problem';
  no: number;
  status: string;
}
export interface SolveDeltaEvent {
  type: 'delta';
  no: number | null;
  text: string;
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
}
export interface SolveErrorEvent {
  type: 'error';
  no: number | null;
  error_code: string;
  message: string;
}
export interface SolveEndEvent {
  type: 'end';
  total_usage: Usage | null;
  total_cost: Cost | null;
}

/** 알 수 없는 이벤트 이름이나 JSON 파싱 실패는 버리지 않고 이 형태로 넘긴다. */
export interface UnknownStreamEvent {
  type: 'unknown';
  event: string;
  raw: string;
}

export type StreamEvent =
  | SolveStartEvent
  | SolveProblemEvent
  | SolveDeltaEvent
  | SolveDoneEvent
  | SolveErrorEvent
  | SolveEndEvent
  | UnknownStreamEvent;
