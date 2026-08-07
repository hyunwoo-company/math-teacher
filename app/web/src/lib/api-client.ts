/**
 * API 클라이언트 인터페이스.
 * 실제 HTTP 구현(`http-client.ts`)과 목 구현(`mock/client.ts`)이 이걸 만족한다.
 */

import type {
  AddNoteItemsResult,
  ChatHistoryResponse,
  ChatRequest,
  EnvResponse,
  FileDetail,
  NoteDetail,
  Section,
  SolutionsResponse,
  SolveRequest,
  StreamEvent,
  ThreadsResponse,
  TreeNode,
  TreeResponse,
  UsageSummaryResponse,
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

  getSolutions(id: string): Promise<SolutionsResponse>;
  /** problemNo 로 스레드를 나눈다. 생략/ null 이면 시험지 전역 스레드. */
  getChatHistory(id: string, problemNo?: number | null): Promise<ChatHistoryResponse>;
  getChatThreads(id: string): Promise<ThreadsResponse>;
  clearChat(id: string, problemNo?: number | null): Promise<void>;

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
}
