/**
 * 백엔드 에러를 UI 가 그대로 보여줄 수 있는 형태로 정규화한다.
 * 계약: 모든 에러는 `{error_code, message(한국어), hint}`.
 */

import type { ApiErrorBody } from '@/types/api';

export class ApiError extends Error {
  readonly code: string;
  readonly hint: string | null;
  readonly status: number | null;

  constructor(code: string, message: string, hint: string | null = null, status: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

/** 네트워크 자체가 안 될 때. 백엔드가 아직 안 떠 있는 상황을 사용자에게 설명한다. */
export function networkError(cause?: unknown): ApiError {
  const detail = cause instanceof Error ? ` (${cause.message})` : '';
  return new ApiError(
    'network',
    `백엔드에 연결할 수 없습니다.${detail}`,
    '로컬 서버가 실행 중인지 확인하세요. 개발 중이라면 NEXT_PUBLIC_MOCK=1 로 목 모드를 쓸 수 있습니다.',
    null,
  );
}

/** 취소(AbortController)인지 판별. 취소는 에러로 표시하지 않는다. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return false;
}

/** 응답 본문에서 에러를 만든다. 계약과 다른 본문이 와도 죽지 않는다. */
export async function errorFromResponse(response: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (typeof body === 'object' && body !== null) {
    const record = body as Partial<ApiErrorBody>;
    if (typeof record.message === 'string') {
      return new ApiError(
        typeof record.error_code === 'string' ? record.error_code : `http_${response.status}`,
        record.message,
        typeof record.hint === 'string' ? record.hint : null,
        response.status,
      );
    }
  }

  return new ApiError(
    `http_${response.status}`,
    fallbackMessage(response.status),
    null,
    response.status,
  );
}

function fallbackMessage(status: number): string {
  switch (status) {
    case 400:
      return '요청이 올바르지 않습니다.';
    case 404:
      return '요청한 항목을 찾을 수 없습니다.';
    case 409:
      return 'AI 공급자가 설정되지 않았습니다.';
    case 413:
      return '파일이 너무 큽니다.';
    case 500:
      return '서버 내부 오류가 발생했습니다.';
    default:
      return `요청이 실패했습니다. (HTTP ${status})`;
  }
}

/** 어떤 예외든 사용자에게 보여줄 문장으로 만든다. */
export function toUserMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '알 수 없는 오류가 발생했습니다.';
}
