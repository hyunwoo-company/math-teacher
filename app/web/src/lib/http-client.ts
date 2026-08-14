/**
 * 실제 백엔드(app/core)와 통신하는 구현.
 *
 * - base URL 은 `NEXT_PUBLIC_API_BASE` (기본 `http://127.0.0.1:8100`).
 * - 웹 모드에서는 API 키를 서버에 저장하지 않고 요청마다 `X-Api-Key` 헤더로 보낸다(계약 3-2).
 * - 스트리밍은 `EventSource` 가 아니라 `fetch` + ReadableStream 으로 처리한다(POST 필요).
 */

import { API_BASE, API_KEY_STORAGE } from '@/lib/config';
import { accessHeaders, reportUnauthorized, withAccess } from '@/lib/access-gate';
import { ApiError, errorFromResponse, isAbortError, networkError } from '@/lib/api-error';
import { iterateSSE } from '@/lib/sse';
import { toStreamEvent } from '@/lib/stream-events';
import type { ApiClient } from '@/lib/api-client';
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
  Transcript,
  TranscriptsResponse,
  TreeNode,
  TreeResponse,
  Usage,
  UsageSummaryResponse,
  JobCreateRequest,
  JobCreated,
  ExportBody,
  ExportFormat,
  ExportInclude,
  ExportTarget,
  JobsResponse,
  VariantsResponse,
} from '@/types/api';

/** 브라우저에 보관한 API 키(웹 모드). 서버에 저장하지 않는다. */
export function readStoredApiKey(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(API_KEY_STORAGE);
  } catch {
    return null;
  }
}

export function writeStoredApiKey(key: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (key == null || key === '') window.localStorage.removeItem(API_KEY_STORAGE);
    else window.localStorage.setItem(API_KEY_STORAGE, key);
  } catch {
    // 프라이빗 모드 등에서 실패할 수 있다. 조용히 무시한다.
  }
}

function url(path: string): string {
  return `${API_BASE}${path}`;
}

/**
 * 요청마다 붙는 인증 헤더.
 *  - `X-Api-Key`         : 웹 모드 API 키(계약 3-2)
 *  - `X-Access-Password` : 접속 비밀번호 게이트(있을 때만)
 */
function authHeaders(): Record<string, string> {
  const key = readStoredApiKey();
  return {
    ...(key ? { 'X-Api-Key': key } : {}),
    ...accessHeaders(),
  };
}

/** login 은 비번을 본문으로 검증하는 예외 경로다. 이 경로의 401 은 게이트를 잠그지 않는다. */
function isLoginPath(path: string): boolean {
  return path === '/api/login';
}

/** 401 이면 저장 비번을 지우고 게이트로 되돌린다(login 경로 제외). */
function handleUnauthorized(path: string, status: number): void {
  if (status === 401 && !isLoginPath(path)) reportUnauthorized();
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url(path), {
      ...init,
      headers: {
        Accept: 'application/json',
        ...authHeaders(),
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw networkError(error);
  }

  if (!response.ok) {
    handleUnauthorized(path, response.status);
    throw await errorFromResponse(response);
  }

  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ApiError('bad_response', '서버 응답을 해석할 수 없습니다.', String(error), response.status);
  }
}

async function requestVoid(path: string, init?: RequestInit): Promise<void> {
  await requestJson<unknown>(path, init);
}

function jsonBody(value: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  };
}

/**
 * `Content-Disposition` 헤더에서 파일명을 뽑는다.
 * RFC5987(`filename*=UTF-8''<pct>`)를 우선하고, 없으면 일반 `filename="..."` 를 쓴다.
 * 교차 오리진에서 헤더가 노출되지 않으면 null 을 돌려준다(호출부가 대체 이름 사용).
 */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // 디코드 실패 시 아래 일반 filename 으로 폴백한다.
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() ?? null;
}

/** SSE 스트림을 열고 StreamEvent 로 변환해 넘긴다. */
async function* openStream(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent, void, void> {
  let response: Response;
  try {
    response = await fetch(url(path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...authHeaders(),
      },
      body: JSON.stringify(body),
      signal,
      // 프록시/브라우저가 버퍼링하지 않게.
      cache: 'no-store',
    });
  } catch (error) {
    if (isAbortError(error)) return;
    throw networkError(error);
  }

  if (!response.ok) {
    handleUnauthorized(path, response.status);
    throw await errorFromResponse(response);
  }
  if (!response.body) {
    throw new ApiError('bad_response', '스트리밍 응답 본문이 비어 있습니다.', null, response.status);
  }

  for await (const message of iterateSSE(response.body, signal)) {
    if (signal?.aborted) return;
    yield toStreamEvent(message);
  }
}

/**
 * GET 으로 SSE 를 구독한다(작업 진행 구독용).
 *
 * 작업은 이미 서버에서 돌고 있고 여기서는 보기만 한다. 끊어도 작업은 계속되므로
 * abort 는 "화면에서 그만 본다" 는 뜻이지 "작업을 멈춘다" 가 아니다.
 */
async function* openEventStream(
  path: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent, void, void> {
  let response: Response;
  try {
    response = await fetch(url(path), {
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...authHeaders() },
      signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (isAbortError(error)) return;
    throw networkError(error);
  }

  if (!response.ok) {
    handleUnauthorized(path, response.status);
    throw await errorFromResponse(response);
  }
  if (!response.body) {
    throw new ApiError('bad_response', '스트리밍 응답 본문이 비어 있습니다.', null, response.status);
  }

  for await (const message of iterateSSE(response.body, signal)) {
    if (signal?.aborted) return;
    yield toStreamEvent(message);
  }
}

export const httpClient: ApiClient = {
  getEnv() {
    return requestJson<EnvResponse>('/api/env');
  },

  getUsageSummary() {
    return requestJson<UsageSummaryResponse>('/api/usage/summary');
  },

  async login(password: string) {
    // 계약: POST /api/login {password} -> {ok:true} | 401. 비번 저장은 스토어가 성공 후 처리.
    await requestJson<{ ok: boolean }>('/api/login', jsonBody({ password }));
  },

  async setApiKey(key: string) {
    // 데스크톱은 서버(data/settings.json)에 저장하고, 웹은 저장하지 않고
    // 요청마다 X-Api-Key 헤더로 보낸다(계약 3-2). 어느 쪽이든 로컬에는 보관한다.
    writeStoredApiKey(key);
    try {
      await requestVoid('/api/settings/apikey', jsonBody({ key }));
    } catch (error) {
      // 웹 배포에서 이 엔드포인트를 막아 둘 수 있다. 그 경우 헤더 방식만으로 동작하므로
      // 없는 엔드포인트(404/405)는 실패로 보지 않는다. 그 외 오류는 그대로 알린다.
      if (error instanceof ApiError && (error.status === 404 || error.status === 405)) return;
      throw error;
    }
  },

  async deleteApiKey() {
    writeStoredApiKey(null);
    try {
      await requestVoid('/api/settings/apikey', { method: 'DELETE' });
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 405)) return;
      throw error;
    }
  },

  getTree(section: Section = 'exam') {
    // 기본 exam 은 파라미터 없이 호출(구버전 백엔드 호환).
    const query = section === 'exam' ? '' : `?section=${section}`;
    return requestJson<TreeResponse>(`/api/tree${query}`);
  },

  async createFolder(name: string, parentId: string | null, section: Section = 'exam') {
    const result = await requestJson<{ node: TreeNode }>(
      '/api/folders',
      jsonBody({ name, parent_id: parentId, section }),
    );
    return result.node;
  },

  async updateNode(id: string, patch: { name?: string; parent_id?: string | null }) {
    const result = await requestJson<{ node: TreeNode }>(`/api/nodes/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return result.node;
  },

  async deleteNode(id: string) {
    await requestVoid(`/api/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async uploadFile(file: File, parentId: string | null) {
    const form = new FormData();
    form.append('file', file);
    if (parentId != null) form.append('parent_id', parentId);
    const result = await requestJson<{ node: TreeNode }>('/api/files', {
      method: 'POST',
      body: form,
    });
    return result.node;
  },

  getFile(id: string) {
    return requestJson<FileDetail>(`/api/files/${encodeURIComponent(id)}`);
  },

  reextractFile(id: string) {
    return requestJson<ReextractResult>(
      `/api/files/${encodeURIComponent(id)}/reextract`,
      { method: 'POST' },
    );
  },

  fileRawUrl(id: string) {
    // 브라우저가 직접 GET 하는 바이너리 URL → 헤더를 못 붙이니 ?access= 로 인증(있을 때만).
    return withAccess(url(`/api/files/${encodeURIComponent(id)}/raw`));
  },

  cropUrl(id: string, no: number) {
    // 크롭 <img src> 도 헤더를 못 붙이므로 ?access= 로 인증(있을 때만).
    return withAccess(url(`/api/files/${encodeURIComponent(id)}/problems/${no}/crop`));
  },

  async exportDocument(
    target: ExportTarget,
    id: string,
    format: ExportFormat,
    include: ExportInclude,
    source?: string,
    body: ExportBody = 'image',
  ): Promise<{ blob: Blob; filename: string | null }> {
    // 바이너리 다운로드. fetch 로 받으므로 헤더 인증(authHeaders)과 ?access= 를 함께 건다
    // (백엔드는 이 경로들에 두 방식 모두 허용). 파일명은 서버 Content-Disposition 우선.
    const encoded = encodeURIComponent(id);
    const base =
      target === 'note'
        ? `/api/notes/${encoded}`
        : target === 'variants'
          ? `/api/files/${encoded}/variants`
          : `/api/files/${encoded}`;
    // 출처는 값이 있을 때만 붙인다. 빈 문자열을 보내면 서버가 문서 끝에 빈 줄을
    // 넣지는 않지만(공백은 걸러진다), 굳이 의미 없는 쿼리를 남기지 않는다.
    const trimmedSource = source?.trim() ?? '';
    // body 도 기본값(image)일 때는 붙이지 않는다. 지금까지의 URL 이 그대로 남아
    // 프록시·브라우저 캐시와 서버 로그가 달라지지 않는다.
    const path =
      `${base}/export.${format}?include=${include}` +
      (trimmedSource === '' ? '' : `&source=${encodeURIComponent(trimmedSource)}`) +
      (body === 'image' ? '' : `&body=${body}`);
    let response: Response;
    try {
      response = await fetch(withAccess(url(path)), {
        cache: 'no-store',
        headers: authHeaders(),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw networkError(error);
    }
    if (!response.ok) {
      handleUnauthorized(path, response.status);
      throw await errorFromResponse(response);
    }
    const blob = await response.blob();
    return { blob, filename: filenameFromDisposition(response.headers.get('Content-Disposition')) };
  },

  getVariants(id: string) {
    return requestJson<VariantsResponse>(`/api/files/${encodeURIComponent(id)}/variants`);
  },

  getTranscripts(id: string) {
    return requestJson<TranscriptsResponse>(`/api/files/${encodeURIComponent(id)}/transcripts`);
  },

  saveTranscript(id: string, no: number, text: string) {
    return requestJson<Transcript>(
      `/api/files/${encodeURIComponent(id)}/problems/${no}/transcript`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      },
    );
  },

  getSolutions(id: string) {
    return requestJson<SolutionsResponse>(`/api/files/${encodeURIComponent(id)}/solutions`);
  },

  saveSolutionContent(
    id: string,
    no: number,
    content: string,
    usage: Usage | null = null,
    source: string | null = 'chat',
  ) {
    return requestJson<Solution>(
      `/api/files/${encodeURIComponent(id)}/problems/${no}/solution`,
      jsonBody({ content, usage, source }),
    );
  },

  getChatHistory(id: string, problemNo?: number | null) {
    const query = problemNo != null ? `?problem_no=${problemNo}` : '';
    return requestJson<ChatHistoryResponse>(`/api/files/${encodeURIComponent(id)}/chat${query}`);
  },

  getChatThreads(id: string) {
    return requestJson<ThreadsResponse>(`/api/files/${encodeURIComponent(id)}/chat/threads`);
  },

  async clearChat(id: string, problemNo?: number | null) {
    const query = problemNo != null ? `?problem_no=${problemNo}` : '';
    await requestVoid(`/api/files/${encodeURIComponent(id)}/chat${query}`, { method: 'DELETE' });
  },

  async createConversation(title: string | null = null) {
    // 계약: POST /api/conversations {title?} → ConversationOut (201). title 생략 시 서버 기본값.
    return requestJson<Conversation>(
      '/api/conversations',
      jsonBody(title != null && title.trim() !== '' ? { title } : {}),
    );
  },

  getConversations() {
    return requestJson<ConversationsResponse>('/api/conversations');
  },

  renameConversation(id: string, title: string) {
    return requestJson<Conversation>(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
  },

  async deleteConversation(id: string) {
    await requestVoid(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  getConversationMessages(id: string) {
    return requestJson<ConversationMessagesResponse>(
      `/api/conversations/${encodeURIComponent(id)}/messages`,
    );
  },

  conversationChat(id: string, body: ConversationChatRequest, signal?: AbortSignal) {
    return openStream(`/api/conversations/${encodeURIComponent(id)}/chat`, body, signal);
  },

  async createNote(name: string, parentId: string | null) {
    const result = await requestJson<{ node: TreeNode }>(
      '/api/notes',
      jsonBody({ name, parent_id: parentId }),
    );
    return result.node;
  },

  getNote(id: string) {
    return requestJson<NoteDetail>(`/api/notes/${encodeURIComponent(id)}`);
  },

  addNoteItems(
    noteId: string,
    sourceNodeId: string,
    problemNumbers: number[],
    memo: string | null = null,
  ) {
    return requestJson<AddNoteItemsResult>(
      `/api/notes/${encodeURIComponent(noteId)}/items`,
      jsonBody({ source_node_id: sourceNodeId, problem_numbers: problemNumbers, memo }),
    );
  },

  async deleteNoteItem(noteId: string, itemId: string) {
    await requestVoid(
      `/api/notes/${encodeURIComponent(noteId)}/items/${encodeURIComponent(itemId)}`,
      { method: 'DELETE' },
    );
  },

  noteCropUrl(noteId: string, itemId: string) {
    // 오답노트 크롭 스냅샷 <img src> → 헤더 대신 ?access= 로 인증(있을 때만).
    return withAccess(
      url(`/api/notes/${encodeURIComponent(noteId)}/items/${encodeURIComponent(itemId)}/crop`),
    );
  },

  chat(id: string, body: ChatRequest, signal?: AbortSignal) {
    return openStream(`/api/files/${encodeURIComponent(id)}/chat`, body, signal);
  },

  createJob(body: JobCreateRequest) {
    return requestJson<JobCreated>('/api/jobs', jsonBody(body));
  },

  listJobs() {
    return requestJson<JobsResponse>('/api/jobs');
  },

  jobEvents(jobId: string, signal?: AbortSignal) {
    return openEventStream(`/api/jobs/${encodeURIComponent(jobId)}/events`, signal);
  },

  async cancelJob(jobId: string) {
    await requestVoid(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  },
};
