import { describe, expect, it } from 'vitest';
import {
  costAmounts,
  effortLabel,
  formatDate,
  formatInt,
  formatKrw,
  formatUsd,
  mergeUsage,
  totalTokens,
} from '@/lib/format';

describe('formatDate', () => {
  it('한국식 날짜(2026. 7. 31.)로 표시한다', () => {
    expect(formatDate('2026-07-31T10:00:00+09:00')).toBe('2026. 7. 31.');
  });

  it('값이 없거나 잘못되면 대시를 준다', () => {
    expect(formatDate(null)).toBe('-');
    expect(formatDate('그냥문자열')).toBe('-');
  });
});

describe('숫자/통화 표시', () => {
  it('토큰 수에 천 단위 구분을 넣는다', () => {
    expect(formatInt(12345)).toBe('12,345');
    expect(formatInt(null)).toBe('-');
  });

  it('소액 USD 는 자릿수를 늘린다', () => {
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatUsd(0)).toBe('$0');
  });

  it('원화는 1원 미만이면 소수점을 보여준다', () => {
    expect(formatKrw(0.58)).toBe('₩0.58');
    expect(formatKrw(1234.6)).toBe('₩1,235');
    expect(formatKrw(null)).toBe('-');
  });
});

describe('usage / cost', () => {
  it('토큰 합계를 낸다', () => {
    expect(
      totalTokens({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      }),
    ).toBe(165);
    expect(totalTokens(null)).toBe(0);
  });

  it('usage 를 합친다', () => {
    expect(mergeUsage({ input_tokens: 10 }, { input_tokens: 5, output_tokens: 3 })).toEqual({
      input_tokens: 15,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(mergeUsage(null, { input_tokens: 1 })).toEqual({ input_tokens: 1 });
    expect(mergeUsage(null, null)).toBeNull();
  });

  it('total_krw 가 없으면 환율로 계산한다', () => {
    const amounts = costAmounts({ total_usd: 0.001 }, 1400);
    expect(amounts.usd).toBe(0.001);
    expect(amounts.krw).toBeCloseTo(1.4, 6);
  });

  it('cost 에 담긴 usd_krw 를 우선 사용한다', () => {
    const amounts = costAmounts({ total_usd: 0.001, usd_krw: 1300 }, 1400);
    expect(amounts.krw).toBeCloseTo(1.3, 6);
  });

  it('cost 가 null(구독 모드)이면 둘 다 null 이다', () => {
    expect(costAmounts(null, 1400)).toEqual({ usd: null, krw: null });
  });
});

describe('라벨', () => {
  it('effort 를 한국어로 바꾼다', () => {
    expect(effortLabel('medium')).toBe('보통');
    expect(effortLabel('xhigh')).toBe('매우 높음');
  });
});
