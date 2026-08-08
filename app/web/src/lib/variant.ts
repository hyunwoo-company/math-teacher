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
