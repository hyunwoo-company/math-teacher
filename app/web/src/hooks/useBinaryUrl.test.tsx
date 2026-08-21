/**
 * 다운로드 토큰의 **백그라운드 자동갱신**.
 *
 * 왜 이 파일이 있나: 예전에는 갱신이 렌더/마운트 때만 lazy 하게 일어나서, 화면을
 * 그대로 둔 채 오래 있으면 토큰이 만료되고 그 뒤 새로 뜨는 크롭·다운로드가 401 이 났다.
 * 타이머를 넣되 **열려 있는 화면을 건드리지 않는다** 는 것이 이 기능의 전부라,
 * 여기서 지키는 것은 다음 다섯 가지다.
 *
 *  1. 만료 전에 알아서 갱신한다
 *  2. 갱신이 일어나도 **이미 만들어진 URL 문자열이 바뀌지 않는다** (← 핵심)
 *  3. 숨은 탭에서는 갱신하지 않고, 다시 보이면 확인한다
 *  4. 언마운트하면 타이머가 멈춘다
 *  5. 갱신 실패가 요청 폭주로 이어지지 않는다
 *
 * 2번이 핵심인 이유: 갱신이 리렌더를 유발해 `<img src>`/pdf.js URL 이 새 토큰으로
 * 바뀌면, 열려 있던 PDF 가 통째로 다시 로드되어 읽던 자리를 잃는다.
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBinaryUrl } from '@/hooks/useBinaryUrl';
import { resetDownloadTokens, withDownloadToken } from '@/lib/download-token';
import { setUnauthorizedHandler, writeStoredPassword } from '@/lib/access-gate';

const CROP = 'http://127.0.0.1:8100/api/files/ab12/problems/3/crop';

/** 백엔드 TTL(30분). `toEntry` 는 여기서 여유 60초를 뺀 값을 갱신 시각으로 잡는다. */
const TTL_SECONDS = 1800;
const RENEW_AT_MS = (TTL_SECONDS - 60) * 1000; // 1,740,000
/** 스케줄러는 갱신 시각보다 30초 앞서 쏜다(새 토큰이 먼저 도착하게). */
const FIRE_AT_MS = RENEW_AT_MS - 30_000; // 1,710,000

/**
 * 실제 호출부(`api.cropUrl(...)` → `withDownloadToken`)와 같은 모양의 대역.
 * URL 을 **렌더 본문에서** 조립하므로, 리렌더가 일어나면 그 시점의 캐시 토큰이 박힌다.
 * = 리렌더가 일어나는지 여부를 화면에 드러나는 문자열로 관찰할 수 있다.
 */
function CropProbe() {
  const src = useBinaryUrl(withDownloadToken(CROP));
  return <span data-testid="src">{src ?? ''}</span>;
}

function shownSrc(): string {
  return screen.getByTestId('src').textContent ?? '';
}

/** 부를 때마다 다른 토큰을 주는 발급 대역. 갱신이 실제로 일어났는지 구분하려는 것. */
function countingIssuer() {
  let issued = 0;
  return vi.fn(async () => {
    issued += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        token: `v1.${issued}.sig`,
        scope: '/api/files/ab12',
        expires_in: TTL_SECONDS,
      }),
    } as unknown as Response;
  });
}

function failingIssuer() {
  return vi.fn(async () => {
    return {
      ok: false,
      status: 500,
      json: async () => ({ error_code: 'server_error', message: '터졌다' }),
    } as unknown as Response;
  });
}

/** jsdom 의 `document.visibilityState` 는 읽기 전용이라 게터를 갈아 끼운다. */
function setTabVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

/** 가짜 타이머 위에서 시간을 흘리고, 그 사이 뜬 프라미스까지 정리한다. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** 첫 발급(마운트 직후의 lazy 경로)이 끝날 때까지 기다린다. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  writeStoredPassword('friend');
});

afterEach(() => {
  setTabVisibility('visible');
  resetDownloadTokens();
  window.localStorage.clear();
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('백그라운드 자동갱신', () => {
  it('만료 전에 스스로 갱신한다(화면을 열어 둔 채 오래 있어도 토큰이 살아 있다)', async () => {
    const fetchMock = countingIssuer();
    vi.stubGlobal('fetch', fetchMock);

    render(<CropProbe />);
    await settle();
    expect(shownSrc()).toBe(`${CROP}?token=v1.1.sig`);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 갱신 시각 직전까지는 손대지 않는다(첫 발급 전에 걸어 둔 확인 타이머가
    // 쓸데없이 재발급하지 않는지도 여기서 걸린다).
    await advance(FIRE_AT_MS - 10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 갱신 시각을 지나면 만료(1,800,000ms) 전에 미리 새 토큰을 받아 둔다.
    await advance(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 캐시는 새 토큰으로 바뀌었다 → 지금부터 새로 뜨는 크롭·다운로드는 이걸 쓴다.
    expect(withDownloadToken(CROP)).toBe(`${CROP}?token=v1.2.sig`);
  });

  it('갱신이 일어나도 이미 그려진 URL 문자열은 그대로다(열린 문서가 재로딩되지 않게)', async () => {
    const fetchMock = countingIssuer();
    vi.stubGlobal('fetch', fetchMock);

    render(<CropProbe />);
    await settle();
    const before = shownSrc();
    expect(before).toBe(`${CROP}?token=v1.1.sig`);

    await advance(FIRE_AT_MS + 10_000);

    // 갱신은 분명히 일어났다.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(withDownloadToken(CROP)).toBe(`${CROP}?token=v1.2.sig`);
    // 그런데 이미 DOM 에 박힌 URL 은 옛 토큰 그대로다 = 리렌더도 재요청도 없었다.
    expect(shownSrc()).toBe(before);
    expect(shownSrc()).toBe(`${CROP}?token=v1.1.sig`);
  });

  it('숨은 탭에서는 갱신하지 않고, 다시 보이면 확인한다', async () => {
    const fetchMock = countingIssuer();
    vi.stubGlobal('fetch', fetchMock);

    render(<CropProbe />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    setTabVisibility('hidden');
    // 갱신 시각을 한참 넘겨도(노트북을 덮어 둔 상황) 숨은 동안에는 요청하지 않는다.
    await advance(FIRE_AT_MS + 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    setTabVisibility('visible');
    // 다시 보이면 밀린 갱신을 곧바로 처리한다(타이머 바닥값 1초).
    await advance(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('언마운트하면 타이머가 멈춘다(화면에서 사라진 노드는 더 갱신하지 않는다)', async () => {
    const fetchMock = countingIssuer();
    vi.stubGlobal('fetch', fetchMock);

    const view = render(<CropProbe />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    view.unmount();
    await advance(FIRE_AT_MS * 3);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('갱신이 계속 실패해도 요청이 폭주하지 않는다(백오프)', async () => {
    const fetchMock = failingIssuer();
    vi.stubGlobal('fetch', fetchMock);

    render(<CropProbe />);
    await settle();

    await advance(60_000);

    // 10초 백오프에서 시작해 간격을 늘려 간다 → 1분에 손에 꼽을 횟수.
    // (고정 간격이면 1분에 6번, 백오프가 없으면 1초마다 60번이 된다.)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('여러 크롭이 같은 노드를 봐도 갱신 타이머는 하나다', async () => {
    const fetchMock = countingIssuer();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <>
        <CropProbe />
        <CropProbe />
        <CropProbe />
      </>,
    );
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(FIRE_AT_MS + 10_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
