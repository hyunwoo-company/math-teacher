# 오답노트 다중선택 + 복사 버튼 통합 — 설계

작성일: 2026-08-09
범위: 프론트엔드 전용. **백엔드 API 변경 없음.**

## 1. 목적

오답노트에 담을 때 한 번에 여러 문항을, 그리고 여러 오답노트에 담을 수 있게 한다.
현재는 문항 1개 → 노트 1개만 가능하다.

곁들여, 중복으로 놓인 복사 버튼 두 개를 평문 복사 하나로 합친다.

## 2. 현재 상태 (확인된 사실)

| 위치 | 현재 동작 |
|---|---|
| `CenterPanel.tsx:171` | `AddToNoteButton` 에 `problemNumbers={[selectedProblemNo]}` — 항상 1개 |
| `AddToNoteButton.tsx:24` | `problemNumbers: number[]` 를 이미 받는다. 배열 처리는 준비됨 |
| `AddToNoteButton.tsx:153` | `NotePickRow` 가 노트를 클릭하면 즉시 담고 모달을 닫는다 — 단일 선택 |
| `workspace.ts:1307` | `addProblemsToNote(noteId, sourceNodeId, numbers, memo)` → `{added, skipped}` 토스트 |
| `POST /api/notes/{id}/items` | `{source_node_id, problem_numbers[], memo}` → `{added[], skipped[]}`. **이미 다중 문항 지원** |
| 복사 버튼 | `AiPanel:389`, `InlineSolutionPanel:151`, `SolutionsTab:251`, `VariantPanel:146` 4곳에 `복사`(마크다운 원문) + `복사(한글·워드용)`(평문) 쌍 |

즉 **API도 스토어도 이미 다중 문항을 지원한다.** 빠진 것은 선택 UI와 노트 다중 선택뿐이다.

## 3. 설계

### 3-1. 문항 다중선택 — 번호 줄에 선택 모드

`CenterPanel.tsx:133-179` 의 문제 번호 줄을 재사용한다. 새 목록을 만들지 않는다.

```
문제  [1][2][3][4][5] … [22]              ← 평소: 클릭 = 그 문제로 대화 시작
      문제 번호를 클릭하면 그 문제로 대화를 시작할 수 있습니다.

──────────────────────── [여러 개 선택] 을 누르면 ────────────────────────

문제  [1][✓2][3][✓4][5] … [22]           ← 선택 모드: 클릭 = 체크 토글
      3개 선택됨   [전체 선택] [선택 해제] [오답노트에 담기] [취소]
```

- 선택 상태는 `CenterPanel` 지역 `useState<Set<number>>` 로 둔다. 스토어에 올리지 않는다
  (한 화면 안에서 끝나고, 파일을 옮기면 사라지는 것이 옳다).
- 선택 모드 진입/이탈은 지역 `useState<boolean>`. 파일이 바뀌면(`node.id` 변경) 초기화한다.
- 선택 모드에서는 `focusProblem` 을 호출하지 않는다. 두 동작이 섞이지 않게 모드로 가른다.
- 선택 0개면 [오답노트에 담기] 는 `disabled`.
- 기존 단일 선택 경로(`selectedProblemNo` 가 있을 때 뜨는 `AddToNoteButton`)는 **그대로 둔다.**
  한 문항만 담는 것이 여전히 가장 흔한 조작이다.

**선택 모드에서의 번호 버튼 표시**: 체크된 번호는 파란 테두리 + `✓`. 풀이 상태 색(초록/파랑)은
선택 모드에서도 유지하되 체크 표시가 우선한다. `aria-pressed` 로 토글임을 알린다.

### 3-2. 노트 다중선택 — 다이얼로그를 체크박스형으로

`AddToNoteButton.tsx` 의 `NotePickRow` 를 "클릭 즉시 담기" 에서 "체크 토글" 로 바꾼다.

```
┌ 오답노트에 담기 (2, 4, 7번) ───────────────┐
│ 담을 오답노트를 선택하세요. (여러 개 가능)   │
│  📁 이현우                                  │
│    ☑ 중간고사 오답                          │
│    ☐ 이차방정식 오답                        │
│  📁 김민지                                  │
│    ☑ 중간고사 오답                          │
│                                             │
│        [새 오답노트]  [닫기]  [2개 노트에 담기] │
└─────────────────────────────────────────────┘
```

- 선택된 노트 id 는 지역 `useState<Set<string>>`. 모달을 닫으면 비운다.
- 확인 버튼 라벨은 선택 수에 따라 `담기` / `2개 노트에 담기`.
- 폴더 행은 지금처럼 클릭 대상이 아니다(라벨일 뿐).

### 3-3. 담기 실행과 결과 보고

노트별로 `addProblemsToNote` 를 **순차** 호출한다. 병렬로 하지 않는다 — 같은 SQLite 를
동시에 건드리지 않게 하고, 실패 원인을 노트 단위로 분간하기 위해서다.

문제는 현재 `addProblemsToNote` 가 **호출마다 토스트를 띄운다**는 점이다. 노트 3개면
토스트가 3번 뜬다. 그래서:

- `workspace.ts` 에 `addProblemsToNotes(noteIds: string[], sourceNodeId, problemNumbers, memo?)`
  를 새로 만든다. 내부에서 `api.addNoteItems` 를 순차 호출하고 **결과를 모아 토스트 1개**로 낸다.
- 기존 `addProblemsToNote` 는 그대로 둔다(단일 경로가 계속 쓴다). 새 함수가 그것을 부르지
  않고 `api.addNoteItems` 를 직접 부르는 이유가 이 토스트 중복이다.

집계 토스트 문안:

| 상황 | 문안 |
|---|---|
| 전부 성공 | `3개 문항을 2개 오답노트에 담았습니다.` |
| 일부 중복 | `3개 문항을 2개 오답노트에 담았습니다. (이미 있던 2건은 건너뛰었습니다)` |
| 전부 중복 | `이미 모두 담겨 있습니다.` (kind: info) |
| 일부 노트 실패 | `2개 오답노트에 담았습니다. '김민지 오답' 은 실패했습니다: <사유>` (kind: error) |
| 전부 실패 | 첫 실패 사유를 그대로 (kind: error) |

한 노트가 실패해도 **나머지 노트는 계속 진행한다.** 중간에 멈추지 않는다.

담기가 끝나면 문항 선택과 선택 모드를 해제한다(같은 걸 두 번 담는 실수 방지).

### 3-4. 복사 버튼 — 두 버튼 모두 용도를 라벨에 적는다

4곳(`AiPanel:389`, `InlineSolutionPanel:151`, `SolutionsTab:251`, `VariantPanel:146`)의
버튼 쌍을 그대로 두되, **둘 다 무엇에 쓰는 것인지**를 이름에 적는다.

```tsx
// 전 — 이름 없는 "복사" 가 무엇인지 알 수 없다
<CopyButton text={entry.text} label="복사" />                                  // 실은 마크다운 원문
<CopyButton text={toPlainText(entry.text)} label="복사(한글·워드용)" />          // 평문

// 후 — 두 버튼 다 성격이 이름에 있다
<CopyButton text={entry.text} label="복사(AI 대화용)"
            title="마크다운·LaTeX 원문 그대로 복사 (다른 AI 에 붙여넣을 때)" />
<CopyButton text={toPlainText(entry.text)} label="복사(한글·워드용)"
            title="한글·워드에 붙여넣을 수 있는 텍스트로 복사" />
```

- 기능은 지금과 같다. **라벨만 바꾼다.**
- 이름 없는 "복사" 를 없애는 것이 요점이다. 마크다운 원문은 사람에게 보여줄 때 쓰는 것이
  아니라 AI 에 넘길 때 쓰는 것인데, 이름이 "복사" 라 기본처럼 보였다.
- 어느 쪽도 기본이 아니다. 용도가 다른 두 기능이 나란히 있을 뿐이다.
- 순서는 지금 그대로 둔다(원문 → 평문). 순서를 바꿀 이유가 없다.

`SolutionsTab.tsx:248` 의 주석("복사는 렌더된 텍스트가 아니라 마크다운 원문을 넣는다")은
버튼 이름이 바뀌면 자명해지므로 그에 맞게 다듬는다.

## 4. 건드리는 파일

| 파일 | 변경 |
|---|---|
| `web/src/components/center/CenterPanel.tsx` | 선택 모드 상태 + 번호 줄 토글 동작 + 액션 바 |
| `web/src/components/center/AddToNoteButton.tsx` | 노트 체크박스 다중선택, 확인 버튼으로 담기 |
| `web/src/store/workspace.ts` | `addProblemsToNotes` 추가 |
| `web/src/components/ai/AiPanel.tsx` | 복사 버튼 통합 |
| `web/src/components/center/InlineSolutionPanel.tsx` | 복사 버튼 통합 |
| `web/src/components/center/SolutionsTab.tsx` | 복사 버튼 통합 (주석 수정 포함) |
| `web/src/components/center/VariantPanel.tsx` | 복사 버튼 통합 |

백엔드는 건드리지 않는다.

## 5. 테스트 (완료 기준)

기존 테스트 파일 옆에 붙인다. Vitest + Testing Library, 프로젝트 기존 방식 그대로.

**`CenterPanel` (신규 `CenterPanel.test.tsx`)**
1. [여러 개 선택] 을 누르면 번호 버튼이 토글로 바뀐다 — 번호 클릭이 `focusProblem` 을 부르지 않는다
2. 2·4·7 을 고르면 "3개 선택됨" 이 뜨고, [오답노트에 담기] 가 `problemNumbers=[2,4,7]` 로 열린다
3. 선택 0개면 [오답노트에 담기] 가 `disabled`
4. [전체 선택] → 모든 문항 번호가 선택된다
5. 다른 파일로 이동하면 선택 모드와 선택이 초기화된다
6. 선택 모드가 꺼져 있으면 번호 클릭이 종전대로 `focusProblem` 을 부른다 (회귀 방지)

**`AddToNoteButton` (신규 `AddToNoteButton.test.tsx`)**
7. 노트 2개를 체크하면 확인 버튼이 "2개 노트에 담기" 가 된다
8. 확인을 누르면 `addProblemsToNotes` 가 노트 id 2개와 문항 배열로 **한 번** 호출된다
9. 노트 0개 선택이면 확인 버튼 `disabled`
10. 폴더 행은 체크할 수 없다

**`workspace.addProblemsToNotes` (기존 `notes-threads.test.ts` 에 추가)**
11. 노트 3개 → `api.addNoteItems` 가 3번 순차 호출되고 토스트는 **1개**
12. 2번째 노트가 실패해도 3번째는 호출되고, 토스트에 실패한 노트 이름이 들어간다
13. 전부 중복(`added` 가 모두 빈 배열)이면 `kind: 'info'` 로 "이미 모두 담겨 있습니다"

**복사 버튼 (기존 테스트 수정)**
14. 4곳 각각에서 [복사(AI 대화용)] 이 **원문 그대로** 를, [복사(한글·워드용)] 이
    `toPlainText(원문)` 을 클립보드에 넣는다
15. 이름이 그냥 "복사" 인 버튼은 어디에도 남아 있지 않다

전체 통과 조건: `cd app/web && npm test` 및 `npm run lint` 무오류.

## 6. 하지 않는 것 (범위 밖)

- `SolutionsTab` 아코디언 각 항목의 체크박스 — 번호 줄 하나로 충분하다. 두 군데에 선택
  상태를 두면 어느 쪽이 진짜인지 모호해진다.
- 오답노트 화면(`NoteView`)에서의 다중 선택/빼기 — 별개 요구다.
- 드래그로 범위 선택, Shift+클릭 범위 선택 — 22문항 규모에서는 과하다.
- 노트 다중선택을 위한 새 API — 기존 엔드포인트 반복 호출로 충분하고, 서버 트랜잭션
  경계를 노트별로 유지하는 편이 실패 처리도 명확하다.
