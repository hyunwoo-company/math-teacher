/**
 * 접속 비밀번호 게이트 공용 로직 + http-client 의 헤더 자동첨부 / 401 처리.
 *
 * http-client 는 실제 fetch 를 쓰므로 global.fetch 를 스텁으로 갈아끼워
 * "요청에 X-Access-Password 가 붙는지" 와 "401 이면 저장 비번을 지우고 게이트로
 * 되돌리는지" 를 직접 관찰한다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accessHeaders,
  initialAccessOk,
  isUnauthorizedError,
  needsAccessGate,
  readStoredPassword,
  reportUnauthorized,
  setUnauthorizedHandler,
  withAccess,
  writeStoredPassword,
} from '@/lib/access-gate';
import { ApiError } from '@/lib/api-error';
import { httpClient } from '@/lib/http-client';
import type { EnvResponse } from '@/types/api';

const baseEnv: EnvResponse = {
  mode: 'web',
  subscription: { available: false, cli_path: null },
  api_key_set: false,
  models: [],
  usd_krw: 1400,
};

/** requestJson 이 기대하는 최소한의 Response 모양. */
function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  window.localStorage.clear();
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

describe('needsAccessGate (게이트 표시 조건)', () => {
  it('env 가 없으면 게이트를 띄우지 않는다', () => {
    expect(needsAccessGate(null, false)).toBe(false);
  });

  it('auth_required 가 false(로컬)면 접근 상태와 무관하게 게이트 없음', () => {
    expect(needsAccessGate({ ...baseEnv, auth_required: false }, false)).toBe(false);
    expect(needsAccessGate({ ...baseEnv }, false)).toBe(false); // 필드 없음 = false
  });

  it('auth_required 이고 아직 접근 전이면 게이트를 띄운다', () => {
    expect(needsAccessGate({ ...baseEnv, auth_required: true }, false)).toBe(true);
  });

  it('auth_required 이어도 접근이 확보되면 게이트 없음', () => {
    expect(needsAccessGate({ ...baseEnv, auth_required: true }, true)).toBe(false);
  });
});

describe('initialAccessOk (초기 접근 상태)', () => {
  it('비번 미요구면 항상 통과', () => {
    expect(initialAccessOk({ ...baseEnv, auth_required: false })).toBe(true);
  });

  it('비번 요구 + 저장 비번 없음 = 통과 못 함', () => {
    expect(initialAccessOk({ ...baseEnv, auth_required: true })).toBe(false);
  });

  it('비번 요구 + 저장 비번 있음 = 낙관적 통과', () => {
    writeStoredPassword('friend');
    expect(initialAccessOk({ ...baseEnv, auth_required: true })).toBe(true);
  });
});

describe('accessHeaders (헤더 생성)', () => {
  it('저장 비번이 없으면 헤더를 붙이지 않는다', () => {
    expect(accessHeaders()).toEqual({});
  });

  it('저장 비번이 있으면 X-Access-Password 를 붙인다', () => {
    writeStoredPassword('friend');
    expect(accessHeaders()).toEqual({ 'X-Access-Password': 'friend' });
  });

  it('빈 문자열은 비번 없음으로 취급한다', () => {
    window.localStorage.setItem('math-teacher.accessPassword', '');
    expect(readStoredPassword()).toBeNull();
    expect(accessHeaders()).toEqual({});
  });
});

describe('withAccess (바이너리 URL 에 ?access= 부착)', () => {
  const raw = 'http://127.0.0.1:8100/api/files/f1/raw';

  it('저장 비번이 없으면(로컬) URL 을 그대로 둔다', () => {
    expect(withAccess(raw)).toBe(raw);
  });

  it('저장 비번이 있으면 ?access=<비번> 을 붙인다', () => {
    writeStoredPassword('friend');
    expect(withAccess(raw)).toBe(`${raw}?access=friend`);
  });

  it('이미 쿼리스트링이 있으면 & 로 이어 붙인다', () => {
    writeStoredPassword('friend');
    expect(withAccess(`${raw}?v=2`)).toBe(`${raw}?v=2&access=friend`);
  });

  it('비번을 URL 인코딩한다', () => {
    writeStoredPassword('p w&x');
    expect(withAccess(raw)).toBe(`${raw}?access=p%20w%26x`);
  });

  it('data: URI 는 쿼리를 붙이지 않는다(깨짐 방지)', () => {
    writeStoredPassword('friend');
    const dataUri = 'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E';
    expect(withAccess(dataUri)).toBe(dataUri);
  });

  it('httpClient 의 세 바이너리 URL 에 ?access= 가 붙는다', () => {
    writeStoredPassword('friend');
    expect(httpClient.fileRawUrl('f1')).toBe(
      'http://127.0.0.1:8100/api/files/f1/raw?access=friend',
    );
    expect(httpClient.cropUrl('f1', 3)).toBe(
      'http://127.0.0.1:8100/api/files/f1/problems/3/crop?access=friend',
    );
    expect(httpClient.noteCropUrl('n1', 'it1')).toBe(
      'http://127.0.0.1:8100/api/notes/n1/items/it1/crop?access=friend',
    );
  });

  it('비번이 없으면 세 바이너리 URL 에 쿼리를 붙이지 않는다', () => {
    expect(httpClient.fileRawUrl('f1')).toBe('http://127.0.0.1:8100/api/files/f1/raw');
    expect(httpClient.cropUrl('f1', 3)).toBe(
      'http://127.0.0.1:8100/api/files/f1/problems/3/crop',
    );
    expect(httpClient.noteCropUrl('n1', 'it1')).toBe(
      'http://127.0.0.1:8100/api/notes/n1/items/it1/crop',
    );
  });
});

describe('reportUnauthorized (401 통로)', () => {
  it('저장 비번을 지우고 등록된 핸들러를 부른다', () => {
    writeStoredPassword('stale');
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    reportUnauthorized();

    expect(readStoredPassword()).toBeNull();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('isUnauthorizedError 는 401 ApiError 만 참', () => {
    expect(isUnauthorizedError(new ApiError('unauthorized', 'x', null, 401))).toBe(true);
    expect(isUnauthorizedError(new ApiError('bad', 'x', null, 400))).toBe(false);
    expect(isUnauthorizedError(new Error('nope'))).toBe(false);
  });
});

describe('http-client 헤더 자동첨부', () => {
  beforeEach(() => {
    writeStoredPassword('friend');
  });

  it('일반 요청(getTree)에 X-Access-Password 가 붙는다', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => fakeResponse({ nodes: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await httpClient.getTree();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Access-Password']).toBe('friend');
  });

  it('SSE 요청(solve)에도 X-Access-Password 가 붙는다', async () => {
    const emptyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        ({ ok: true, status: 200, body: emptyStream }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);

    const stream = httpClient.jobEvents('job-1');
    // 스트림을 소비해 fetch 가 호출되게 한다(닫힌 스트림이라 즉시 끝난다).
    for await (const _event of stream) {
      // no-op
    }

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Access-Password']).toBe('friend');
  });
});

describe('http-client 401 처리', () => {
  it('보호 요청이 401 이면 저장 비번을 지우고 핸들러를 부른다', async () => {
    writeStoredPassword('stale');
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      fakeResponse({ error_code: 'unauthorized', message: '접속 비밀번호가 필요합니다.' }, 401),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(httpClient.getTree()).rejects.toMatchObject({ status: 401 });
    expect(readStoredPassword()).toBeNull();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('login 경로의 401 은 게이트를 잠그지 않는다(비번 오류일 뿐)', async () => {
    writeStoredPassword('kept');
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      fakeResponse({ error_code: 'unauthorized', message: '접속 비밀번호가 필요합니다.' }, 401),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(httpClient.login('wrong')).rejects.toMatchObject({ status: 401 });
    // login 실패는 세션 만료가 아니므로 저장 비번/핸들러를 건드리지 않는다.
    expect(handler).not.toHaveBeenCalled();
  });
});
