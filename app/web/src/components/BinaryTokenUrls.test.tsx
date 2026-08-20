/**
 * 실서버 클라이언트(httpClient)로 그렸을 때, 크롭 `<img src>` 가 DOM 까지
 * **단기 토큰(`?token=`)** 을 달고 나오고 **비밀번호는 어디에도 없는지** 확인한다.
 *
 * 왜 별도 파일인가: 나머지 컴포넌트 테스트는 목 클라이언트(`NEXT_PUBLIC_MOCK=1`)로 도는데,
 * 목의 크롭은 `data:` URI 라 애초에 인증이 필요 없다. 인증이 걸린 URL 이 화면까지
 * 도달하는지는 실서버 클라이언트로만 관찰할 수 있어서 이 파일에서만 api 를 갈아끼운다.
 * (브라우저 육안 확인 대신 쓰는 검증 수단 — AccessBinaryUrls.test 와 같은 취지.)
 */

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { httpClient } from '@/lib/http-client';
import { resetDownloadTokens } from '@/lib/download-token';
import { setUnauthorizedHandler, writeStoredPassword } from '@/lib/access-gate';
import { ProblemCrop } from '@/components/center/ProblemCrop';

// vi.mock 은 import 보다 먼저 끌어올려지므로, 아래 ProblemCrop 은 실서버 클라이언트를 본다.
vi.mock('@/lib/api', async () => {
  const { httpClient: client } = await import('@/lib/http-client');
  return { api: client, IS_MOCK: false };
});

function tokenIssuer() {
  return vi.fn(async (input: unknown) => {
    if (String(input).endsWith('/api/download-tokens')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: 'v1.123.sig', scope: '/api/files/ab12', expires_in: 900 }),
      } as unknown as Response;
    }
    throw new Error(`예상치 못한 요청: ${String(input)}`);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  resetDownloadTokens();
  writeStoredPassword('friend');
});

afterEach(() => {
  window.localStorage.clear();
  setUnauthorizedHandler(null);
  resetDownloadTokens();
  vi.unstubAllGlobals();
});

describe('배포 인증에서 크롭 URL 이 DOM 까지 토큰을 달고 간다', () => {
  it('<img src> 에 ?token= 이 붙고 비밀번호는 없다', async () => {
    vi.stubGlobal('fetch', tokenIssuer());

    render(<ProblemCrop fileId="ab12" no={3} />);

    const img = await screen.findByRole('img', { name: '3번 문제 이미지' });
    const src = img.getAttribute('src') ?? '';
    expect(src).toBe('http://127.0.0.1:8100/api/files/ab12/problems/3/crop?token=v1.123.sig');
    expect(src).not.toContain('access=');
    expect(src).not.toContain('friend');
  });

  it('토큰이 오기 전에는 인증 없는 요청을 만들지 않는다(자리표시자만 그린다)', () => {
    // 발급이 끝나지 않은 상태 = 첫 렌더. 이때 <img> 를 걸면 401 로 굳는다.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    render(<ProblemCrop fileId="ab12" no={3} />);

    expect(screen.queryByRole('img', { name: '3번 문제 이미지' })).toBeNull();
  });

  it('같은 시험지의 크롭 여러 장이 함께 떠도 토큰 발급은 한 번이다', async () => {
    const fetchMock = tokenIssuer();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <>
        <ProblemCrop fileId="ab12" no={1} />
        <ProblemCrop fileId="ab12" no={2} />
        <ProblemCrop fileId="ab12" no={3} />
      </>,
    );

    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(3));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const img of screen.getAllByRole('img')) {
      expect(img.getAttribute('src')).toContain('?token=v1.123.sig');
    }
  });

  it('api 헬퍼 자체도 비밀번호를 URL 에 싣지 않는다', () => {
    expect(httpClient.cropUrl('ab12', 3)).not.toContain('access=');
  });
});
