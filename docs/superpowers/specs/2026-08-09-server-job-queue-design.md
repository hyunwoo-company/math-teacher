# 서버 작업 큐 (풀이·변형 백그라운드 실행) — 설계

작성일: 2026-08-09
범위: 백엔드 신규 서브시스템 + 프론트 전면 전환. 요청 2번.

## 1. 목적

풀이와 변형을 요청한 뒤 **그 화면에 머물지 않아도** 되게 한다.
다른 시험지를 보거나 오답노트를 정리하거나 브라우저를 닫아도 서버가 계속 작업하고,
돌아오면 결과가 있어야 한다.

진행 상황은 상단 배너로 알린다: `풍문고 중간고사 · 3/22번 풀이 중`.

## 2. 현재 상태 (확인된 사실)

- `POST /api/files/{id}/solve` 는 `ai_service.solve_stream` 을 **HTTP 응답으로 직접** 흘린다
  (`main.py:504`). 클라이언트가 끊으면 async generator 가 중단되고 작업도 멈춘다.
- `workspace.ts:1014` `selectFile()` 이 `abortSolve()` 를 부르고, 스트림 루프도
  `if (get().selectedFileId !== selectedFileId) break;` (`workspace.ts:1420`) 로 빠져나온다.
  → **파일을 옮기면 진행 중 풀이가 취소된다.**
- 다만 `solve_stream` 은 문항이 끝날 때마다 `_save_solution` 으로 **이미 DB 에 저장**한다
  (`ai_service.py:271`). 중단되어도 그때까지의 결과는 남는다.
- 변형(`generateVariant`)은 `variantControllers` Map 으로 관리되며 저장은 하지 않는다.
- 배포는 k3s 단일 Pod + uvicorn(`main:app`). 워커 다중화 설정은 없다.
- 채팅(`/chat`)은 사용자가 답을 기다리는 대화형이라 성격이 다르다.

## 3. 설계

### 3-1. 큰 그림

```
POST /api/jobs ──► [jobs 테이블 queued] ──► 단일 워커 코루틴 ──► provider 호출
                                                │
                                                ├─► 문항 끝날 때마다 solutions/variants 저장
                                                └─► 이벤트 발행 ──► SSE 구독자들
                                                                     (0명이어도 계속 진행)
GET /api/jobs/{id}/events ◄── 언제든 붙었다 떨어졌다 할 수 있다
```

핵심은 **작업의 수명이 HTTP 연결과 무관해진다**는 것 하나다.

### 3-2. 전역 순차 큐

동시 실행하지 않는다. 이유가 셋이다.

1. agy·구독 모드는 쿼터가 한정되어 있고, 병렬 호출은 그것을 빨리 태운다.
2. `solve_stream` 주석대로 순차 호출이 프롬프트 캐시 히트를 만든다(`ai_service.py:237`).
3. agy 는 자식 프로세스를 띄운다. 동시에 여러 개를 띄우면 이 PC/노드가 버겁다.

큐는 **FIFO**. 우선순위는 두지 않는다. 22문항 전체 풀이 뒤에 단일 문항을 넣으면 기다린다 —
급하면 앞 작업을 취소하면 된다. 우선순위 큐는 "왜 내 것이 안 도나"를 설명하기 어렵게 만든다.

### 3-3. 데이터 모델

```sql
-- 작업 큐. 서버가 재시작해도 이력이 남도록 영속한다.
jobs(id TEXT PRIMARY KEY,
     kind TEXT,              -- 'solve' | 'variant'
     node_id TEXT,           -- 대상 시험지
     node_name TEXT,         -- 배너 표시용 스냅샷(노드가 지워져도 이름을 보여준다)
     targets_json TEXT,      -- solve: [1,2,3] / variant: {"no":3,"modes":["number"]}
     params_json TEXT,       -- {provider, model, effort}
     status TEXT,            -- 'queued'|'running'|'done'|'error'|'canceled'|'interrupted'
     total INTEGER,          -- 전체 단위 수
     done_count INTEGER,     -- 완료 단위 수
     current_no INTEGER NULL,
     error TEXT NULL,
     created_at TEXT, updated_at TEXT)
```

- `SCHEMA_VERSION` 을 올리고 `CREATE TABLE IF NOT EXISTS` 로 추가한다.
  (문서 내보내기 스펙에서도 버전을 올리므로, **먼저 머지되는 쪽이 3, 나중이 4** 를 쓴다.)
- 결과 자체는 기존 `solutions` / `variants` 테이블에 저장한다. `jobs` 는 진행 상태만 갖는다.
- 완료된 job 행은 지우지 않는다(최근 이력 표시용). 정리는 하지 않는다 — 개인용 규모다.

**서버 시작 시**: `status IN ('queued','running')` 인 행을 전부 `interrupted` 로 바꾼다.
자동 재개하지 않는다. 재개는 중단 지점 추적과 중복 과금 위험을 낳고, 사용자가 다시 누르면
이미 저장된 문항은 건너뛰므로(기존 캐시 로직) 손실이 적다.
배너에는 `중단됨 — 서버가 재시작되었습니다` 로 표시하고 [이어서 풀기] 를 준다.

### 3-4. 인메모리 실행 상태

`core/jobs.py` 에 프로세스 단위 싱글턴을 둔다.

```python
class JobRunner:
    _queue: asyncio.Queue[str]              # job_id
    _worker: asyncio.Task | None            # 단일 워커
    _live: dict[str, LiveJob]               # 실행 중/최근 job 의 휘발 상태
    _subscribers: dict[str, set[asyncio.Queue]]

@dataclass
class LiveJob:
    current_no: int | None
    partial_text: str          # 현재 문항의 누적 델타 (완료되면 비운다)
    cancel: asyncio.Event
```

- **단일 프로세스 전제.** uvicorn 워커를 늘리면 큐가 프로세스마다 생겨 깨진다.
  `README.md` 와 배포 차트에 "워커 1개" 를 명시한다.
- 워커는 앱 `lifespan` 에서 띄우고 종료 시 취소한다.
- 구독자가 0명이어도 워커는 계속 돈다. 이것이 이 스펙의 전부다.

**부분 텍스트를 메모리에 두는 이유**: SSE 로 재접속했을 때 "지금 3번을 쓰는 중이고 여기까지
썼다" 를 보여주려면 필요하다. 완료된 문항의 텍스트는 DB 에 있으므로 보관하지 않는다.
`partial_text` 는 문항 하나 분량이라 메모리 부담이 없다.

### 3-5. 이벤트

기존 SSE 이벤트 이름을 그대로 쓴다(프론트 파서 재사용).

| event | data | 시점 |
|---|---|---|
| `snapshot` | `{status, total, done_count, current_no, partial_text}` | **구독 직후 1회** |
| `problem` | `{no, status:"running"}` | 문항 시작 |
| `delta` | `{no, text}` | 델타 |
| `done` | `{no, solution, usage, cost, truncated}` | 문항 완료(저장 후) |
| `error` | `{no, error_code, message}` | 문항 실패 |
| `end` | `{status, total_usage, total_cost}` | 작업 종료 |

`snapshot` 이 새로 생기는 유일한 이벤트다. 이것 덕분에 늦게 붙은 클라이언트도 진행 중인
문항의 타이핑을 이어서 볼 수 있다.

한 문항이 실패해도 다음 문항으로 넘어간다(현재 동작 유지). 전부 실패해도 `end` 는 나간다.

### 3-6. API

```
POST   /api/jobs
       { kind: "solve"|"variant", node_id,
         problem_numbers?: number[]|null,     # solve. null = 전체
         no?: number, modes?: VariantMode[],  # variant
         provider, model?, effort? }
    -> { job_id, status, position }           # position = 큐에서 앞에 있는 작업 수

GET    /api/jobs            -> { jobs: [ {id, kind, node_id, node_name, status,
                                          total, done_count, current_no, created_at} ] }
       # 진행 중(queued/running) 전부 + 최근 종료 10건

GET    /api/jobs/{id}/events -> text/event-stream (재접속 가능, snapshot 선행)
DELETE /api/jobs/{id}        -> { ok: true }   # queued 면 큐에서 제거, running 이면 취소
```

**기존 `POST /api/files/{id}/solve` 와 `.../variant` 는 제거한다.** 두 경로를 함께 두면
"어떤 것은 화면을 떠나면 죽는다" 가 남아 버그로 되돌아온다. 프론트를 전부 전환한다.

**채팅(`/chat`)은 그대로 둔다.** 사용자가 답을 기다리는 대화이고, 큐에 넣으면 오히려 나빠진다.

`_AUTH_EXEMPT` 나 `_is_binary_asset` 은 건드릴 필요가 없다(전부 헤더 인증 경로).

### 3-7. 중복 요청 처리

같은 (node_id, 문항)에 대한 작업이 이미 `queued`/`running` 이면 새 작업을 만들지 않고
기존 `job_id` 를 돌려준다(`status: "existing"`). 사용자가 버튼을 두 번 눌러 쿼터를 두 배로
쓰는 일을 막는다.

이미 풀린 문항을 건너뛰는 기존 규칙(`force` 가 아니면 `status==='done'` 제외)은
**서버 쪽 job 생성 시점으로 옮긴다.** 지금은 프론트(`workspace.ts:1380`)에 있는데,
그러면 잡을 만든 클라이언트가 아닌 다른 창에서는 규칙이 적용되지 않는다.

### 3-8. 프론트

**전역 진행 배너** — `Workspace.tsx` 상단, 좌/중/우 패널 위에 걸친다.

```
┌──────────────────────────────────────────────────────────────┐
│ ⏳ 풍문고 중간고사 · 3/22번 풀이 중        [보기] [취소]        │
│    대기 1건: 2학기 기말 · 변형 5번                             │
└──────────────────────────────────────────────────────────────┘
```

- 진행 중 작업이 없으면 배너 자체가 없다.
- [보기] 는 그 시험지를 연다. [취소] 는 `DELETE /api/jobs/{id}`.
- 여러 작업이 있으면 실행 중 1건을 크게, 나머지는 `대기 N건` 으로 접어 보여준다.
- 완료 시 토스트: `풍문고 중간고사 22문항 풀이가 끝났습니다.` [보기]

**스토어 구조 변경**

```ts
jobs: JobSummary[]            // 서버 목록 (폴링 아님 — 아래 참고)
jobStreams: Map<jobId, AbortController>
```

- 앱이 뜨면 `GET /api/jobs` 로 진행 중 작업을 받아 **각각 `events` 를 구독**한다.
  새로고침해도 배너와 타이핑이 되살아난다.
- `startSolve` / `solveProblem` / `generateVariant` 는 `POST /api/jobs` 를 부르고
  반환된 `job_id` 를 구독한다. 셋 다 같은 경로를 쓴다.
- `selectFile()` 의 `abortSolve()` 호출을 **제거**한다. 스트림 루프의
  `selectedFileId !== selectedFileId` `break` 도 제거한다.
- 대신 이벤트를 받을 때 "그 파일이 지금 열려 있으면 화면 상태도 갱신, 아니면 배너만 갱신"
  으로 가른다. `done` 이벤트는 열려 있지 않아도 무시해도 된다(DB 에 저장되어 있고, 그 파일을
  열 때 `getSolutions` 로 받는다).
- `abortSolve` 는 `cancelJob(jobId)` 로 대체한다.

폴링은 하지 않는다. 목록은 앱 시작 시 1회 + 작업 생성/종료 때 갱신한다.

## 4. 건드리는 파일

| 파일 | 변경 |
|---|---|
| `core/jobs.py` (신규) | JobRunner, LiveJob, 구독/발행, 워커 루프 |
| `core/storage.py` | `jobs` 테이블, 시작 시 `interrupted` 정리, CRUD |
| `core/ai_service.py` | `solve_stream`/`variant_stream` 을 "이벤트 콜백" 형태로 조정 |
| `core/main.py` | `lifespan` 에 워커 기동/정리, `/api/jobs` 4개 라우트, 기존 solve·variant 라우트 제거 |
| `core/schemas.py` | `JobRequest`, `JobSummary`, `JobsResponse` |
| `core/README.md` | **uvicorn 워커 1개** 제약 명시 |
| `web/src/lib/api-client.ts` · `api.ts` · `mock/client.ts` | jobs API |
| `web/src/store/workspace.ts` | 잡 기반으로 전환, `abortSolve` → `cancelJob` |
| `web/src/components/JobBanner.tsx` (신규) | 전역 배너 |
| `web/src/components/Workspace.tsx` | 배너 배치, 앱 시작 시 작업 복구 |
| k8s helm values (별도 레포) | replicas 1, 워커 1 확인 |

## 5. 테스트 (완료 기준)

**백엔드**
1. `POST /api/jobs` 가 즉시 `job_id` 를 주고 응답이 **1초 내** 끝난다(스트림을 기다리지 않는다)
2. 구독자가 하나도 없어도 작업이 끝까지 돌고 `solutions` 에 저장된다 ← **이 스펙의 핵심**
3. `events` 에 늦게 붙으면 `snapshot` 이 먼저 오고 `done_count`·`partial_text` 가 실제 진행과 맞다
4. 구독을 끊었다가 다시 붙어도 작업이 계속된다
5. 작업 2개를 넣으면 **순차** 실행된다(두 번째는 첫 번째가 끝난 뒤 시작)
6. `DELETE /api/jobs/{id}` — queued 는 큐에서 사라지고, running 은 현재 문항 뒤 멈추며 `canceled`
7. 같은 문항 중복 요청은 새 job 을 만들지 않고 기존 id 를 준다
8. 이미 풀린 문항은 job 대상에서 빠진다(`force` 면 포함)
9. 앱 재시작 시 `running` 행이 `interrupted` 가 된다
10. 한 문항이 실패해도 다음 문항이 실행되고 `end` 가 나온다

**프론트**
11. 풀이 중 다른 시험지로 이동해도 스트림이 끊기지 않고 배너가 유지된다 ← **회귀 방지 핵심**
12. 새로고침 후 `GET /api/jobs` 로 진행 중 작업을 복구해 배너가 다시 뜬다
13. 배너 [취소] 가 `DELETE /api/jobs/{id}` 를 부른다
14. 열려 있지 않은 파일의 `done` 이벤트는 화면 상태를 건드리지 않는다
15. 작업 완료 토스트가 뜬다

**수동 확인**: 전체 풀이를 걸고 브라우저 탭을 닫았다가 1분 뒤 다시 열어, 그 사이 문항이
더 풀려 있는지 본다. 자동 테스트로는 브라우저 종료를 재현하기 어렵다.

## 6. 위험과 대응

| 위험 | 대응 |
|---|---|
| uvicorn 워커 다중화 시 큐가 깨진다 | README·차트에 워커 1개 명시. 다중화가 필요해지면 큐를 DB 폴링 기반으로 바꿔야 한다 |
| k8s 재배포로 Pod 이 죽으면 작업 중단 | `interrupted` 로 표시 + [이어서 풀기]. 이미 저장된 문항은 건너뛴다 |
| 기존 solve 라우트 제거로 되돌리기 어려움 | 프론트·백엔드를 한 커밋으로 함께 바꾼다. 배포 순서를 지켜야 한다(백엔드 먼저) |
| 작업이 무한정 쌓임 | 개인용 규모라 상한을 두지 않는다. 배너에 대기 건수를 보여 사용자가 판단하게 한다 |

## 7. 하지 않는 것 (범위 밖)

- 재개(resume) — 중단된 작업을 자동으로 이어서 하지 않는다.
- 우선순위 큐 / 동시 실행 — 쿼터 보호와 캐시 히트가 우선이다.
- 여러 서버 인스턴스 지원 — 단일 Pod 전제다.
- 채팅의 백그라운드화 — 대화는 즉답이어야 한다.
- 브라우저 푸시 알림 — 앱 안 배너와 토스트로 충분하다.
