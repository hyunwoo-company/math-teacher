import { describe, expect, it } from 'vitest';
import {
  armClickGuard,
  isBlankClick,
  isDragCancelKey,
  shouldSuppressClick,
  CLICK_SUPPRESS_MS,
  NO_CLICK_GUARD,
} from '@/lib/tree-drag';

describe('끌기 잔상 click 막기', () => {
  it('끌기가 없었으면 click 을 막지 않는다', () => {
    expect(shouldSuppressClick(NO_CLICK_GUARD, 1_000)).toBe(false);
  });

  it('끌기가 끝난 직후의 click 은 막는다', () => {
    const guard = armClickGuard(1_000);
    expect(shouldSuppressClick(guard, 1_000)).toBe(true);
    expect(shouldSuppressClick(guard, 1_000 + CLICK_SUPPRESS_MS)).toBe(true);
  });

  it('시간이 지난 뒤의 click 은 통과시킨다 — 표식이 영구히 남아 멀쩡한 클릭을 먹지 않는다', () => {
    const guard = armClickGuard(1_000);
    expect(shouldSuppressClick(guard, 1_000 + CLICK_SUPPRESS_MS + 1)).toBe(false);
    expect(shouldSuppressClick(guard, 60_000)).toBe(false);
  });

  it('시계가 뒤로 간 경우도 막지 않는다', () => {
    expect(shouldSuppressClick(armClickGuard(1_000), 900)).toBe(false);
  });

  it('끌기를 다시 시작하면 표식이 새 시각으로 갱신된다', () => {
    const first = armClickGuard(1_000);
    const second = armClickGuard(5_000);
    expect(shouldSuppressClick(first, 5_010)).toBe(false);
    expect(shouldSuppressClick(second, 5_010)).toBe(true);
  });
});

describe('Esc 취소 판정', () => {
  it('Esc 면 취소다', () => {
    expect(isDragCancelKey({ key: 'Escape', defaultPrevented: false })).toBe(true);
  });

  it('다른 키는 아니다', () => {
    expect(isDragCancelKey({ key: 'Enter', defaultPrevented: false })).toBe(false);
    expect(isDragCancelKey({ key: 'Delete', defaultPrevented: false })).toBe(false);
  });

  it('검색어 지우기 등 이미 처리한 Esc 는 건드리지 않는다', () => {
    expect(isDragCancelKey({ key: 'Escape', defaultPrevented: true })).toBe(false);
  });
});

describe('빈 공간 클릭 판정', () => {
  it('빈 공간을 눌렀다 그대로 떼면 클릭이다', () => {
    expect(isBlankClick({ moved: false, additive: false })).toBe(true);
  });

  it('고무줄로 끌었으면 클릭이 아니다', () => {
    expect(isBlankClick({ moved: true, additive: false })).toBe(false);
  });

  it('Ctrl 을 누른 채였으면 선택을 쌓는 중이므로 지우지 않는다', () => {
    expect(isBlankClick({ moved: false, additive: true })).toBe(false);
  });

  it('세션이 없으면 아무것도 아니다', () => {
    expect(isBlankClick(null)).toBe(false);
  });
});
