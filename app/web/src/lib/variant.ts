/**
 * 동일 유형 변형 문제 생성 관련 공용 상수와 "진행 중" 판정(순수 함수).
 * 목 데이터(`mock/data.ts`)와 UI(`VariantPanel`·`SolutionsTab`)가 함께 쓴다.
 */

import type { JobKind, JobStatus, VariantMode } from '@/types/api';

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

/* ── "진행 중" 판정 ──────────────────────────────────────────────────
 *
 * 진행 여부의 단일 소스는 **`variants[key][mode].status === 'streaming'`** 이다.
 * 개별 생성(`generateVariant`)과 일괄 생성(`startVariantBatch`) 이 둘 다 요청 전에
 * 이 자리를 먼저 만들고, 작업이 끝나거나 끊기면(`watchJob` 의 finally) 정리한다.
 *
 * 그래서 상단 헤더·유형 버튼·문항 행·문항 안 패널이 **모두 이 자리만** 본다.
 * 진행 여부를 따로 집계해 두면 같은 사실의 사본이 생겨, 아래는 "생성 중…" 인데
 * 위는 평상 상태인 지금의 괴리가 형태만 바꿔 다시 난다.
 */

/** 진행 여부 판정에 필요한 변형 항목의 최소 형태(스토어 `VariantEntry` 가 이걸 만족한다). */
export interface VariantStatusLike {
  status: 'idle' | 'streaming' | 'done' | 'error';
}

/**
 * 변형 캐시를 읽기 전용으로 본 것. key = `${fileId}::${no}`.
 *
 * 스토어 타입(`VariantByMode`)을 import 하지 않는다 — `store/workspace` 가 이
 * 모듈을 쓰므로 반대 방향 의존을 만들면 순환이 된다.
 */
export type VariantStatusMap = Readonly<
  Record<string, Readonly<Partial<Record<VariantMode, VariantStatusLike>>>>
>;

/** 진행 표시에 필요한 작업의 최소 형태(`Job` 이 이걸 만족한다). */
export interface VariantJobLike {
  id: string;
  kind: JobKind;
  node_id: string;
  status: JobStatus;
  total: number;
  done_count: number;
  current_no: number | null;
}

/** 상단에 낼 변형 진행 상황. */
export interface VariantProgress {
  /** 끝난 조합 수. */
  doneCount: number;
  /** 전체 조합 수((문항 × 유형) 단위). */
  total: number;
  /** 지금 만들고 있는 문항 번호. 모르면 null. */
  currentNo: number | null;
  /** [중단] 이 취소할 작업 id. 대응하는 작업을 못 찾았으면 null(버튼을 내지 않는다). */
  jobId: string | null;
}

/** 변형 캐시 키. 스토어와 이 함수들이 같은 형식을 쓰도록 여기 하나만 둔다. */
export function variantCacheKey(fileId: string, no: number): string {
  return `${fileId}::${no}`;
}

/** 그 (문항, 유형)이 지금 생성 중인지. */
export function isVariantModeRunning(
  variants: VariantStatusMap,
  fileId: string,
  no: number,
  mode: VariantMode,
): boolean {
  return variants[variantCacheKey(fileId, no)]?.[mode]?.status === 'streaming';
}

/**
 * 그 문항을 고른 유형으로 **다시 걸 이유가 없는지**(전부 생성 중인지).
 *
 * `'all'` 은 3종 모두를 뜻하므로 3종 전부 생성 중일 때만 true 다. 하나라도
 * 비어 있으면 걸 수 있어야 한다 — 겹치는 조합은 서버가 건너뛴다.
 */
export function isPickRunning(
  variants: VariantStatusMap,
  fileId: string,
  no: number,
  kind: VariantPickKind,
): boolean {
  return variantModesOf(kind).every((mode) => isVariantModeRunning(variants, fileId, no, mode));
}

/** 그 문항의 변형이 유형 하나라도 생성 중인지(문항 행 배지용). */
export function hasRunningVariant(
  variants: VariantStatusMap,
  fileId: string,
  no: number,
): boolean {
  const byMode = variants[variantCacheKey(fileId, no)];
  if (!byMode) return false;
  return VARIANT_MODES.some((mode) => byMode[mode]?.status === 'streaming');
}

/** 고른 문항 중 그 유형으로 이미 생성 중인 문항 수. */
export function runningPickCount(
  variants: VariantStatusMap,
  fileId: string,
  picked: readonly number[],
  kind: VariantPickKind,
): number {
  return picked.filter((no) => isPickRunning(variants, fileId, no, kind)).length;
}

/**
 * 고른 문항 **전부**가 그 유형으로 생성 중인지(그때만 버튼을 막는다).
 *
 * 아무것도 고르지 않았으면 막을 근거가 없으므로 false 다.
 */
export function allPicksRunning(
  variants: VariantStatusMap,
  fileId: string,
  picked: readonly number[],
  kind: VariantPickKind,
): boolean {
  if (picked.length === 0) return false;
  return runningPickCount(variants, fileId, picked, kind) === picked.length;
}

/** 그 시험지에서 지금 생성 중인 (문항, 유형) 조합 수. */
export function countRunningVariants(variants: VariantStatusMap, fileId: string): number {
  const prefix = `${fileId}::`;
  let count = 0;
  for (const [key, byMode] of Object.entries(variants)) {
    if (!key.startsWith(prefix)) continue;
    for (const mode of VARIANT_MODES) {
      if (byMode[mode]?.status === 'streaming') count += 1;
    }
  }
  return count;
}

/**
 * 상단에 낼 변형 진행 상황을 계산한다. 진행 중이 아니면 null.
 *
 * 판정 기준은 "아래 패널이 생성 중이면 위에도 반드시 보인다" 다. 그래서 작업
 * 목록(`jobs`)이 아직 안 들어왔더라도 생성 중 자리가 있으면 표시한다. 반대로
 * 자리가 없어도 큐에 걸린(queued) 작업이 있으면 표시한다.
 *
 * `total` 은 작업이 알려 준 값과 실제 생성 중 자리 수 중 큰 쪽을 쓴다. 개별
 * 생성이 여러 건 겹치면 첫 작업의 total(1)보다 자리가 많아, 작게 잡으면 진행이
 * 100% 를 넘는 표시가 된다.
 */
export function variantProgressOf(input: {
  variants: VariantStatusMap;
  fileId: string;
  jobs: readonly VariantJobLike[];
}): VariantProgress | null {
  const { variants, fileId, jobs } = input;
  const job =
    jobs.find(
      (candidate) =>
        candidate.node_id === fileId &&
        candidate.kind === 'variant' &&
        (candidate.status === 'running' || candidate.status === 'queued'),
    ) ?? null;
  const streaming = countRunningVariants(variants, fileId);
  if (!job && streaming === 0) return null;

  const doneCount = job?.done_count ?? 0;
  return {
    doneCount,
    total: Math.max(job?.total ?? 0, doneCount + streaming),
    currentNo: job?.current_no ?? null,
    jobId: job?.id ?? null,
  };
}
