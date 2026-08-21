/**
 * 바이너리 URL(`<img src>` 등)을 다운로드 토큰이 준비된 뒤에 내보내는 훅.
 *
 * 왜 훅이 필요한가: `<img src>` 는 렌더 시점에 **동기 문자열**을 요구하는데,
 * 토큰 발급은 네트워크(비동기)다. 그래서 URL 조립은 캐시를 보는 동기 함수로 두고
 * (`withDownloadToken`), 캐시가 비어 있을 때 발급을 시작해 도착하면 다시 그리는
 * 역할만 이 훅이 맡는다.
 *
 * 사용 규칙: **URL 은 컴포넌트 렌더 본문에서 만들어 넘긴다.**
 * 토큰이 도착하면 이 훅이 재렌더를 일으키고, 그때 다시 호출된 `api.cropUrl(...)` 이
 * 캐시에서 토큰을 붙인 URL 을 돌려준다.
 *
 *   const src = useBinaryUrl(api.cropUrl(fileId, no));
 *   if (src == null) return <준비 중 자리표시자 />;
 *
 * 토큰이 필요 없는 URL(비번 미저장 = 로컬, `data:` URI, 게이트 밖 정적 자산)은
 * 첫 렌더에서 그대로 통과한다 — 목 모드와 로컬 개발의 기존 동작이 그대로다.
 *
 * 이 훅은 마운트되어 있는 동안 해당 노드 범위를 "쓰는 중" 으로 등록해
 * 백그라운드 자동갱신 대상으로 만든다(`retainDownloadToken`). 화면을 열어 둔 채
 * 오래 두어도 토큰이 만료되지 않게 하려는 것이다. 갱신은 캐시만 조용히 바꾸므로
 * **이미 돌려준 URL 문자열은 갱신 때문에 바뀌지 않는다**(자세한 이유는 download-token.ts).
 */

import { useEffect, useSyncExternalStore } from 'react';
import {
  binaryTarget,
  downloadTokenVersion,
  ensureDownloadToken,
  isBinaryUrlReady,
  retainDownloadToken,
  subscribeDownloadTokens,
} from '@/lib/download-token';

/** 토큰이 준비되면 그 URL 을, 아직이면 null 을 준다. */
export function useBinaryUrl(url: string): string | null {
  // 값 자체는 쓰지 않는다. 토큰 캐시가 바뀌면 이 컴포넌트를 다시 그리게 하는 신호다.
  // (서버 스냅샷도 같은 함수로 충분하다 — 모듈 변수라 프리렌더 중에 안 변한다.)
  useSyncExternalStore(subscribeDownloadTokens, downloadTokenVersion, downloadTokenVersion);

  const ready = isBinaryUrlReady(url);

  // 갱신 등록에 쓸 키. 쿼리를 뗀 경로라 토큰이 바뀌어도 같은 값이다 — url 을 그대로
  // 의존성에 넣으면 토큰이 붙고 떨어질 때마다 등록이 풀렸다 다시 걸려 타이머가 초기화된다.
  const retainKey = binaryTarget(url)?.path ?? null;

  useEffect(() => {
    // 발급은 렌더가 아니라 이펙트에서 시작한다(렌더는 순수해야 한다).
    // ensureDownloadToken 은 reject 하지 않고, 같은 노드의 동시 요청을 하나로 합친다.
    if (ready) return;
    void ensureDownloadToken(url);
  }, [url, ready]);

  useEffect(() => {
    // 언마운트하면 해제된다 → 화면에서 사라진 노드의 토큰은 더 갱신하지 않는다.
    if (retainKey == null) return;
    return retainDownloadToken(retainKey);
  }, [retainKey]);

  return ready ? url : null;
}
