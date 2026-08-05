/**
 * 런타임 설정. 하드코딩 금지 — 빌드 시점 환경변수로 주입한다.
 *
 * 정적 export(Tauri) 에서는 서버가 없으므로 `NEXT_PUBLIC_*` 만 사용 가능하다.
 * 값은 빌드 시 번들에 박히므로 데스크톱 배포 시 sidecar 포트와 맞춰야 한다.
 */

/** 백엔드(app/core) base URL. */
export const API_BASE: string = (
  process.env.NEXT_PUBLIC_API_BASE ?? 'http://127.0.0.1:8100'
).replace(/\/+$/, '');

/** 목 모드 여부. 백엔드 없이 UI 전체 흐름을 돌릴 때 쓴다. */
export const IS_MOCK: boolean = process.env.NEXT_PUBLIC_MOCK === '1';

/** API 키를 브라우저에 보관할 때 쓰는 localStorage 키 (웹 모드는 요청마다 헤더로 보낸다). */
export const API_KEY_STORAGE = 'math-teacher.apiKey';

/**
 * 접속 비밀번호(공유 암호)를 브라우저에 보관할 때 쓰는 localStorage 키.
 * 배포본에서 친구만 쓰게 하려는 게이트용. 요청마다 `X-Access-Password` 헤더로 보낸다.
 */
export const ACCESS_PASSWORD_STORAGE = 'math-teacher.accessPassword';

/** UI 환경설정 저장 키. */
export const UI_PREFS_STORAGE = 'math-teacher.uiPrefs';
