# 문서 내보내기 확장 (변형 저장 + DOCX/HWPX) — 설계

작성일: 2026-08-09
범위: 백엔드 중심 + 프론트 버튼. 요청 3번·4번을 하나로 묶은 스펙이다.

## 1. 목적

변형 문항과 오답노트를 한글에서 열 수 있는 파일로 저장한다.
변형은 지금 저장조차 되지 않으므로 저장부터 만든다.

내보내는 것은 세 가지, 형식은 두 가지, 구성은 두 가지다.

| 대상 | 문제만 | 문제 + 해설 |
|---|---|---|
| 시험지 | 크롭 이미지 | 크롭 이미지 + 풀이 |
| 변형 | 변형 `## 문제` | 변형 `## 문제` + `## 정답` + `## 풀이` |
| 오답노트 | 스냅샷 크롭 이미지 | 스냅샷 크롭 + 원본 문항 풀이(있을 때) |

× `.docx` / `.hwpx`

## 2. 현재 상태 (확인된 사실)

- `docx_export.py` 는 63줄, `build_problems_docx(title, images)` 하나뿐. 크롭 이미지만 넣는다.
- `service.problems_docx(node_id)` (`service.py:416`) 가 문항을 모아 위 함수를 부른다.
- 라우트는 `GET /api/files/{id}/export.docx` (`main.py:464`) 하나.
- `_is_binary_asset` (`main.py:165`) 이 `path.endswith("/export.docx")` 로 `?access=` 인증을
  허용한다. **`.hwpx` 와 새 경로를 추가하지 않으면 배포 환경에서 401 이 난다.**
- **변형은 저장되지 않는다.** `main.py:532` 주석 "v1 은 저장하지 않는다". 프론트 스토어
  `variants[`${fileId}::${no}`][mode]` 에만 있다.
- 변형 출력 형식은 `## 문제 / ## 정답 / ## 풀이` (`prompts.py:247-255`),
  풀이는 `## 문제 확인 / ## 풀이 / ## 정답` (`prompts.py:95-106`). 둘 다 고정 형식이다.
- LaTeX 평문 변환기 `to-plain-text.ts` 는 **TypeScript 로만** 있다.
- `python-hwpx` 6.0.2 로 이미지 포함 HWPX 생성이 실제로 되는 것을 확인했다:
  `HwpxDocument.new()` → `add_paragraph` / `add_picture(bytes, 'png', width_mm=)` → `to_bytes()`.
  결과물은 `mimetype = application/hwp+zip`, 이미지는 `BinData/BIN0001.png` 로 들어간다.
  한컴 오피스 설치가 필요 없다.
- `SCHEMA_VERSION = 2` (`storage.py:32`). 마이그레이션은 `CREATE TABLE IF NOT EXISTS` 와
  `ALTER TABLE ADD COLUMN` 만 쓰는 규칙이다(drop/recreate 금지).

## 3. 설계

### 3-1. 변형 저장

```sql
-- 변형 문항. (시험지, 문항, 변형유형) 당 최신 1건.
variants(node_id TEXT, no INTEGER, mode TEXT, text TEXT,
         usage_json TEXT, cost_json TEXT, created_at TEXT,
         PRIMARY KEY(node_id, no, mode))
```

- `mode` 는 기존 `VariantMode` (`number` / `condition` / `number_condition`).
- "다시 생성" 은 같은 키를 **덮어쓴다**(upsert). 이력은 남기지 않는다 — 선생님이 원하는 건
  최신 변형 한 벌이고, 이력을 쌓으면 어느 것을 내보낼지 골라야 하는 문제가 생긴다.
- `SCHEMA_VERSION` 을 올리고 `CREATE TABLE IF NOT EXISTS` 로 추가한다.
  (서버 작업 큐 스펙도 버전을 올리므로 **먼저 머지되는 쪽이 3, 나중이 4** 를 쓴다.)
- 노드 삭제 시 함께 지운다(`solutions` 와 같은 자리에서 처리).

**저장 시점**: `ai_service.variant_stream` 이 `done` 을 낼 때 `solutions` 와 같은 방식으로 저장한다.

**조회 API 추가**:
```
GET /api/files/{id}/variants            -> { variants: [{no, mode, text, usage, cost, created_at}] }
```
프론트는 시험지를 열 때 이걸 받아 `variants` 스토어를 채운다. 그러면 새로고침해도 남고,
이미 만든 변형을 다시 생성해 쿼터를 낭비하지 않는다.

`generateVariant` 의 캐시 판정(`workspace.ts:1656`)은 지금도 `status === 'done'` 이면 no-op
하므로, 서버 값으로 스토어를 채우면 그대로 동작한다.

### 3-2. LaTeX 평문화 — 파이썬 포팅

`to-plain-text.ts` 를 `core/to_plain_text.py` 로 포팅한다.

- 이유: 문서를 만드는 주체가 서버다. 서버가 `\(x^2\)` 를 그대로 넣으면 한글에서 깨진 채 보인다.
- 포팅 대상은 `SUPERSCRIPT` / `SUBSCRIPT` 표, `\frac`·`\sqrt` 등 명령 매핑, 매핑에 없는
  명령의 백슬래시/중괄호 제거 폴백까지 **동작이 같아야 한다**.
- `to-plain-text.test.ts` 의 케이스를 `tests/test_to_plain_text.py` 로 그대로 옮긴다.
  같은 입력에 같은 출력이 나오는 것이 완료 기준이다.
- 이 중복은 감수한다. 대안(프론트가 변환해 서버로 보내기)은 "시험지 전체 변형 내보내기"
  처럼 화면에 없는 데이터를 내보낼 때 성립하지 않는다.

**HWPX 수식은 v1 범위 밖.** `python-hwpx` 에 `shapes.add_equation(script)` 가 있지만 한글
수식 문법이고 LaTeX 와 호환되지 않는다. 평문 유니코드(`x²`)로 넣는다.

### 3-3. export 패키지 분리

`docx_export.py` 하나로는 형식 2 × 대상 3 을 감당하지 못한다. 공통 문서 모델을 두고 형식별
렌더러를 나눈다.

```
core/export/
  __init__.py     # build_docx / build_hwpx 만 공개
  model.py        # ExportDoc, Block (Heading | Image | Text)
  docx.py         # ExportDoc -> .docx 바이트 (기존 docx_export.py 이식)
  hwpx.py         # ExportDoc -> .hwpx 바이트 (python-hwpx)
  build.py        # 대상별 ExportDoc 조립 (시험지/변형/오답노트)
```

```python
# model.py — 형식에 독립적인 최소 표현
@dataclass(frozen=True)
class Heading:  text: str; level: int
@dataclass(frozen=True)
class Image:    path: Path
@dataclass(frozen=True)
class Text:     text: str          # 이미 평문화된 상태로 들어온다

Block = Heading | Image | Text

@dataclass(frozen=True)
class ExportDoc:
    title: str
    blocks: Sequence[Block]
```

- `docx.py` 는 기존 `_fit_width` 로직(150 DPI 기준, 최대 6인치)을 그대로 가져온다.
- `hwpx.py` 는 같은 계산을 mm 로 바꾼다(6 inch = 152.4 mm). 폭 상한도 동일하게 둔다.
- **평문화는 `build.py` 에서 끝낸다.** 렌더러는 이미 사람이 읽을 수 있는 문자열만 받는다.
  이렇게 해야 형식이 늘어도 변환 규칙이 한 곳에 남는다.
- 기존 `docx_export.py` 는 지운다. 지금 유일한 호출부인 `service.problems_docx` 를 새 경로로
  바꾸므로 남겨둘 이유가 없다.

### 3-4. 라우트

```
GET /api/files/{id}/export.docx          ?include=problems|full     # 기존 — 기본 problems 유지
GET /api/files/{id}/export.hwpx          ?include=problems|full
GET /api/files/{id}/variants/export.docx ?include=problems|full
GET /api/files/{id}/variants/export.hwpx ?include=problems|full
GET /api/notes/{id}/export.docx          ?include=problems|full
GET /api/notes/{id}/export.hwpx          ?include=problems|full
```

- `include` 기본값은 `problems`. 기존 `export.docx` 호출자가 그대로 동작한다(하위호환).
- 파일명: `<이름>_문제.docx` / `<이름>_문제와해설.docx`,
  변형은 `<이름>_변형문제.docx` / `<이름>_변형문제와해설.docx`.
  기존 `_attachment_disposition` (RFC5987) 을 그대로 쓴다.
- `_is_binary_asset` 을 고친다:
  ```python
  path.endswith("/raw") or path.endswith("/crop")
  or path.endswith("/export.docx") or path.endswith("/export.hwpx")
  ```
  `/variants/export.docx` 도 `endswith` 로 걸리므로 별도 분기가 필요 없다.
- 모두 `run_in_threadpool` 로 감싼다(기존 `export_file_docx` 와 동일 — 이미지 인코딩이 블로킹이다).

**빈 결과 처리**: 내보낼 것이 없으면 400 `no_problems` / `no_variants` / `no_items` 로
한국어 메시지와 힌트를 준다. 빈 문서를 내려주지 않는다.

### 3-5. 문서 구성 규칙

**시험지** (`include=full` 이 새로 추가되는 부분)
```
제목: <시험지명>
  1번          (Heading 2)
  [크롭 이미지]
  풀이          (Heading 3, include=full 일 때만)
  <풀이 평문>
```

**변형** — 원본 크롭은 넣지 않는다. 변형 문제만 깔끔하게 배포할 수 있어야 한다.
```
제목: <시험지명> 변형 문제
  1번 · 수치 변형     (Heading 2 — mode 라벨 병기)
  <## 문제 본문 평문>
  정답               (include=full 일 때만)
  <## 정답 본문>
  풀이               (include=full 일 때만)
  <## 풀이 본문>
```
한 문항에 여러 mode 가 저장돼 있으면 **모두** 넣는다(번호 → mode 순).

**오답노트**
```
제목: <노트명>
  <시험지명> 3번      (Heading 2 — 출처 병기)
  [스냅샷 크롭 이미지]
  메모: <memo>        (memo 가 있을 때만)
  풀이                (include=full 이고 원본이 살아 있고 저장 풀이가 있을 때만)
  <풀이 평문>
```
원본이 삭제된 항목(`source_node_id IS NULL`)도 스냅샷 크롭으로 넣는다. 풀이만 빠진다.

### 3-6. 마크다운 섹션 파서

`## 문제 / ## 정답 / ## 풀이` 를 나누는 함수가 필요하다. `core/markdown_sections.py`:

```python
def split_sections(text: str) -> dict[str, str]:
    """`## 제목` 기준으로 본문을 나눈다. 제목은 공백을 제거한 원문 그대로 키가 된다."""
```

- 형식이 어긋난 응답(섹션이 없음)에 대비해, 아무 섹션도 못 찾으면 **전체 텍스트를
  `문제` 로 취급**한다. 내보내기가 빈 문서가 되는 것보다 낫다.
- 풀이의 `## 문제 확인` 은 내보내기에 넣지 않는다(모델이 문제를 어떻게 읽었는지는 학생에게
  불필요하다).

### 3-7. 프론트

`DownloadDocxButton` 을 일반화한 `ExportButton` 으로 바꾼다.

```
[내보내기 ▾]
   문제만 · DOCX
   문제만 · HWPX
   문제+해설 · DOCX
   문제+해설 · HWPX
```

- 드롭다운 1개. 버튼 4개를 늘어놓지 않는다.
- `target: 'exam' | 'variants' | 'note'` 를 prop 으로 받아 URL 만 갈아끼운다.
- 다운로드 방식(fetch→blob→objectURL→`a[download]`)과 파일명 처리는 기존 것을 그대로 쓴다.
- 배치: 시험지 헤더(기존 자리, `target='exam'`), 시험지 헤더에 변형용 하나 더
  (`target='variants'`), `NoteView` 헤더(`target='note'`).

## 4. 건드리는 파일

| 파일 | 변경 |
|---|---|
| `core/storage.py` | `variants` 테이블, `SCHEMA_VERSION` 3, upsert/조회 함수, 삭제 연쇄 |
| `core/ai_service.py` | 변형 `done` 시 저장 |
| `core/export/` (신규 5개) | 공통 모델 + docx/hwpx 렌더러 + 조립 |
| `core/docx_export.py` | **삭제** (export/docx.py 로 이식) |
| `core/to_plain_text.py` (신규) | TS 포팅 |
| `core/markdown_sections.py` (신규) | `## ` 섹션 분리 |
| `core/service.py` | `problems_docx` → 대상 3종 × 형식 2종 진입점 |
| `core/main.py` | 라우트 5개 추가 + 기존 1개에 `include`, `_is_binary_asset` 수정, `GET .../variants` |
| `core/requirements.txt` · `pyproject.toml` | `python-hwpx` 추가 |
| `web/src/lib/api-client.ts` · `api.ts` · `mock/client.ts` | 내보내기 함수 일반화, `getVariants` |
| `web/src/components/center/DownloadDocxButton.tsx` | → `ExportButton.tsx` 로 대체 |
| `web/src/components/center/CenterPanel.tsx` · `NoteView.tsx` | 버튼 배치 |
| `web/src/store/workspace.ts` | 시험지 열 때 저장 변형 로드 |

## 5. 테스트 (완료 기준)

**백엔드** (`pytest`, 기존 `tests/` 규칙)
1. `test_to_plain_text.py` — TS 테스트 케이스 이식분이 **전부** 같은 출력
2. `test_markdown_sections.py` — 정상 3섹션 분리 / 섹션 없는 입력은 전체가 `문제`
3. `test_variant.py` 확장 — 변형 `done` 후 DB 에 저장된다, 같은 (node,no,mode) 재생성은 덮어쓴다
4. `test_migration.py` 확장 — v2 DB 를 열면 `variants` 가 생기고 기존 데이터가 남는다
5. `test_export_docx.py` 확장 → `test_export.py`
   - 6개 라우트가 200 과 올바른 media type 을 준다
   - `.docx` 는 `PK` 시그니처, `.hwpx` 는 ZIP 안에 `mimetype == application/hwp+zip`
   - `.hwpx` 안에 `BinData/` 이미지가 문항 수만큼 있다
   - `include=full` 이 `include=problems` 보다 크다(풀이가 실제로 들어갔다)
   - 문항/변형/항목이 없으면 400 과 한국어 메시지
   - Content-Disposition 의 한글 파일명이 RFC5987 로 인코딩된다
6. `test_auth.py` 확장 — 접속 비밀번호가 설정된 상태에서 `?access=` 로 `.hwpx` 가 200
   (미들웨어 수정 회귀 방지)

**프론트** (`vitest`)
7. `ExportButton` — 4개 항목이 각각 올바른 URL(`target`/확장자/`include`)로 호출한다
8. 실패 시 토스트가 뜨고 버튼이 다시 활성화된다
9. 시험지를 열면 `getVariants` 결과가 스토어 `variants` 에 채워진다
10. 저장된 변형이 있는 문항은 `generateVariant` 가 재호출되지 않는다(쿼터 낭비 방지)

**수동 확인 (사람이 해야 함)**: 생성된 `.hwpx` 를 실제 한글에서 열어 이미지와 한글이 정상인지
본다. 자동 테스트는 파일 구조만 검증할 수 있다.

## 6. 하지 않는 것 (범위 밖)

- HWPX 수식 객체(`add_equation`) — LaTeX↔한글수식 변환기가 필요하다. 별도 과제다.
- `.hwp`(v5 바이너리) — `python-hwpx` 가 지원하지 않는다. 한글에서 hwpx 를 열어 저장하면 된다.
- 변형 이력 보관 — 최신 1건만 둔다.
- 문서 서식(글꼴·여백·머리말) 지정 — 기본 서식으로 낸다.
- 오답노트 내보내기에 변형 포함 — 오답노트는 원본 문제 중심이다. 변형은 변형 내보내기로 낸다.
