# 출시 전 개선 8건 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 출시 전 나온 요청 8건(변형 일괄생성·출처·검산 제외·업로드 안내·오답노트 버그·docx 렌더 버그·트리 다중이동)을 구현하고 배포한다.

**Architecture:** 설계는 `docs/superpowers/specs/2026-08-14-release-fixes-design.md` 가 단일 소스다. 위험도 낮은 순서로 6개 태스크를 독립 커밋한다. 백엔드는 `app/core`(FastAPI, Python 3.12), 프론트는 `app/web`(Next.js 15 App Router + zustand). 각 태스크는 그 자체로 배포 가능하다.

**Tech Stack:** FastAPI / pytest / python-docx / python-hwpx / Next.js 15 / TypeScript / zustand / vitest

## Global Constraints

- 모든 UI 텍스트·에러 메시지는 **한국어**. 날짜·통화는 한국 기준.
- 백엔드 검증: `cd app/core && ruff check . && mypy . && python -m pytest`
- 프론트 검증: `cd app/web && npm run check` (lint + typecheck + vitest)
- `mypy` 는 **strict**. 새 함수에 타입 애너테이션과 Google 스타일 docstring 필수.
- `extractor.py` 는 **로직 변경 금지**(22문항 분할 검증됨).
- 기존 API 계약을 깨지 않는다. 새 파라미터는 전부 **선택(기본값 있음)** 으로 넣는다.
- 이미 저장된 풀이·변형은 재생성하지 않는다.
- 커밋은 태스크마다 1건. 메시지는 기존 컨벤션(`feat(web):`, `fix(api,web):`, `docs:`).

---

### Task 1: 검산 출력 제외 + 업로드 안내 문구

설계 §3-3, §3-4. 프롬프트 문구와 UI 문구만 바꾼다. 로직 변경 없음.

**Files:**
- Modify: `app/core/prompts.py:40-48` (`_SKILL_SOLUTION_STEPS`), `app/core/prompts.py:160`
- Modify: `app/core/markdown_sections.py` (`VERIFY_TITLE` 추가)
- Modify: `app/core/export/build.py:96-125` (`_solution_blocks` 에서 검산 섹션 제외)
- Create: `app/web/src/lib/upload-notice.ts`
- Modify: `app/web/src/components/tree/FileTreePanel.tsx` (하단 안내 + 빈 보관함 EmptyState 2곳)
- Modify: `app/web/src/store/workspace.ts` (`uploadFiles` 성공 토스트에 `hint`)
- Test: `app/core/tests/test_prompts.py`, `app/core/tests/test_export.py`

**Interfaces:**
- Produces: `markdown_sections.VERIFY_TITLE: Final[str] = "검산"`
- Produces: `UPLOAD_NOTICE: string` (`app/web/src/lib/upload-notice.ts` 기본 내보내기 아님, 이름 있는 export)

- [ ] **Step 1: 실패하는 테스트 작성 (백엔드)**

`app/core/tests/test_prompts.py` 에 추가:

```python
def test_solve_prompt_forbids_printing_verification() -> None:
    """검산은 시키되 출력은 막는다(요청 4)."""
    assert "검산" in prompts.SOLVE_SYSTEM_PROMPT
    assert "검산 과정은 답변에 쓰지 마십시오" in prompts.SOLVE_SYSTEM_PROMPT
    # 옛 지시("✔ 를 붙이십시오")가 남아 있으면 모델이 혼란스러워한다.
    assert "✔ 를 붙이십시오" not in prompts.SOLVE_SYSTEM_PROMPT


def test_variant_prompt_shares_the_same_rule() -> None:
    """변형도 같은 공유 스킬을 쓰므로 같은 규약이 걸린다."""
    assert "검산 과정은 답변에 쓰지 마십시오" in prompts.VARIANT_SYSTEM_PROMPT
```

`app/core/tests/test_export.py` 에 추가:

```python
def test_export_drops_verification_section() -> None:
    """모델이 규칙을 어기고 '## 검산' 을 내도 문서에는 넣지 않는다."""
    doc = export_build.build_exam_doc(
        title="시험지",
        items=[
            export_build.ExamItem(
                no=1,
                image=CROP_PNG,  # 이 파일의 기존 픽스처 경로를 쓴다
                solution="## 풀이\n본문입니다.\n\n## 검산\n2+2=4 입니다.\n\n## 정답\n정답: ③",
            )
        ],
        include_full=True,
    )
    texts = [b.text for b in doc.blocks if isinstance(b, export_model.Text)]
    joined = "\n".join(texts)
    assert "본문입니다" in joined
    assert "2+2=4" not in joined
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app/core && python -m pytest tests/test_prompts.py tests/test_export.py -v`
Expected: FAIL — 프롬프트에 새 문구가 없고, 검산 섹션이 문서에 들어감

- [ ] **Step 3: 프롬프트 수정**

`prompts.py` `_SKILL_SOLUTION_STEPS` 의 두 번째 문단을 통째로 교체:

```python
_SKILL_SOLUTION_STEPS: Final[str] = """\
단계를 번호로 나누어 전개합니다. 각 단계는 "무엇을 왜 하는지" 한 문장으로
밝히고 그 다음에 식을 씁니다. 암산으로 건너뛰지 말고 학생이 따라올 수 있는
크기로 단계를 쪼개십시오.

답을 확정하기 전에 **반드시 스스로 검산하십시오.** 구한 답을 원래 식이나
조건에 도로 넣어 맞는지 확인하고, 객관식이면 그 값이 선택지에 실제로 있는지도
확인하십시오. 다만 **검산 과정은 답변에 쓰지 마십시오.** 검산은 당신이 혼자
하는 확인 절차이며 학생에게 보여 줄 내용이 아닙니다. "검산", "검산했습니다",
✔ 표시, `## 검산` 섹션 중 어느 것도 출력하지 마십시오."""
```

`prompts.py:160` 의 정확성 원칙 한 줄도 교체:

```python
- 계산이 복잡해지면 중간 결과를 스스로 확인하되, 그 확인 과정은 쓰지 마십시오.
```

> 주의: `SOLVE_SYSTEM_PROMPT` docstring 에 "리팩터 후에도 원문과 바이트 단위로 동일"
> 이라고 적혀 있다. 이번 변경으로 그 서술이 더는 참이 아니므로 **docstring 도 함께
> 고친다**(검산 출력 제외로 의도적으로 달라졌다고 적을 것).

- [ ] **Step 4: 검산 섹션 안전망 구현**

`markdown_sections.py` 에 상수 추가:

```python
# 모델이 지시를 어기고 검산을 섹션으로 낼 때가 있다. 내보내기에서 제외한다.
VERIFY_TITLE: Final[str] = "검산"
```

`__all__` 에 `"VERIFY_TITLE"` 추가.

`export/build.py` 의 `_solution_blocks` 루프와 `build_variants_doc` 루프에서
`PROBLEM_CHECK_TITLE` 을 거르는 조건에 `VERIFY_TITLE` 을 더한다:

```python
_SKIPPED_SECTIONS: Final[frozenset[str]] = frozenset(
    {markdown_sections.PROBLEM_CHECK_TITLE, markdown_sections.VERIFY_TITLE}
)
```

두 곳 모두 `if title in _SKIPPED_SECTIONS: continue` 로 바꾼다.

- [ ] **Step 5: 백엔드 테스트 통과 확인**

Run: `cd app/core && python -m pytest -q && ruff check . && mypy .`
Expected: 전부 통과

- [ ] **Step 6: 프론트 안내 문구 (테스트 먼저)**

`app/web/src/components/Workspace.test.tsx` 또는 새 테스트에 추가:

```tsx
it('업로드 안내 문구가 좌측 패널에 보인다', async () => {
  render(<FileTreePanel />);
  expect(await screen.findAllByText(/문항만 있는 PDF/)).not.toHaveLength(0);
});
```

- [ ] **Step 7: 문구 구현**

`app/web/src/lib/upload-notice.ts` 생성:

```ts
/** 답안지·해설이 섞인 PDF 업로드로 오인식이 생기는 것을 막는 안내(요청 5). */
export const UPLOAD_NOTICE =
  '문항만 있는 PDF를 올려 주세요. 답안·해설이 섞이면 그 페이지도 문제로 인식됩니다.';
```

3곳에 적용:
1. `FileTreePanel.tsx` footer 의 "업로드 위치" `<p>` 아래에 `<p className="mt-1 text-[11px] text-amber-700">{UPLOAD_NOTICE}</p>` (시험지 섹션에서만: `!isNote` 조건)
2. 빈 보관함 `EmptyState` 의 `description` 끝에 이어 붙임
3. `workspace.ts` 의 `uploadFiles` 성공 토스트에 `hint: UPLOAD_NOTICE`

- [ ] **Step 8: 프론트 검증**

Run: `cd app/web && npm run check`
Expected: 전부 통과

- [ ] **Step 9: 커밋**

```bash
git add app/core/prompts.py app/core/markdown_sections.py app/core/export/build.py \
        app/core/tests app/web/src/lib/upload-notice.ts \
        app/web/src/components/tree/FileTreePanel.tsx app/web/src/store/workspace.ts \
        app/web/src/components
git commit -m "feat(api,web): 검산은 AI만 하고 출력에서 제외 + 답안지 업로드 안내"
```

---

### Task 2: 오답노트 선택 잔존 수정

설계 §3-5. **재현 테스트를 먼저 쓴다.** 통과하지 않으면 원인을 다시 찾는다.

**Files:**
- Modify: `app/web/src/store/workspace.ts:1901-1906` (`startNotePicking`)
- Modify: `app/web/src/components/center/AddToNoteButton.tsx` (모달 닫기 시 정리)
- Test: `app/web/src/store/workspace.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `startNotePicking()` 이 `notePicked` 를 항상 `[]` 로 초기화한다는 보장

- [ ] **Step 1: 재현 테스트 작성**

`app/web/src/store/workspace.test.ts` 에 추가:

```ts
it('담기 모드를 다시 켜면 이전 선택이 남지 않는다', () => {
  const store = useWorkspace.getState();
  store.startNotePicking();
  store.toggleNotePick(3);
  store.toggleNotePick(5);
  expect(useWorkspace.getState().notePicked).toEqual([3, 5]);

  // 담지 않고 모달만 닫은 상황: stopNotePicking 이 불리지 않는다.
  // 이 상태에서 담기 모드를 다시 켜면 선택은 비어 있어야 한다.
  useWorkspace.getState().startNotePicking();
  expect(useWorkspace.getState().notePicked).toEqual([]);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app/web && npx vitest run src/store/workspace.test.ts -t '담기 모드를 다시'`
Expected: FAIL — `[3, 5]` 가 남는다

- [ ] **Step 3: 수정**

`workspace.ts` 의 `startNotePicking`:

```ts
  startNotePicking() {
    // 이전 선택을 반드시 버린다. 남기면 담기 모달을 닫기만 했을 때 그 선택이
    // 다음 담기에 딸려가 엉뚱한 문항이 노트에 들어간다.
    set({ notePicking: true, notePicked: [], variantPicking: false });
  },
```

> `variantPicking` 은 Task 5 에서 생긴다. **Task 5 를 아직 안 했다면 그 필드는 빼고**
> `set({ notePicking: true, notePicked: [] })` 만 쓴다. Task 5 에서 다시 넣는다.

`AddToNoteButton.tsx` 의 모달 `onClose` 와 `[닫기]` 버튼은 `setOpen(false)` 만 하는데,
이것만으로는 담기 모드가 유지되는 것이 정상 동작이다(사용자가 선택을 고치고 다시 열 수
있어야 한다). 여기서는 **바꾸지 않는다.** Step 3 의 초기화만으로 증상이 사라진다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app/web && npm run check`
Expected: 전부 통과

- [ ] **Step 5: 통과했는데도 증상이 남을 경우의 대비 (문서화)**

이 커밋 메시지 본문에 다음을 적는다 — 다음 사람이 재조사할 때 시작점이 된다.

```
재현 불확실. startNotePicking 이 선택을 안 비우는 경로가 유력해 먼저 막았다.
증상이 남으면 GET /api/notes/{id} 응답과 note_items 테이블을 대조할 것.
백엔드 delete_nodes(storage.py:503-515)의 노트 항목 삭제는 정상 확인됨.
```

- [ ] **Step 6: 커밋**

```bash
git add app/web/src/store/workspace.ts app/web/src/store/workspace.test.ts
git commit -m "fix(web): 담기 모드 재진입 시 이전 문항 선택이 남는 문제"
```

---

### Task 3: docx 렌더 수정 (페이지 폭증 + 수식 깨짐)

설계 §3-6. `docx.py` 만 고친다. `build.py`·`hwpx.py`·`ExportDoc` 은 건드리지 않는다.

**Files:**
- Modify: `app/core/export/docx.py`
- Test: `app/core/tests/test_export.py`

**Interfaces:**
- Consumes: `export.model.ExportDoc`
- Produces: `build_docx(doc: ExportDoc) -> bytes` (시그니처 불변)

- [ ] **Step 1: 실패하는 테스트 작성**

`app/core/tests/test_export.py` 에 추가:

```python
def _docx_styles_xml(payload: bytes) -> str:
    """생성된 docx 에서 styles.xml 을 꺼낸다."""
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return archive.read("word/styles.xml").decode("utf-8")


def test_docx_normal_style_has_no_paragraph_spacing() -> None:
    """문단마다 붙는 10pt 여백이 74페이지를 만들었다(hwpx 는 14페이지).

    평문을 줄 단위로 문단화하므로 문단 여백이 그대로 페이지 수가 된다.
    """
    payload = export_docx.build_docx(
        export_model.ExportDoc(title="시험지", blocks=[export_model.Text("가\n나\n다")])
    )
    styles = _docx_styles_xml(payload)
    normal = re.search(
        r'<w:style [^>]*w:styleId="Normal".*?</w:style>', styles, re.S
    )
    assert normal is not None
    assert 'w:after="0"' in normal.group(0)
    assert 'w:line="240"' in normal.group(0)


def test_docx_uses_a_font_that_covers_math_glyphs() -> None:
    """Calibri 는 위·아래첨자와 ⇒ ∘ ∠ ⋯ ≡ ✔ 글리프가 없어 수식이 깨진다."""
    payload = export_docx.build_docx(
        export_model.ExportDoc(title="시험지", blocks=[export_model.Text("x² ⇒ a₁ ✔")])
    )
    styles = _docx_styles_xml(payload)
    normal = re.search(
        r'<w:style [^>]*w:styleId="Normal".*?</w:style>', styles, re.S
    )
    assert normal is not None
    for attribute in ("w:ascii", "w:eastAsia", "w:hAnsi", "w:cs"):
        assert f'{attribute}="맑은 고딕"' in normal.group(0)
```

`import io`, `import re`, `import zipfile` 과 `from export import docx as export_docx`,
`from export import model as export_model` 이 이미 있는지 확인하고 없으면 추가한다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app/core && python -m pytest tests/test_export.py -k docx_ -v`
Expected: FAIL — `Normal` 스타일에 `w:after`/`rFonts` 가 아예 없다

- [ ] **Step 3: 구현**

`app/core/export/docx.py` 에 스타일 설정 함수를 더한다.

```python
from docx.enum.text import WD_LINE_SPACING
from docx.oxml.ns import qn
from docx.shared import Inches, Length, Pt

# 본문 폰트. Calibri(python-docx 기본)는 위·아래첨자와 ⇒ ∘ ∠ ⋯ ≡ ✔ 글리프가
# 없어 평문화된 수식이 깨진다. 맑은 고딕은 Windows·한글·워드에 기본 설치돼 있다.
_BODY_FONT: Final[str] = "맑은 고딕"


def _apply_font(style: Any, name: str) -> None:
    """스타일에 폰트를 넣는다(ascii/eastAsia/hAnsi/cs 전부).

    python-docx 의 `font.name` 은 `w:ascii` 와 `w:hAnsi` 만 건드린다. 한글과
    수학 기호는 `w:eastAsia` / `w:cs` 를 따라가므로 XML 에 직접 넣어야 한다.
    """
    style.font.name = name
    rpr = style.element.get_or_add_rPr()
    fonts = rpr.get_or_add_rFonts()
    for attribute in ("w:ascii", "w:eastAsia", "w:hAnsi", "w:cs"):
        fonts.set(qn(attribute), name)


def _tighten(document: Document) -> None:
    """문단 여백과 줄간격을 눌러 페이지 수를 정상화한다.

    python-docx 기본 템플릿의 docDefaults 는 문단마다 뒤 여백 10pt(`after=200`)
    와 줄간격 1.15배(`line=276`)를 준다. 본문을 줄 단위로 문단화하는 이 렌더러
    에서는 그것이 문단 수만큼 곱해져 hwpx 대비 페이지가 5배로 불어난다.
    """
    normal = document.styles["Normal"]
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(0)
    normal.paragraph_format.line_spacing_rule = WD_LINE_SPACING.SINGLE
    _apply_font(normal, _BODY_FONT)

    for name in ("Title", "Heading 1", "Heading 2", "Heading 3"):
        try:
            style = document.styles[name]
        except KeyError:
            continue
        style.paragraph_format.space_before = Pt(6)
        style.paragraph_format.space_after = Pt(2)
        _apply_font(style, _BODY_FONT)
```

`build_docx` 안에서 `document = Document()` 바로 뒤에 `_tighten(document)` 를 부른다.

> `line_spacing_rule = WD_LINE_SPACING.SINGLE` 이 `w:line="240"` 을 만든다.
> `line_spacing = 1.0` 으로도 되지만 `lineRule="auto"` 가 남으므로 테스트가 요구하는
> 형태에 맞추려면 SINGLE 을 쓴다. 실제 산출 XML 을 보고 테스트를 맞추되,
> **테스트를 느슨하게 고쳐 통과시키지 말 것** — 여백 0 과 폰트 지정이 목적이다.
>
> `Any` 를 쓰려면 `from typing import Any, Final` 로 import 를 맞춘다. mypy strict
> 에서 python-docx 의 스타일 타입이 잡히지 않으면 `Any` 가 정당하다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd app/core && python -m pytest tests/test_export.py -v && ruff check . && mypy .`
Expected: 전부 통과

- [ ] **Step 5: 실제 문서로 눈 검증**

`tmp/` 에 있는 개포고 시험지로 다시 뽑아 페이지 수를 확인한다. 서버를 띄우지 않고
`build_docx` 를 직접 불러도 되지만, 가장 쉬운 방법은 로컬 서버 기동 후 내보내기다.
결과 docx 를 열어 **hwpx(14p)와 같은 자릿수**인지, 수식(`x²`, `⇒`, `a₁`, `✔`)이
□ 로 보이지 않는지 확인하고 결과를 보고에 적는다.

- [ ] **Step 6: 커밋**

```bash
git add app/core/export/docx.py app/core/tests/test_export.py
git commit -m "fix(api): docx 페이지 폭증(문단 여백)과 수식 깨짐(Calibri 글리프) 수정"
```

---

### Task 4: 내보내기 출처 표시

설계 §3-2. 모델 → 렌더러 → 서비스 → 라우트 → 프론트 순으로 한 줄을 흘린다.

**Files:**
- Modify: `app/core/export/model.py` (`ExportDoc.footer`)
- Modify: `app/core/export/docx.py`, `app/core/export/hwpx.py` (footer 렌더)
- Modify: `app/core/export/build.py` (3개 build 함수에 `source` 인자)
- Modify: `app/core/service.py` (`export_exam` / `export_variants` / `export_note`)
- Modify: `app/core/main.py` (4+2개 export 라우트에 `source` 쿼리)
- Modify: `app/web/src/lib/api.ts`, `app/web/src/components/center/ExportButton.tsx`
- Test: `app/core/tests/test_export.py`, `app/web/src/components/center/ExportButton.test.tsx`

**Interfaces:**
- Produces (백엔드):
  - `ExportDoc(title: str, blocks: Sequence[Block], footer: str | None = None)`
  - `build_exam_doc(*, title, items, include_full, source: str | None = None)`
  - `build_variants_doc(*, title, items, include_full, source: str | None = None)`
  - `build_note_doc(*, title, items, include_full, source: str | None = None)`
  - `export_exam(node_id, *, fmt, include, source: str | None = None)` (나머지 2개도 동일)
  - 쿼리 파라미터 `source` (선택, 최대 100자, 개행 제거)
- Produces (프론트):
  - `api.exportDocument(target, id, format, include, source?: string)`
  - localStorage 키 `export.source`

- [ ] **Step 1: 실패하는 테스트 작성 (백엔드)**

```python
def test_export_puts_source_at_the_end() -> None:
    """출처는 문서 맨 끝 한 줄로 들어간다."""
    doc = export_build.build_exam_doc(
        title="시험지", items=[...], include_full=False, source="HY EDU"
    )
    assert doc.footer == "HY EDU"


def test_export_without_source_has_no_footer() -> None:
    """빈 값이면 지금과 똑같은 문서가 나온다."""
    doc = export_build.build_exam_doc(title="시험지", items=[...], include_full=False)
    assert doc.footer is None


def test_docx_renders_source_line() -> None:
    payload = export_docx.build_docx(
        export_model.ExportDoc(title="t", blocks=[], footer="HY EDU")
    )
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        document = archive.read("word/document.xml").decode("utf-8")
    assert "HY EDU" in document


def test_hwpx_renders_source_line() -> None:
    payload = export_hwpx.build_hwpx(
        export_model.ExportDoc(title="t", blocks=[], footer="HY EDU")
    )
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        section = archive.read("Contents/section0.xml").decode("utf-8")
    assert "HY EDU" in section


def test_export_route_accepts_source_query(client: TestClient) -> None:
    """라우트가 source 를 받아 문서에 흘린다."""
    node_id = ...  # 이 파일의 기존 픽스처 헬퍼를 쓴다
    response = client.get(f"/api/files/{node_id}/export.docx", params={"source": "HY EDU"})
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert "HY EDU" in archive.read("word/document.xml").decode("utf-8")
```

`items=[...]` 는 이 파일에 이미 있는 픽스처(크롭 PNG 경로) 구성을 그대로 쓴다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app/core && python -m pytest tests/test_export.py -k source -v`
Expected: FAIL — `build_exam_doc() got an unexpected keyword argument 'source'`

- [ ] **Step 3: 모델·렌더러 구현**

`model.py`:

```python
@dataclass(frozen=True)
class ExportDoc:
    """내보낼 문서 하나.

    Attributes:
        title: 문서 상단 제목.
        blocks: 본문 블록들(순서대로 렌더한다).
        footer: 문서 끝에 넣을 출처 한 줄. None 이면 아무것도 넣지 않는다.
    """

    title: str
    blocks: Sequence[Block]
    footer: str | None = None
```

`docx.py` `build_docx` 끝(`buffer` 만들기 직전):

```python
    if doc.footer:
        paragraph = document.add_paragraph()
        run = paragraph.add_run(doc.footer)
        run.font.size = Pt(8)
        run.font.color.rgb = RGBColor(0x80, 0x80, 0x80)
```

`from docx.shared import RGBColor` 추가.

`hwpx.py` `build_hwpx` 의 `return` 직전:

```python
    if doc.footer:
        document.add_paragraph(doc.footer)
```

(hwpx 는 서식을 지정하지 않는 기존 방침을 유지한다.)

- [ ] **Step 4: build/service/route 배선**

`build.py` 의 세 함수에 `source: str | None = None` 키워드 인자를 더하고
`ExportDoc(title=..., blocks=blocks, footer=source or None)` 로 넘긴다.
docstring 의 Args 에 `source: 문서 끝에 넣을 출처. None/빈 문자열이면 넣지 않는다.` 추가.

`service.py` 의 `export_exam` / `export_variants` / `export_note` 에 같은 인자를 더해
`build_*_doc(..., source=source)` 로 전달한다.

`main.py`:

```python
#: 내보내기 출처(선택). 문서 끝에 한 줄로 들어간다.
SourceQuery = Annotated[str | None, Query(max_length=100)]


def _clean_source(value: str | None) -> str | None:
    """출처 문자열을 정리한다. 개행을 지우고, 비면 None 으로 만든다."""
    if value is None:
        return None
    cleaned = " ".join(value.split())
    return cleaned or None
```

6개 export 라우트(`export_file_docx`, `export_file_hwpx`, `export_variants_docx`,
`export_variants_hwpx`, `export_note_docx`, `export_note_hwpx`)에 `source: SourceQuery = None`
을 더하고 `_export_response(..., source=_clean_source(source))` 로 넘긴다.
`_export_response` 에도 `source` 인자를 더해 `exporter(node_id, fmt=..., include=..., source=source)`
로 전달한다.

- [ ] **Step 5: 백엔드 검증**

Run: `cd app/core && python -m pytest -q && ruff check . && mypy .`
Expected: 전부 통과

- [ ] **Step 6: 프론트 테스트 작성**

`app/web/src/components/center/ExportButton.test.tsx` 에 추가:

```tsx
it('출처를 입력하면 내보내기 요청에 실려 간다', async () => {
  const spy = vi.spyOn(api, 'exportDocument').mockResolvedValue({
    blob: new Blob(['x']),
    filename: 'a.docx',
  });
  render(<ExportButton target="exam" id="n1" name="시험지" />);
  await userEvent.click(screen.getByRole('button', { name: /내보내기/ }));
  await userEvent.type(screen.getByLabelText('출처'), 'HY EDU');
  await userEvent.click(screen.getByRole('menuitem', { name: '문제만 · DOCX' }));
  expect(spy).toHaveBeenCalledWith('exam', 'n1', 'docx', 'problems', 'HY EDU');
});
```

기존 테스트 파일의 렌더 방식·모킹 관례를 먼저 읽고 그것에 맞춘다.

- [ ] **Step 7: 프론트 구현**

`api.ts` 의 `exportDocument` 에 다섯 번째 인자 `source?: string` 을 더해
값이 있을 때만 쿼리스트링 `&source=<encodeURIComponent>` 를 붙인다.

`ExportButton.tsx`:
- `const [source, setSource] = useState(() => localStorage.getItem('export.source') ?? '')`
  (SSR 안전: `useEffect` 로 읽어 초기화하거나 `typeof window` 가드. 이 프로젝트는
  `'use client'` 컴포넌트지만 Next 정적 내보내기라 초기 렌더가 서버에서 돈다 —
  **`useEffect` 로 읽는 쪽을 쓴다.**)
- 드롭다운 맨 위에 라벨 `출처` 가 붙은 `<input>` 을 둔다(`aria-label="출처"`,
  placeholder `예: HY EDU`, `maxLength={100}`).
- `run()` 에서 `api.exportDocument(target, id, item.format, item.include, source.trim() || undefined)`
  를 호출하고, 성공 시 `localStorage.setItem('export.source', source.trim())`.
- 입력 중에는 드롭다운이 닫히지 않아야 한다(바깥 클릭 핸들러가 input 을 포함하는지 확인).

- [ ] **Step 8: 프론트 검증**

Run: `cd app/web && npm run check`
Expected: 전부 통과

- [ ] **Step 9: 커밋**

```bash
git add app/core app/web
git commit -m "feat(api,web): 내보내기 문서에 출처 한 줄 추가"
```

---

### Task 5: 변형 문제 일괄 생성

설계 §3-1. 가장 큰 태스크다. 백엔드(다중 문항 작업) → 프론트(선택 UI) 순으로 간다.

**Files:**
- Modify: `app/core/schemas.py` (`JobCreate.problem_numbers` 를 variant 에도 허용)
- Modify: `app/core/main.py:698-730` (variant 작업 생성)
- Modify: `app/core/ai_service.py` (`plan_variant_job` / `variant_batch_events` 다중 문항)
- Modify: `app/core/jobs.py` (`variant_batch_factory` 인자)
- Modify: `app/web/src/store/workspace.ts` (변형 모드 상태·액션)
- Modify: `app/web/src/components/center/SolutionsTab.tsx` (헤더 + 체크박스)
- Modify: `app/web/src/lib/variant.ts` (`'all'` 처리)
- Test: `app/core/tests/test_variant.py`, `app/core/tests/test_jobs.py`, `app/web/src/store/variant.test.ts`

**Interfaces:**
- Consumes: `prompts.variant_user_text(no, *, mode, text, kind)` (기존, 불변)
- Produces (백엔드):
  - `JobCreate` 에서 `kind="variant"` 일 때 `problem_numbers: list[int] | None` 사용 가능.
    `problem_numbers` 가 오면 그것을, 없으면 `no` 하나를 대상으로 삼는다.
  - job `targets = {"numbers": [int, ...], "modes": [str, ...]}`, `total = len(numbers) * len(modes)`
- Produces (프론트):
  - `VariantPickKind = VariantMode | 'all'`
  - store: `variantPicking: boolean`, `variantPicked: number[]`, `variantKind: VariantPickKind`
  - store 액션: `startVariantPicking()`, `stopVariantPicking()`, `toggleVariantPick(no)`,
    `setVariantPicked(numbers)`, `setVariantKind(kind)`, `startVariantBatch()`

- [ ] **Step 1: 백엔드 실패 테스트 작성**

`app/core/tests/test_variant.py` 에 추가:

```python
def test_variant_job_accepts_multiple_problems(client: TestClient) -> None:
    """문항 여러 개 × 유형 여러 개를 한 작업으로 만든다(요청 1·2)."""
    node_id = ...  # 기존 업로드 픽스처
    response = client.post(
        "/api/jobs",
        json={
            "kind": "variant",
            "node_id": node_id,
            "problem_numbers": [1, 2],
            "modes": ["number", "condition"],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 4  # 2문항 × 2유형
    assert body["targets"]["numbers"] == [1, 2]
    assert body["targets"]["modes"] == ["number", "condition"]


def test_variant_job_single_problem_still_works(client: TestClient) -> None:
    """기존 단일 경로(no)를 깨지 않는다 — VariantPanel 이 계속 쓴다."""
    node_id = ...
    response = client.post(
        "/api/jobs",
        json={"kind": "variant", "node_id": node_id, "no": 1, "modes": ["number"]},
    )
    assert response.status_code == 200
    assert response.json()["total"] == 1
```

기존 `test_variant.py` 의 픽스처·스텁 방식(AI 호출 스텁)을 먼저 읽고 그대로 따른다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app/core && python -m pytest tests/test_variant.py -k multiple -v`
Expected: FAIL

- [ ] **Step 3: 백엔드 구현**

`schemas.py` `JobCreate` docstring 을 고치고 `problem_numbers` 설명을 갱신한다
(`solve`: null=전체 / `variant`: 대상 문항들, null 이면 `no` 를 쓴다).

`main.py` variant 분기:

```python
        numbers = list(payload.problem_numbers or ([] if payload.no is None else [payload.no]))
        if not numbers:
            raise bad_request(
                "no_required",
                "변형 작업에는 문항 번호가 필요합니다.",
                "problem_numbers 또는 no 를 넣어 주세요.",
            )
        kinds = list(payload.modes or ["number"])
        mode, problems, node_name = await run_in_threadpool(
            ai_service.plan_variant_batch, payload.node_id, numbers
        )
        record = await run_in_threadpool(
            _insert_job,
            kind="variant",
            node_id=payload.node_id,
            node_name=node_name,
            targets={"numbers": numbers, "modes": kinds},
            params=params,
            total=len(numbers) * len(kinds),
        )
```

`ai_service.py` 에 `plan_variant_batch(node_id, numbers) -> tuple[str, list[dict], str]`
를 더한다. 기존 `plan_variant_job` 을 지우지 말고 그것을 부르는 얇은 래퍼로 두거나,
반대로 `plan_variant_job` 이 `plan_variant_batch` 를 쓰게 한다 — **기존 호출부가
깨지지 않는 쪽**을 고른다.

`variant_batch_events` 는 `problem` 하나 대신 `problems` 목록을 받아
(문항 → 유형) 순으로 순차 처리한다. 문항마다 기존 단일 로직을 그대로 돌리면 된다.
`jobs.variant_batch_factory` 의 인자도 맞춘다.

`force=false` 면 이미 저장된 (문항, 유형)은 건너뛴다 — 기존 solve 의 스킵 규칙을
찾아 같은 방식으로 구현한다.

- [ ] **Step 4: 백엔드 검증**

Run: `cd app/core && python -m pytest -q && ruff check . && mypy .`
Expected: 전부 통과 (기존 변형 테스트도 그대로 통과해야 한다)

- [ ] **Step 5: 프론트 스토어 테스트 작성**

`app/web/src/store/variant.test.ts` 에 추가:

```ts
it('변형 모드와 담기 모드는 동시에 켜지지 않는다', () => {
  useWorkspace.getState().startNotePicking();
  expect(useWorkspace.getState().notePicking).toBe(true);
  useWorkspace.getState().startVariantPicking();
  expect(useWorkspace.getState().variantPicking).toBe(true);
  expect(useWorkspace.getState().notePicking).toBe(false);
});

it('변형 모드를 다시 켜면 이전 선택이 남지 않는다', () => {
  const store = useWorkspace.getState();
  store.startVariantPicking();
  store.toggleVariantPick(2);
  expect(useWorkspace.getState().variantPicked).toEqual([2]);
  useWorkspace.getState().startVariantPicking();
  expect(useWorkspace.getState().variantPicked).toEqual([]);
});

it("유형 '전체' 는 3종 모두를 보낸다", async () => {
  // startVariantBatch 가 api.createJob 에 modes 3개를 넘기는지 확인.
  // 이 파일의 기존 api 모킹 방식을 그대로 쓴다.
});
```

- [ ] **Step 6: 프론트 스토어 구현**

`workspace.ts` 에 상태와 액션을 더한다.

```ts
  /** 변형 일괄 생성 모드인지. 담기 모드(notePicking)와 상호 배타다. */
  variantPicking: boolean;
  /** 변형을 만들 문항 번호들(오름차순). */
  variantPicked: number[];
  /** 만들 변형 유형. 'all' 은 3종 모두를 뜻한다. */
  variantKind: VariantPickKind;
```

```ts
  startVariantPicking() {
    // 이전 선택을 버리고 시작한다(담기 모드와 같은 규칙 — 엉뚱한 문항 방지).
    set({ variantPicking: true, variantPicked: [], notePicking: false, notePicked: [] });
  },
  stopVariantPicking() {
    set({ variantPicking: false, variantPicked: [] });
  },
```

`startNotePicking` 에도 `variantPicking: false, variantPicked: []` 를 더한다(Task 2 의
주석대로).

`startVariantBatch()` 는 `variantKind === 'all' ? VARIANT_MODES : [variantKind]` 를
`modes` 로, `variantPicked` 를 `problem_numbers` 로 넣어 `POST /api/jobs` 를 부르고,
성공하면 `stopVariantPicking()` 한다. `selectFile` 의 초기화 목록에도 변형 모드 두 필드를
더한다(다른 시험지를 열면 선택을 버린다).

`lib/variant.ts` 에 `export type VariantPickKind = VariantMode | 'all';` 와
`VARIANT_PICK_LABEL`(`숫자`/`조건`/`숫자+조건`/`전체`)을 더한다.

- [ ] **Step 7: 프론트 UI 구현**

`SolutionsTab.tsx` 헤더 줄(현재 "풀이 완료 N/M" 줄)에 `[변형 만들기]` 버튼을 더하고,
`variantPicking` 이면 아래 줄에 유형 버튼 4개 + 선택 개수 + `[전체 선택]`/`[선택 해제]`
+ `[N개 문항 변형 생성]` + `[취소]` 를 그린다.

`SolutionRow` 의 체크박스 조건을 `picking || variantPicking` 으로 넓히고, 어느 모드냐에
따라 `onTogglePick` 대상을 가른다. 변형 모드 행 배경은 담기(rose)와 구분되게
`bg-violet-50/60` 을 쓴다. `aria-label` 도 모드에 맞춘다(`N번 변형 선택`).

- [ ] **Step 8: 프론트 검증**

Run: `cd app/web && npm run check`
Expected: 전부 통과

- [ ] **Step 9: 커밋**

```bash
git add app/core app/web
git commit -m "feat(api,web): 문항 다중선택 변형 일괄 생성(숫자·조건·숫자+조건·전체)"
```

---

### Task 6: 트리 다중 선택·이동

설계 §3-7. 프론트만. 백엔드 `move` 는 그대로 쓰고 여러 번 부른다.

**Files:**
- Modify: `app/web/src/components/tree/FileTreePanel.tsx`
- Modify: `app/web/src/components/tree/TreeRow.tsx`
- Modify: `app/web/src/store/workspace.ts` (`moveNodes`)
- Test: `app/web/src/store/workspace.test.ts`

**Interfaces:**
- Consumes: `moveNode(id: string, parentId: string | null)` (기존)
- Produces: `moveNodes(ids: string[], parentId: string | null): Promise<void>` — 순차 호출,
  끝나고 트리 1회 새로고침, 실패는 모아 토스트 1건
- Produces: `NODE_MIME` 의 값 형식이 **JSON 배열 문자열**로 바뀐다 (`'["a","b"]'`)

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
it('여러 노드를 한 번에 옮기고 트리는 한 번만 새로 고친다', async () => {
  const move = vi.spyOn(api, 'moveNode').mockResolvedValue(undefined);
  const tree = vi.spyOn(api, 'getTree').mockResolvedValue({ nodes: [] });
  await useWorkspace.getState().moveNodes(['a', 'b', 'c'], 'folder1');
  expect(move).toHaveBeenCalledTimes(3);
  expect(tree).toHaveBeenCalledTimes(1);
});

it('일부가 실패해도 나머지는 옮기고 실패만 알린다', async () => {
  vi.spyOn(api, 'moveNode')
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('cycle_detected'));
  const toast = vi.fn();
  useWorkspace.setState({ showToast: toast });
  await useWorkspace.getState().moveNodes(['a', 'b'], 'folder1');
  expect(toast).toHaveBeenCalledTimes(1);
});
```

기존 `workspace.test.ts` 의 api 모킹 관례를 먼저 읽고 맞춘다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd app/web && npx vitest run src/store/workspace.test.ts -t '여러 노드'`
Expected: FAIL — `moveNodes is not a function`

- [ ] **Step 3: 스토어 구현**

```ts
  /**
   * 여러 노드를 한 폴더로 옮긴다.
   *
   * 서버 `move` 를 순차로 부른다(순환 방지가 서버에 있다). 실패한 것만 모아
   * 토스트 한 건으로 알리고, 성공분은 그대로 둔다. 트리는 끝나고 한 번만 다시 읽는다.
   */
  async moveNodes(ids: string[], parentId: string | null) { ... },
```

- [ ] **Step 4: 선택·드래그 UI 구현**

`FileTreePanel`:
- `const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())`
- 행 클릭 핸들러에 `event` 를 넘겨 `ctrlKey || metaKey` 는 토글, `shiftKey` 는
  화면에 보이는 순서(=평탄화한 트리 순서) 기준 범위 선택, 그 외는 단일 선택으로 리셋.
  범위 선택을 위해 `buildTree` 결과를 평탄화한 배열을 `useMemo` 로 만들어 둔다.
- 섹션 전환(`setSection`) 시 선택을 비운다.
- 드롭 핸들러: `JSON.parse(event.dataTransfer.getData(NODE_MIME))` 로 배열을 받아
  `moveNodes(ids, target)` 를 부른다. **옛 형식(단일 문자열)도 파싱 실패 시
  단일 id 로 처리**해 붙여넣기 사고를 막는다.

`TreeRow`:
- `selectedIds` 와 `onRowClick(event, item)` 을 props 로 받는다.
- `onDragStart` 에서 끌기 시작한 노드가 선택에 있으면 선택 전체를, 아니면 그 노드
  하나만 `JSON.stringify([...])` 로 싣는다.
- 선택된 행은 `bg-blue-100` 계열로 표시하고 `aria-selected` 를 준다.
- 2개 이상 끌 때는 드래그 이미지 대신 행 옆에 `N개` 배지를 띄운다(간단히
  `title` 속성과 배지 span 으로 충분하다).

- [ ] **Step 5: 검증**

Run: `cd app/web && npm run check`
Expected: 전부 통과

- [ ] **Step 6: 커밋**

```bash
git add app/web
git commit -m "feat(web): 트리에서 여러 노드를 골라 한 번에 이동"
```

---

### Task 7: 배포

`memory/deploy-topology.md` 의 순서를 그대로 따른다. **백엔드 먼저, 프론트 나중.**

- [ ] **Step 1: 전체 검증**

```bash
cd app/core && ruff check . && mypy . && python -m pytest -q
cd ../web && npm run check
```
Expected: 전부 통과. 하나라도 실패하면 배포하지 않는다.

- [ ] **Step 2: push (백엔드 CI 트리거)**

```bash
git push origin main
```

`app/core/**` 가 바뀌었으므로 CI 빌드 → GHCR → k8s-helm tag 자동 커밋 → ArgoCD 자동배포가
돈다. CI 약 1분, **ArgoCD 반영까지 추가 3~8분.**

- [ ] **Step 3: 백엔드 동기화 확인 (프론트보다 먼저)**

`curl -s --http1.1 <API>/openapi.json` 을 받아 **파싱해서** 새 계약이 올라왔는지 본다.

확인할 것: `/api/files/{node_id}/export.docx` 의 파라미터에 `source` 가 있는지.
`grep '"source"'` 같은 부분 문자열 검사는 다른 스키마에 걸려 거짓 양성이 난다 —
JSON 을 파싱해 해당 경로의 parameters 배열에서 이름을 확인할 것.

테일넷 안(이 PC)에서 브라우저로 테스트하면 503 이 뜬다(MagicDNS → serve 경로).
curl/httpx 로 확인하거나 공인 IP 를 고정한다.

- [ ] **Step 4: 프론트 배포**

```bash
cd app/web && npx vercel --prod --yes
```

**`--token` 을 넘기지 말 것**(만료됨). 저장 인증을 쓴다. 먼저 `npx vercel whoami` 로
인증을 확인한다.

- [ ] **Step 5: 배포 성공을 마커로 검증**

HTTP 200 은 증거가 못 된다(옛 번들이 그대로 떠 있을 수 있다). 프로덕션 번들을 받아
**이번에 넣은 새 문구가 들어갔는지** grep 한다. 마커로 쓸 문자열:

```
문항만 있는 PDF를 올려 주세요
```

이 문자열이 프로덕션 JS 번들에 없으면 배포가 조용히 실패한 것이다.

- [ ] **Step 6: 결과 보고**

배포된 URL, 확인한 마커, 백엔드 openapi 확인 결과를 사용자에게 보고한다.
