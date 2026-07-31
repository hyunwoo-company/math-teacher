# app/core — 공용 백엔드 (FastAPI, Python 3.12)

시험지 PDF 를 폴더/파일로 정리하고, 문항을 코드로 분리한 뒤(AI 호출 0회),
AI 로 풀이·채팅을 스트리밍한다. API 계약은 프로젝트 루트 `ARCHITECTURE.md` 가 단일 소스다.

## 실행

```bash
cd app/core
pip install -r requirements.txt
uvicorn main:app --port 8100
```

- 기동 시 `data/` 와 `data/app.db` 스키마를 자동으로 만들고 **마이그레이션**을 적용한다.
  (`storage.migrate` — `ALTER TABLE ADD COLUMN` / `CREATE ... IF NOT EXISTS` 만 쓰는
  비파괴·멱등 방식이다. 기존 `app.db` 를 drop 하지 않는다.)
- 헬스체크: `GET /api/health` → `{"ok": true}`

### 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `MATH_TEACHER_MODE` | `desktop` | `web` 으로 두면 구독 모드를 끈다(서버는 사용자 PC 인증에 접근 불가). |
| `MATH_TEACHER_DATA_DIR` | `app/core/data` | 데이터 루트(`app.db`, `files/`, `crops/`, `note_crops/`, `settings.json`). |
| `MATH_TEACHER_DISABLE_SUBSCRIPTION` | 없음 | `1` 이면 구독 모드를 강제 비활성화(`/api/env` 의 `subscription.reason == "disabled"`). |
| `ANTHROPIC_API_KEY` | 없음 | 저장된 키가 없을 때 대체로 읽는다. |

## 섹션 / 오답노트 / 문항별 스레드

- 트리는 `section` 으로 갈린다: `exam`(시험지) / `note`(오답노트).
  `GET /api/tree` 는 `section` 을 생략하면 기존 호환을 위해 `exam` 을 돌려준다.
  **섹션을 넘나드는 이동/생성은 400 `section_mismatch`.**
- 오답노트 항목은 추가 시점의 시험지 이름과 크롭 PNG 를 `data/note_crops/{item_id}.png`
  로 **스냅샷 복사**한다. 그래서 원본 시험지를 지워도 항목이 남는다
  (`source_node_id` 만 NULL → `source_available: false`, 바로가기만 비활성).
  반대로 **노트(또는 노트 폴더)를 지우면** 그 안의 항목과 스냅샷은 삭제된다.
- 채팅은 `(node_id, problem_no)` 단위 스레드다. `problem_no` 가 NULL 이면 시험지 전역.
  이력은 최근 `config.CHAT_HISTORY_LIMIT` 개만 모델에 보낸다 — **요약(compaction)이
  아니라 truncation** 이므로, 잘리면 SSE `done` 에 `history_truncated: true` /
  `truncated_before: N` 을, `GET .../chat` 응답에 `truncated_before` 를 실어 알린다.

## 모듈 구성

| 파일 | 역할 |
|---|---|
| `main.py` | 라우트(얇게). 검증·조립은 서비스에 위임. |
| `service.py` | 트리 CRUD, 업로드/추출, 크롭/원본 경로. 전부 블로킹. |
| `ai_service.py` | 프로바이더 선택, 풀이/채팅 SSE 생성. |
| `storage.py` | SQLite (스키마는 ARCHITECTURE 7항). |
| `extractor.py` | `service/extractor.py` 이식본. **로직 변경 금지**(22문항 분할 검증됨). |
| `pricing.py` | `service/pricing.py` 이식본. 단가표 + 실측 비용 계산. |
| `prompts.py` | 풀이/채팅 system 프롬프트. |
| `providers/` | `base.py`(추상) / `subscription.py`(Claude Code) / `apikey.py`(anthropic SDK). |
| `errors.py` | `{error_code, message, hint}` 한국어 에러 통일. |

블로킹 함수(`service.*`, `storage.*`)를 `async def` 안에서 부를 때는 반드시
`run_in_threadpool` 로 감싼다. `async def` 안에서 직접 호출 금지.

## 프로바이더

- **구독 모드**(기본, 데스크톱 전용): `claude-agent-sdk` 가 Claude Code CLI 를 띄워
  로그인 프로필 인증을 그대로 쓴다. API 키를 넘기지 않으며, 자식 프로세스의
  `ANTHROPIC_API_KEY` 를 빈 값으로 덮어 API 과금으로 새는 것을 막는다.
  추가 과금이 없으므로 **`cost` 는 항상 `null`**, 토큰(`usage`)만 실측으로 채운다.
- **API 키 모드**: `anthropic` SDK. `temperature`/`top_p`/`top_k` 를 넣지 않고,
  `thinking={"type":"adaptive"}` + `output_config={"effort": ...}` 만 쓴다.
  system 프롬프트에 `cache_control: ephemeral` 를 걸어 문항별 호출에서 캐시를 노린다.
- `provider: "auto"` 는 구독 → API 키 순서. 둘 다 없으면 409 `no_provider`.

### ⚠️ API 키는 평문으로 저장된다

`POST /api/settings/apikey` 로 저장한 키는 `app/core/data/settings.json` 에
**암호화 없이 평문**으로 기록된다(데스크톱 단일 사용자 가정).

- `data/` 디렉터리를 공유 폴더·백업·git 에 올리지 말 것 (`.gitignore` 에 포함되어 있다).
- 여러 사람이 쓰는 PC 라면 키를 저장하지 말고 요청 헤더 `X-Api-Key` 로 그때그때 전달할 것.
- 웹 배포(`MATH_TEACHER_MODE=web`)에서는 서버에 키를 저장하지 말고 항상 헤더로 받을 것.
- 키가 노출되었다면 Anthropic 콘솔에서 즉시 폐기(rotate)할 것.

## 개발

```bash
cd app/core
ruff check .          # 린트
mypy .                # 타입체크 (strict)
python -m pytest      # 테스트 (AI 호출은 스텁, 실제 PDF 로 추출 검증)
```

테스트는 `MATH_TEACHER_DATA_DIR` 대신 `config.use_data_dir()` 로 임시 폴더에 격리된다.
