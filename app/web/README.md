# app/web — 수학 문제풀이 워크스페이스 (프론트엔드)

Next.js 15 App Router + TypeScript + Tailwind CSS v4.
API 계약은 저장소 루트의 `ARCHITECTURE.md` 5항이 단일 소스다. 경로·필드명을 임의로 바꾸지 않는다.

## 빠른 시작

```bash
npm install

# 백엔드 없이 UI 전체 흐름 확인 (권장: 개발 초기)
NEXT_PUBLIC_MOCK=1 npm run dev

# 실제 백엔드(app/core)와 함께
NEXT_PUBLIC_API_BASE=http://127.0.0.1:8100 npm run dev
```

`.env.example` 를 `.env.local` 로 복사해서 쓰면 된다.

## 스크립트

| 명령 | 설명 |
|---|---|
| `npm run dev` | 개발 서버 (prebuild 로 pdf.js 에셋 복사) |
| `npm run build` | 정적 빌드 → `out/` |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest (SSE 파서 · 스토어 · 컴포넌트) |
| `npm run check` | 위 셋을 한 번에 |

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `NEXT_PUBLIC_API_BASE` | `http://127.0.0.1:8100` | 백엔드 base URL. 하드코딩 금지 |
| `NEXT_PUBLIC_MOCK` | `0` | `1` 이면 목 클라이언트 사용 |
| `NEXT_PUBLIC_MOCK_MODE` | `desktop` | 목 시나리오: `desktop` \| `desktop-nokey` \| `web` |

`NEXT_PUBLIC_*` 는 **빌드 시점에 번들에 박힌다.** 데스크톱 배포 시 sidecar 포트와 맞춰서 빌드할 것.

## 목 모드

`NEXT_PUBLIC_MOCK=1` 이면 `lib/api.ts` 가 `lib/mock/client.ts` 를 내보낸다.

- 2단 중첩 폴더 + PDF 1개(실제 시험지 사본 `public/mock/sample.pdf`) + 문제 22개
- 크롭 썸네일은 SVG data URI 플레이스홀더
- 폴더 생성/이름변경/이동/삭제가 메모리 상태에 실제로 반영된다
- **스트리밍도 진짜 SSE 바이트를 만들어 실제 파서를 통과시킨다**
  (`lib/mock/sse-stream.ts` 가 청크를 일부러 들쭉날쭉하게 잘라 경계 버그를 드러낸다)

시나리오를 바꾸면 온보딩 분기를 볼 수 있다.

```bash
NEXT_PUBLIC_MOCK=1 NEXT_PUBLIC_MOCK_MODE=web npm run dev          # 구독 불가 -> API 키 입력
NEXT_PUBLIC_MOCK=1 NEXT_PUBLIC_MOCK_MODE=desktop-nokey npm run dev # Claude Code 미설치 안내
```

## 구조

```
src/
  app/            layout.tsx / page.tsx / globals.css  (정적 셸만 담당)
  components/
    Workspace.tsx        클라이언트 루트: 3분할 레이아웃 + 리사이즈 + 토스트
    Onboarding.tsx       공급자 미설정 안내
    MathText.tsx         KaTeX 렌더
    tree/                파일 트리(중첩/DnD/컨텍스트 메뉴)
    center/              PDF 뷰어 · 풀이 아코디언
    ai/                  AI 패널 · 사용량 표시
    ui/                  다이얼로그 / 로딩·빈·에러 상태
  lib/
    sse.ts               SSE 증분 파서 (단위 테스트 필수 대상)
    stream-events.ts     SSE -> 타입 이벤트 변환
    api.ts               http/mock 스위치
    http-client.ts       실제 백엔드 호출
    mock/                목 데이터 · 목 SSE 스트림
    tree.ts format.ts math-text.ts
  store/workspace.ts     zustand 전역 상태
  types/api.ts           API 계약 타입
```

## 설계 메모

### SSE
`EventSource` 는 POST/헤더를 못 쓰므로 사용하지 않는다.
`fetch` + `ReadableStream` → `lib/sse.ts` 로 직접 파싱한다.
청크가 이벤트 경계에서 쪼개지는 경우(CRLF 가 청크 사이에 걸리는 경우 포함)를
`src/lib/sse.test.ts` 에서 커버한다.

### 오프라인 (데스크톱 대비)
- KaTeX: `katex` 패키지 + `katex/dist/katex.min.css` 를 번들. 폰트도 `_next/static/media` 로 함께 나간다.
- pdf.js: `scripts/copy-pdf-assets.mjs` 가 worker/cmaps/standard_fonts 를 `public/pdfjs/` 로 복사한다.
  CDN 을 참조하는 코드는 없다.
- 폰트: Pretendard 가 설치돼 있으면 쓰고, 없으면 시스템 한글 폰트로 폴백한다(웹폰트 CDN 미사용).

### Tauri 대비
- `output: 'export'` 정적 빌드가 통과한다(`out/`). 서버 런타임 기능(Server Actions, Route Handler,
  동적 라우트 SSR, next/image 최적화)에 의존하지 않는다.
- 그 대신 초기 데이터를 서버 컴포넌트에서 미리 받아올 수 없어, 데이터 로딩은 모두
  클라이언트(zustand 액션)에서 한다. 서버 컴포넌트는 `layout.tsx` / `page.tsx` 정적 셸만 담당한다.
- 백엔드 주소는 `NEXT_PUBLIC_API_BASE` 하나로 바꾼다.

## 검증

- `npm test` : SSE 파서(경계 분할 포함) · 스토어 통합 · 컴포넌트 렌더 94개
- `scripts/browser-smoke/` : 실제 Chromium 으로 pdf.js 렌더/KaTeX 폰트/스트리밍/리사이즈 확인.
  준비와 실행 방법은 그 폴더의 README 참고.

## 아직 안 한 것

- 데스크톱 래퍼(`app/desktop`, Tauri v2): Rust 미설치로 이번 범위 밖.
- 드래그&드롭 이동은 브라우저에서 수동 확인. (HTML5 DnD 는 jsdom 에서 자동 테스트가 어렵다.
  대신 이동 규칙 자체는 `moveNode` 스토어 테스트로 검증한다.)
