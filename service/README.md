# 시험지 PDF → 문제 추출 + AI 풀이 비용 실측

시험지 PDF를 올리면 **문제 분리는 코드로(비용 0원)**, **풀이만 AI로** 처리하고
Anthropic API 응답의 `usage` 실측값으로 토큰과 비용을 표시하는 로컬 테스트 서비스입니다.

비용은 추정하지 않습니다. 화면에 뜨는 토큰 수는 전부 `response.usage` 원본값입니다.

---

## 설치와 실행

```bat
cd service
pip install -r requirements.txt

REM Windows CMD
set ANTHROPIC_API_KEY=sk-ant-...

uvicorn main:app --reload
```

PowerShell이면 키 설정만 다릅니다.

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
uvicorn main:app --reload
```

브라우저에서 <http://127.0.0.1:8000> 을 엽니다.

> API 키가 없어도 **추출 기능은 그대로 동작합니다.** 키 없이 `/api/solve` 를 부르면
> 500이 아니라 400 + 안내 메시지(JSON)가 돌아옵니다.

### AI 호출 없이 분할 품질만 먼저 확인하기

```bat
python extractor.py "..\[2026-1-1-M][공수1][풍문고].pdf" --outdir tmp_crops
```

문항별 번호/페이지/bbox/크롭 크기를 콘솔에 출력하고 `tmp_crops/` 에 PNG를 저장합니다.
AI를 전혀 부르지 않으므로 몇 번을 돌려도 비용이 0원입니다.

주요 옵션: `--dpi 150` `--pua-threshold 0.02` `--mode auto|text|image`
`--no-images`(분할만) `--json`(JSON 요약 추가 출력)

### 테스트

```bat
python -m pytest test_service.py -v
```

실제 API는 호출하지 않습니다. 공식 SDK를 로컬 스텁 서버에 물려서
**SDK가 실제로 만들어 보내는 요청 본문**을 검사합니다.

---

## 비용 절감 원리

### 1. 추출을 AI에게 시키지 않는다 — 가장 큰 절감

PDF 전체를 페이지 이미지로 AI에 던져 "문제를 나눠줘"라고 시키면 페이지마다 수천 토큰이
듭니다. 이 서비스는 PyMuPDF로 좌표를 직접 읽어 문제를 나눕니다. **이 단계의 API 비용은 0원**입니다.

- `page.get_text("dict")` 로 라인/스팬의 좌표를 얻습니다.
- 문제 번호(`^\s*(\d{1,2})\s*\.`)를 앵커로 삼습니다. 수식이 깨지는 시험지에서도
  **문제 번호만은 별도 폰트라 ASCII로 정상 추출**되는 점을 이용합니다.
- 2단 조판은 페이지 가로 중앙을 기준으로 좌/우 칼럼을 나눠 `좌측 위→아래 → 우측 위→아래`
  순서로 읽습니다.
- 본문 위/아래의 가로 괘선을 찾아 머리말·꼬리말(페이지 번호 등)을 제외합니다.
- 번호가 오름차순이 되도록 오탐 앵커를 버립니다(최장 증가 부분수열).

### 2. 텍스트가 멀쩡하면 이미지를 안 보낸다 — PUA 비율 자동 판정

한글 워드프로세서 수식편집기(`HyhwpEQ` 계열) 폰트는 ToUnicode를 **사설영역(PUA,
U+E000~U+F8FF)** 으로 매핑합니다. 그래서 한글 본문은 정상 추출되는데 수식만
`` 같은 코드로 깨져 나옵니다. 이런 텍스트를 AI에 보내면 답이 틀립니다.

전체 추출 텍스트의 PUA 문자 비율을 계산해 모드를 자동으로 정합니다.

| PUA 비율 | 모드 | 전송 내용 | 비용 |
|---|---|---|---|
| 임계값(기본 0.02) 미만 | `text` | 문제 텍스트만 | 가장 저렴 |
| 임계값 이상 | `image` | 문제별 크롭 PNG | 텍스트보다 비쌈 |

동봉된 샘플 시험지는 PUA 비율이 **0.3896** 이라 자동으로 `image` 모드가 됩니다.

### 3. 이미지를 보내야 한다면 최대한 작게

시험지는 여백이 매우 많습니다. 문제 영역만 크롭한 뒤 픽셀을 훑어 흰 여백을 잘라냅니다
(상하좌우 전부, 6px 패딩). Anthropic 이미지 토큰은 대략 `가로 × 세로 / 750` 이므로
높이를 줄이면 그대로 비용이 줄어듭니다.

실제 효과 (샘플 시험지, 150dpi):

| 문항 | 트림 전 | 트림 후 | 이미지 토큰(추정) |
|---|---|---|---|
| 20번 | 516×705 | 516×171 | 약 485 → 118 |
| 22번 | 567×1451 | 540×232 | 약 1097 → 167 |

페이지 통째로(595×841pt → 1240×1752px) 보내는 것과 비교하면 문항당 입력 토큰이
한 자릿수 %까지 내려갑니다.

### 4. 프롬프트 캐싱

system 프롬프트(수학 교사 역할 + 출력 형식 지시)에 `cache_control: {"type": "ephemeral"}`
를 겁니다(5분 TTL). 문제마다 개별 호출이므로 **2번째 문항부터 `cache_read_input_tokens`
가 잡혀야 정상**입니다.

- 캐시 write 단가는 input의 **1.25배**, read 단가는 input의 **0.10배**입니다.
- 즉 2문항 이상 풀면 system 프롬프트 부분이 사실상 1/10 가격이 됩니다.
- 캐시 히트를 만들려면 **순차 호출**이어야 합니다. 병렬로 쏘면 전부 미스가 날 수 있어
  서버는 선택 문항을 순서대로 처리합니다.

> **주의**: 프롬프트 캐싱은 최소 토큰 수(모델에 따라 1024~2048 토큰)를 넘는 프리픽스에만
> 적용됩니다. `solver.SYSTEM_PROMPT` 가 길게 작성된 이유가 그것입니다(약 2,400자).
> 프롬프트를 줄이면 캐시가 아예 안 걸려 `cache_read` 가 0으로 나올 수 있습니다.
> Haiku 계열은 최소 토큰이 더 클 수 있어 캐시가 안 잡힐 수 있습니다.

---

## 단가표

> **주의: 아래 단가는 2026-06 기준으로 `pricing.py` 에 하드코딩한 값입니다.**
> Anthropic 단가는 예고 없이 바뀔 수 있습니다. 실제 정산에 쓰기 전에 반드시
> <https://platform.claude.com/docs/en/pricing> 에서 최신 값을 확인하세요.

USD per 1M tokens:

| 모델 | input | output | cache write (×1.25) | cache read (×0.10) |
|---|---|---|---|---|
| `claude-opus-5` | 5.00 | 25.00 | 6.25 | 0.50 |
| `claude-sonnet-5` | 3.00 | 15.00 | 3.75 | 0.30 |
| `claude-haiku-4-5` | 1.00 | 5.00 | 1.25 | 0.10 |

**환율은 상수입니다.** `pricing.USD_KRW = 1400` 으로 고정되어 있고 실시간 조회를 하지
않습니다. 원화 표시는 감을 잡기 위한 근사치이며 정산 근거로 쓰면 안 됩니다.

---

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/` | 단일 페이지 UI |
| GET | `/api/health` | 서버 상태, API 키 설정 여부 |
| POST | `/api/extract` | multipart PDF 업로드 → 문제 분리. **AI 호출 없음, 비용 0원** |
| POST | `/api/solve` | 선택한 문항만 AI로 풀이 |

`/api/extract` 응답에는 문제 목록(크롭 이미지 base64 포함), PUA 비율, 선택된 모드와
그 이유, `ai_calls: 0`, `cost.total_usd: 0.0` 이 담깁니다.

`/api/solve` 요청 본문:

```json
{
  "job_id": "0584ee762d50",
  "problem_numbers": [1, 2, 3],
  "model": "claude-opus-5",
  "effort": "medium",
  "max_tokens": 8000
}
```

응답에는 문항별 `usage`(SDK 원본), `cost`(항목별 breakdown + USD/KRW), 풀이 텍스트와
전체 합계·전체 문항 환산 예상비용이 담깁니다.

업로드와 추출 결과는 메모리 `dict`(`JOBS`)에만 보관합니다. **서버를 재시작하면 사라지므로**
`job_id` 가 404가 나면 PDF를 다시 올리면 됩니다.

### 에러 응답 형식

```json
{ "detail": { "error_code": "missing_api_key", "message": "...", "hint": "..." } }
```

| error_code | HTTP | 상황 |
|---|---|---|
| `missing_api_key` | 400 | `ANTHROPIC_API_KEY` 미설정 |
| `unknown_model` | 400 | 단가 테이블에 없는 모델 |
| `problem_not_found` | 400 | 해당 job에 없는 문항 번호 |
| `not_a_pdf` / `empty_file` / `file_too_large` | 400 | 업로드 검증 실패 |
| `no_problems_found` | 400 | 문제 번호 앵커를 못 찾음 |
| `job_not_found` | 404 | 없는 `job_id` |

---

## 모델 파라미터 제약 (중요)

`solver.py` 는 다음을 지킵니다. 어기면 400이 납니다.

- `temperature` / `top_p` / `top_k` 를 **보내지 않습니다.** Opus 5 / Sonnet 5에서 400입니다.
- `thinking` 은 `{"type": "adaptive"}` 만 씁니다. `budget_tokens` 를 넣으면 400입니다.
- 사고 강도는 `output_config={"effort": "low|medium|high|xhigh|max"}` 로 조절합니다.
  기본값은 비용 테스트가 목적이므로 `medium` 입니다.

`stop_reason` 이 `refusal` 이면 content를 읽기 전에 분기하고, `max_tokens` 면 잘렸다고
표시합니다. 두 경우 모두 usage는 실측 그대로 보존합니다.

---

## 파일 구성

```
service/
├─ extractor.py      PDF → 문제 분리 (AI 없음). 단독 CLI 실행 가능
├─ pricing.py        단가 테이블 + 실측 usage 기반 비용 계산
├─ solver.py         Anthropic 공식 SDK 호출, usage 원본 보존
├─ main.py           FastAPI 엔드포인트
├─ test_service.py   pytest (실제 API 호출 없음)
├─ static/index.html 단일 페이지 UI (바닐라 JS, MathJax CDN)
├─ requirements.txt
├─ .env.example
└─ tmp_crops/        CLI 크롭 PNG 출력 (gitignore)
```

수식은 MathJax 3으로 렌더링합니다. 시스템 프롬프트가 `\( \)` / `\[ \]` 구분자만 쓰도록
지시하고, 프런트엔드 MathJax 설정도 그 구분자에 맞춰져 있습니다.
