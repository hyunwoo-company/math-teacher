/**
 * 바이너리 URL 인증을 비밀번호(`?access=`) 대신 단기 토큰(`?token=`)으로 바꾼 흐름.
 *
 * 여기서 지키는 것:
 *  - URL 에 토큰만 붙고 비밀번호는 절대 안 붙는다
 *  - 같은 노드의 두 번째 자산은 재발급 없이 캐시를 쓴다
 *  - 만료가 가까우면 미리 갱신한다
 *  - `token: null`(게이트 꺼짐)이면 쿼리를 아예 안 붙인다
 *  - 동시 요청이 겹쳐도 발급은 한 번이다
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeBinaryUrl,
  binaryTarget,
  ensureDownloadToken,
  isBinaryUrlReady,
  resetDownloadTokens,
  stripDownloadToken,
  withDownloadToken,
} from '@/lib/download-token';
import {
  readStoredPassword,
  setUnauthorizedHandler,
  writeStoredPassword,
} from '@/lib/access-gate';
import { httpClient } from '@/lib/http-client';

const RAW = 'http://127.0.0.1:8100/api/files/ab12/raw';
const CROP = 'http://127.0.0.1:8100/api/files/ab12/problems/3/crop';
const NOTE_CROP = 'http://127.0.0.1:8100/api/notes/n1/items/it1/crop';

/** `POST /api/download-tokens` 응답 대역. */
function tokenResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function stubIssuer(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => tokenResponse(body, status));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  writeStoredPassword('friend');
});

afterEach(() => {
  window.localStorage.clear();
  setUnauthorizedHandler(null);
  resetDownloadTokens();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('binaryTarget (토큰을 붙일 경로 판정)', () => {
  it('노드 단위 범위를 백엔드와 같은 규칙으로 계산한다', () => {
    expect(binaryTarget(RAW)).toEqual({ path: '/api/files/ab12/raw', scope: '/api/files/ab12' });
    expect(binaryTarget(CROP)?.scope).toBe('/api/files/ab12');
    expect(binaryTarget(NOTE_CROP)?.scope).toBe('/api/notes/n1');
    expect(binaryTarget('/api/files/ab12/export.docx?include=full')?.path).toBe(
      '/api/files/ab12/export.docx',
    );
  });

  it('바이너리가 아닌 경로·다른 오리진·data: URI 는 대상이 아니다', () => {
    expect(binaryTarget('http://127.0.0.1:8100/api/files/ab12')).toBeNull();
    expect(binaryTarget('http://127.0.0.1:8100/api/tree')).toBeNull();
    expect(binaryTarget('https://example.com/api/files/ab12/raw')).toBeNull();
    expect(binaryTarget('data:image/png;base64,AAA')).toBeNull();
    expect(binaryTarget('/mock/sample.pdf')).toBeNull();
  });
});

describe('토큰 발급과 URL 조립', () => {
  it('URL 에 ?token= 이 붙고 비밀번호는 어디에도 없다', async () => {
    stubIssuer({ token: 'v1.123.sig', scope: '/api/files/ab12', expires_in: 900 });

    await ensureDownloadToken(RAW);
    const authorized = withDownloadToken(RAW);

    expect(authorized).toBe(`${RAW}?token=v1.123.sig`);
    expect(authorized).not.toContain('access=');
    expect(authorized).not.toContain('friend');
  });

  it('발급 요청은 X-Access-Password 헤더로, 본문에는 바이너리 경로를 넣는다', async () => {
    const fetchMock = stubIssuer({
      token: 'v1.123.sig',
      scope: '/api/files/ab12',
      expires_in: 900,
    });

    await ensureDownloadToken(CROP);

    const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(requestUrl).toBe('http://127.0.0.1:8100/api/download-tokens');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Access-Password']).toBe('friend');
    expect(JSON.parse(String(init.body))).toEqual({ path: '/api/files/ab12/problems/3/crop' });
  });

  it('이미 쿼리가 있으면 & 로 이어 붙인다', async () => {
    stubIssuer({ token: 'v1.123.sig', scope: '/api/files/ab12', expires_in: 900 });
    await ensureDownloadToken(RAW);
    expect(withDownloadToken(`${RAW}?v=2`)).toBe(`${RAW}?v=2&token=v1.123.sig`);
  });

  it('비번이 없으면(로컬) 발급을 시도하지도 않고 URL 을 그대로 둔다', async () => {
    writeStoredPassword(null);
    const fetchMock = stubIssuer({ token: 'v1.x.y', scope: '/api/files/ab12', expires_in: 900 });

    await ensureDownloadToken(RAW);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(withDownloadToken(RAW)).toBe(RAW);
    expect(isBinaryUrlReady(RAW)).toBe(true);
  });

  it('token 이 null 이면(게이트 꺼짐) 쿼리를 붙이지 않는다', async () => {
    stubIssuer({ token: null, scope: '/api/files/ab12', expires_in: null });

    await ensureDownloadToken(RAW);

    expect(withDownloadToken(RAW)).toBe(RAW);
    // "붙일 것이 없다" 도 결론이므로 화면은 바로 그려도 된다.
    expect(isBinaryUrlReady(RAW)).toBe(true);
  });
});

describe('캐시(노드 단위 재사용)', () => {
  it('같은 노드의 두 번째 자산은 재발급 없이 캐시를 쓴다', async () => {
    const fetchMock = stubIssuer({
      token: 'v1.123.sig',
      scope: '/api/files/ab12',
      expires_in: 900,
    });

    await ensureDownloadToken(RAW);
    await ensureDownloadToken(CROP);
    await ensureDownloadToken('http://127.0.0.1:8100/api/files/ab12/problems/7/crop');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(withDownloadToken(CROP)).toBe(`${CROP}?token=v1.123.sig`);
  });

  it('다른 노드는 따로 발급한다(토큰 범위가 노드에 묶여 있다)', async () => {
    const fetchMock = stubIssuer({
      token: 'v1.123.sig',
      scope: '/api/files/ab12',
      expires_in: 900,
    });

    await ensureDownloadToken(RAW);
    await ensureDownloadToken(NOTE_CROP);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('비밀번호가 바뀌면 옛 토큰을 재사용하지 않는다(서명키가 비번에서 나온다)', async () => {
    const fetchMock = stubIssuer({
      token: 'v1.123.sig',
      scope: '/api/files/ab12',
      expires_in: 900,
    });
    await ensureDownloadToken(RAW);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    writeStoredPassword('other');
    expect(withDownloadToken(RAW)).toBe(RAW);
    await ensureDownloadToken(RAW);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('만료 갱신', () => {
  it('만료가 가까우면(여유 60초 안쪽) 미리 새로 받는다', async () => {
    vi.useFakeTimers();
    let issued = 0;
    const fetchMock = vi.fn(async () => {
      issued += 1;
      return tokenResponse({
        token: `v1.${issued}.sig`,
        scope: '/api/files/ab12',
        expires_in: 900,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await ensureDownloadToken(RAW);
    expect(withDownloadToken(RAW)).toBe(`${RAW}?token=v1.1.sig`);

    // 800초: 아직 갱신 시점(900-60=840초) 전이라 그대로 쓴다.
    vi.setSystemTime(Date.now() + 800_000);
    await ensureDownloadToken(RAW);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 850초: 만료(900초)까지 60초도 안 남았으므로 미리 갱신한다.
    vi.setSystemTime(Date.now() + 50_000);
    expect(isBinaryUrlReady(RAW)).toBe(false);
    await ensureDownloadToken(RAW);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(withDownloadToken(RAW)).toBe(`${RAW}?token=v1.2.sig`);
  });

  it('갱신 시 옛 토큰이 URL 에 남지 않는다', async () => {
    stubIssuer({ token: 'v1.new.sig', scope: '/api/files/ab12', expires_in: 900 });
    const stale = `${RAW}?token=v1.old.sig`;
    expect(await authorizeBinaryUrl(stale)).toBe(`${RAW}?token=v1.new.sig`);
    expect(stripDownloadToken(`${RAW}?include=full&token=v1.old.sig`)).toBe(`${RAW}?include=full`);
  });
});

describe('동시성', () => {
  it('같은 노드에 동시에 몰려도 발급은 한 번이다', async () => {
    const deferred: { resolve?: (response: Response) => void } = {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // 크롭 여러 장 + 원본 PDF 가 같은 프레임에 붙는 상황.
    const pending = Promise.all([
      ensureDownloadToken(RAW),
      ensureDownloadToken(CROP),
      ensureDownloadToken('http://127.0.0.1:8100/api/files/ab12/problems/9/crop'),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    deferred.resolve?.(
      tokenResponse({ token: 'v1.123.sig', scope: '/api/files/ab12', expires_in: 900 }),
    );
    const entries = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(entries.every((entry) => entry?.token === 'v1.123.sig')).toBe(true);
  });
});

describe('발급 실패', () => {
  it('실패해도 비밀번호로 되돌아가지 않는다(?access= 폴백 없음)', async () => {
    stubIssuer({ error_code: 'server_error', message: '터졌다' }, 500);

    const entry = await ensureDownloadToken(RAW);

    expect(entry?.failed).toBe(true);
    expect(withDownloadToken(RAW)).toBe(RAW);
    expect(withDownloadToken(RAW)).not.toContain('access=');
  });

  it('실패 직후에는 재요청하지 않는다(백오프)', async () => {
    const fetchMock = stubIssuer({ error_code: 'server_error', message: '터졌다' }, 500);

    await ensureDownloadToken(RAW);
    await ensureDownloadToken(CROP);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('비동기 경로(authorizeBinaryUrl)는 실패를 감추지 않고 던진다', async () => {
    stubIssuer({ error_code: 'server_error', message: '터졌다' }, 500);
    await expect(authorizeBinaryUrl(RAW)).rejects.toMatchObject({
      code: 'download_token_failed',
    });
  });

  it('401 이면 저장 비번을 지우고 게이트로 되돌린다', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    stubIssuer({ error_code: 'unauthorized', message: '접속 비밀번호가 필요합니다.' }, 401);

    await ensureDownloadToken(RAW);

    expect(readStoredPassword()).toBeNull();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('httpClient 바이너리 URL 과의 연결', () => {
  it('토큰이 캐시되면 세 URL 모두 ?token= 을 달고 나온다', async () => {
    stubIssuer({ token: 'v1.123.sig', scope: '/api/files/ab12', expires_in: 900 });
    await ensureDownloadToken(RAW);
    stubIssuer({ token: 'v1.456.sig', scope: '/api/notes/n1', expires_in: 900 });
    await ensureDownloadToken(NOTE_CROP);

    expect(httpClient.fileRawUrl('ab12')).toBe(`${RAW}?token=v1.123.sig`);
    expect(httpClient.cropUrl('ab12', 3)).toBe(`${CROP}?token=v1.123.sig`);
    expect(httpClient.noteCropUrl('n1', 'it1')).toBe(`${NOTE_CROP}?token=v1.456.sig`);
  });

  it('내보내기 다운로드는 헤더 인증이라 URL 에 자격증명을 싣지 않는다', async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          blob: async () => new Blob(['x']),
          headers: { get: () => null },
        }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);

    await httpClient.exportDocument('exam', 'ab12', 'docx', 'problems');

    const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(requestUrl).toBe(
      'http://127.0.0.1:8100/api/files/ab12/export.docx?include=problems',
    );
    expect(requestUrl).not.toContain('access=');
    expect(requestUrl).not.toContain('token=');
    expect((init.headers as Record<string, string>)['X-Access-Password']).toBe('friend');
  });
});
