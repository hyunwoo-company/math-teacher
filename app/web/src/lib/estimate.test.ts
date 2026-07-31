import { describe, expect, it } from 'vitest';
import {
  BASELINE_TOKENS,
  CACHE_READ_MULTIPLIER,
  estimatePerProblem,
  estimateTotal,
  findModel,
} from '@/lib/estimate';
import type { ModelInfo } from '@/types/api';

const opus: ModelInfo = {
  id: 'claude-opus-5',
  label: 'Claude Opus 5',
  input_usd_per_mtok: 5,
  output_usd_per_mtok: 25,
};

const haiku: ModelInfo = {
  id: 'claude-haiku-4-5',
  label: 'Claude Haiku 4.5',
  input_usd_per_mtok: 1,
  output_usd_per_mtok: 5,
};

/** 백엔드 pricing.py 와 같은 식으로 직접 계산한 기대값. */
function expectedUsd(model: ModelInfo): number {
  return (
    (BASELINE_TOKENS.input / 1_000_000) * model.input_usd_per_mtok +
    (BASELINE_TOKENS.output / 1_000_000) * model.output_usd_per_mtok +
    (BASELINE_TOKENS.cacheRead / 1_000_000) * model.input_usd_per_mtok * CACHE_READ_MULTIPLIER
  );
}

describe('estimatePerProblem', () => {
  it('Opus 5 단가로 문항당 비용을 계산한다', () => {
    const estimate = estimatePerProblem(opus, 1400);
    // input 100*5 + output 1400*25 + cache_read 2500*5*0.1 (per 1M)
    expect(estimate?.usd).toBeCloseTo(expectedUsd(opus), 10);
    expect(estimate?.usd).toBeCloseTo(0.03675, 8);
    expect(estimate?.krw).toBeCloseTo(0.03675 * 1400, 6);
  });

  it('모델이 싸면 추정도 싸진다', () => {
    const opusEstimate = estimatePerProblem(opus, 1400);
    const haikuEstimate = estimatePerProblem(haiku, 1400);
    expect(haikuEstimate?.usd).toBeCloseTo(expectedUsd(haiku), 10);
    expect(haikuEstimate?.usd).toBeLessThan(opusEstimate?.usd ?? 0);
  });

  it('캐시 읽기 단가는 input 단가의 0.1배로 계산한다', () => {
    // cache_read 를 0 으로 둔 모델(input 0)과 비교해 기여분을 분리 확인한다.
    const zeroInput: ModelInfo = { ...opus, input_usd_per_mtok: 0 };
    const withInput = estimatePerProblem(opus, 1400)?.usd ?? 0;
    const withoutInput = estimatePerProblem(zeroInput, 1400)?.usd ?? 0;
    const inputContribution =
      (BASELINE_TOKENS.input / 1_000_000) * 5 + (BASELINE_TOKENS.cacheRead / 1_000_000) * 5 * 0.1;
    expect(withInput - withoutInput).toBeCloseTo(inputContribution, 10);
  });

  it('모델 정보가 없으면 null 이다', () => {
    expect(estimatePerProblem(undefined, 1400)).toBeNull();
  });

  it('단가가 숫자가 아니면 null 이다', () => {
    const broken = { ...opus, output_usd_per_mtok: Number.NaN };
    expect(estimatePerProblem(broken, 1400)).toBeNull();
  });
});

describe('estimateTotal', () => {
  it('문항 수만큼 곱한다', () => {
    const per = estimatePerProblem(opus, 1400);
    const total = estimateTotal(opus, 1400, 22);
    expect(total?.usd).toBeCloseTo((per?.usd ?? 0) * 22, 10);
    expect(total?.krw).toBeCloseTo((per?.krw ?? 0) * 22, 8);
  });

  it('22문항 Opus 5 전체는 대략 1천원대다(자릿수 확인)', () => {
    const total = estimateTotal(opus, 1400, 22);
    expect(total?.krw).toBeGreaterThan(500);
    expect(total?.krw).toBeLessThan(5000);
  });

  it('문항이 0개면 null 이다', () => {
    expect(estimateTotal(opus, 1400, 0)).toBeNull();
    expect(estimateTotal(opus, 1400, -3)).toBeNull();
  });
});

describe('findModel', () => {
  it('id 로 모델을 찾고 없으면 undefined', () => {
    expect(findModel([opus, haiku], 'claude-haiku-4-5')).toBe(haiku);
    expect(findModel([opus, haiku], 'claude-sonnet-5')).toBeUndefined();
  });
});
