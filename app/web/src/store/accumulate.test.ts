import { describe, expect, it } from 'vitest';

import { __internal } from '@/store/workspace';
import type { Cost, Usage } from '@/types/api';

const { accumulate } = __internal;

const ZERO = { usage: null, usd: 0, krw: 0, billedCalls: 0, subscriptionCalls: 0 };

/** 구독 모드에서 백엔드가 실제로 보내는 모양: usage 는 있고 cost 만 null. */
const SUB_USAGE: Usage = {
  input_tokens: 2,
  output_tokens: 1469,
  cache_creation_input_tokens: 459,
  cache_read_input_tokens: 2521,
};

/** API 키 모드: usage + cost 둘 다 온다. */
const API_USAGE: Usage = {
  input_tokens: 1000,
  output_tokens: 500,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};
const API_COST: Cost = { total_usd: 0.0175, total_krw: 24.5, usd_krw: 1400 };

describe('accumulate — 과금/구독 집계 분리', () => {
  it('구독 호출은 토큰만 세고 금액과 billedCalls 를 건드리지 않는다', () => {
    // 회귀 방어: 예전 구현은 `!usage && !cost` 로 판별해서, usage 가 오는
    // 구독 호출을 "$0 인 과금 호출" 로 잘못 집계했다("누적 사용량 / 호출 2회 / $0").
    const t = accumulate(ZERO, SUB_USAGE, null);

    expect(t.subscriptionCalls).toBe(1);
    expect(t.billedCalls).toBe(0);
    expect(t.usd).toBe(0);
    expect(t.krw).toBe(0);
    expect(t.usage?.output_tokens).toBe(1469);
  });

  it('API 키 호출은 토큰과 금액을 모두 센다', () => {
    const t = accumulate(ZERO, API_USAGE, API_COST);

    expect(t.billedCalls).toBe(1);
    expect(t.subscriptionCalls).toBe(0);
    expect(t.usd).toBeCloseTo(0.0175, 6);
    expect(t.krw).toBeCloseTo(24.5, 6);
  });

  it('구독과 API 를 섞어 쓰면 토큰은 합계, 금액은 API 분량만 잡힌다', () => {
    const t = accumulate(accumulate(ZERO, SUB_USAGE, null), API_USAGE, API_COST);

    expect(t.subscriptionCalls).toBe(1);
    expect(t.billedCalls).toBe(1);
    expect(t.usage?.output_tokens).toBe(1469 + 500);
    expect(t.usd).toBeCloseTo(0.0175, 6); // 구독분은 금액에 안 들어간다
  });

  it('usage 도 cost 도 없는 호출은 구독으로 집계한다(금액 미확인)', () => {
    const t = accumulate(ZERO, null, null);

    expect(t.subscriptionCalls).toBe(1);
    expect(t.billedCalls).toBe(0);
    expect(t.usd).toBe(0);
  });

  it('cost 가 있는데 total_usd 가 비어 있어도 과금 호출로 세고 금액은 0 을 더한다', () => {
    const t = accumulate(ZERO, API_USAGE, { usd_krw: 1400 });

    expect(t.billedCalls).toBe(1);
    expect(t.usd).toBe(0);
    expect(t.krw).toBe(0);
  });
});
