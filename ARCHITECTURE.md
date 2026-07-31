# 수학 문제풀이 워크스페이스 — 아키텍처 & API 계약

> 이 문서가 **단일 소스**다. 백엔드/프론트엔드 워커는 이 계약을 그대로 구현한다.
> 계약을 바꿔야 한다면 임의로 바꾸지 말고 보고에 명시할 것.

## 0. 제품 요약

시험지 PDF를 위키처럼 폴더/파일로 정리해두고, 파일을 클릭하면 화면에 문제지가 뜨고,
옆 패널에서 AI에게 풀이를 요청하거나 "전체 문제풀이" 버튼으로 자동 생성한다.

**대상 사용자: 한국인.** 모든 UI 텍스트·에러 메시지·날짜 형식은 한국어/한국 기준.

## 1. 배포 형태 2가지 (코드 공유)

| | 데스크톱 (Tauri) | 웹앱 |
|---|---|---|
| 프론트엔드 | `app/web` (동일) | `app/web` (동일) |
| 백엔드 | `app/core` 를 sidecar 로 로컬 실행 | `app/core` 를 서버에서 실행 |
| **구독 모드(Claude Code 인증)** | **가능** | **불가능** (서버가 사용자 PC 인증에 접근 못 함) |
| API 키 모드 | 가능 | 가능 |

→ 프론트엔드는 `GET /api/env` 로 현재 모드를 받아 UI를 분기한다. 하드코딩 금지.

## 2. 디렉터리 구조

```
math-teacher/
  service/            # 기존 비용측정 프로토타입 — 건드리지 말고 보존
  ARCHITECTURE.md     # 이 문서
  app/
    core/             # 공용 백엔드 (FastAPI, Python 3.12)
      main.py
      extractor.py    # service/extractor.py 를 이식 (로직 재사용, 재작성 금지)
      pricing.py      # service/pricing.py 를 이식
      storage.py      # SQLite (app.db)
      providers/
        base.py
        subscription.py   # claude-agent-sdk 경유 (데스크톱 전용)
        apikey.py         # anthropic SDK 경유
      data/
        files/        # 업로드 원본 PDF
        crops/        # 문제별 크롭 PNG
        app.db
    web/              # Next.js 15 App Router + TypeScript
    desktop/          # Tauri v2 래퍼 (Rust 설치 후 별도 작업)
```

## 3. 인증 / Provider

### 3-1. 구독 모드 (우선)
- Claude Code CLI 가 설치되어 있고 로그인되어 있으면 그 인증을 사용한다.
- 이 PC 확인 결과: CLI = `C:\Users\hyunwoo\.local\bin\claude.exe`, 프로필 = `C:\Users\hyunwoo\.claude`
- 구현: `pip install claude-agent-sdk` → `claude_agent_sdk.query(...)`.
  SDK 가 Claude Code 와 동일한 인증 프로필을 읽는다. **API 키를 넘기지 않는다.**
- 감지 로직: ① `claude` 실행파일 탐색(PATH + `%USERPROFILE%\.local\bin`) ② `%USERPROFILE%\.claude` 존재
  둘 다 만족하면 `available: true`. 실제 호출 성공 여부는 첫 호출에서 판정.
- **비용 표시:** 구독 모드는 별도 과금이 없으므로 `cost` 를 `null` 로 두고 UI에 "구독 사용 (추가 과금 없음)" 으로 표기.
  토큰 수는 얻을 수 있으면 표시하고, 못 얻으면 `null`.

### 3-2. API 키 모드 (대체)
- `anthropic` SDK 사용. 모델·파라미터 규칙은 아래 4항 준수.
- 키 저장: 데스크톱은 `data/settings.json`(평문 저장하되 파일 권한 주의, README에 경고 명시),
  웹은 서버에 저장하지 말고 요청마다 헤더로 받는다 (`X-Api-Key`).
- 비용은 응답 `usage` 실측으로 계산 (`pricing.py`).

### 3-3. 선택 규칙
`provider: "auto" | "subscription" | "apikey"`. `auto` 는 구독 가능하면 구독, 아니면 API 키.
API 키도 없으면 `409` + `{"error_code":"no_provider", "message":"...", "hint":"..."}`.

## 3-C. Provider 3종 + 동적 모델 목록

Provider 는 셋이다. `provider: "auto" | "subscription" | "apikey" | "agy"`.

| provider | 수단 | 과금 | 모델 |
|---|---|---|---|
| `subscription` | Claude Code CLI (claude-agent-sdk) | 없음(구독 한도) | Claude 계열 |
| `apikey` | Anthropic API 키 | 종량(달러) | Claude 계열 |
| `agy` | Antigravity CLI (`agy -p`) | 없음(5시간 리셋 쿼터) | Gemini 3 Flash(기본)·Gemini 3.1 Pro·Claude Sonnet 4.6 등 |

### 모델 목록은 환경에 따라 동적으로 (`GET /api/env` 확장)
`env.models` 를 **provider 별로** 내려준다. 프론트는 현재 provider 의 사용 가능 모델만 드롭다운에 노출한다.

```
GET /api/env
 -> { ...,
      providers: {
        agy:          { available: bool, reason: str, models: [{id,label,default:bool}] },
        subscription: { available: bool, cli_path, reason: str, models: [...] },
        apikey:       { available: bool, models: [...] }
      },
      default_provider: "agy"|"subscription"|"apikey" }
```
- **감지 규칙**: agy 는 `agy` 실행파일 존재로 판정. subscription 은 기존 `reason` 로직.
- **default_provider**: agy 가 가능하면 agy(무과금·빠름), 아니면 subscription, 아니면 apikey.
- **모델 선택 가능 여부가 환경에 좌우된다**: Claude CLI(subscription) 가 없으면 프론트에서 Claude 모델 선택지를 **비활성/숨김**. agy 만 있으면 agy 모델만. 사용자 요구사항이다 — 하드코딩 금지, `env` 응답 기반으로 판단.
- 기존 최상위 `models`/`subscription` 필드는 하위호환으로 유지(agy 미도입 프론트가 안 깨지게). 새 프론트는 `providers` 를 쓴다.

### agy provider 구현 주의 (실측 기반)
`providers/agy.py` 를 만든다. `agy -p "<prompt>" --model <id> --output-format json --dangerously-skip-permissions` 를 자식 프로세스로 실행.
- **출력**: `{conversation_id, status, response, duration_seconds, usage:{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}}`. `status=="SUCCESS"` 만 성공.
- **비용**: 쿼터 기반이라 달러 비용이 없다. `cost = null` 로 준다(구독 모드와 동일 규칙). usage 토큰은 그대로 전달하되, **agy 는 IDE 오버헤드로 input 이 3만+ 토큰씩 잡히므로** UI 에 "쿼터 사용" 으로 표기하고 달러 환산하지 마라.
- **모델별 파라미터 차이**: `gemini-3-flash` 는 `--effort` 를 **거부**한다(400 유사 에러). effort 는 지원 모델에만 조건부로 붙여라. 모델↔지원옵션 매핑을 코드에 둔다.
- **응답 후처리**: agy 가 "Follow-up Question / 꼬리 질문" 같은 잡음을 자동 첨부한다. 실제 풀이만 남기고 이런 꼬리말은 제거해라(경계 패턴을 코드에 두고 테스트).
- **이미지 입력**: 프롬프트에 크롭 PNG **파일 경로**를 넣으면 agy 가 read_file 로 읽는다(실측 확인). headless 라 `--dangerously-skip-permissions` 필수. 경로는 서버가 만든 crops 경로만 넘겨라(사용자 입력 경로 금지 — 경로 주입 방지).
- **속도**: flash ~18s/문항, pro ~45s/문항(실측). SSE 로 진행상황을 알리고, 전체 풀이 시 문항별로 순차 처리.
- **스트리밍**: agy `-p` 는 `--output-format stream-json` 도 있다. 우선 text/json 으로 1회 응답을 받아 done 이벤트로 내보내되, 가능하면 stream-json 으로 델타를 흘려라(안 되면 done 만).

## 4. Anthropic 호출 규칙 (위반하면 400)

- 모델 기본 `claude-opus-5`. 선택 가능: `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`
- **`temperature` / `top_p` / `top_k` 절대 금지**
- **`thinking` 은 `{"type": "adaptive"}` 만.** `budget_tokens` 금지
- `output_config={"effort": ...}` — 기본 `"medium"`, 선택 `low|medium|high|xhigh|max`
- system 프롬프트에 `cache_control: {"type":"ephemeral"}` (문제별 개별 호출이므로 캐시 히트 노림)
- `stop_reason == "refusal"` 이면 content 읽기 전에 분기
- `stop_reason == "max_tokens"` 이면 "잘렸음" 플래그를 응답에 포함
- 스트리밍 응답은 `client.messages.stream()` 사용

## 5. API 계약 (이대로 구현)

모든 에러는 `{"error_code": str, "message": str(한국어), "hint": str|null}` 형태.

### 환경 / 설정
```
GET  /api/env
 -> { mode: "desktop"|"web",
      subscription: { available: bool, cli_path: string|null, reason: string },
      api_key_set: bool,
      models: [{id, label, input_usd_per_mtok, output_usd_per_mtok}],
      usd_krw: number }

    # subscription.reason — 구독을 쓸 수 없는 이유. 프론트가 안내 문구를 갈라 쓴다.
    #   "ok"            사용 가능
    #   "cli_missing"   Claude Code 미설치        -> 설치 안내
    #   "not_logged_in" Claude Code 는 있으나 미로그인 -> 로그인 안내
    #   "sdk_missing"   claude-agent-sdk 미설치   -> 앱 설치 문제
    #   "web_mode"      웹 배포(구조적으로 불가)  -> API 키 안내
    #   "disabled"      MATH_TEACHER_DISABLE_SUBSCRIPTION 로 강제 비활성화
    #
    # 구독 모드에 필요한 것은 **Claude Code (CLI, `claude.exe`)** 이고
    # Claude 데스크톱 앱(채팅 GUI)이 아니다. 데스크톱 앱은 CLI 를 설치하지 않는다.
    # 안내 문구에서 이 둘을 혼동하지 말 것.
    #
    # 테스트: `MATH_TEACHER_DISABLE_SUBSCRIPTION=1` 로 띄우면 Claude Code 를
    # 지우지 않고도 "미설치 상태" UI 를 확인할 수 있다.

POST /api/settings/apikey   { key: string }        -> { ok: true }
DELETE /api/settings/apikey                        -> { ok: true }
```

### 폴더 / 파일 트리 (중첩 무제한)
```
GET  /api/tree
 -> { nodes: [ { id, type:"folder"|"file", name, parent_id: string|null,
                 created_at, file?: { pages, problem_count, mode:"text"|"image", pua_ratio } } ] }
    (플랫 배열로 주고 프론트에서 트리 구성. parent_id=null 이 루트)

POST   /api/folders          { name, parent_id }        -> { node }
PATCH  /api/nodes/{id}       { name?, parent_id? }      -> { node }   # 이름변경/이동
DELETE /api/nodes/{id}                                   -> { ok: true }  # 폴더는 하위 전체 삭제(확인은 UI 책임)
POST   /api/files            multipart: file, parent_id -> { node }   # 업로드 즉시 추출 실행(AI 호출 0)
GET    /api/files/{id}       -> { node, problems: [{no, page, bbox, image_w, image_h, has_solution}] }
    # bbox = [x0, y0, x1, y1], 단위는 PDF pt.
    # **좌표계 원점은 페이지 좌상단이고 y 는 아래로 증가한다** (PyMuPDF 기준).
    # PDF 표준 좌표계(좌하단 원점, y 위로 증가)가 아니다. pdf.js 의
    # viewport.convertToViewportRectangle() 에 그대로 넘기면 세로로 뒤집힌다 —
    # MediaBox 높이 기준으로 y 를 반전시킨 뒤 넘겨야 한다.
    # page 는 1-base.
GET    /api/files/{id}/raw   -> application/pdf (뷰어용)
GET    /api/files/{id}/problems/{no}/crop -> image/png
```

### 풀이 (SSE 스트리밍)
```
POST /api/files/{id}/solve
  body { problem_numbers?: number[]|null,   # null = 전체
         provider: "auto"|"subscription"|"apikey",
         model?: string, effort?: string }
  -> text/event-stream, 이벤트 종류:
     event: start      data: {"total": 22}
     event: problem    data: {"no": 1, "status": "running"}
     event: delta      data: {"no": 1, "text": "부분 텍스트"}
     event: done       data: {"no": 1, "solution": "...", "usage": {...}|null,
                              "cost": {...}|null, "truncated": false}
     event: error      data: {"no": 1, "error_code": "...", "message": "..."}
     event: end        data: {"total_usage": {...}|null, "total_cost": {...}|null}

GET /api/files/{id}/solutions -> { solutions: [{no, solution, usage, cost, created_at}] }
```

### 채팅 (SSE 스트리밍)
```
POST /api/files/{id}/chat
  body { message: string, provider, model?, effort?, problem_no?: number|null }
  -> text/event-stream: delta / done / error
     # problem_no 가 있으면 그 문제의 크롭 이미지 + 기존 풀이를 컨텍스트로 첨부
     # 없으면 파일 전체 문제 목록 요약을 컨텍스트로 첨부
     # 대화 이력은 서버가 파일별로 보관하고 자동으로 이어붙인다

GET    /api/files/{id}/chat -> { messages: [{role, content, created_at, usage?, cost?}] }
DELETE /api/files/{id}/chat -> { ok: true }
```

## 6. UI 레이아웃 (3분할)

```
┌──────────────┬────────────────────────────┬─────────────────────┐
│ 파일 트리     │  PDF 뷰어 / 풀이 결과       │  AI 패널            │
│ (280px)      │  (flex)                    │  (400px, 리사이즈)  │
│              │                            │                     │
│ 📁 2026-1학기 │  [PDF] [풀이] 탭            │ [전체 문제풀이] 버튼 │
│  📁 공통수학1 │                            │ 모델 ▾  effort ▾    │
│   📄 풍문고.pdf│  pdf.js 렌더               │ ─────────────────── │
│  📁 미적분    │  문제 클릭 → 해당 위치 하이라이트│ 채팅 메시지 목록     │
│ 📁 모의고사   │                            │ ─────────────────── │
│              │                            │ [입력창] [전송]      │
│ + 폴더  + 파일│                            │ 사용량: 토큰/원      │
└──────────────┴────────────────────────────┴─────────────────────┘
```

### 좌측 패널 2섹션 (6-A 반영)
- 좌측 패널 상단에 **[시험지] / [오답노트]** 섹션 전환 탭(또는 접이식 2블록).
- 두 섹션 모두 같은 트리 컴포넌트를 재사용하되 `section` 이 다르다.
- 오답노트 섹션의 파일형 노드를 클릭하면 중앙에 **오답 항목 목록**(시험지명 · 문항 ·
  크롭 썸네일 · [원본 바로가기])을 보여준다. 원본이 지워진 항목은 바로가기 비활성 + "원본 삭제됨" 배지.

### 중앙 상단 문제 번호 — 클릭 유도
- 문제가 선택되지 않은 상태에서, 중앙 상단 문제 번호(1~22) 줄 근처에
  **"문제 번호를 클릭하면 그 문제로 대화를 시작할 수 있습니다"** 안내를 노출한다.
  (지금은 "5번 · 문제 이미지와 기존 풀이가 함께 전달됩니다 / 해제" 배너가 선택 후에만 보인다.
   선택 전에도 클릭이 대화 시작 트리거임을 알려야 한다.)

### AI 패널 — 시험지 선택 직후 사용 예시
- 시험지를 열고 대화가 비어 있을 때, 입력창 위에 **사용 예시 칩**을 보여준다(클릭하면 입력됨):
  - `6번 문제 풀이해줘`
  - `5번 이현우 오답노트에 추가해줘`
  - `3번이랑 5번 비교해서 설명해줘`
  예시는 실제 동작하는 문장이어야 한다(의도 파싱/오답노트 추가와 연결).

### 프론트엔드 요구사항
- Next.js 15 App Router, TypeScript, Tailwind CSS
- **폴더 트리**: 중첩 무제한, 접기/펼치기, 드래그&드롭 이동, 우클릭 컨텍스트 메뉴(이름변경/삭제/새폴더)
- **PDF 뷰어**: `pdfjs-dist` 사용. 페이지 스크롤, 확대/축소
- **문제 목록**: 크롭 썸네일 + 번호. 클릭하면 우측 채팅에 해당 문제 컨텍스트가 걸림
- **풀이 탭**: 문제별 풀이를 아코디언으로. 수식은 **KaTeX**(`katex` 패키지, CDN 아님 — 데스크톱 오프라인 대비)
- **채팅**: SSE 스트리밍을 실시간 렌더. 사용자 메시지/AI 응답 구분. 수식 렌더 동일
- **비용 표시**: API 키 모드에서 누적 토큰·USD·KRW. 구독 모드에서는 "구독 사용 (추가 과금 없음)"
- 모든 텍스트 한국어. 로딩/빈 상태/에러 상태 다 만들 것
- `GET /api/env` 결과로 구독 불가(웹) 시 구독 옵션을 숨기고 API 키 입력을 유도

## 6-A. 오답노트 (2차 기능)

### 개념
좌측 패널을 **두 섹션**으로 나눈다.
- **시험지** 섹션: 지금까지의 폴더/PDF 트리
- **오답노트** 섹션: 같은 방식의 폴더/노트 트리 (중첩 자유)

선생님이 여러 학생을 관리하는 것이 주 사용 패턴이므로 `이현우` 같은 학생 폴더 밑에
`중간고사 오답` 노트를 두는 구성이 기본이지만, 단원별(`이차방정식 오답`) 구성도
막지 않는다. **구조를 강제하지 않고 폴더로 자유 구성**한다.

### 노트 항목(entry)
노트 안에는 "어느 시험지의 몇 번" 이 들어간다. **풀이는 저장하지 않는다.**
- 원본 시험지로 바로가기가 되어야 한다(원본이 살아 있을 때).
- **원본 시험지를 지워도 오답노트는 남아야 한다.** 따라서 추가 시점의
  시험지 이름과 크롭 이미지를 **스냅샷으로 복사**해 둔다. 원본 삭제 시
  항목은 유지하고 바로가기만 비활성화한다.
- 같은 (노트, 시험지, 문항) 중복 추가는 막는다(멱등).

### 추가 경로 3가지 (모두 지원)
1. **의도 파싱 (1차, AI 호출 0회)** — `"5번 6번 이현우 오답노트에 추가해줘"` 를
   프론트에서 파싱해 바로 API 호출. 문항 번호 파싱은 기존 `detectProblemNo` 확장.
   노트 이름은 기존 노트 목록과 매칭하고, 없으면 **만들지 물어본다**(임의 생성 금지).
2. **AI 보조 (2차)** — 파싱 실패 시에만 AI 에게 넘겨 의도를 구조화해 받는다.
   구독 한도/비용을 쓰므로 1차에서 최대한 잡는 것이 목표다.
3. **UI** — 문제 목록/풀이 탭의 각 문항에 담기 버튼. 노트 선택 드롭다운.

### API
기존 노드 엔드포인트를 재사용한다. `section` 으로 갈린다.
```
GET    /api/tree?section=exam|note        # 기본 exam (기존 호환)
POST   /api/folders   { name, parent_id, section }
POST   /api/notes     { name, parent_id }           -> { node }   # 노트 생성
GET    /api/notes/{note_id}
 -> { node, items: [ { id, source_node_id: string|null, source_name, problem_no,
                       crop_url, memo, created_at, source_available: bool } ] }
POST   /api/notes/{note_id}/items
       { source_node_id, problem_numbers: number[], memo?: string|null }
 -> { added: number[], skipped: number[] }          # skipped = 이미 있던 것
DELETE /api/notes/{note_id}/items/{item_id}
```
`PATCH /api/nodes/{id}` · `DELETE /api/nodes/{id}` 는 두 섹션 공통으로 그대로 쓴다.
**섹션을 넘나드는 이동(`parent_id` 를 다른 섹션 노드로)은 400 으로 거부한다.**

## 6-B. 대화 세션 = 문항별 스레드

`chat_messages` 를 **(시험지, 문항) 단위 스레드**로 나눈다. `problem_no` 가 `null`
인 스레드는 "시험지 전역" 대화다.

- 5번을 보다 6번으로 옮기면 자동으로 6번 스레드가 열린다. 컨텍스트가 짧게 유지된다.
- 지난 스레드를 다시 열어 이어갈 수 있다.
- **이력을 조용히 잘라내지 마라.** 현재 구현은 최근 20개만 보내고 나머지를 말없이
  버린다(= compaction 이 아니라 truncation 이다). 스레드로 나눈 뒤에도 한 스레드가
  길어지면, 잘리기 전에 **"이전 대화 일부가 생략됩니다"** 를 사용자에게 알리고
  "새 대화" 를 권해라.
- 스레드마다 턴 수와 대략 토큰을 표시해라.

```
GET    /api/files/{id}/chat?problem_no=N   # N 생략 시 전역 스레드
DELETE /api/files/{id}/chat?problem_no=N
GET    /api/files/{id}/chat/threads
 -> { threads: [ { problem_no: number|null, turns: int, updated_at } ] }
```

## 7. 데이터 모델 (SQLite)

```sql
-- section: 'exam'(시험지) | 'note'(오답노트). 기존 행은 'exam' 으로 백필.
nodes(id TEXT PK, type TEXT, name TEXT, parent_id TEXT NULL, section TEXT DEFAULT 'exam', created_at TEXT)
files(node_id TEXT PK, stored_path TEXT, pages INT, mode TEXT, pua_ratio REAL, problem_count INT)
problems(node_id TEXT, no INT, page INT, bbox TEXT, crop_path TEXT, PRIMARY KEY(node_id, no))
solutions(node_id TEXT, no INT, solution TEXT, usage_json TEXT, cost_json TEXT,
          truncated INT, created_at TEXT, PRIMARY KEY(node_id, no))

-- 문항별 스레드: problem_no NULL = 시험지 전역 대화.
chat_messages(id INTEGER PK AUTOINCREMENT, node_id TEXT, problem_no INT NULL, role TEXT, content TEXT,
              usage_json TEXT, cost_json TEXT, created_at TEXT)

-- 오답노트 항목. note_node_id = section='note' 인 파일형 노드.
-- 원본(source)을 지워도 남도록 이름/크롭을 스냅샷으로 복사해 둔다.
note_items(id TEXT PK, note_node_id TEXT, source_node_id TEXT NULL, source_name TEXT,
           problem_no INT, crop_snapshot_path TEXT, memo TEXT NULL, created_at TEXT,
           UNIQUE(note_node_id, source_node_id, problem_no))
```

- 폴더 삭제 시 하위 노드/파일/크롭/풀이/채팅/노트항목까지 재귀 삭제한다.
- **시험지(원본) 삭제 시 오답노트 항목은 남긴다.** `source_node_id` 를 NULL 로 만들고
  스냅샷(`source_name`, `crop_snapshot_path`)으로 계속 보여준다. 바로가기만 비활성화.
- `section` 은 마이그레이션으로 추가하고 기존 행을 `'exam'` 으로 채운다.
- `chat_messages.problem_no` 도 마이그레이션으로 추가(기존 행 NULL = 전역 스레드).

## 8. 하지 말 것

- `/tmp` 사용 금지. 임시파일은 `app/core/data/` 하위에만.
- `service/` 디렉터리와 프로젝트 루트의 기존 PDF/HTML/`tmp`/`카톡전송용` 수정·삭제 금지.
- extractor 로직 재작성 금지 — `service/extractor.py` 는 22문항 분할이 검증된 코드다. 이식해서 쓴다.
- 임의로 API 경로/필드명 변경 금지.
