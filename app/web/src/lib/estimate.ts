/**
 * API 키 모드로 풀 때의 예상 비용 추정.
 *
 * 목적은 "정확한 청구액" 이 아니라 **사용자가 과금 규모를 감으로 알게 하는 것**이다.
 * 그래서 UI 문구에도 반드시 "실측 기반 추정" 임을 밝힌다.
 *
 * ── 기준 토큰의 근거(실측) ──────────────────────────────────────────
 * 이 시험지(공통수학1, 이미지 모드, effort 보통)를 Claude Opus 5 로 실제 호출한 usage:
 *   output      1,133 ~ 1,469 tokens
 *   cache_read  2,521 tokens   (2번째 호출부터 시스템 프롬프트 캐시 히트)
 *   fresh input     2 ~   100 tokens
 * => 기준값(문항당): output 1400, cache_read 2500, input 100
 *
 * 첫 호출은 cache_write(= input 단가 x 1.25)가 한 번 더 붙지만, 문항 수가 많아지면
 * 문항당 기여가 작아지므로 추정에서는 제외한다(과소추정 방향이라 주석으로 남긴다).
 * 단가 계산 규칙은 백엔드 `pricing.py` 와 동일하게 맞춘다.
 */

import type { ModelInfo } from '@/types/api';

/** 문항당 기준 토큰(위 실측 근거). */
export const BASELINE_TOKENS = {
  output: 1400,
  cacheRead: 2500,
  input: 100,
} as const;

/** 캐시 읽기 단가는 input 단가의 0.1배 (pricing.py CACHE_READ_MULTIPLIER). */
export const CACHE_READ_MULTIPLIER = 0.1;

export interface CostEstimate {
  usd: number;
  krw: number;
}

/**
 * 문항 1개를 푸는 예상 비용.
 * 모델 단가 정보가 없으면(=env 를 못 받았거나 목록에 없는 모델) null.
 */
export function estimatePerProblem(
  model: ModelInfo | undefined,
  usdKrw: number,
): CostEstimate | null {
  if (!model) return null;
  const inputRate = model.input_usd_per_mtok;
  const outputRate = model.output_usd_per_mtok;
  if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate)) return null;

  const usd =
    (BASELINE_TOKENS.input / 1_000_000) * inputRate +
    (BASELINE_TOKENS.output / 1_000_000) * outputRate +
    (BASELINE_TOKENS.cacheRead / 1_000_000) * inputRate * CACHE_READ_MULTIPLIER;

  return { usd, krw: usd * usdKrw };
}

/** 문항 `count` 개를 전부 푸는 예상 비용. count 가 0 이면 null. */
export function estimateTotal(
  model: ModelInfo | undefined,
  usdKrw: number,
  count: number,
): CostEstimate | null {
  if (count <= 0) return null;
  const perProblem = estimatePerProblem(model, usdKrw);
  if (!perProblem) return null;
  return { usd: perProblem.usd * count, krw: perProblem.krw * count };
}

/** 모델 목록에서 id 로 찾는다. */
export function findModel(models: readonly ModelInfo[], id: string): ModelInfo | undefined {
  return models.find((model) => model.id === id);
}
