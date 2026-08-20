/**
 * 접속 비밀번호(공유 암호) 게이트의 공용 로직.
 *
 * 배포본을 친구 1명만 쓰게 하려는 인증이다. 백엔드가 모든 `/api/*` 에
 * `X-Access-Password` 헤더를 요구하고(예외: health / env / login), 없거나 틀리면
 * 401 `{"error_code":"unauthorized"}` 를 준다.
 *
 * 이 모듈은 프레임워크에 의존하지 않는 순수 로직만 둔다.
 *  - 비밀번호 보관/조회 (localStorage)
 *  - 요청 헤더 생성
 *  - 게이트 표시 여부 판단
 *  - 401 이 나면 저장 비번을 지우고 등록된 핸들러(스토어)를 깨우는 통로
 *
 * http-client(실서버) 와 mock/client(목) 가 같은 401 통로를 쓰므로,
 * 두 경로 모두 로그인 화면으로 되돌아가는 동작이 일치한다.
 */

import { ACCESS_PASSWORD_STORAGE } from '@/lib/config';
import { ApiError } from '@/lib/api-error';
import type { EnvResponse } from '@/types/api';

/** 브라우저에 보관한 접속 비밀번호. 없으면 null. */
export function readStoredPassword(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(ACCESS_PASSWORD_STORAGE);
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

export function writeStoredPassword(password: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (password == null || password === '') {
      window.localStorage.removeItem(ACCESS_PASSWORD_STORAGE);
    } else {
      window.localStorage.setItem(ACCESS_PASSWORD_STORAGE, password);
    }
  } catch {
    // 프라이빗 모드 등에서 실패할 수 있다. 조용히 무시한다.
  }
}

/** 저장된 비번이 있으면 `X-Access-Password` 헤더를 만든다. 없으면 빈 객체. */
export function accessHeaders(): Record<string, string> {
  const password = readStoredPassword();
  return password ? { 'X-Access-Password': password } : {};
}

/* 바이너리 URL 인증에 대하여 (예전 `withAccess()` 자리)
 *
 * `<img src>` 와 pdf.js 는 브라우저가 직접 GET 하므로 `X-Access-Password` 헤더를
 * 붙일 수 없다. 예전에는 그 자리에 비밀번호를 `?access=<비번>` 로 실었지만,
 * URL 은 방문 기록·서버 액세스 로그·Referer 에 남고 비번은 전원 공용이라
 * 한 번 새면 앱 전체가 열린다. 그래서 지금은 `lib/download-token.ts` 의
 * 단기 서명 토큰(`?token=`)을 쓴다 — **이 모듈은 URL 에 비번을 싣지 않는다.**
 * (백엔드는 구버전 프론트를 위해 `?access=` 를 아직 받아 주지만, 프론트는 쓰지 않는다.)
 */

/**
 * 게이트(로그인 화면)를 보여줘야 하는지.
 *  - `env.auth_required` 가 true(=서버가 비번을 요구) 이고
 *  - 아직 유효한 접근이 확보되지 않았을 때만 true.
 *
 * `auth_required` 가 false(로컬 개발)면 게이트를 절대 띄우지 않는다(기존 흐름 보존).
 * 필드가 없는 구버전 백엔드도 false 로 취급한다.
 */
export function needsAccessGate(env: EnvResponse | null, accessOk: boolean): boolean {
  if (!env) return false;
  if (!env.auth_required) return false;
  return !accessOk;
}

/**
 * 앱 진입 시 초기 접근 상태.
 * 비번이 필요 없으면 항상 통과. 필요하면 저장된 비번이 있는 동안은 낙관적으로 통과시키고,
 * 실제 유효성은 첫 요청의 401 로 판정한다(틀리면 handler 가 다시 잠근다).
 */
export function initialAccessOk(env: EnvResponse): boolean {
  if (!env.auth_required) return true;
  return readStoredPassword() != null;
}

/** ApiError 가 접근 401(세션 만료/비번 변경) 인지. login 자체의 401 은 여기서 다루지 않는다. */
export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/* ── 401 통로 ─────────────────────────────────────────────────────
 * 저수준 클라이언트(http/mock)가 401 을 만나면 reportUnauthorized() 를 부른다.
 * 스토어가 setUnauthorizedHandler() 로 콜백을 등록해 로그인 화면으로 되돌린다.
 * (저수준 모듈이 스토어를 직접 import 하지 않도록 이 통로를 둔다.)
 */
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

/** 401 을 받았을 때: 저장 비번을 지우고 등록된 핸들러를 깨운다. */
export function reportUnauthorized(): void {
  writeStoredPassword(null);
  unauthorizedHandler?.();
}
