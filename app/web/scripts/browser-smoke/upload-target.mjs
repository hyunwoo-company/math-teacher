/**
 * ⒜ 업로드 대상 폴더 검증 (실제 백엔드 8100 / dev 3000).
 *
 * 사용자 데이터는 건드리지 않는다.
 *  - 검증용 폴더를 새로 만들어 그 안에 올리고, 끝나면 그 폴더만 삭제한다.
 *  - 기존 `test-hw` 폴더와 루트의 22문항 PDF 는 읽기만 한다.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const API = process.env.API ?? 'http://127.0.0.1:8100';
const SHOTS = new URL('../shots/', import.meta.url).pathname.replace(/^\//, '');
await mkdir(SHOTS, { recursive: true });

const PDF_PATH = new URL('../../public/mock/sample.pdf', import.meta.url).pathname.replace(/^\//, '');
const VERIFY_FOLDER = '업로드검증-임시';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function tree() {
  const response = await fetch(`${API}/api/tree`);
  return (await response.json()).nodes;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

let createdFolderId = null;

try {
  const before = await tree();
  console.log(
    '시작 트리:',
    before.map((n) => `${n.type}:${n.name}(parent=${n.parent_id ?? 'root'})`).join(' | '),
  );

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tree').waitFor({ timeout: 30000 });

  // 업로드 위치 표시가 있는지 (기본 = 최상위)
  await page.getByText('업로드 위치').waitFor({ timeout: 5000 });
  check('업로드 위치 표시 존재', true, await page.getByText(/→ /).first().innerText());

  // 검증용 폴더 생성
  await page.getByRole('button', { name: '+ 폴더' }).click();
  const dialog = page.getByRole('dialog', { name: '새 폴더' });
  await dialog.waitFor();
  await dialog.getByRole('textbox').fill(VERIFY_FOLDER);
  await dialog.getByRole('button', { name: '만들기' }).click();
  const folderRow = page.getByRole('treeitem', { name: new RegExp(VERIFY_FOLDER) });
  await folderRow.waitFor({ timeout: 10000 });
  createdFolderId = (await tree()).find((n) => n.name === VERIFY_FOLDER)?.id ?? null;
  check('검증용 폴더 생성', createdFolderId != null, `id=${createdFolderId}`);

  // 폴더를 클릭하면 업로드 위치가 그 폴더로 바뀐다
  await folderRow.click();
  await page.getByText(`→ ${VERIFY_FOLDER}`).waitFor({ timeout: 5000 });
  check('폴더 클릭 -> 업로드 위치 갱신', true, `→ ${VERIFY_FOLDER}`);
  await page.screenshot({ path: `${SHOTS}30-upload-target.png` });

  // 하단 버튼으로 업로드 (대상 = 그 폴더)
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '+ 파일 업로드' }).click();
  (await chooser).setFiles(PDF_PATH);

  // 업로드 + 추출이 끝날 때까지 기다린다.
  await page.getByText(new RegExp(`${VERIFY_FOLDER} 에 1개 업로드했습니다`)).waitFor({ timeout: 180000 });
  check('업로드 완료 토스트에 폴더명 포함', true);

  const after = await tree();
  const uploaded = after.filter((n) => n.type === 'file' && n.parent_id === createdFolderId);
  check(
    '실제로 그 폴더 안에 들어갔다 (parent_id 확인)',
    uploaded.length === 1,
    uploaded.map((n) => `${n.name} parent=${n.parent_id}`).join(', ') || '없음',
  );

  // 화면에서 "비어 있음" 이 사라졌는지
  await page.waitForTimeout(1200);
  const folderText = await page.getByRole('tree').innerText();
  const emptyAfterFolder = /업로드검증-임시[\s\S]{0,30}비어 있음/.test(folderText);
  check('폴더에 "비어 있음" 이 사라졌다', !emptyAfterFolder, folderText.replace(/\n/g, ' > '));
  await page.screenshot({ path: `${SHOTS}31-uploaded-into-folder.png` });

  // 사용자 데이터가 그대로인지 확인
  const userFolder = after.find((n) => n.name === 'test-hw');
  const userPdf = after.find((n) => n.name.includes('풍문고'));
  check('사용자 데이터 보존 (test-hw)', userFolder != null);
  check('사용자 데이터 보존 (루트 22문항 PDF)', userPdf != null, `parent=${userPdf?.parent_id ?? 'root'}`);
} catch (error) {
  check('예외 없이 완주', false, String(error).slice(0, 300));
  await page.screenshot({ path: `${SHOTS}39-upload-failure.png` }).catch(() => {});
} finally {
  // 검증용으로 만든 폴더만 정리한다(하위 파일 포함).
  if (createdFolderId) {
    const response = await fetch(`${API}/api/nodes/${createdFolderId}`, { method: 'DELETE' });
    console.log(`정리: 검증용 폴더 삭제 -> HTTP ${response.status}`);
  }
  const remaining = await tree();
  console.log(
    '종료 트리:',
    remaining.map((n) => `${n.type}:${n.name}(parent=${n.parent_id ?? 'root'})`).join(' | '),
  );
  check(
    '정리 후 사용자 데이터만 남았다',
    remaining.every((n) => n.name !== VERIFY_FOLDER),
  );
}

check('페이지 에러 없음', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();

// PDF 경로 확인용(존재하지 않으면 위에서 실패했을 것)
await readFile(PDF_PATH).catch(() => console.log('주의: 업로드용 샘플 PDF 를 찾지 못했습니다.'));

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length === 0 ? 0 : 1);
