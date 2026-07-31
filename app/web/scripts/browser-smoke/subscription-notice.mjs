/**
 * ⒝ 구독 불가 상태의 안내 UI 검증.
 *
 * 대상: 격리된 dev 서버(3001) -> 백엔드 8101(MATH_TEACHER_DISABLE_SUBSCRIPTION=1)
 *      또는 8102(reason 주입 스텁).
 *
 * 주의: 실제 백엔드를 쓰므로 **API 키 저장 버튼은 누르지 않는다**
 * (사용자 settings.json 을 건드리게 된다). 키 저장 흐름은 목 기반 컴포넌트 테스트에서 검증했다.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3001';
const LABEL = process.env.LABEL ?? 'real';
const EXPECT = process.env.EXPECT ?? '';
const SHOTS = new URL('../shots/', import.meta.url).pathname.replace(/^\//, '');
await mkdir(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  // 1) 공급자가 아무것도 없으면 먼저 온보딩이 뜬다.
  await page.getByText('AI 공급자를 설정해 주세요').waitFor({ timeout: 30000 });
  check('온보딩 화면 표시(구독 불가 + 키 없음)', true);
  await page.screenshot({ path: `${SHOTS}40-${LABEL}-onboarding.png` });

  // 2) 건너뛰면 워크스페이스로 들어간다.
  await page.getByRole('button', { name: /일단 둘러보기/ }).click();
  await page.getByRole('tree').waitFor({ timeout: 15000 });
  check('온보딩 건너뛰기 후 워크스페이스 진입', true);

  // 3) 프롬프트 영역 안내가 계속 보인다(온보딩과 중복이 아니라 이어서).
  const note = page.getByRole('note', { name: 'AI 사용 준비 안내' });
  await note.waitFor({ timeout: 10000 });
  const noteText = await note.innerText();
  console.log(`안내(${LABEL}):`, noteText.replace(/\n/g, ' | '));
  check('프롬프트 영역에 안내 표시', true);

  if (EXPECT) {
    check(`사유별 문구 확인: "${EXPECT}"`, noteText.includes(EXPECT), noteText.slice(0, 80));
  }

  // 용어 검증: Claude Code(CLI) 와 데스크톱 앱을 혼동시키지 않는다.
  await page.getByRole('button', { name: '자세히' }).click();
  const expanded = await note.innerText();
  check('데스크톱 앱을 설치하라고 하지 않는다', !/데스크톱 앱을 설치/.test(expanded));

  // 4) 대안 경로(API 키) 안내 + 과금 사실
  check('API 키 대안 제시', expanded.includes('지금 바로 쓰려면 API 키를 입력하세요'));
  check('과금 사실 명시', /사용량만큼 요금이 청구됩니다/.test(expanded));
  check('예상 금액 표시', /문항당 약\s*₩/.test(expanded));

  // 5) 입력창이 막히고 이유를 알려준다
  const textarea = page.locator('textarea');
  check('입력창 비활성화', await textarea.isDisabled());
  const placeholder = await textarea.getAttribute('placeholder');
  check('placeholder 로도 이유 안내', /API 키|Claude Code|구독/.test(placeholder ?? ''), placeholder ?? '');

  // 6) 전체 문제풀이 버튼도 막힌다
  const solveButton = page.getByRole('button', { name: /전체 문제풀이/ });
  check('전체 문제풀이 비활성화', await solveButton.isDisabled(), await solveButton.getAttribute('title'));

  // 7) [다시 확인] 이 동작한다(여전히 불가 -> 안내 유지)
  const recheck = page.getByRole('button', { name: '다시 확인' });
  if ((await recheck.count()) > 0) {
    await recheck.click();
    await page.waitForTimeout(1500);
    check('다시 확인 후에도 안내 유지(상태 그대로)', (await note.count()) > 0);
  } else {
    check('다시 확인 버튼 존재', false, '없음(웹 모드가 아니면 있어야 한다)');
  }

  await page.screenshot({ path: `${SHOTS}41-${LABEL}-notice.png` });
} catch (error) {
  check('예외 없이 완주', false, String(error).slice(0, 300));
  await page.screenshot({ path: `${SHOTS}49-${LABEL}-failure.png` }).catch(() => {});
}

check('페이지 에러 없음', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n=== [${LABEL}] ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length === 0 ? 0 : 1);
