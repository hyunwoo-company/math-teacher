/**
 * 실제 백엔드로 (a) 기본 공급자=구독 (b) API 선택 시 과금 안내 (c) "6번" 자동 첨부 확인.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const SHOTS = new URL('../shots/', import.meta.url).pathname.replace(/^\//, '');
await mkdir(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
// 이전 세션의 prefs(provider 저장값)를 지운 상태에서 기본값을 확인한다.
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tree').waitFor({ timeout: 30000 });
  await page.evaluate(() => window.localStorage.removeItem('math-teacher.uiPrefs'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tree').waitFor({ timeout: 30000 });

  // (b) 기본값 = 구독
  const providerSelect = page.locator('select[aria-label="공급자 선택"]');
  check('기본 공급자가 구독', (await providerSelect.inputValue()) === 'subscription', await providerSelect.inputValue());
  check('구독 기본값에서는 과금 안내가 없다', (await page.locator('[role="note"]').count()) === 0);

  await page.getByRole('treeitem', { name: /풍문고/ }).click();
  await page.getByRole('button', { name: '22', exact: true }).waitFor({ timeout: 30000 });

  // (a) API 키 선택 -> 과금 안내
  await providerSelect.selectOption('apikey');
  const note = page.locator('[role="note"]');
  await note.waitFor({ timeout: 5000 });
  console.log('안내문:', (await note.innerText()).replace(/\n/g, ' | '));
  const noteText = await note.innerText();
  check('과금 안내 표시', noteText.includes('사용량만큼 요금이 청구됩니다'));
  check('문항당 예상 금액(원) 표시', /문항당 약\s*₩/.test(noteText));
  check('전체 예상 금액(22문항) 표시', /22문항 전체 약\s*₩/.test(noteText));
  check('추정임을 명시', noteText.includes('실측 기반 추정'));
  check('구독 대비 안내', noteText.includes('구독 모드로 바꾸면'));
  await page.screenshot({ path: `${SHOTS}22-apikey-notice.png` });

  // 모델을 바꾸면 금액도 바뀐다
  const before = await note.innerText();
  await page.locator('select[aria-label="모델 선택"]').selectOption('claude-haiku-4-5');
  await page.waitForTimeout(300);
  const after = await note.innerText();
  check('모델 변경 시 예상 금액 갱신', before !== after, after.replace(/\n/g, ' | '));

  // 구독으로 되돌리면 안내가 사라진다
  await providerSelect.selectOption('subscription');
  await page.waitForTimeout(300);
  check('구독으로 돌리면 안내가 사라진다', (await page.locator('[role="note"]').count()) === 0);
  await page.locator('select[aria-label="모델 선택"]').selectOption('claude-opus-5');

  // (c) "6번" 자동 첨부 — 대화 기록을 비우고 시작
  const clearButton = page.getByRole('button', { name: '대화 기록 지우기' });
  if ((await clearButton.count()) > 0) {
    await clearButton.click();
    await page.waitForTimeout(800);
  }

  const input = page.getByPlaceholder(/질문을 입력하세요/);
  await input.fill('6번 문제의 조건을 한 줄로 요약해줘.');
  await page.getByText('6번 문항을 함께 보냅니다').waitFor({ timeout: 3000 });
  check('입력 중 첨부 안내 표시', true);
  await page.screenshot({ path: `${SHOTS}23-mention-hint.png` });

  await input.press('Enter');
  await page.locator('li', { hasText: '6번 문제의 조건을' }).first().waitFor({ timeout: 10000 });
  const tagCount = await page.getByText('· 6번').count();
  check('메시지에 · 6번 태그', tagCount > 0, `${tagCount}개`);

  // 실제 응답을 기다려 이미지가 전달됐는지 확인한다(구독 모드 호출).
  await page
    .getByRole('button', { name: '전송' })
    .waitFor({ state: 'visible', timeout: 180000 });
  await page.waitForTimeout(1000);
  const chat = await page.locator('ul').last().innerText();
  const complained = /전달되지 않아|전달되지 않았|확인할 수 없습니다/.test(chat);
  check('AI 가 "이미지가 안 왔다" 고 하지 않는다', !complained, complained ? chat.slice(-260) : '정상');
  console.log('AI 응답 꼬리:', chat.replace(/\n/g, ' ').slice(-300));
  await page.screenshot({ path: `${SHOTS}24-mention-answer.png` });
} catch (error) {
  check('예외 없이 완주', false, String(error).slice(0, 300));
  await page.screenshot({ path: `${SHOTS}28-features-failure.png` }).catch(() => {});
}

check('페이지 에러 없음', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();

const failed = results.filter((result) => !result.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length === 0 ? 0 : 1);
