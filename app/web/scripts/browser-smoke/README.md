# 브라우저 스모크 테스트

jsdom(vitest)으로는 확인할 수 없는 것들을 실제 Chromium 으로 확인한다.

- pdf.js 가 캔버스에 **실제로 그렸는지** (알파 채널까지 보고 빈 캔버스를 걸러낸다)
- KaTeX 폰트가 로컬 번들에서 로드되는지 (`document.fonts.check`)
- SSE delta 가 화면에 실시간으로 쌓이는지
- 우측 패널 리사이즈, 우클릭 메뉴, 삭제 경고 다이얼로그
- 콘솔 에러 / 실패한 네트워크 요청이 없는지

## 준비

playwright 는 프로젝트 의존성에 넣지 않았다(개발 확인용). 임시로 설치해서 쓴다.

```bash
# app/web 에서
mkdir -p tmp/pw && cd tmp/pw
npm init -y && npm i playwright@1.56.0
npx playwright install chromium
cd ../..
```

## 실행

```bash
# 1) 개발 서버(목 모드) 대상
NEXT_PUBLIC_MOCK=1 npm run dev            # 다른 터미널, 포트 3000/3100 등
BASE=http://127.0.0.1:3100 node --experimental-default-type=module \
  --input-type=module -e "$(cat scripts/browser-smoke/smoke.mjs)"

# 더 간단하게는 tmp/pw 안에서 실행 (node_modules 해석 때문)
cp scripts/browser-smoke/smoke.mjs tmp/pw/ && cd tmp/pw && BASE=http://127.0.0.1:3100 node smoke.mjs
```

```bash
# 2) 정적 export(out/) 대상 — Tauri 배포 형태 검증
NEXT_PUBLIC_MOCK=1 npm run build
node scripts/browser-smoke/static-server.mjs      # http://127.0.0.1:3102
cp scripts/browser-smoke/smoke.mjs tmp/pw/ && cd tmp/pw && BASE=http://127.0.0.1:3102 node smoke.mjs
```

스크린샷은 `app/web/tmp/shots/` 에 저장된다.

## 주의

`next dev` 를 같은 프로젝트에서 여러 개 동시에 띄우면 `.next` 를 공유해 서로 깨진다.
포트를 바꿔 여러 시나리오를 볼 때는 하나씩 순차로 실행할 것.

## 실제 백엔드 대상 스크립트

| 파일 | 확인 내용 | 주의 |
|---|---|---|
| `smoke.mjs` | 목 모드 전체 흐름(pdf.js/KaTeX/SSE/리사이즈) | AI 호출 없음(목) |
| `highlight.mjs` | 문제 하이라이트 좌표가 bbox 비율과 일치하는지(뒤집힘 회귀) | AI 호출 없음 |
| `features.mjs` | 기본 공급자=구독, API 선택 시 과금 안내, "6번" 자동 첨부 | **실제 AI 를 1회 호출한다**(구독 한도 소비) |

`highlight.mjs` 는 백엔드에 이 시험지(22문항)가 업로드된 상태를 전제로 하고,
`/api/files/{id}` 의 bbox 실측값(1번 `[32,69,290,142]` 등)과 화면 좌표 비율을 비교한다.

## 추가 스크립트 (2차)

| 파일 | 확인 내용 | 주의 |
|---|---|---|
| `upload-target.mjs` | 업로드가 지정한 폴더로 들어가는지(`/api/tree` 의 `parent_id` 로 확인) | 검증용 폴더를 만들고 끝나면 그 폴더만 삭제한다 |
| `subscription-notice.mjs` | 구독 불가 시 프롬프트 영역 안내/입력 차단/다시 확인 | **API 키 저장 버튼은 누르지 않는다**(실서버 설정을 건드리게 됨) |
| `reason-stub.mjs` | 백엔드 앞에 두는 프록시. `/api/env` 에 `subscription.reason` 주입 + CORS 허용 | 검증 전용. `REASON=none` 이면 주입 없이 CORS 만 |

### 다른 포트로 검증할 때 두 가지 함정

1. **CORS**: 백엔드가 `http://127.0.0.1:3000` 만 허용한다. 다른 포트의 프론트로 붙으면
   `Failed to fetch` 가 된다. `reason-stub.mjs` 를 경유하면 CORS 헤더가 붙는다.
2. **`.next` 공유**: 같은 디렉터리에서 `next dev` 를 두 개 띄우면 서로 깨진다.
   사용자가 쓰는 dev 를 살려 둔 채 확인해야 할 때는 프로젝트를 다른 폴더로 복사하고
   `node_modules` 만 junction 으로 연결한다(`mklink /J node_modules ..\..\node_modules`).
   지울 때는 `rmdir node_modules` 로 junction 을 먼저 끊어야 실제 node_modules 가 안 지워진다.

## 좌측 트리 끌기 (4차)

| 파일 | 확인 내용 | 주의 |
|---|---|---|
| `tree-drag.mjs` | 들여쓰기 여백에서 `dragstart` 가 뜨는지 / 끌기 뒤 click 이 따라오는지 / 파일 행 위 드롭이 최상위로 튀는지 / 끌기 상태(삭제 영역·반투명)가 남는지 / 빈 공간 클릭으로 선택이 풀리는지 | **Windows 전용.** 목 모드 dev 서버가 필요하다. AI 호출 없음 |

```bash
NEXT_PUBLIC_MOCK=1 npx next dev -p 3101      # 다른 터미널
cp scripts/browser-smoke/tree-drag.mjs tmp/pw/ && cd tmp/pw && BASE=http://127.0.0.1:3101 node tree-drag.mjs
```

⚠️ 이 스크립트는 Playwright 의 합성 입력이 아니라 **진짜 OS 마우스 입력**(Win32
`SetCursorPos`/`mouse_event`)으로 창을 조작한다. 실제 커서가 움직이므로 도는 동안
마우스·키보드를 만지면 안 된다. 창을 띄워야 하므로 `headless: false` 고정이다.

네이티브 HTML5 끌기는 jsdom 에서 아예 일어나지 않는다(`draggable` 은 그려지지만
`dragstart` 를 브라우저가 만들어 주지 않는다). "들여쓰기 여백에서 끌기가 시작되는가"
같은 질문은 **여기서만** 답할 수 있다. 알아 둘 것 두 가지:

- Chromium 의 끌기 임계값은 **5px** 이다. 4px 이하로 움직였다 놓으면 `dragstart` 없이
  click 이 된다(= 파일이 열린다). 이건 브라우저 동작이라 앱에서 바꿀 수 없다.
- 끌기가 도는 동안 **키 입력은 페이지로 오지 않는다.** Esc 취소는 `keydown` 이 아니라
  브라우저가 주는 `dragend` 로 감지해야 한다.

## 오답노트/스레드 스크립트 (3차)

| 파일 | 확인 내용 | 주의 |
|---|---|---|
| `oanote.mjs` | 좌측 섹션 전환·노트 생성·채팅 의도파싱 추가·원본 바로가기·문항 스레드·클릭 힌트 | 검증용 학생 폴더만 만들고 끝나면 그 폴더만 삭제. 사용자 데이터(test-hw, 22문항 PDF) 보존. **AI 를 호출하지 않는다**(의도파싱은 AI 0회). |

⚠️ `next dev`(3000)가 도는 중에는 **절대 `npm run build` 를 같은 폴더에서 돌리지 마라.**
둘 다 `.next` 를 쓰기 때문에 도는 dev 가 500 으로 깨진다. 빌드가 필요하면 3000 을 먼저 내리고,
빌드 후 `rm -rf .next && next dev -p 3000` 로 다시 띄운다.
