/**
 * 좌측 트리 끌기 회귀 확인 (목 모드 전용, AI 호출 없음).
 *
 * jsdom 으로는 네이티브 HTML5 끌기가 아예 일어나지 않는다. 그래서 **진짜 OS 마우스
 * 입력**(Win32 `SetCursorPos`/`mouse_event`)으로 창을 조작해 확인한다.
 * Playwright 의 합성 입력(`page.mouse`)도 renderer 까지는 가지만, "사용자가 정말
 * 그렇게 했을 때" 를 못 믿겠다는 것이 이 스크립트의 존재 이유다.
 *
 * 확인 항목
 *  1) 행의 **들여쓰기 여백**에서 눌러도 `dragstart` 가 뜬다(클릭으로 새지 않는다).
 *  2) 폴더에 떨구면 실제로 옮겨진다.
 *  3) 파일 행 위에 떨군 것은 아무 일도 아니다(예전엔 최상위로 튀었다).
 *  4) 끌기가 끝나면(정상/취소/창 밖 드롭/Esc) 끌기 표시가 남지 않는다.
 *  5) 끌기 뒤 **빈 공간을 클릭하면** 선택이 풀린다.
 *
 * 실행 (app/web 에서, Windows 전용):
 *   NEXT_PUBLIC_MOCK=1 npx next dev -p 3101      # 다른 터미널
 *   cp scripts/browser-smoke/tree-drag.mjs tmp/pw/ && cd tmp/pw && BASE=http://127.0.0.1:3101 node tree-drag.mjs
 *
 * 창을 실제로 띄우고 커서를 움직인다. 도는 동안 마우스를 만지지 말 것.
 */
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3101';

const PS_HEADER = `
Add-Type @"
using System;using System.Runtime.InteropServices;
public class M {
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,int e);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 public const uint DOWN=0x0002, UP=0x0004;
}
"@
[void][M]::SetProcessDPIAware()
`;
const ps = (script) => spawnSync('powershell', ['-NoProfile', '-Command', PS_HEADER + script], { encoding: 'utf8' });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const browser = await chromium.launch({ headless: false, args: ['--window-position=0,0', '--window-size=1200,900'] });
const page = await browser.newPage();

/** 이벤트를 눈으로 보기 위한 계측(앱 코드는 건드리지 않는다). */
const INSTRUMENT = () => {
  window.__log = [];
  const record = (type) => (event) => {
    const row = event.target?.closest?.('[data-node-id]');
    window.__log.push({ type, node: row?.getAttribute('data-node-id') ?? null });
  };
  for (const type of ['dragstart', 'dragend', 'drop', 'click', 'mousedown', 'mouseup', 'keydown']) {
    document.addEventListener(type, record(type), true);
  }
};

async function reset() {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-node-id]').first().waitFor({ timeout: 30000 });
  // 이전 시나리오의 열린 파일/펼침 상태를 끌고 가지 않는다.
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-node-id]').first().waitFor({ timeout: 30000 });
  await page.locator('[data-node-id="folder-common1"]').click();
  await page.locator('[data-node-id="file-punmun"]').waitFor({ timeout: 10000 });
  await page.bringToFront();
  await page.waitForTimeout(400);
  await page.evaluate(INSTRUMENT);
}

const drain = () => page.evaluate(() => { const log = window.__log; window.__log = []; return log; });
const fmt = (events) => events.map((e) => `${e.type}${e.node ? '@' + e.node : ''}`).join(' ') || '(없음)';
const state = () => page.evaluate(() => ({
  // 끌기 중에만 뜨는 삭제 영역 = "끌기 상태가 살아 있다" 의 눈에 보이는 증거.
  dragging: !!document.body.textContent?.includes('여기에 놓으면 삭제'),
  faded: document.querySelectorAll('[data-node-id].opacity-50').length,
  picked: [...document.querySelectorAll('[data-node-id]')].filter((el) => el.className.includes('bg-blue-100')).length,
  fileLevel: document.querySelector('[data-node-id="file-punmun"]')?.getAttribute('aria-level'),
  // 화면 순서에서 파일 바로 앞 행 = 그 파일이 들어 있는 폴더(펼쳐진 상태 기준).
  fileAfter: (() => {
    const rows = [...document.querySelectorAll('[data-node-id]')];
    const index = rows.findIndex((el) => el.getAttribute('data-node-id') === 'file-punmun');
    return index > 0 ? rows[index - 1].getAttribute('data-node-id') : null;
  })(),
}));

await reset();

// 화면 좌표 ↔ client 좌표 보정(창 테두리·툴바 높이).
await page.evaluate(() => {
  window.__mm = [];
  document.addEventListener('mousemove', (e) => window.__mm.push([e.clientX, e.clientY]), true);
});
ps(`[M]::SetCursorPos(400,400); Start-Sleep -Milliseconds 150; [M]::SetCursorPos(401,400); Start-Sleep -Milliseconds 150`);
await page.waitForTimeout(200);
const probe = await page.evaluate(() => window.__mm.slice(-1)[0]);
if (!probe) {
  console.log('보정 실패: 창이 앞에 있지 않거나 입력이 막혀 있다.');
  await browser.close();
  process.exit(2);
}
const off = { x: 401 - probe[0], y: 400 - probe[1] };
console.log(`좌표 보정 오프셋 = (${off.x}, ${off.y})`);

const moves = (from, to, steps = 20, ms = 30) => {
  const out = [];
  for (let i = 1; i <= steps; i += 1) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    out.push(`[M]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds ${ms}`);
  }
  return out;
};

/** client 좌표로 진짜 끌기 한 번. `hold` 가 true 면 버튼을 놓지 않고 돌아온다. */
async function dragTo(fromClient, toClient, { hold = false } = {}) {
  const from = { x: fromClient.x + off.x, y: fromClient.y + off.y };
  const to = { x: toClient.x + off.x, y: toClient.y + off.y };
  ps([
    `[M]::SetCursorPos(${Math.round(from.x)},${Math.round(from.y)})`,
    `Start-Sleep -Milliseconds 250`,
    `[M]::mouse_event([M]::DOWN,0,0,0,0)`,
    `Start-Sleep -Milliseconds 120`,
    ...moves(from, to),
    `Start-Sleep -Milliseconds 300`,
  ].join('; '));
  if (hold) return;
  ps(`[M]::mouse_event([M]::UP,0,0,0,0)`);
  await page.waitForTimeout(800);
}

async function clickAt(client) {
  ps([
    `[M]::SetCursorPos(${Math.round(client.x + off.x)},${Math.round(client.y + off.y)})`,
    `Start-Sleep -Milliseconds 200`,
    `[M]::mouse_event([M]::DOWN,0,0,0,0)`,
    `Start-Sleep -Milliseconds 80`,
    `[M]::mouse_event([M]::UP,0,0,0,0)`,
  ].join('; '));
  await page.waitForTimeout(600);
}

const rowBox = (id) => page.locator(`[data-node-id="${id}"]`).boundingBox();

try {
  // ① 들여쓰기 여백에서 끌기가 시작되고, 폴더에 떨구면 옮겨진다
  {
    await reset();
    const file = await rowBox('file-punmun');
    const target = await rowBox('folder-calculus');
    const pad = await page.locator('[data-node-id="file-punmun"]').evaluate((el) => getComputedStyle(el).paddingLeft);
    await page.evaluate(() => { window.__log = []; });
    await dragTo({ x: file.x + 4, y: file.y + file.height / 2 }, { x: target.x + 60, y: target.y + target.height / 2 });
    const events = await drain();
    const after = await state();
    check(`들여쓰기 여백(x+4, padding ${pad})에서 dragstart 가 뜬다`, events.some((e) => e.type === 'dragstart'), fmt(events));
    check('끌기 뒤에 click 이 따라붙지 않는다', !events.some((e) => e.type === 'click'), fmt(events));
    // 미적분(2단계) 안으로 들어가면 파일은 그대로 3단계지만 바로 위 행이 미적분이 된다.
    check('폴더에 떨구면 실제로 그 폴더 안으로 옮겨진다', after.fileAfter === 'folder-calculus',
      `앞 행=${after.fileAfter} level=${after.fileLevel}`);
    check('끌기 표시가 남지 않는다', !after.dragging && after.faded === 0, JSON.stringify(after));
  }

  // ② 파일 행 위에 떨군 것은 아무 일도 아니다(최상위로 튀지 않는다)
  {
    await reset();
    const calculus = await rowBox('folder-calculus');
    const file = await rowBox('file-punmun');
    const before = (await state()).fileLevel;
    await dragTo({ x: calculus.x + 60, y: calculus.y + calculus.height / 2 }, { x: file.x + 60, y: file.y + file.height / 2 });
    const level = await page.locator('[data-node-id="folder-calculus"]').getAttribute('aria-level');
    check('파일 행 위 드롭은 최상위 이동이 되지 않는다', level === '2', `미적분 aria-level=${level} (파일 level=${before})`);
  }

  // ③ 받아 줄 곳이 없는 데서 놓아도 상태가 남지 않는다
  {
    await reset();
    const file = await rowBox('file-punmun');
    await dragTo({ x: file.x + 4, y: file.y + file.height / 2 }, { x: 900, y: 450 });
    const after = await state();
    check('드롭 대상 없이 끝나도 끌기 표시가 사라진다', !after.dragging && after.faded === 0, JSON.stringify(after));
  }

  // ④ 창 밖으로 끌고 나가 놓아도 상태가 남지 않는다
  {
    await reset();
    const file = await rowBox('file-punmun');
    await dragTo({ x: file.x + 4, y: file.y + file.height / 2 }, { x: 1500 - off.x, y: 950 - off.y });
    const after = await state();
    check('창 밖 드롭 뒤에도 끌기 표시가 사라진다', !after.dragging && after.faded === 0, JSON.stringify(after));
  }

  /*
   * ⑤ 끌기 중 Esc.
   *
   * 네이티브 끌기가 도는 동안 Chromium 은 키 입력을 페이지로 내려보내지 않는다
   * (아래에서 keydown 이 하나도 안 잡히는 것으로 확인한다). 브라우저가 끌기를
   * 취소하고 `dragend` 만 준다 — 끌기 상태는 그 `dragend` 로 지워진다.
   * 선택까지 푸는 것은 "끌지 않는 상태에서 누른 Esc" 의 몫이다.
   */
  {
    await reset();
    const file = await rowBox('file-punmun');
    await page.evaluate(() => { window.__log = []; });
    await dragTo({ x: file.x + 60, y: file.y + file.height / 2 }, { x: file.x + 180, y: file.y + 90 }, { hold: true });
    const mid = await state();
    check('끌고 있는 동안에는 끌기 표시가 보인다(대조군)', mid.dragging, JSON.stringify(mid));
    ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("{ESC}"); Start-Sleep -Milliseconds 400`);
    ps(`[M]::mouse_event([M]::UP,0,0,0,0)`);
    await page.waitForTimeout(800);
    const events = await drain();
    const after = await state();
    check('Esc 로 취소하면 끌기 표시가 사라진다', !after.dragging && after.faded === 0, JSON.stringify(after));
    check('끌기 중 keydown 은 페이지로 오지 않는다(그래서 dragend 로 지운다)',
      !events.some((e) => e.type === 'keydown'), fmt(events));

    // 끌기가 끝난 뒤 누른 Esc 는 선택까지 푼다.
    await page.locator('[data-node-id="file-punmun"]').press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    const afterEsc = await state();
    check('끌지 않을 때 누른 Esc 는 선택도 푼다', afterEsc.picked === 0, JSON.stringify(afterEsc));
  }

  // ⑥ 끌기 뒤 빈 공간을 클릭하면 선택이 풀린다
  {
    await reset();
    const file = await rowBox('file-punmun');
    await dragTo({ x: file.x + 60, y: file.y + file.height / 2 }, { x: 900, y: 450 });
    const afterDrag = await state();
    check('끌기 뒤에는 끌던 행이 선택으로 남는다(대조군)', afterDrag.picked >= 1, JSON.stringify(afterDrag));
    const tail = await page.getByTestId('tree-tail-space').boundingBox();
    await clickAt({ x: tail.x + 40, y: tail.y + 30 });
    const after = await state();
    check('빈 공간 클릭으로 선택이 풀린다', after.picked === 0, JSON.stringify(after));
  }
} catch (error) {
  check('예외 없이 완주', false, String(error).slice(0, 300));
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length === 0 ? 0 : 1);
