/**
 * 바이너리 GET 용 단기 다운로드 토큰(`?token=`) 캐시.
 *
 * 왜 필요한가: `<img src>` 크롭·pdf.js·원본 PDF 다운로드는 브라우저가 직접 GET 하므로
 * 커스텀 헤더(`X-Access-Password`)를 붙일 수 없다. 예전에는 그 자리에 공유 비밀번호를
 * `?access=<비번>` 로 실었는데, URL 은 방문 기록·서버 액세스 로그·Referer 에 남고
 * 비밀번호는 전원 공용이라 한 번 새면 앱 전체가 열린다. 그래서 비밀번호 대신
 * `POST /api/download-tokens` 로 받은 **단기·범위 제한 토큰**을 싣는다.
 *
 * 설계(백엔드 계약에 맞춘 것):
 *  - 범위는 **노드 단위**(`/api/files/{id}` · `/api/notes/{id}`). 시험지 하나를 열면
 *    원본 PDF 1건 + 크롭 수십 건을 동시에 로드하므로, 자산마다 발급하면 화면 진입마다
 *    수십 번 왕복한다. 그래서 응답의 `scope` 를 캐시 키로 삼아 노드 하나당 한 번만 받는다.
 *  - 만료는 서버가 `expires_in`(초)로 준다. 절대 시각을 받지 않으므로 클라이언트 시계
 *    오차와 무관하다. 여기서는 받은 순간을 기준으로 **여유(60초)를 뺀 갱신 시각**을
 *    잡아, 만료 직전 토큰을 URL 에 박는 일이 없게 한다.
 *  - 캐시 키에 비밀번호를 섞는다. 토큰 서명키가 비밀번호에서 파생되므로 비번이 바뀌면
 *    옛 토큰은 무효다. 키에 비번을 넣어 두면 로그아웃/비번 교체 때 별도 무효화 통로
 *    없이도 자동으로 빗나간다(access-gate ↔ 이 모듈의 순환 의존을 피하는 이유이기도 하다).
 *
 * ## 백그라운드 자동갱신 (이전 결정을 뒤집었다)
 *
 * 처음에는 타이머를 두지 않고 렌더/마운트 때만 lazy 하게 갱신했다. 이유는
 * "URL 을 갈아끼우면 열려 있는 PDF 가 통째로 재로딩되어 읽던 자리를 잃는다" 였다.
 * 그런데 그러면 **화면을 그대로 둔 채 오래 있으면 토큰이 만료**되고, 그 뒤 새로 뜨는
 * 크롭과 새로 누르는 다운로드가 401 로 실패한다. 그래서 타이머를 두되,
 * 재로딩 문제는 **"토큰 갱신" 과 "URL 교체" 를 분리**해서 피한다:
 *
 *  - 갱신은 캐시만 조용히 갈아 끼운다. 이미 쓸 수 있는 토큰이 있던 자리를 새 토큰으로
 *    덮을 때는 `bumpVersion()` 을 하지 **않는다**(→ `storeEntry` 의 알림 조건 참고).
 *    구독자가 깨지 않으니 리렌더가 없고, 리렌더가 없으니 이미 DOM 에 박힌
 *    `<img src>`·pdf.js 문서 URL 문자열은 그대로다 = 재로딩도 재요청도 없다.
 *  - 앞으로 **새로 마운트되는** 크롭과 **새로 누르는** 다운로드만 새 토큰을 집어 간다.
 *    이들은 어차피 지금 URL 을 만드는 참이라 바뀔 URL 자체가 없다.
 *  - 갱신 대상은 **지금 화면이 참조 중인 scope 뿐**이다(`retainDownloadToken`).
 *    한 번 본 노드의 토큰을 영원히 갱신하면 쓰지도 않는 요청이 쌓인다.
 *  - **숨은 탭에서는 갱신하지 않는다.** 노트북을 덮어 두면 어차피 타이머가 밀리므로,
 *    도로 보일 때 한 번 확인하는 편이 요청도 적고 결과도 정확하다.
 *
 * ⚠️ 이 모듈은 URL 에 **비밀번호를 절대 싣지 않는다.** 발급이 실패해도 `?access=` 로
 * 되돌아가지 않는다(그러면 없애려던 노출이 그대로 남고, 전환이 깨진 것도 눈치채지
 * 못한다). 실패는 짧은 시간 "토큰 없음" 으로 기록해 두고, 그동안의 요청은 인증 없이
 * 나가 401 로 실패한다 — 호출부의 기존 오류 표시(크롭 '미리보기 없음', 다운로드 토스트)가
 * 그대로 동작한다.
 */

import { API_BASE } from '@/lib/config';
import { accessHeaders, readStoredPassword, reportUnauthorized } from '@/lib/access-gate';
import { ApiError, errorFromResponse, isAbortError, networkError } from '@/lib/api-error';
import type { DownloadTokenResponse } from '@/types/api';

/** 바이너리 GET 이 토큰을 받는 쿼리 파라미터 이름(백엔드 `download_token.QUERY_PARAM`). */
const TOKEN_PARAM = 'token';

/** 만료 여유. 이만큼 남으면 미리 갱신한다(만료 직전 토큰을 URL 에 박지 않으려고). */
const RENEW_SKEW_MS = 60_000;

/** 발급 실패 후 재시도까지 쉬는 시간. 서버가 흔들릴 때 발급 요청이 몰리지 않게 한다. */
const FAILURE_BACKOFF_MS = 10_000;

/**
 * 백그라운드 갱신을 `renewAt` 보다 이만큼 앞당긴다.
 * 왜: `renewAt` 에 정확히 맞춰 쏘면 응답이 오는 동안 캐시가 "쓸 토큰 없음" 상태가 되어
 * 그사이 렌더된 크롭이 자리표시자로 깜빡인다. 새 토큰이 먼저 도착하게 여유를 둔다.
 */
const RENEW_LEAD_MS = 30_000;

/**
 * 갱신 타이머의 최소 지연. 이미 갱신 시각이 지난 항목(숨은 탭에서 깨어난 직후 등)을
 * 0ms 로 걸면 실패가 반복될 때 타이머가 사실상 바쁜 대기로 돈다. 바닥을 둔다.
 */
const MIN_RENEW_DELAY_MS = 1_000;

/** 갱신이 계속 실패할 때 재시도 간격의 상한. 10초 → 20초 → … → 5분에서 멈춘다. */
const MAX_RENEW_BACKOFF_MS = 300_000;

/** 게이트가 꺼져 토큰이 null 일 때 다시 물어보기까지의 간격(서버 설정이 바뀔 수 있으므로). */
const NULL_TOKEN_RECHECK_MS = 900_000;

/** 토큰을 받을 수 있는 바이너리 경로(백엔드 `_is_binary_asset` 과 같은 판정). */
const BINARY_PATH_RE = /\/(?:raw|crop|export\.docx|export\.hwpx)$/;

/** 노드 범위 판정(백엔드 `scope_for` 와 같은 규칙). */
const SCOPE_RE = /^\/api\/(files|notes)\/([A-Za-z0-9_-]{1,64})(?:\/|$)/;

interface TokenEntry {
  /** 붙일 토큰. null 이면 "붙일 것이 없다"(게이트 꺼짐 또는 발급 실패). */
  token: string | null;
  /** 이 시각(ms)을 넘기면 새로 받는다. 만료 여유가 이미 빠져 있다. */
  renewAt: number;
  /** 발급이 실패해서 만든 항목인지(호출부가 오류를 구분할 수 있게). */
  failed: boolean;
}

const cache = new Map<string, TokenEntry>();
const inflight = new Map<string, Promise<TokenEntry | null>>();

/* 캐시가 바뀐 횟수. `<img src>` 처럼 동기 URL 이 필요한 화면이 이 값을 구독해
 * 토큰이 도착하면 다시 그린다(useSyncExternalStore). */
let version = 0;
const listeners = new Set<() => void>();

function bumpVersion(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** 토큰 캐시 변경 구독(React `useSyncExternalStore` 용). */
export function subscribeDownloadTokens(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 캐시 버전 스냅샷. 값 자체에 의미는 없고 "바뀌었다" 는 신호로만 쓴다. */
export function downloadTokenVersion(): number {
  return version;
}

/**
 * 테스트/초기화용. 프로덕션 흐름에서는 비번이 캐시 키에 있어 별도 무효화가 필요 없다.
 * 갱신 타이머까지 정리한다 — 테스트 사이에 살아남으면 다음 테스트의 fetch 대역을 때린다.
 */
export function resetDownloadTokens(): void {
  cache.clear();
  inflight.clear();
  clearRetainedScopes();
  bumpVersion();
}

interface BinaryTarget {
  /** 토큰 발급 요청에 넣을 경로(쿼리 제외). */
  path: string;
  /** 노드 범위. 캐시 조회 키의 일부. */
  scope: string;
}

/** 절대 URL/상대 URL 에서 우리 API 경로만 뽑는다. 우리 API 가 아니면 null. */
function apiPathOf(url: string): string | null {
  if (url.startsWith('/')) return url;
  if (API_BASE !== '' && url.startsWith(`${API_BASE}/`)) return url.slice(API_BASE.length);
  // data:/blob: 나 다른 오리진(목 모드의 정적 자산 등)은 게이트를 지나지 않는다.
  return null;
}

/**
 * 이 URL 이 토큰을 붙일 대상인지, 붙인다면 어떤 노드 범위인지.
 * 백엔드가 쿼리 인증을 허용하는 바이너리 경로가 아니면 null(그 경로들은 헤더 전용이다).
 */
export function binaryTarget(url: string): BinaryTarget | null {
  const path = apiPathOf(url);
  if (path == null) return null;
  const bare = path.split('?', 1)[0]?.split('#', 1)[0] ?? '';
  if (!BINARY_PATH_RE.test(bare)) return null;
  const match = SCOPE_RE.exec(bare);
  const collection = match?.[1];
  const nodeId = match?.[2];
  if (collection == null || nodeId == null) return null;
  return { path: bare, scope: `/api/${collection}/${nodeId}` };
}

/** 비밀번호가 바뀌면 옛 토큰은 서명이 어긋난다 → 키에 비번을 섞어 자동으로 빗나가게 한다. */
function cacheKey(password: string, scope: string): string {
  return `${password}\u0000${scope}`; // 비번에 어떤 문자가 있어도 안 겹치는 구분자
}

function freshEntry(key: string): TokenEntry | null {
  const entry = cache.get(key);
  if (entry == null) return null;
  return entry.renewAt > Date.now() ? entry : null;
}

function storeEntry(key: string, entry: TokenEntry, serverScope: string | null): void {
  const previous = freshEntry(key);
  cache.set(key, entry);
  // 캐시 키는 응답의 scope 를 정본으로 쓴다. 다만 로컬 판정과 다르면 이후 조회가 영원히
  // 빗나가 매번 재발급하게 되므로, 로컬 키에도 같은 항목을 넣어 둔다.
  if (serverScope != null && serverScope !== '') {
    const password = readStoredPassword();
    if (password != null) cache.set(cacheKey(password, serverScope), entry);
  }
  // 왜 조건부 알림인가: 백그라운드 갱신은 **이미 쓰고 있는** 토큰을 조용히 갈아 끼운다.
  // 여기서 구독자를 깨우면 렌더가 다시 돌면서 `<img src>`·pdf.js URL 이 새 토큰 문자열로
  // 바뀌고, 열려 있던 PDF 가 통째로 재로딩된다(자동갱신을 미루게 했던 바로 그 문제).
  // 그래서 알리는 경우는 둘뿐이다.
  //  1. 쓸 토큰이 아예 없던 상태 — 자리표시자로 기다리는 화면이 있다.
  //  2. "토큰을 붙일지 말지" 의 답이 뒤집힌 경우(null ↔ 토큰) — 붙이는 형태가 달라진다.
  if (previous == null || (previous.token == null) !== (entry.token == null)) bumpVersion();
}

/** `POST /api/download-tokens`. 401 은 기존 게이트 통로로 보낸다(비번이 틀렸다는 뜻). */
async function requestToken(path: string): Promise<DownloadTokenResponse> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/download-tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...accessHeaders(),
      },
      body: JSON.stringify({ path }),
      cache: 'no-store',
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw networkError(error);
  }
  if (!response.ok) {
    if (response.status === 401) reportUnauthorized();
    throw await errorFromResponse(response);
  }
  try {
    return (await response.json()) as DownloadTokenResponse;
  } catch (error) {
    throw new ApiError(
      'bad_response',
      '다운로드 토큰 응답을 해석할 수 없습니다.',
      String(error),
      response.status,
    );
  }
}

function toEntry(body: DownloadTokenResponse): TokenEntry {
  const now = Date.now();
  if (body.token == null) {
    // 게이트가 꺼진 환경. 쿼리를 붙이지 않는 것이 정답이라 null 을 그대로 캐시한다.
    return { token: null, renewAt: now + NULL_TOKEN_RECHECK_MS, failed: false };
  }
  const ttlMs = (body.expires_in ?? 0) * 1000;
  // 여유를 뺀다. 다만 TTL 이 여유보다 짧으면 음수가 되어 매 렌더 재발급하게 되므로
  // 최소한 절반은 쓰도록 바닥을 둔다.
  const lifetime = ttlMs > 0 ? Math.max(ttlMs - RENEW_SKEW_MS, Math.floor(ttlMs / 2)) : 0;
  return { token: body.token, renewAt: now + lifetime, failed: false };
}

/**
 * 발급 한 번. 성공하면 캐시에 넣고 항목을, 실패하면 null 을 준다.
 *
 * 실패를 캐시에 남기지 **않는** 것이 요점이다. 백그라운드 갱신은 아직 쓸 수 있는 토큰이
 * 캐시에 있는 상태에서 도는데, 여기서 실패 항목으로 덮으면 멀쩡히 동작하던 화면이
 * 갱신 실패 한 번에 무너진다. "실패를 얼마나 기억할지" 는 호출부 정책으로 넘긴다.
 *
 * 같은 노드에 대한 동시 요청은 in-flight 프라미스를 공유한다. 크롭 수십 개가 한
 * 프레임에 붙어도, 그 와중에 갱신 타이머가 겹쳐도 발급은 한 번이다.
 */
function issueToken(key: string, path: string): Promise<TokenEntry | null> {
  const pending = inflight.get(key);
  if (pending != null) return pending;

  const promise = requestToken(path)
    .then((body) => {
      const entry = toEntry(body);
      storeEntry(key, entry, body.scope);
      return entry;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

/**
 * 이 URL 에 쓸 토큰을 확보한다(있으면 캐시 재사용).
 *
 * - 절대 reject 하지 않는다. 호출부(특히 렌더 이펙트)가 `void` 로 던져도 unhandled
 *   rejection 이 나지 않아야 하기 때문이다. 실패는 `failed: true` 항목으로 표현한다.
 * - 실패는 짧게(FAILURE_BACKOFF_MS) 캐시한다. 크롭 수십 장이 동시에 실패를 보고
 *   저마다 재발급을 시도하는 것을 막는다.
 */
export function ensureDownloadToken(url: string): Promise<TokenEntry | null> {
  const target = binaryTarget(url);
  const password = readStoredPassword();
  // 비번이 없으면 게이트를 통과할 방법도 없고 통과할 필요도 없다(로컬 개발 = 기존 규칙).
  if (target == null || password == null) return Promise.resolve(null);

  const key = cacheKey(password, target.scope);
  const cached = freshEntry(key);
  if (cached != null) return Promise.resolve(cached);

  return issueToken(key, target.path).then((entry) => {
    if (entry != null) return entry;
    // 실패해도 비밀번호로 되돌아가지 않는다. 잠깐 "토큰 없음" 으로 두고 나중에 다시 받는다.
    // 이미 백오프 중인 실패 항목이 있으면 그대로 둔다(동시 호출이 백오프를 늘리지 않게).
    const existing = cache.get(key);
    if (existing?.failed === true && existing.renewAt > Date.now()) return existing;
    const failure: TokenEntry = {
      token: null,
      renewAt: Date.now() + FAILURE_BACKOFF_MS,
      failed: true,
    };
    storeEntry(key, failure, null);
    return failure;
  });
}

/**
 * 동기로 URL 을 완성한다(렌더 중에 쓰는 경로 — 네트워크를 타지 않는다).
 * 캐시에 쓸 토큰이 있을 때만 `?token=` 을 붙이고, 없으면 URL 을 그대로 돌려준다.
 */
export function withDownloadToken(url: string): string {
  const target = binaryTarget(url);
  const password = readStoredPassword();
  if (target == null || password == null) return url;
  const entry = freshEntry(cacheKey(password, target.scope));
  if (entry?.token == null) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${TOKEN_PARAM}=${encodeURIComponent(entry.token)}`;
}

/**
 * 이 URL 을 지금 화면에 내보내도 되는지.
 * false 면 "토큰을 기다리는 중" 이라는 뜻이라, 호출부는 `<img>` 를 아직 걸지 말고
 * `ensureDownloadToken` 이 끝나기를 기다려야 한다(인증 없이 요청해 401 을 만들지 않도록).
 */
export function isBinaryUrlReady(url: string): boolean {
  const target = binaryTarget(url);
  const password = readStoredPassword();
  if (target == null || password == null) return true;
  return freshEntry(cacheKey(password, target.scope)) != null;
}

/**
 * 비동기 경로(fetch·pdf.js)용. 토큰을 확보한 뒤 완성된 URL 을 돌려준다.
 * 발급이 실패하면 던진다 — 이쪽은 호출부에 오류 표시 수단(토스트·에러 화면)이 있어서,
 * 실패를 삼키고 401 을 맞게 두는 것보다 원인을 그대로 보여 주는 편이 낫다.
 */
export async function authorizeBinaryUrl(url: string): Promise<string> {
  const entry = await ensureDownloadToken(url);
  if (entry?.failed === true) {
    throw new ApiError(
      'download_token_failed',
      '다운로드 인증 토큰을 받지 못했습니다.',
      '잠시 후 다시 시도해 주세요.',
      null,
    );
  }
  return withDownloadToken(stripDownloadToken(url));
}

/* ── 백그라운드 자동갱신 ────────────────────────────────────────────────────
 *
 * 화면이 지금 참조 중인 scope 만 갱신 대상으로 삼는다. 참조 여부는 훅의
 * 마운트/언마운트가 알려 준다(`retainDownloadToken` 의 반환값이 해제 함수다).
 * 갱신 자체는 캐시만 조용히 바꾸므로(→ `storeEntry` 의 알림 조건) 이미 그려진
 * URL 문자열은 건드리지 않는다.
 */

interface RetainedScope {
  /** 재발급 요청에 실을 바이너리 경로. 쿼리를 뗀 값이라 토큰이 바뀌어도 그대로다. */
  path: string;
  /** 이 scope 를 참조 중인 마운트 수. 0 이 되면 타이머를 접는다. */
  count: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** 연속 실패 횟수. 재시도 간격을 지수로 늘리는 데 쓴다. */
  failures: number;
}

/** 키는 scope. 비밀번호는 실행 시점에 읽는다(비번이 바뀌어도 참조 자체는 유효하므로). */
const retained = new Map<string, RetainedScope>();
let visibilityBound = false;

function isTabHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function clearScopeTimer(scope: RetainedScope): void {
  if (scope.timer == null) return;
  clearTimeout(scope.timer);
  scope.timer = null;
}

/** 다음 갱신까지의 지연. 실패 중이면 백오프, 아니면 만료 여유보다 조금 더 앞. */
function renewDelayMs(scopeName: string, scope: RetainedScope): number {
  if (scope.failures > 0) {
    const backoff = FAILURE_BACKOFF_MS * 2 ** (scope.failures - 1);
    return Math.min(backoff, MAX_RENEW_BACKOFF_MS);
  }
  const password = readStoredPassword();
  const entry = password == null ? null : cache.get(cacheKey(password, scopeName));
  if (entry == null) return MIN_RENEW_DELAY_MS; // 아직 첫 발급 전 — 곧 다시 본다
  // 실토큰만 앞당긴다. `token: null`(게이트 꺼짐) 은 갈아 끼울 것이 없어 재확인일 뿐이다.
  const lead = entry.token == null ? 0 : RENEW_LEAD_MS;
  return Math.max(entry.renewAt - lead - Date.now(), MIN_RENEW_DELAY_MS);
}

/** 지금 이 scope 를 갈아 끼울 때가 됐는가. 타이머가 예정보다 일찍 깬 경우를 거른다. */
function renewalDue(key: string): boolean {
  const entry = cache.get(key);
  if (entry == null) return true; // 아직 아무것도 없다 = 지금 받아야 한다
  const lead = entry.token == null ? 0 : RENEW_LEAD_MS;
  return entry.renewAt - lead <= Date.now();
}

function scheduleRenew(scopeName: string): void {
  const scope = retained.get(scopeName);
  if (scope == null) return;
  clearScopeTimer(scope);
  // 숨은 탭에서는 타이머를 아예 걸지 않는다. 다시 보일 때 visibilitychange 가 잡는다.
  if (isTabHidden()) return;
  scope.timer = setTimeout(() => {
    scope.timer = null;
    void runRenew(scopeName);
  }, renewDelayMs(scopeName, scope));
}

async function runRenew(scopeName: string): Promise<void> {
  const scope = retained.get(scopeName);
  if (scope == null) return; // 언마운트됨
  if (isTabHidden()) return; // 타이머가 밀려 숨은 뒤에 도착했다 — 다시 보일 때 처리한다
  const password = readStoredPassword();
  if (password == null) return; // 로그아웃 — 갱신할 것이 없다(다시 들어오면 lazy 로 받는다)

  const key = cacheKey(password, scopeName);
  if (!renewalDue(key)) {
    // 타이머가 예정보다 일찍 깼다(첫 발급 전에 걸어 둔 확인 타이머를 lazy 경로가 먼저
    // 채운 경우 등). 요청 없이 제 시각으로 다시 건다. 다른 경로가 성공한 셈이니
    // 쌓아 둔 백오프도 푼다.
    scope.failures = 0;
    scheduleRenew(scopeName);
    return;
  }

  const entry = await issueToken(key, scope.path);

  // 기다리는 동안 언마운트됐으면 타이머를 다시 걸지 않는다(누수 방지).
  const current = retained.get(scopeName);
  if (current == null) return;
  current.failures = entry == null ? current.failures + 1 : 0;
  scheduleRenew(scopeName);
}

function handleVisibilityChange(): void {
  if (isTabHidden()) {
    for (const scope of retained.values()) clearScopeTimer(scope);
    return;
  }
  // 다시 보이면 곧바로 한 번 확인한다. 숨은 사이(노트북을 덮어 둔 동안) 갱신 시각이
  // 이미 지났을 수 있는데, 그때 `renewDelayMs` 는 바닥값을 돌려주므로 거의 즉시 돈다.
  for (const scopeName of retained.keys()) scheduleRenew(scopeName);
}

function bindVisibility(): void {
  if (visibilityBound || typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', handleVisibilityChange);
  visibilityBound = true;
}

/** 등록된 scope 와 타이머를 모두 접는다(`resetDownloadTokens` 용). */
function clearRetainedScopes(): void {
  for (const scope of retained.values()) clearScopeTimer(scope);
  retained.clear();
  unbindVisibilityIfIdle();
}

function unbindVisibilityIfIdle(): void {
  if (!visibilityBound || retained.size > 0 || typeof document === 'undefined') return;
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  visibilityBound = false;
}

/**
 * 이 URL 의 노드 범위를 "지금 화면이 쓰는 중" 으로 등록하고, 해제 함수를 돌려준다.
 * 등록돼 있는 동안만 백그라운드 갱신 타이머가 돈다.
 *
 * 인자는 토큰이 붙지 않은 형태(`binaryTarget(url).path`)로 넘기는 편이 좋다.
 * 토큰이 섞인 URL 을 넘겨도 판정 결과는 같지만, 호출부의 이펙트 의존성이 토큰마다
 * 바뀌어 타이머가 불필요하게 다시 걸린다.
 */
export function retainDownloadToken(url: string): () => void {
  const target = binaryTarget(url);
  // 토큰이 필요 없는 URL(목의 data: URI, 정적 자산)은 갱신할 것도 없다.
  if (target == null) return () => {};

  const scopeName = target.scope;
  const existing = retained.get(scopeName);
  if (existing == null) {
    retained.set(scopeName, { path: target.path, count: 1, timer: null, failures: 0 });
    bindVisibility();
    scheduleRenew(scopeName);
  } else {
    existing.count += 1;
  }

  let released = false;
  return () => {
    if (released) return; // 같은 해제 함수를 두 번 불러도 다른 마운트의 참조를 깎지 않는다
    released = true;
    const scope = retained.get(scopeName);
    if (scope == null) return; // resetDownloadTokens 등으로 이미 비워졌다
    scope.count -= 1;
    if (scope.count > 0) return;
    clearScopeTimer(scope);
    retained.delete(scopeName);
    unbindVisibilityIfIdle();
  };
}

/** 이미 붙어 있던 `?token=` 을 떼어 낸다(갱신 시 옛 토큰이 남지 않게). */
export function stripDownloadToken(url: string): string {
  const queryAt = url.indexOf('?');
  if (queryAt < 0) return url;
  const head = url.slice(0, queryAt);
  const rest = url.slice(queryAt + 1);
  const [query = '', hash] = rest.split('#', 2);
  const kept = query
    .split('&')
    .filter((part) => part !== '' && part !== TOKEN_PARAM && !part.startsWith(`${TOKEN_PARAM}=`));
  const rebuilt = kept.length > 0 ? `${head}?${kept.join('&')}` : head;
  return hash == null ? rebuilt : `${rebuilt}#${hash}`;
}
