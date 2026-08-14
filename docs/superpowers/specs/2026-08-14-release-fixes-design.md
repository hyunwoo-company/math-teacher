# 출시 전 개선 8건 — 설계

작성일: 2026-08-14
범위: 백엔드(`app/core`) + 프론트엔드(`app/web`). 두 벌 모두 변경.

## 1. 목적

출시를 앞두고 사용 중 나온 요청 8건을 처리한다. 성격이 셋으로 갈린다.

- **신규 기능**: 변형 일괄 생성(1·2), 출처 표시(3), 트리 다중 이동(8)
- **버그**: 오답노트 항목 잔존(6), docx 페이지 폭증·수식 깨짐(7)
- **문구·프롬프트**: 검산 출력 제외(4), 답안지 업로드 안내(5)

## 2. 현재 상태 (코드로 확인한 사실)

| 위치 | 확인된 동작 |
|---|---|
| `prompts.py:274-289` `_VARIANT_KIND_GUIDE` | 변형 3종(`number`/`condition`/`number_condition`) **이미 존재** |
| `schemas.py:246-256` `JobCreate` | `kind="variant"` 는 `no`(단일) + `modes[]`. **문항은 1개만** |
| `main.py:698-730` | 변형 작업은 `plan_variant_job(node_id, no)` 로 문항 1개를 잡고 `total=len(kinds)` |
| `VariantPanel.tsx:71-74` | 탭을 열면 `useEffect` 가 그 유형을 **자동 생성**. 유형 선택 개념이 없다 |
| `SolutionsTab.tsx:221-229` | 담기 모드 체크박스가 이미 있다. 변형용 선택은 없다 |
| `export/model.py:47-57` `ExportDoc` | `title` + `blocks` 뿐. 출처/꼬리말 필드 없음 |
| `ExportButton.tsx:26-31` | 드롭다운 4항목(형식 × 구성). 입력란 없음 |
| `prompts.py:45-48` | 검산을 **"## 풀이" 마지막 단계**로 강제. 별도 섹션이 아니라 지금 구조로는 분리 불가 |
| `FileTreePanel.tsx:205-208` | 드롭 처리가 `getData(NODE_MIME)` **문자열 1개**. 다중 이동 불가 |
| `service.py:158-175` | 이동 시 순환 참조 방지(`cycle_detected`) **이미 구현됨** |
| `workspace.ts:1902` `startNotePicking` | `set({ notePicking: true })` — **`notePicked` 를 비우지 않는다** |
| `docx.py:59-68` | `add_heading` + 줄마다 `add_paragraph`. 스타일·폰트 미지정 |

### 2-1. 7번 원인 (실측 확정)

테스트 파일 `tmp/[2026-1-1-M][공수1][개포고]_문제와해설.{docx,hwpx}` 를 열어 측정했다.

```
                        docx        hwpx
문단 수                 1141        1374
이미지 수                 22          22   (동일 PNG, 동일 바이트)
이미지 폭              2.3~3.4in    동일
보고된 페이지 수          74p         14p
```

이미지도 문단 수도 원인이 아니다. `word/styles.xml` 의 `docDefaults`:

```xml
<w:pPrDefault><w:pPr>
  <w:spacing w:after="200" w:line="276" w:lineRule="auto"/>
</w:pPr></w:pPrDefault>
```

`after="200"` = 문단마다 뒤 여백 10pt, `line="276"` = 줄간격 1.15배. 평문을 `\n` 단위로
문단 1141개로 쪼개므로 문단당 약 0.31인치를 먹는다. hwpx 는 기본 문단에 여백이 없어
문단이 더 많은데도 14페이지다. **줄 수가 아니라 문단 여백이 5배를 만들었다.**

수식 깨짐은 폰트다. `docDefaults` 의 `rFonts asciiTheme="minorHAnsi"` = Calibri 인데,
본문에 실제로 쓰인 비ASCII 문자를 세면 Calibri 에 글리프가 없는 것이 다수다.

```
²(564) √(132) •(118) α(112) β(106) ³(81) ×(62) ⇒(57) ≤(33)
₂(30) ₁(29) ✔(21) ⁻(19) ᵐ(18) ⁿ(18) ∘(14) ∠(8) ⋯(2) ≡(2) ㉠(1)
```

위첨자(`ᵐ ⁿ ᵏ ⁻ ⁽ ⁾`)·아래첨자(`₁ ₂ ₃ ₓ`)·`⇒ ∘ ∠ ⋯ ≡ ✔ ㉠` 이 대표적이다.
hwpx 는 한글 기본 폰트가 이들을 커버해 멀쩡하다.

### 2-2. 6번 원인 (유력 가설, 미확정)

`startNotePicking()` 이 `notePicked` 를 비우지 않는다. 담기 모달을 `[닫기]` 로 취소하면
`notePicking` 도 `notePicked` 도 살아남는다(`stopNotePicking` 만 비운다). 그 상태에서
다시 담으면 이전에 골랐던 문항이 함께 담긴다.

사용자 증언은 "다른 이름의 새 노트인데도 이전 문항이 있었다"이며 재현 절차는 불확실하다.
따라서 **재현 테스트를 먼저 쓰고**, 통과하지 않으면 원인을 다시 찾는다. 추측만으로
코드를 고치고 끝내지 않는다.

## 3. 설계

### 3-1. 변형 일괄 생성 (요청 1·2)

**백엔드** — `JobCreate` 의 variant 경로를 다중 문항으로 확장한다.

```python
# schemas.py
class JobCreate(BaseModel):
    kind: JobKind
    node_id: str
    problem_numbers: list[int] | None = None   # solve: null=전체 / variant: 대상 문항들
    no: int | None = None                      # variant 단일(하위호환, 유지)
    modes: list[VariantKind] | None = None
```

- `kind="variant"` 에서 `problem_numbers` 가 오면 그것을 쓰고, 없으면 기존 `no` 를 쓴다.
  **기존 단일 경로를 깨지 않는다**(`VariantPanel` 이 계속 쓴다).
- `targets = {"numbers": [...], "modes": [...]}`, `total = len(numbers) * len(modes)`.
- 작업은 (문항 × 유형) 순서로 순차 처리한다. agy 기준 flash ~18s/건이므로
  5문항 × 3유형 = 15건 ≈ 4.5분. 진행률은 기존 job 배너가 그대로 보여준다.
- `force=false` 면 이미 저장된 (문항, 유형)은 건너뛴다. 기존 solve 규칙과 같다.

**프론트** — `[풀이]` 탭 상단에 담기 모드와 같은 구조의 **변형 모드**를 추가한다.

```
┌──────────────────────────────────────────────┐
│ 풀이 완료 12/22    [변형 만들기] [오답노트에 담기]│
├──────────────────────────────────────────────┤   ← 변형 모드 진입 시
│ 변형 유형  (숫자)(조건)(숫자+조건)(전체)         │
│ 3개 문항 선택됨  [전체 선택][선택 해제]          │
│                    [ 변형 생성 ] [취소]         │
├──────────────────────────────────────────────┤
│ ☑ 1번 …    ☐ 2번 …    ☑ 3번 …                 │
└──────────────────────────────────────────────┘
```

- 유형 버튼은 **단일 선택**이다. `전체` 는 3종 모두를 뜻하는 네 번째 선택지다
  (다중 토글로 만들면 "전체"와 "3개 다 켬"이 같은 상태가 되어 UI 가 중복된다).
- 선택 상태는 스토어에 `variantPicking: boolean` / `variantPicked: number[]` /
  `variantKind: VariantKind | 'all'` 로 둔다. 담기 모드(`notePicking`)와 **상호 배타**다
  — 한쪽을 켜면 다른 쪽은 꺼진다. 체크박스가 두 뜻을 갖는 사고를 막는다.
- 두 모드 모두 진입 시 자기 선택 목록을 **비우고 시작한다**(6번 재발 방지와 같은 규칙).
- 생성 결과는 기존 `variants` 스토어에 그대로 쌓이므로 문항을 펼치면 바로 보인다.

기존 문항별 `VariantPanel` 은 그대로 둔다. 한 문항만 빠르게 만드는 경로로 계속 쓴다.

### 3-2. 출처 표시 (요청 3)

**모델** — `ExportDoc` 에 필드 하나를 더한다.

```python
@dataclass(frozen=True)
class ExportDoc:
    title: str
    blocks: Sequence[Block]
    footer: str | None = None   # 문서 끝 한 줄(출처). None/빈 문자열이면 렌더하지 않는다.
```

- 렌더러 두 벌이 문서 맨 끝에 작은 글씨 한 줄로 넣는다. docx 는 8pt 회색,
  hwpx 는 기본 문단(서식을 지정하지 않는 기존 방침 유지).
- API: 4개 export 엔드포인트에 쿼리 파라미터 `source` 를 더한다(선택, 기본 없음).
  길이 상한 100자, 개행 제거. 값이 없으면 지금과 동일한 문서가 나온다.

**프론트** — `ExportButton` 드롭다운 맨 위에 입력란을 둔다.

```
┌ 내보내기 ▾ ─────────────────┐
│ 출처 [ HY EDU            ] │   ← 마지막 값을 localStorage 에 기억
│ ───────────────────────── │
│ 문제만 · DOCX              │
│ 문제만 · HWPX              │
│ 문제+해설 · DOCX           │
│ 문제+해설 · HWPX           │
└───────────────────────────┘
```

`localStorage` 키 `export.source`. 비워두면 출처 없이 나간다.

### 3-3. 검산 출력 제외 (요청 4)

프롬프트에서 **출력만** 막는다. 검산 자체는 계속 시킨다 — 답 정확도에 기여하기 때문이다.

`prompts.py` `_SKILL_SOLUTION_STEPS` 를 고친다.

```
단계를 번호로 나누어 전개합니다. …

답을 확정하기 전에 **반드시 스스로 검산하십시오.** 구한 답을 원래 식이나
조건에 도로 넣어 맞는지 확인하고, 객관식이면 그 값이 선택지에 있는지도
확인하십시오. 다만 **검산 과정은 답변에 쓰지 마십시오.** 검산은 당신이
혼자 하는 확인 절차이며, 학생에게 보여 줄 내용이 아닙니다. "검산: …",
"검산했습니다", ✔ 표시 중 어느 것도 출력하지 마십시오.
```

`prompts.py:160` 의 "계산이 복잡해지면 중간에 반드시 검산 단계를 넣으십시오"도
"중간 결과를 스스로 확인하되 그 과정은 쓰지 마십시오"로 맞춘다.

**안전망** — 모델이 지시를 어기고 `## 검산` 섹션을 낼 수 있다.
`markdown_sections.py` 에 `VERIFY_TITLE = "검산"` 를 두고, `build.py` 가
`PROBLEM_CHECK_TITLE` 과 같은 방식으로 내보내기에서 제외한다. 화면(`MathText`)은
건드리지 않는다 — 섹션이 안 나오는 것이 정상이고, 나오면 사용자가 알아채는 편이 낫다.

프롬프트가 바뀌어도 **이미 저장된 풀이는 그대로다.** 재생성하지 않는다.

### 3-4. 답안지 업로드 안내 (요청 5)

문구 한 벌을 `lib/` 상수로 두고 3곳에서 쓴다.

```ts
// lib/upload-notice.ts
export const UPLOAD_NOTICE =
  '문항만 있는 PDF를 올려 주세요. 답안·해설이 섞이면 그 페이지도 문제로 인식됩니다.';
```

1. `FileTreePanel` 하단 "업로드 위치" 줄 아래 상시 표시
2. 빈 보관함 `EmptyState.description` 에 이어 붙임
3. 업로드 성공 토스트에 `hint` 로 첨부

추출 로직(`extractor.py`)은 건드리지 않는다. 문구로 처리한다는 결정이다.

### 3-5. 오답노트 항목 잔존 (요청 6)

**먼저 재현 테스트를 쓴다.** `workspace.test.ts` 에 스토어 수준 시나리오를 만든다.

```
1. startNotePicking() → toggleNotePick(3) → toggleNotePick(5)
2. (담기 모달을 닫기만 하고 담지 않음 = stopNotePicking 미호출)
3. startNotePicking() 다시 호출
   → notePicked 가 [] 여야 한다.  ← 현재는 [3,5] 로 남는다 (실패)
```

통과하도록 고친다.

- `startNotePicking()` 이 `notePicked: []` 로 초기화한다.
- 담기 성공 후 `stopNotePicking` 은 지금대로 유지.
- `selectNote(id)` 는 이미 `noteDetail: null` 로 비우고 서버에서 다시 받는다 — 변경 없음.

이 테스트가 통과했는데도 사용자 화면에서 증상이 남으면, 그때는 서버 데이터를 직접
확인한다(`GET /api/notes/{id}` 응답과 `note_items` 테이블 대조). **추측으로 닫지 않는다.**

### 3-6. docx 렌더 수정 (요청 7)

`docx.py` 만 고친다. `build.py`·`hwpx.py`·`ExportDoc` 은 그대로다.

**(a) 페이지 폭증** — 문서 기본 문단 서식을 눌러 준다.

```python
style = document.styles['Normal'].paragraph_format
style.space_after = Pt(0)
style.space_before = Pt(0)
style.line_spacing = 1.0
```

제목 스타일(`Heading 1~3`, `Title`)도 앞뒤 여백을 줄인다(앞 6pt / 뒤 2pt 정도).
빈 줄은 지금도 문단으로 들어가므로 문단 사이 간격은 원문 개행이 담당한다.

**(b) 수식 깨짐** — Normal·Heading 계열 폰트를 명시한다.

```python
font = document.styles['Normal'].font
font.name = '맑은 고딕'
# eastAsia 는 python-docx 가 안 건드리므로 rPr 에 직접 넣는다
rpr.rFonts.set(qn('w:eastAsia'), '맑은 고딕')
rpr.rFonts.set(qn('w:cs'), '맑은 고딕')
```

맑은 고딕(Malgun Gothic)은 Windows·한글·워드에 기본 설치돼 있고 위/아래첨자와
`⇒ ∘ ∠ ⋯ ≡ ✔ ㉠` 을 포함한다. macOS 워드에서 없으면 워드가 폴백하는데,
현재 사용자 환경이 Windows 이므로 이 선택으로 간다.

**회귀 테스트** — `tests/test_export.py` 에서 생성된 docx 의 `word/styles.xml` 을 직접 읽어
검증한다. 문단 수는 지표가 되지 못한다(수정 전에도 docx 1141 / hwpx 1374 로 비슷하다).
페이지를 만든 것은 문단당 여백이므로 여백을 검증한다.

1. `Normal` 스타일에 `w:spacing w:after="0"` 과 `w:line="240"`(=1.0배)이 있는지
2. `rFonts` 의 `w:ascii` / `w:eastAsia` / `w:cs` 가 모두 `맑은 고딕` 인지
3. `Heading2` / `Heading3` 의 `w:after` 가 100(5pt) 이하인지

실제 페이지 수는 구현 후 `tmp/` 의 개포고 파일을 다시 생성해 눈으로 확인한다.
목표는 hwpx(14p)와 같은 자릿수다 — 정확히 같을 필요는 없다(제목 스타일이 다르다).

### 3-7. 트리 다중 선택·이동 (요청 8)

**프론트만** 바꾼다. 백엔드 `POST /api/nodes/{id}/move` 는 그대로 쓰고 여러 번 호출한다
(순환 방지가 이미 서버에 있다 — `service.py:158-175`).

- `FileTreePanel` 에 `selectedIds: Set<string>` 지역 상태를 둔다.
  - 그냥 클릭 = 기존 동작(열기) + 선택을 그 하나로 리셋
  - `Ctrl/Cmd + 클릭` = 토글 추가
  - `Shift + 클릭` = 화면에 보이는 순서 기준 범위 선택
- 드래그 시작: 끌기 시작한 노드가 선택에 있으면 **선택 전체**를, 없으면 그 노드 하나를
  옮긴다(파일 탐색기와 같은 규칙). `dataTransfer` 에 id 를 **JSON 배열**로 싣는다.
  MIME 은 기존 `NODE_MIME` 을 그대로 쓰되 값 형식만 배열로 바꾼다.
- 드롭: `moveNodes(ids, targetFolderId)` 를 새로 만들어 순차 호출하고, 끝나고 한 번만
  트리를 새로 고친다. 개별 실패(순환 등)는 모아서 토스트 한 건으로 알린다.
- 선택된 행은 배경으로 구분하고, 2개 이상이면 드래그 중 "N개 이동" 배지를 띄운다.
- 섹션(`exam`/`note`)을 바꾸면 선택을 비운다.

## 4. 구현 순서

의존이 없으므로 위험도 낮은 것부터 간다. 각 단계가 독립적으로 배포 가능하다.

| 순서 | 항목 | 범위 |
|---|---|---|
| 1 | 4번 검산, 5번 안내 문구 | 프롬프트·문구. 테스트 최소 |
| 2 | 6번 오답노트 (재현 테스트 → 수정) | 프론트 스토어 |
| 3 | 7번 docx 렌더 + 회귀 테스트 | 백엔드 |
| 4 | 3번 출처 (모델 → API → 다이얼로그) | 백엔드+프론트 |
| 5 | 1·2번 변형 일괄 생성 | 백엔드+프론트, 가장 큼 |
| 6 | 8번 트리 다중 이동 | 프론트 |

## 5. 하지 않는 것

- 추출 로직(`extractor.py`) 변경 — 5번은 문구로 처리한다는 결정이다.
- hwpx 수식 객체(`add_equation`) 도입 — 기존 방침(평문 유니코드)을 유지한다.
- 이미 저장된 풀이의 재생성 — 4번 프롬프트 변경은 새로 만드는 풀이에만 적용된다.
- 출처를 화면(웹 UI)에 표시 — 내보낸 문서 안에만 넣는다.
- 변형 유형 다중 토글 — `전체` 를 네 번째 단일 선택지로 둔다.
