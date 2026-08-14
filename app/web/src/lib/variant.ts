/**
 * 동일 유형 변형 문제 생성 관련 공용 상수.
 * 목 데이터(`mock/data.ts`)와 UI(`VariantPanel`)가 함께 쓴다.
 */

import type { VariantMode } from '@/types/api';

/** 변형 모드별 한국어 라벨. */
export const VARIANT_MODE_LABEL: Record<VariantMode, string> = {
  number: '숫자 변형',
  condition: '조건 변형',
  number_condition: '숫자·조건 변형',
};

/** 탭 렌더 순서. 첫 항목(`VARIANT_MODES[0]`)이 기본/자동 생성 탭이다. */
export const VARIANT_MODES = ['number', 'condition', 'number_condition'] as const satisfies readonly VariantMode[];

/**
 * 일괄 생성에서 고르는 변형 유형. `'all'` 은 3종 모두를 뜻한다.
 *
 * 다중 토글이 아니라 **단일 선택**이다. 토글로 만들면 "전체" 와 "3개 다 켬" 이
 * 같은 상태가 되어 화면이 두 가지로 같은 뜻을 말하게 된다.
 */
export type VariantPickKind = VariantMode | 'all';

/** 일괄 생성 유형 버튼 순서(마지막이 '전체'). */
export const VARIANT_PICK_KINDS = [
  ...VARIANT_MODES,
  'all',
] as const satisfies readonly VariantPickKind[];

/** 유형 버튼 라벨. 버튼이 좁아 `VARIANT_MODE_LABEL` 보다 짧게 쓴다. */
export const VARIANT_PICK_LABEL: Record<VariantPickKind, string> = {
  number: '숫자',
  condition: '조건',
  number_condition: '숫자+조건',
  all: '전체',
};

/** 고른 유형을 실제로 만들 변형 종류들로 편다. */
export function variantModesOf(kind: VariantPickKind): VariantMode[] {
  return kind === 'all' ? [...VARIANT_MODES] : [kind];
}
