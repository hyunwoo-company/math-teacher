/**
 * 실제 브라우저(Chromium)로 목 모드 UI 를 끝까지 돌려 본다.
 * 자동 테스트로 못 잡는 부분(pdf.js canvas 렌더, KaTeX 폰트, 실제 레이아웃)을 확인한다.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
// 스크린샷은 gitignore 되는 tmp/ 로 떨어뜨린다.
const SHOTS = new URL('../../tmp/shots/', import.meta.url).pathname.replace(/^\//, '');
await mkdir(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

const failedRequests = [];
page.on('requestfailed', (request) => {
  failedRequests.push(`${request.url()} :: ${request.failure()?.errorText}`);
});
page.on('response', (response) => {
  if (response.status() >= 400) failedRequests.push(`${response.url()} :: HTTP ${response.status()}`);
});

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  // 1) 3분할 레이아웃
  await page.getByRole('tree', { name: '시험지 폴더 트리' }).waitFor({ timeout: 15000 });
  check('트리 패널 렌더', true);
  check(
    '목 모드 배너 표시',
    await page.getByText('목 모드').first().isVisible(),
  );

  // 2) 중첩 트리 접기/펼치기
  const subject = page.getByRole('treeitem', { name: /공통수학1/ });
  await subject.waitFor();
  check('2단 중첩 폴더 표시', await subject.isVisible());
  check('접힌 폴더의 파일은 숨김', (await page.getByRole('treeitem', { name: /풍문고/ }).count()) === 0);

  await subject.click();
  const fileRow = page.getByRole('treeitem', { name: /풍문고/ });
  await fileRow.waitFor();
  check('펼치기 동작', await fileRow.isVisible());
  check('중첩 깊이 aria-level=3', (await fileRow.getAttribute('aria-level')) === '3');

  await page.screenshot({ path: `${SHOTS}01-tree.png`, fullPage: false });

  // 3) 파일 클릭 -> PDF 뷰어 (pdf.js 실제 렌더)
  await fileRow.click();
  await page.getByRole('heading', { name: '[2026-1-1-M][공수1][풍문고].pdf' }).waitFor();
  await page.locator('canvas').first().waitFor({ timeout: 20000 });
  // 캔버스가 실제로 뭔가 그렸는지(흰 화면이 아닌지) 픽셀로 확인
  // 재렌더/StrictMode 로 캔버스가 지워지는 경우를 잡기 위해 잠시 기다렸다 측정한다.
  await page.waitForTimeout(2500);
  const canvasInfo = await page.evaluate(() =>
    [...document.querySelectorAll('canvas')].map((canvas) => {
      const context = canvas.getContext('2d');
      if (!context || canvas.width === 0) return 0;
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) {
        // 알파가 0 인 픽셀은 "아무것도 안 그려진" 것이다. 이걸 세면 빈 캔버스도 통과해 버린다.
        if (data[i + 3] > 0 && (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240)) ink += 1;
      }
      return ink;
    }),
  );
  check(
    'pdf.js 캔버스 렌더(모든 쪽에 내용 있음)',
    canvasInfo.length === 7 && canvasInfo.every((ink) => ink > 1000),
    `쪽별 잉크 픽셀 ${canvasInfo.join(', ')}`,
  );
  const renderErrors = await page.getByText(/쪽을 그리지 못했습니다/).count();
  check('렌더 실패 메시지 없음', renderErrors === 0, `${renderErrors}건`);
  const pageCount = await page.locator('canvas').count();
  check('전체 페이지 렌더', pageCount === 7, `canvas ${pageCount}개`);
  await page.screenshot({ path: `${SHOTS}02-pdf.png` });

  // 4) 확대/축소
  await page.getByTitle('확대').click();
  await page.waitForTimeout(400);
  check('확대 동작', (await page.getByText('125%').count()) > 0);
  await page.getByRole('button', { name: '너비 맞춤' }).click();
  await page.waitForTimeout(600);

  // 5) 문제 클릭 -> 채팅 컨텍스트 + 하이라이트
  await page.getByRole('button', { name: '7', exact: true }).click();
  await page.getByText('문제 이미지와 기존 풀이가 함께 전달됩니다').waitFor();
  check('문제 클릭 -> AI 패널 컨텍스트', true);
  const highlighted = await page.locator('button[title*="7번 문제"]').count();
  check('PDF 위 문제 하이라이트 오버레이', highlighted > 0, `${highlighted}개`);
  await page.screenshot({ path: `${SHOTS}03-problem-context.png` });

  // 6) 전체 문제풀이 스트리밍
  await page.getByRole('button', { name: /전체 문제풀이/ }).click();
  await page.getByRole('button', { name: '풀이 중단' }).waitFor({ timeout: 5000 });
  await page.getByText(/풀이 중 \d+\/22/).first().waitFor({ timeout: 15000 });
  check('스트리밍 진행률 표시', true);

  // 델타가 실시간으로 누적되는지 두 시점 비교
  const bodyLocator = page.locator('li:has-text("생성 중")').first();
  await bodyLocator.waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}04-streaming.png` });
  const lengthA = (await page.locator('main').innerText()).length;
  await page.waitForTimeout(1200);
  const lengthB = (await page.locator('main').innerText()).length;
  check('delta 실시간 누적', lengthB > lengthA, `${lengthA} -> ${lengthB}자`);

  await page.getByText('완료 22/22').waitFor({ timeout: 120000 });
  check('22문항 전부 완료', true);

  // 7) KaTeX 렌더 확인
  await page.getByRole('button', { name: '1번 문제 풀이 펼치기', exact: true }).click();
  await page.locator('.katex-display').first().waitFor({ timeout: 5000 });
  const katexCount = await page.locator('.katex').count();
  const displayCount = await page.locator('.katex-display').count();
  check('KaTeX 인라인 렌더', katexCount > 0, `${katexCount}개`);
  check('KaTeX 디스플레이 렌더', displayCount > 0, `${displayCount}개`);
  const fontLoaded = await page.evaluate(() =>
    document.fonts.check('12px KaTeX_Main'),
  );
  check('KaTeX 폰트 로드(로컬 번들)', fontLoaded === true, `document.fonts.check=${fontLoaded}`);
  await page.screenshot({ path: `${SHOTS}05-solution-katex.png` });

  // 8) 채팅
  const input = page.getByPlaceholder(/질문을 입력하세요/);
  await input.fill('7번 문제에서 판별식이 왜 음수인가요?');
  await input.press('Enter');
  await page.getByText('7번 문제에서 판별식이 왜 음수인가요?').waitFor();
  await page.getByText(/핵심은/).waitFor({ timeout: 30000 });
  check('채팅 전송/응답 스트리밍', true);
  await page.screenshot({ path: `${SHOTS}06-chat.png` });

  // 9) 누적 사용량(구독 모드 표기)
  const usage = await page.locator('footer').last().innerText();
  check('사용량 표시', usage.includes('구독 사용') || usage.includes('토큰'), usage.replace(/\n/g, ' | '));

  // 10) 우측 패널 리사이즈
  const separator = page.getByRole('separator', { name: 'AI 패널 너비 조절' });
  const box = await separator.boundingBox();
  await page.mouse.move(box.x + 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x - 150, box.y + 200, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const newBox = await separator.boundingBox();
  check('AI 패널 리사이즈', Math.abs(newBox.x - box.x) > 100, `${Math.round(box.x)} -> ${Math.round(newBox.x)}`);
  await page.screenshot({ path: `${SHOTS}07-resized.png` });

  // 11) 삭제 확인 다이얼로그(폴더 경고)
  await page.getByRole('treeitem', { name: /2026-1학기/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '삭제' }).click();
  const dialog = page.getByRole('dialog', { name: '삭제 확인' });
  await dialog.waitFor();
  const dialogText = await dialog.innerText();
  check('폴더 삭제 경고 문구', dialogText.includes('모두 함께 삭제'), dialogText.replace(/\n/g, ' '));
  await page.screenshot({ path: `${SHOTS}08-delete-dialog.png` });
  await dialog.getByRole('button', { name: '취소' }).click();
} catch (error) {
  check('예외 없이 완주', false, String(error).slice(0, 400));
  await page.screenshot({ path: `${SHOTS}99-failure.png` }).catch(() => {});
}

check(
  '콘솔 에러 없음',
  consoleErrors.length === 0,
  consoleErrors.slice(0, 5).join(' || '),
);
check(
  '실패한 네트워크 요청 없음',
  failedRequests.length === 0,
  failedRequests.slice(0, 5).join(' || '),
);

await browser.close();

const failed = results.filter((result) => !result.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length === 0 ? 0 : 1);
