/**
 * 실제 백엔드(app/core)와 통신하는 구현.
 *
 * - base URL 은 `NEXT_PUBLIC_API_BASE` (기본 `http://127.0.0.1:8100`).
 * - 웹 모드에서는 API 키를 서버에 저장하지 않고 요청마다 `X-Api-Key` 헤더로 보낸다(계약 3-2).
 * - 스트리밍은 `EventSource` 가 아니라 `fetch` + ReadableStream 으로 처리한다(POST 필요).
 */

import { API_BASE, API_KEY_STORAGE } from '@/lib/config';
import { ApiError, errorFromResponse, isAbortError, networkError } from '@/lib/api-error';
import { iterateSSE } from '@/lib/sse';
import { toStreamEvent } from '@/lib/stream-events';
import type { ApiClient } from '@/lib/api-client';
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

function authHeaders(): Record<string, string> {
  const key = readStoredApiKey();
  return key ? { 'X-Api-Key': key } : {};
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

  if (!response.ok) throw await errorFromResponse(response);

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

  if (!response.ok) throw await errorFromResponse(response);
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

  fileRawUrl(id: string) {
    return url(`/api/files/${encodeURIComponent(id)}/raw`);
  },

  cropUrl(id: string, no: number) {
    return url(`/api/files/${encodeURIComponent(id)}/problems/${no}/crop`);
  },

  getSolutions(id: string) {
    return requestJson<SolutionsResponse>(`/api/files/${encodeURIComponent(id)}/solutions`);
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
    return url(
      `/api/notes/${encodeURIComponent(noteId)}/items/${encodeURIComponent(itemId)}/crop`,
    );
  },

  solve(id: string, body: SolveRequest, signal?: AbortSignal) {
    return openStream(`/api/files/${encodeURIComponent(id)}/solve`, body, signal);
  },

  chat(id: string, body: ChatRequest, signal?: AbortSignal) {
    return openStream(`/api/files/${encodeURIComponent(id)}/chat`, body, signal);
  },
};
