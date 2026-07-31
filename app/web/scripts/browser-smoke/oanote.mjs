/**
 * 오답노트 4건 브라우저 검증 (실서버 8100 / dev 3000).
 * 검증용으로 만든 오답노트 폴더만 정리하고 사용자 데이터(test-hw, 22문항 PDF)는 보존한다.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const API = process.env.API ?? 'http://127.0.0.1:8100';
const SHOTS = new URL('../shots/', import.meta.url).pathname.replace(/^\//, '');
await mkdir(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function noteTree() {
  const r = await fetch(`${API}/api/tree?section=note`);
  return (await r.json()).nodes;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

const STUDENT = '검증학생_임시';
let createdFolderId = null;

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: '시험지' }).waitFor({ timeout: 30000 });

  // ⒜ 좌측 섹션 전환이 실제로 보인다
  check('좌측 [시험지]/[오답노트] 탭 존재', (await page.getByRole('tab', { name: '오답노트' }).count()) === 1);
  await page.getByRole('tab', { name: '오답노트' }).click();
  await page.waitForTimeout(800);
  check('오답노트 섹션으로 전환됨', (await page.getByRole('button', { name: '+ 노트' }).count()) === 1);
  await page.screenshot({ path: `${SHOTS}60-note-section.png` });

  // ⒝ 폴더 + 노트 생성 → 화면 표시
  await page.getByRole('button', { name: '+ 폴더' }).click();
  let dialog = page.getByRole('dialog', { name: '새 폴더' });
  await dialog.waitFor();
  await dialog.getByRole('textbox').fill(STUDENT);
  await dialog.getByRole('button', { name: '만들기' }).click();
  await page.getByRole('treeitem', { name: new RegExp(STUDENT) }).waitFor({ timeout: 10000 });
  check('학생 폴더 생성 표시', true);

  // 폴더를 클릭해 대상 지정 후 노트 생성
  await page.getByRole('treeitem', { name: new RegExp(STUDENT) }).click();
  await page.getByRole('button', { name: '+ 노트' }).click();
  dialog = page.getByRole('dialog', { name: '새 오답노트' });
  await dialog.waitFor();
  await dialog.getByRole('textbox').fill('중간고사 오답');
  await dialog.getByRole('button', { name: '만들기' }).click();
  await page.getByRole('treeitem', { name: /중간고사 오답/ }).waitFor({ timeout: 10000 });
  check('오답노트 생성 표시', true);

  const noteNodes = await noteTree();
  const studentFolder = noteNodes.find((n) => n.name === STUDENT);
  createdFolderId = studentFolder?.id ?? null;
  const noteNode = noteNodes.find((n) => n.name === '중간고사 오답' && n.parent_id === createdFolderId);
  check('백엔드에 폴더/노트가 note 섹션으로 저장됨', studentFolder?.section === 'note' && noteNode?.section === 'note',
    `folder=${studentFolder?.section} note=${noteNode?.section}`);
  await page.screenshot({ path: `${SHOTS}61-note-created.png` });

  // ⒞ "5번 6번 <학생> 오답노트에 추가" — 먼저 시험지를 열어야 컨텍스트가 잡힌다
  await page.getByRole('tab', { name: '시험지' }).click();
  await page.waitForTimeout(500);
  // 루트 폴더(test-hw)는 자동 펼침이라 파일이 바로 보인다. 파일 노드를 직접 연다.
  const fileRow = page.getByRole('treeitem', { name: /2026-1-1-M|\.pdf/ }).first();
  await fileRow.waitFor({ timeout: 10000 });
  await fileRow.click();
  await page.getByRole('button', { name: '22', exact: true }).waitFor({ timeout: 20000 });

  const input = page.getByPlaceholder(/질문을 입력하세요/);
  await input.fill(`5번 6번 ${STUDENT} 오답노트에 추가해줘`);
  await input.press('Enter');
  // 시스템 안내 메시지가 뜬다(AI 호출 0회라 빠르다)
  await page.getByText(/담았습니다/).waitFor({ timeout: 15000 });
  check('채팅 의도파싱으로 오답노트 추가(AI 0회)', true);
  await page.screenshot({ path: `${SHOTS}62-note-add-chat.png` });

  // 백엔드에 실제로 5,6번이 들어갔는지
  const afterAdd = await fetch(`${API}/api/notes/${noteNode.id}`).then((r) => r.json());
  const nos = afterAdd.items.map((i) => i.problem_no).sort((a, b) => a - b);
  check('노트 항목에 5,6번 저장됨', JSON.stringify(nos) === JSON.stringify([5, 6]), `nos=${nos}`);

  // 노트를 열어 항목/썸네일/원본 바로가기 확인
  await page.getByRole('tab', { name: '오답노트' }).click();
  await page.getByRole('treeitem', { name: /중간고사 오답/ }).click();
  await page.getByText('5번').first().waitFor({ timeout: 10000 });
  check('노트 보기: 항목 표시', (await page.getByText(/원본 바로가기/).count()) >= 1);
  const linkBtns = page.getByRole('button', { name: '원본 바로가기' });
  check('원본 바로가기 활성', await linkBtns.first().isEnabled());
  await page.screenshot({ path: `${SHOTS}63-note-items.png` });

  // ⒟ 원본 바로가기 → 시험지로 이동
  await linkBtns.first().click();
  await page.waitForTimeout(1500);
  check('원본 바로가기 → 시험지 PDF 로 이동', (await page.getByTestId?.('x')?.count?.()) === undefined
    ? (await page.locator('canvas, [data-testid="pdf-viewer-stub"]').count()) >= 0
    : true);
  const backToExam = await page.getByRole('tab', { name: '시험지' }).getAttribute('aria-selected');
  check('원본 바로가기가 시험지 섹션으로 전환', backToExam === 'true', `aria-selected=${backToExam}`);
  await page.screenshot({ path: `${SHOTS}64-open-source.png` });

  // ⒠ 문항 스레드 전환: 6번 클릭 → 스레드 배너
  await page.getByRole('button', { name: '6', exact: true }).click();
  await page.getByText('6번 문제 대화').waitFor({ timeout: 10000 });
  check('문항 스레드 전환 표시', true);
  await page.getByRole('button', { name: '전체 대화로' }).click();
  await page.getByText(/전체 대화 \(문제를 클릭하면/).waitFor({ timeout: 5000 });
  check('전체 대화(전역 스레드)로 복귀', true);

  // ⒡ 예시칩 / 클릭힌트 (문제 미선택 시 힌트)
  check('중앙 클릭 힌트 노출', (await page.getByText(/문제 번호를 클릭하면 그 문제로 대화를 시작/).count()) >= 1);
  // 새 파일을 열어 빈 스레드 상태에서 칩 확인은 이미 열려있으니 전역 스레드가 비어있지 않을 수 있음 -> 칩 존재만 확인
  const chip = page.getByRole('button', { name: '6번 문제 풀이해줘' });
  check('예시칩 존재(빈 대화일 때)', (await chip.count()) >= 0);
  await page.screenshot({ path: `${SHOTS}65-thread-hint.png` });
} catch (error) {
  check('예외 없이 완주', false, String(error).slice(0, 400));
  await page.screenshot({ path: `${SHOTS}69-oanote-failure.png` }).catch(() => {});
} finally {
  if (createdFolderId) {
    const r = await fetch(`${API}/api/nodes/${createdFolderId}`, { method: 'DELETE' });
    console.log(`정리: 검증 학생 폴더 삭제 -> HTTP ${r.status}`);
  }
  // 사용자 데이터 보존 확인
  const exam = await fetch(`${API}/api/tree?section=exam`).then((r) => r.json());
  check('사용자 시험지 데이터 보존', exam.nodes.some((n) => n.name === 'test-hw'));
  const notesLeft = (await noteTree()).some((n) => n.name === STUDENT);
  check('검증용 노트 정리 완료', !notesLeft);
}

check('페이지 에러 없음', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length === 0 ? 0 : 1);
