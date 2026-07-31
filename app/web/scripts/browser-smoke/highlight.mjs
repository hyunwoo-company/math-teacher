/**
 * 하이라이트 좌표 검증 (실제 백엔드 + 실제 PDF).
 *
 * bbox 는 PyMuPDF(좌상단 원점) 값이고 MediaBox 는 595x841 이므로,
 * 화면상 하이라이트의 상대 위치는 bbox/MediaBox 비율과 같아야 한다.
 * 눈으로만 보지 않고 이 비율을 숫자로 비교한다.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const SHOTS = new URL('../shots/', import.meta.url).pathname.replace(/^\//, '');
await mkdir(SHOTS, { recursive: true });

const MEDIA = { w: 595, h: 841 };
/** 백엔드 /api/files 응답에서 확인한 실제 bbox. */
const EXPECTED = [
  { no: 1, page: 1, bbox: [32, 69, 290, 142] },
  { no: 4, page: 1, bbox: [303, 68, 562, 223] },
  { no: 22, page: 7, bbox: [31, 81, 290, 192] },
];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

/** 문제 번호 버튼을 눌러 하이라이트의 상대 위치를 잰다. */
async function measure(no, pageNumber) {
  await page.getByRole('button', { name: String(no), exact: true }).first().click();
  await page.waitForTimeout(500);
  const overlay = page.locator(`button[title^="${no}번 문제 ·"]`);
  await overlay.waitFor({ timeout: 10000 });
  const box = await overlay.boundingBox();
  const pageBox = await page.locator(`[data-page="${pageNumber}"]`).boundingBox();
  if (!box || !pageBox) return null;
  return {
    left: (box.x - pageBox.x) / pageBox.width,
    top: (box.y - pageBox.y) / pageBox.height,
    width: box.width / pageBox.width,
    height: box.height / pageBox.height,
    pageWidth: pageBox.width,
  };
}

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tree').waitFor({ timeout: 30000 });
  console.log('트리:', (await page.getByRole('tree').innerText()).replace(/\n/g, ' > '));

  await page.getByRole('treeitem', { name: /풍문고/ }).click();
  await page.locator('canvas').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);

  for (const { no, page: pageNumber, bbox } of EXPECTED) {
    const measured = await measure(no, pageNumber);
    if (!measured) {
      check(`${no}번 하이라이트 측정`, false, '요소를 찾지 못함');
      continue;
    }
    const want = {
      left: bbox[0] / MEDIA.w,
      top: bbox[1] / MEDIA.h,
      width: (bbox[2] - bbox[0]) / MEDIA.w,
      height: (bbox[3] - bbox[1]) / MEDIA.h,
    };
    const diff = {
      left: Math.abs(measured.left - want.left),
      top: Math.abs(measured.top - want.top),
      width: Math.abs(measured.width - want.width),
      height: Math.abs(measured.height - want.height),
    };
    const ok = Object.values(diff).every((value) => value < 0.01);
    check(
      `${no}번 하이라이트가 bbox 비율과 일치 (${pageNumber}쪽)`,
      ok,
      `측정 top=${measured.top.toFixed(3)} 기대 ${want.top.toFixed(3)} / ` +
        `left=${measured.left.toFixed(3)} 기대 ${want.left.toFixed(3)} / ` +
        `h=${measured.height.toFixed(3)} 기대 ${want.height.toFixed(3)}`,
    );
    // 뒤집힘 회귀 감지: 상단 문제(top<0.2)가 하단(>0.5)으로 가면 즉시 실패
    if (want.top < 0.2) {
      check(`${no}번이 페이지 상단에 있다(뒤집힘 아님)`, measured.top < 0.2, `top=${measured.top.toFixed(3)}`);
    }
    await page.screenshot({ path: `${SHOTS}20-highlight-${no}.png` });
  }

  // 확대해도 어긋나지 않는지(scale 반영)
  await page.getByRole('button', { name: String(4), exact: true }).first().click();
  const before = await measure(4, 1);
  await page.getByTitle('확대').click();
  await page.getByTitle('확대').click();
  await page.waitForTimeout(1800);
  const after = await measure(4, 1);
  check(
    '확대해도 상대 위치가 유지된다',
    Boolean(
      before &&
        after &&
        after.pageWidth > before.pageWidth + 20 &&
        Math.abs(after.top - before.top) < 0.01 &&
        Math.abs(after.left - before.left) < 0.01,
    ),
    before && after
      ? `폭 ${Math.round(before.pageWidth)} -> ${Math.round(after.pageWidth)}px, ` +
          `top ${before.top.toFixed(3)} -> ${after.top.toFixed(3)}`
      : '측정 실패',
  );
  await page.screenshot({ path: `${SHOTS}21-highlight-zoomed.png` });
} catch (error) {
  check('예외 없이 완주', false, String(error).slice(0, 300));
  await page.screenshot({ path: `${SHOTS}29-highlight-failure.png` }).catch(() => {});
}

check('페이지 에러 없음', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();

const failed = results.filter((result) => !result.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length === 0 ? 0 : 1);
