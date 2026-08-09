/**
 * API 클라이언트 인터페이스.
 * 실제 HTTP 구현(`http-client.ts`)과 목 구현(`mock/client.ts`)이 이걸 만족한다.
 */

import type {
  AddNoteItemsResult,
  ChatHistoryResponse,
  ChatRequest,
  Conversation,
  ConversationChatRequest,
  ConversationMessagesResponse,
  ConversationsResponse,
  EnvResponse,
  FileDetail,
  NoteDetail,
  ReextractResult,
  Section,
  Solution,
  SolutionsResponse,
  StreamEvent,
  ThreadsResponse,
  TreeNode,
  TreeResponse,
  Usage,
  UsageSummaryResponse,
  JobCreateRequest,
  JobCreated,
  ExportFormat,
  ExportInclude,
  ExportTarget,
  JobsResponse,
  VariantsResponse,
} from '@/types/api';

export interface ApiClient {
  getEnv(): Promise<EnvResponse>;
  /**
   * agy 쿼터 기반 사용량 요약(계약: `GET /api/usage/summary`).
   * 아직 배포 안 됐을 수 있는 신규 엔드포인트다 — 호출부가 실패를 조용히 흡수한다.
   */
  getUsageSummary(): Promise<UsageSummaryResponse>;
  /**
   * 접속 비밀번호 검증(계약: `POST /api/login {password}`).
   * 맞으면 resolve, 틀리면 401 ApiError 로 reject.
   */
  login(password: string): Promise<void>;
  setApiKey(key: string): Promise<void>;
  deleteApiKey(): Promise<void>;

  /** section 생략 시 'exam'(기존 호환). */
  getTree(section?: Section): Promise<TreeResponse>;
  createFolder(name: string, parentId: string | null, section?: Section): Promise<TreeNode>;
  updateNode(id: string, patch: { name?: string; parent_id?: string | null }): Promise<TreeNode>;
  deleteNode(id: string): Promise<void>;
  uploadFile(file: File, parentId: string | null): Promise<TreeNode>;

  getFile(id: string): Promise<FileDetail>;
  /**
   * 등록된 PDF 를 원본 그대로 다시 추출한다 (계약:
   * `POST /api/files/{id}/reextract`, AI 호출 0회).
   *
   * extractor 를 고친 뒤 기존 업로드분에 반영할 때 쓴다. 파일을 지우고 다시
   * 올릴 필요가 없다. **기존 풀이는 지워진다**(문항 번호가 달라질 수 있어서).
   */
  reextractFile(id: string): Promise<ReextractResult>;
  /** PDF 뷰어가 열 URL. */
  fileRawUrl(id: string): string;
  /** 문제 크롭 PNG URL. */
  cropUrl(id: string, no: number): string;
  /**
   * '문제만' 담은 시험지 DOCX 를 내려받는다(계약: `GET /api/files/{id}/export.docx`).
   * 크롭 이미지만 담고 풀이/변형/정답은 넣지 않는다. 파일명은 서버 Content-Disposition
   * 을 우선하고, 없으면(교차 오리진 등) 호출부가 `<시험지명>_문제.docx` 로 정한다.
   */
  /**
   * 문서를 내려받는다(계약: `GET /api/{files|notes}/{id}[/variants]/export.{docx|hwpx}`).
   *
   * `target` 이 무엇을(시험지/변형/오답노트), `format` 이 어떤 형식으로,
   * `include` 가 문제만인지 해설까지인지를 정한다. 파일명은 서버
   * `Content-Disposition` 을 우선한다.
   */
  exportDocument(
    target: ExportTarget,
    id: string,
    format: ExportFormat,
    include: ExportInclude,
  ): Promise<{ blob: Blob; filename: string | null }>;

  /** 저장된 변형 목록(시험지를 열 때 스토어를 채운다). */
  getVariants(id: string): Promise<VariantsResponse>;

  getSolutions(id: string): Promise<SolutionsResponse>;
  /**
   * 주어진 내용을 그 문항의 풀이로 저장(upsert)한다(계약:
   * `POST /api/files/{id}/problems/{no}/solution`). 대화 답변을 "풀이" 탭에 반영할 때 쓴다.
   */
  saveSolutionContent(
    id: string,
    no: number,
    content: string,
    usage?: Usage | null,
    source?: string | null,
  ): Promise<Solution>;
  /** problemNo 로 스레드를 나눈다. 생략/ null 이면 시험지 전역 스레드. */
  getChatHistory(id: string, problemNo?: number | null): Promise<ChatHistoryResponse>;
  getChatThreads(id: string): Promise<ThreadsResponse>;
  clearChat(id: string, problemNo?: number | null): Promise<void>;

  /* ── 전역(파일 무관) 자유 대화 ── */
  createConversation(title?: string | null): Promise<Conversation>;
  getConversations(): Promise<ConversationsResponse>;
  renameConversation(id: string, title: string): Promise<Conversation>;
  deleteConversation(id: string): Promise<void>;
  getConversationMessages(id: string): Promise<ConversationMessagesResponse>;
  conversationChat(
    id: string,
    body: ConversationChatRequest,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent>;

  /* ── 오답노트 (계약 6-A) ── */
  createNote(name: string, parentId: string | null): Promise<TreeNode>;
  getNote(id: string): Promise<NoteDetail>;
  addNoteItems(
    noteId: string,
    sourceNodeId: string,
    problemNumbers: number[],
    memo?: string | null,
  ): Promise<AddNoteItemsResult>;
  deleteNoteItem(noteId: string, itemId: string): Promise<void>;
  /** 노트 항목 크롭 스냅샷 URL. */
  noteCropUrl(noteId: string, itemId: string): string;

  chat(id: string, body: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;

  /* ── 작업 큐 ──────────────────────────────────────────────────────
   * 풀이·변형은 전부 여기로 간다. 예전 `/solve`·`/variant` 는 HTTP 응답이 곧
   * 작업이라 화면을 떠나면 끊겼다. 이제 작업은 서버에서 돌고, 구독은 선택이다.
   */

  /** 작업을 큐에 넣고 즉시 돌려받는다(스트림을 기다리지 않는다). */
  createJob(body: JobCreateRequest): Promise<JobCreated>;
  /** 진행 중 작업 전부 + 최근 종료분. 앱이 뜰 때 복구용으로 부른다. */
  listJobs(): Promise<JobsResponse>;
  /** 작업 진행 구독. 붙는 즉시 `snapshot` 이 온다. 끊어도 작업은 계속된다. */
  jobEvents(jobId: string, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  /** 작업 취소. 대기 중이면 큐에서 빠지고, 실행 중이면 현재 문항 뒤 멈춘다. */
  cancelJob(jobId: string): Promise<void>;
}
