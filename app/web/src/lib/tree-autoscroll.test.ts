/**
 * 드래그 중 자동 스크롤 속도 규칙.
 *
 * 실사용 불편: 화면 밖(위쪽) 폴더로 항목을 옮기려는데 목록이 스크롤되지 않아
 * 대상까지 갈 수가 없었다. rAF 루프 자체는 jsdom 에서 볼 것이 없으므로,
 * "어느 위치에서 어느 방향으로 얼마나" 라는 규칙만 여기서 굳힌다.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTO_SCROLL_EDGE_PX,
  AUTO_SCROLL_MAX_SPEED_PX,
  autoScrollSpeed,
} from '@/lib/tree-autoscroll';

/** 화면 y 100~500 에 놓인 높이 400px 컨테이너. */
const BOX = { top: 100, bottom: 500 };

describe('autoScrollSpeed', () => {
  it('한가운데에서는 멈춰 있다', () => {
    expect(autoScrollSpeed({ pointerY: 300, ...BOX })).toBe(0);
  });

  it('위 가장자리에서는 음수이고, 가장자리에 가까울수록 빠르다', () => {
    const near = autoScrollSpeed({ pointerY: 105, ...BOX });
    const far = autoScrollSpeed({ pointerY: 140, ...BOX });
    expect(near).toBeLessThan(0);
    expect(far).toBeLessThan(0);
    expect(Math.abs(near)).toBeGreaterThan(Math.abs(far));
    // 딱 가장자리면 최대 속도로 올라간다.
    expect(autoScrollSpeed({ pointerY: 100, ...BOX })).toBe(-AUTO_SCROLL_MAX_SPEED_PX);
  });

  it('아래 가장자리에서는 양수이고, 가장자리에 가까울수록 빠르다', () => {
    const near = autoScrollSpeed({ pointerY: 495, ...BOX });
    const far = autoScrollSpeed({ pointerY: 460, ...BOX });
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(0);
    expect(near).toBeGreaterThan(far);
    expect(autoScrollSpeed({ pointerY: 500, ...BOX })).toBe(AUTO_SCROLL_MAX_SPEED_PX);
  });

  it('임계값 밖이면 0이다', () => {
    // 위에서 정확히 임계값만큼 떨어진 지점부터는 걸리지 않는다.
    expect(autoScrollSpeed({ pointerY: BOX.top + AUTO_SCROLL_EDGE_PX, ...BOX })).toBe(0);
    expect(autoScrollSpeed({ pointerY: BOX.bottom - AUTO_SCROLL_EDGE_PX, ...BOX })).toBe(0);
  });

  it('컨테이너 밖에서는 0이다 — 커서가 나갔는데도 굴러가면 멈출 방법이 없다', () => {
    expect(autoScrollSpeed({ pointerY: 60, ...BOX })).toBe(0);
    expect(autoScrollSpeed({ pointerY: 540, ...BOX })).toBe(0);
  });

  it('최대 속도를 넘지 않는다', () => {
    for (let y = BOX.top; y <= BOX.bottom; y += 1) {
      expect(Math.abs(autoScrollSpeed({ pointerY: y, ...BOX }))).toBeLessThanOrEqual(
        AUTO_SCROLL_MAX_SPEED_PX,
      );
    }
    // 사용자 지정 상한도 지킨다.
    expect(autoScrollSpeed({ pointerY: 100, ...BOX, maxSpeed: 4 })).toBe(-4);
  });

  it('컨테이너가 임계값의 2배보다 낮아도 위/아래가 섞이지 않는다', () => {
    // 높이 60px < 48*2. 임계값을 30 으로 줄여 반씩 나눠 갖는다.
    const small = { top: 0, bottom: 60 };
    expect(autoScrollSpeed({ pointerY: 29, ...small })).toBeLessThan(0);
    expect(autoScrollSpeed({ pointerY: 30, ...small })).toBe(0);
    expect(autoScrollSpeed({ pointerY: 31, ...small })).toBeGreaterThan(0);
  });

  it('높이가 없는 컨테이너는 계산하지 않는다', () => {
    expect(autoScrollSpeed({ pointerY: 10, top: 10, bottom: 10 })).toBe(0);
  });
});
