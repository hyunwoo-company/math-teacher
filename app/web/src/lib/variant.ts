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

/** 버튼 그룹 렌더 순서. */
export const VARIANT_MODES: readonly VariantMode[] = ['number', 'condition', 'number_condition'];
