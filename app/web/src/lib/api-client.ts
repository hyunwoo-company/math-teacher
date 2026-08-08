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
  ProviderChoice,
  Section,
  Solution,
  SolutionsResponse,
  SolveRequest,
  StreamEvent,
  ThreadsResponse,
  TreeNode,
  TreeResponse,
  Usage,
  UsageSummaryResponse,
  VariantMode,
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
  /** PDF 뷰어가 열 URL. */
  fileRawUrl(id: string): string;
  /** 문제 크롭 PNG URL. */
  cropUrl(id: string, no: number): string;
  /**
   * '문제만' 담은 시험지 DOCX 를 내려받는다(계약: `GET /api/files/{id}/export.docx`).
   * 크롭 이미지만 담고 풀이/변형/정답은 넣지 않는다. 파일명은 서버 Content-Disposition
   * 을 우선하고, 없으면(교차 오리진 등) 호출부가 `<시험지명>_문제.docx` 로 정한다.
   */
  exportProblemsDocx(id: string): Promise<{ blob: Blob; filename: string | null }>;

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

  solve(id: string, body: SolveRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  chat(id: string, body: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;

  /**
   * 동일 유형 변형 문제를 생성한다(계약:
   * `POST /api/files/{fileId}/problems/{no}/variant`). solve/chat 과 동일한
   * SSE(delta/done) 를 흘리며, done 본문(`solution`)에 최종 마크다운이 담긴다.
   */
  generateVariant(
    fileId: string,
    no: number,
    mode: VariantMode,
    opts?: { provider?: ProviderChoice; model?: string; effort?: string },
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent>;
}
